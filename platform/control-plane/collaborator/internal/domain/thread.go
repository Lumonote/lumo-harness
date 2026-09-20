// 线程档位的领域层（§24.2 两档成员：Worker 一次性 / Thread 可续跑）。
//
// `2026-09-20-cluster-multi-agent-coordinator-fleet-design.md` §24.2.1 把 Thread 定义成
// 三元组 **(稳定 sessionRef, 承载节点, 事件订阅集合)**，并明确「没有任何新执行机制」：
// 续跑就是 §7.1 的 resume，唤醒就是 §8.1 的 mailbox，配额就是 §6.4 的预算树。因此本文件
// 只负责**判据**（状态闭集与合法边、承载节点亲和的降级结论、工作目录的归属），执行面不在
// 这里，也不在协作服务里。
//
// 表结构见 store.go 的 DDL（逐字照抄设计说明 §11 的 `threads`）。三条在本文件里被反复
// 引用的硬约束：
//
//  1. **不假装可迁移。** 承载节点丢失 = Thread 终止、标 `failed`、重派**新 Run**，
//     绝不迁移（§24.2.1 + architecture.md §7.1 评审 R2「句柄型 seam 的会话不可跨节点
//     恢复」）。所以 node_id 一经写入不可改，终态不可复活。
//  2. **不新增业务态。** §23.3 的业务态机与 Run 的 7 值闭集一字不动；这里的状态闭集只描述
//     **线程自己的生命周期**（在跑 / 在等 / 停了），一轮 = 一个 Run（§24.2.2）。
//  3. **工作目录不进复制日志。** 目录不是模型可见状态，与句柄型 seam 同训（§24.3.2）。
package domain

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ErrInvalidThread 线程行不合法的统一错误（server 层映射 400）。
//
// 与 store 层的领域错误（ErrThreadNotFound 等）分开：校验发生在纯函数里，而 store 无法
// 向上定义 domain 的错误。两层用 errors.Is 判定，跨层身份靠它维持。
var ErrInvalidThread = errors.New("非法线程行")

// ThreadState 线程状态闭集（§11 的 threads.state 注释直译）。
//
// **为什么闭集里必须有 `failed`，而 §11 的注释只列了五个值**：设计说明 §24.2.1 与
// architecture.md §7.1（评审 R2）给出的降级判据都是「终止会话并**标记 `failed`**」，
// §14 验收判据 9 也直接要求「承载节点失联 → Thread 标 `failed` 并重派新 Run」。
// 少了它，节点丢失只能混进 `stopped` —— 而两者的处置恰好相反：
//
//   - `stopped` 是**有人主动停下**：现场还在（工作目录、会话日志都在承载节点上），
//     处置是等人/等指令；
//   - `failed` 是**现场已经没了**：工作目录不迁移，必须重派新 Run。
//
// 混成一个值，协调者就失去了「要不要重派」的输入，而这正是本切片要防的那类静默错误。
// 结论：闭集是六个值，§11 的注释是**漏写**——该处已于 2026-09-20 一并订正，
// 上面这段「处置相反」的论证也已回填进 §11 的列注释（设计说明与代码以同一份理由为准）。
type ThreadState string

const (
	// ThreadStateIdle 已建、未跑。新建即此态。
	ThreadStateIdle ThreadState = "idle"
	// ThreadStateRunning 有一轮 Run 正在承载节点上执行。
	ThreadStateRunning ThreadState = "running"
	// ThreadStateAwaiting 已挂起，等一个带 TTL 的事件唤醒（§8.1）。
	ThreadStateAwaiting ThreadState = "awaiting"
	// ThreadStateStopped 被人主动停下（现场还在，但不再推进）。
	ThreadStateStopped ThreadState = "stopped"
	// ThreadStateDone 目标达成。终态。
	ThreadStateDone ThreadState = "done"
	// ThreadStateFailed 承载节点丢失或不可恢复的失败。终态，且**必须重派新 Run**。
	ThreadStateFailed ThreadState = "failed"
)

// ThreadStates 闭集的有序快照（错误信息与测试共用，避免两处手抄）。
var ThreadStates = []ThreadState{
	ThreadStateIdle, ThreadStateRunning, ThreadStateAwaiting,
	ThreadStateStopped, ThreadStateDone, ThreadStateFailed,
}

// ValidThreadState 闭集校验。闭集外的值一律拒绝——不是「未知即跳过」：读路径把一个
// 拼错的状态当合法值收下，症状是这条线程在按状态过滤的读面里**静默消失**（看板上
// 「少了一条线程」比「多了一条状态不明的线程」难查得多）。
func ValidThreadState(state ThreadState) error {
	for _, s := range ThreadStates {
		if s == state {
			return nil
		}
	}
	return fmt.Errorf("%w: 未知 state %q，合法取值：%s",
		ErrInvalidThread, string(state), threadStatesJoined())
}

func threadStatesJoined() string {
	names := make([]string, 0, len(ThreadStates))
	for _, s := range ThreadStates {
		names = append(names, string(s))
	}
	return strings.Join(names, " | ")
}

// threadTransitions 合法状态转移（**判据只有这一张表**，调用方只消费 CanThreadTransition）。
//
// 每条边的理由，按「为什么必须是它」写：
//
//	idle → running      派发第一轮。
//	idle → stopped      建了又不想跑（例如协调者改主意）。
//	idle → failed       还没跑承载节点就没了：现场是空的，但线程确实无法推进。
//	running → awaiting  一轮挂起，交出 Slot 等事件（§8.1 suspend/resume 的落点）。
//	running → done      一轮跑完且目标达成。
//	running → stopped   跑着被人叫停（§8.4 的 stop）。
//	running → failed    承载节点丢失 / 不可恢复失败（§7.1 评审 R2）。
//	awaiting → running  被事件唤醒，开**新一轮**（新一轮 = 新 Run，§24.2.2）。
//	awaiting → stopped  挂着被人叫停。
//	awaiting → failed   等待期间承载节点丢失。
//
// 三条**刻意不存在的边**，每一条都可以被误加、且误加之后会静默出错：
//
//   - **`idle → awaiting` 不合法**：没跑过就等，说明调用方把状态搞错了；更危险的是它会
//     造出「等一个从未 arm 过的唤醒」——等待项不存在，等待方永远不被释放，而状态看起来
//     完全正常（这与 §8.1 要消灭的「永不唤醒」是同一形状）。
//   - **`awaiting → done` 不合法**：完成必须来自某一轮 Run 的产出（§24.2.2：一轮 = 一个
//     Run）。从等待态直达完成会造出「没有 Run 的完成」——那种完成没有产出物可裁决，
//     §23.4 的报告与 evidence 也就无处可挂。唤醒事件若表示目标达成，先转 `running`。
//   - **终态无出边**（stopped / done / failed 都是空集）：`failed` 若能复活，节点丢失就
//     变成了「换台机器接着跑」，正是 §24.2.1 禁止的迁移；`stopped`/`done` 若能复活，
//     「一个线程一个稳定会话一个承载节点」这条不变量就会被绕开。要续跑就**新建 Thread**
//     （新 session_ref、新工作目录、可能落在别的节点上）——那是新 Run 的正确形态。
var threadTransitions = map[ThreadState][]ThreadState{
	ThreadStateIdle:     {ThreadStateRunning, ThreadStateStopped, ThreadStateFailed},
	ThreadStateRunning:  {ThreadStateAwaiting, ThreadStateDone, ThreadStateStopped, ThreadStateFailed},
	ThreadStateAwaiting: {ThreadStateRunning, ThreadStateStopped, ThreadStateFailed},
	ThreadStateStopped:  nil,
	ThreadStateDone:     nil,
	ThreadStateFailed:   nil,
}

// ThreadStateTerminal 是否终态。终态 = 线程生命周期结束，只有新建 Thread 才能继续这项工作。
func ThreadStateTerminal(state ThreadState) bool {
	return state == ThreadStateStopped || state == ThreadStateDone || state == ThreadStateFailed
}

// CanThreadTransition 状态转移判据：**唯一来源**（store 与读侧都只调它）。
func CanThreadTransition(from, to ThreadState) bool {
	for _, candidate := range threadTransitions[from] {
		if candidate == to {
			return true
		}
	}
	return false
}

// ValidateThreadTransition 转移判据 + 可读的拒绝理由。
//
// 先判两端是不是闭集内的值：`from` 不在闭集里意味着**存储被写脏了**（读路径本应拒绝
// 这种行），这时既不能当合法边放行、也不能报「非法转移」把现场引到状态机上去。
func ValidateThreadTransition(from, to ThreadState) error {
	if err := ValidThreadState(from); err != nil {
		return err
	}
	if err := ValidThreadState(to); err != nil {
		return err
	}
	if from == to {
		// 同态转移一律拒绝：它是「重复投递」的形状（§8.1 的至少一次投递下必然出现），
		// 接受它会让「state 从 A 到 A」在审计上看起来像一次真实推进。幂等要由调用方
		// 用读数判断，不能由状态机默认接受。
		return fmt.Errorf("%w: state 已经是 %q，重复置位不是一次转移", ErrInvalidThread, string(from))
	}
	if !CanThreadTransition(from, to) {
		if ThreadStateTerminal(from) {
			return fmt.Errorf("%w: %q 是终态，不能再转移（承载节点亲和不迁移：要续跑请新建 Thread）",
				ErrInvalidThread, string(from))
		}
		return fmt.Errorf("%w: 非法转移 %q → %q", ErrInvalidThread, string(from), string(to))
	}
	return nil
}

// ThreadAcceptsNewRound 本线程此刻能不能开一轮新的 Run。
//
// 只有 `idle`（还没跑过）与 `awaiting`（被唤醒）可以。三条拒绝各自的理由：
//
//   - `running`：一轮未完不得并行开第二轮——两轮共用一个工作目录会互相踩踏，而「同一
//     Thread 同时有两个执行者」正是本设计要消灭的形状（与「同一 Thread 两个 node_id 并存」
//     同源）。
//   - `stopped` / `done` / `failed`：终态。尤其 `failed` —— 节点丢了的工作**不能在同一
//     个 Thread 上重试**，重派必须新建 Thread（§24.2.1）。
func ThreadAcceptsNewRound(state ThreadState) bool {
	return state == ThreadStateIdle || state == ThreadStateAwaiting
}

// ThreadRound 一个轮次的身份：**就是 §23.3 的一个 Run**（§24.2.2：一轮 = 一个 Run）。
//
// 为什么线程行里没有代数列：`threads` 表的列**照抄 §11**，不新增；轮次身份由 Run 侧
// 持有（`(task_id, attempt)` 唯一约束照旧，§23.3 的闭集一字不动）。本结构只是把
// 「这一轮是谁」在两个系统之间搬来搬去时的形状。
type ThreadRound struct {
	// TaskID §23.3 的任务，必须等于 threads.task_id。
	TaskID string `json:"task_id"`
	// Attempt Run 的代数（`(task_id, attempt)` 唯一约束的右半）。
	Attempt int `json:"attempt"`
}

// Key 归因键（§14 验收判据 10：一次由事件唤醒的 Run，其成本可按 wake 事件聚合）。
//
// 形如 `task-7#2`，刻意与 `session_ref` 分开：归因要能落到**某一轮**上，只落到会话上就
// 分不清是被唤醒的那一轮还是上一轮在烧钱。
func (r ThreadRound) Key() string {
	return fmt.Sprintf("%s#%d", r.TaskID, r.Attempt)
}

// Validate 轮次身份自证：任务非空、代数 >= 1。
//
// 为什么 attempt 从 1 起：0 表示「还没有过任何一次尝试」（§23.3 的 Run 表用 0 起表示
// 未派发）。让 0 通过，就会造出一个「第 0 轮被唤醒」的归因键，而它永远不会与任何真实
// Run 对上——成本聚合会静默少掉这一笔。
func (r ThreadRound) Validate() error {
	if strings.TrimSpace(r.TaskID) == "" {
		return fmt.Errorf("%w: 轮次必须引用一个任务（task_id 非空）", ErrInvalidThread)
	}
	if r.Attempt < 1 {
		return fmt.Errorf("%w: 轮次的 attempt 必须 >= 1（0 表示从未派发，不是一轮）", ErrInvalidThread)
	}
	return nil
}

// ThreadRoundOf 从线程行与 Run 代数构造本轮身份。
//
// 这是「一轮 = 一个 Run」在写侧的落点：**开新一轮之前先问线程答不答应**
// （ThreadAcceptsNewRound）。把两件事放在一个函数里，是为了让「没检查状态就开跑」
// 在调用点看起来就是漏了一步，而不是一次看不见的越权。
func ThreadRoundOf(t Thread, attempt int) (ThreadRound, error) {
	if !ThreadAcceptsNewRound(t.State) {
		return ThreadRound{}, fmt.Errorf("%w: 线程 %s 处于 %q，不接受新一轮（running 会与在跑的一轮抢同一个工作目录；终态要续跑必须新建 Thread）",
			ErrInvalidThread, t.ID, string(t.State))
	}
	round := ThreadRound{TaskID: t.TaskID, Attempt: attempt}
	if err := round.Validate(); err != nil {
		return ThreadRound{}, err
	}
	return round, nil
}

// ThreadNodeLoss 承载节点丢失的**唯一判据**（§24.2.1 末段 + §7.1 评审 R2）。
type ThreadNodeLoss struct {
	// State 处置后的状态：未终态 → `failed`；已终态 → 原状态不变。
	State ThreadState `json:"state"`
	// ReassignRun 是否应当重派**新 Run**（新 Thread），而不是恢复既有 Thread。
	ReassignRun bool `json:"reassign_run"`
	// MigrateNode 恒为 false。这一列存在，是为了让「迁移」在任何调用路径上都**没有**
	// 可以读到的肯定值——一个布尔字段的默认值比一段注释更难被绕过。
	MigrateNode bool `json:"migrate_node"`
	// Reason 供上报与看板使用（§24.6 的「已停」格要能说清是失败/取消）。
	Reason string `json:"reason"`
}

// ThreadOnNodeLoss 承载节点丢失时的处置结论（纯函数）。
//
// 两条判据：
//
//  1. **未终态 → `failed` + 重派新 Run。** 工作目录不迁移（§24.3.2），模型可见状态可以
//     重建到最近检查点，但现场（PTY/进程/fd/文件）随节点消失——「绝不假装可迁移」。
//  2. **已终态 → 原状态不变、不重派。** 节点丢失是**至少一次投递**的通知：同一个节点的
//     丢失会被多个观察者（心跳、调度器、协调者）各报一次。若每次都回「重派」，一个已经
//     `done` 的线程会被反复重投——§7.1 的原话是「**绝不无限重投**：把『不可恢复』误判成
//     『可重试』会放大外部副作用」。
func ThreadOnNodeLoss(t Thread) (ThreadNodeLoss, error) {
	if err := ValidThreadState(t.State); err != nil {
		return ThreadNodeLoss{}, err
	}
	if t.NodeID == "" {
		return ThreadNodeLoss{}, fmt.Errorf("%w: 线程 %s 没有承载节点，无法判定节点丢失（一行没有 node_id 的线程是「还没放上去」，不是「节点丢了」）",
			ErrInvalidThread, t.ID)
	}
	if ThreadStateTerminal(t.State) {
		return ThreadNodeLoss{
			State:       t.State,
			ReassignRun: false,
			MigrateNode: false,
			Reason:      fmt.Sprintf("线程已是终态 %q，节点丢失通知按幂等忽略（绝不无限重投）", string(t.State)),
		}, nil
	}
	return ThreadNodeLoss{
		State:       ThreadStateFailed,
		ReassignRun: true,
		MigrateNode: false,
		Reason:      fmt.Sprintf("承载节点 %s 丢失：工作目录与会话现场随节点消失，标 failed 并重派新 Run（不迁移）", t.NodeID),
	}, nil
}

// NodeLossNotice 节点失联的**通知**（§24.2.3(4) 的信号链中段：collaborator 标记 `failed`
// 之后要通知协调者）。
//
// ## 为什么通知是协作服务自己的一行，而不是直接写 mailbox
//
// §8.1 的 mailbox 表（`mailbox_future`）由 `@lumo/mailbox` 插件持有并创建，本服务既不是
// 它的建表方也不是它的写入方。从 Go 侧直接 UPDATE 它，要同时复制三件本服务不该知道的事：
// 等待项 id 的派生规则（插件侧按 (线程, 轮次) 派生）、realm 前缀、以及「首次兑现为准」
// 的条件写语义。任一处漂移，症状都是**通知静默丢失**——等待方一直等到 TTL 到期才靠对账
// 发现，与 §8.1 要消灭的「永不唤醒」同形。
//
// 所以本服务只负责**产生可读的通知**（append-only，单调 seq 游标），由**持有 mailbox 的
// 那一侧**（协调者所在节点的 `agent-teams`，见 `thread-wake.ts` 的 `announce`）把它投进
// 等待通道。这与 §8.1 的第三条纪律同源：**轮询才是正确性来源，通知只降低延迟**——
// 通知落在本表里就不会丢，投递方迟到或重复投递都不影响结论。
//
// ## 为什么没有「已处理」状态列
//
// 通知是**事实**（这条线程随它的节点没了），不是待办事项。消费方各自持有游标（`seq`），
// 多个消费方（协调者、看板、运维）互不干扰；加一个 `handled` 列会把「谁处理过」变成一次
// 全局写，而两个消费方第一个 ack 之后第二个就再也读不到这条通知了。
type NodeLossNotice struct {
	// Seq 单调递增的游标（`BIGSERIAL`）。消费方按 `seq > 上次` 拉增量：时间戳会撞
	// （同一个节点的丢失在同一毫秒里产生多条通知），游标不会。
	Seq int64 `json:"seq"`
	// Realm 首要授权边界。跨 realm 的读一律按空集处理（与 threads 同训）。
	Realm string `json:"realm"`
	// ThreadID 出事的线程。**(realm, thread_id) 唯一**：一条线程只能死一次（终态不可复活），
	// 因此重复上报结构上不可能产生第二条通知——去重靠唯一索引，不靠调用方的自觉。
	ThreadID string `json:"thread_id"`
	// NodeID 丢失的承载节点。协调者据此判断「要不要重派」（§7.1 R2：不可恢复 ≠ 可重试）。
	NodeID string `json:"node_id"`
	// SessionRef 出事的那条**稳定会话**。现场在死节点上，这个 ref 只用于归因与排查。
	SessionRef string `json:"session_ref"`
	// CoordinatorSessionRef 该通知要送达的协调者会话（§24.1：协调者做路由与验收）。
	CoordinatorSessionRef string `json:"coordinator_session_ref"`
	// Reason 可读的结论（来自 `ThreadOnNodeLoss`），供看板与日志直接引用。
	Reason string `json:"reason"`
	// CreatedAt 由库端时钟给出（单一时钟源，见 store 的同款取舍）。
	CreatedAt time.Time `json:"created_at"`
}

// NodeLossNoticeOf 由一条**已推入 failed 的线程行**派生通知（纯函数）。
//
// 判据只有两条，都是 fail-closed 的：
//
//  1. 行必须是 `failed`——给一条还在跑的线程发「节点没了」的通知，会让协调者重派一条
//     其实活着的线程，于是同一份工作出现两个执行者；
//  2. 两个 ref 必须非空——通知的**唯一用途**就是被送到协调者手里。送不到的通知在库里
//     看起来完全正常，而它占掉的唯一索引（(realm, thread_id)）会让真正的通知插不进来。
func NodeLossNoticeOf(t Thread, reason string) (NodeLossNotice, error) {
	if t.State != ThreadStateFailed {
		return NodeLossNotice{}, fmt.Errorf("%w: 只有 %q 的线程才产生节点失联通知，线程 %s 处于 %q",
			ErrInvalidThread, string(ThreadStateFailed), t.ID, string(t.State))
	}
	if err := ValidateThreadRef("session_ref", t.SessionRef); err != nil {
		return NodeLossNotice{}, err
	}
	if err := ValidateThreadRef("coordinator_session_ref", t.CoordinatorSessionRef); err != nil {
		return NodeLossNotice{}, err
	}
	if err := ValidateThreadRef("node_id", t.NodeID); err != nil {
		return NodeLossNotice{}, err
	}
	if strings.TrimSpace(t.Realm) == "" {
		return NodeLossNotice{}, fmt.Errorf("%w: 通知必须有 realm（它是首要授权边界）", ErrInvalidThread)
	}
	return NodeLossNotice{
		Realm:                 t.Realm,
		ThreadID:              t.ID,
		NodeID:                t.NodeID,
		SessionRef:            t.SessionRef,
		CoordinatorSessionRef: t.CoordinatorSessionRef,
		Reason:                reason,
	}, nil
}

// Thread 线程行（§11 的 `threads` 表；字段名与列名一一对应，不另起别名）。
//
// `Workspace` 存的是**相对节点工作区根的路径**（`thread/<id>/`），不是绝对路径——理由见
// ValidateThreadWorkspace。
type Thread struct {
	ID                    string      `json:"id"`
	Realm                 string      `json:"realm"`
	ProjectID             string      `json:"project_id"`
	TaskID                string      `json:"task_id"`
	CoordinatorSessionRef string      `json:"coordinator_session_ref"`
	SessionRef            string      `json:"session_ref"`
	NodeID                string      `json:"node_id"`
	Workspace             string      `json:"workspace"`
	State                 ThreadState `json:"state"`
	CreatedAt             time.Time   `json:"created_at"`
	UpdatedAt             time.Time   `json:"updated_at"`
}

// threadIDRe 线程 id 的合法形态。
//
// 与 `TEAM_ID_RE`（TS 侧）同款理由，外加两条本表特有的：id 会进协作服务的 URL 路径段
// （`/threads/{threadID}`）**并且**会进工作目录段（`thread/<id>/`）。含 `/` 或 `..` 的 id
// 会让「资源归属」与「路径归属」脱钩——那时一个线程能读写另一个线程的目录，而两边的
// 记录都自洽。
var threadIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ValidateThreadID 校验线程 id。
func ValidateThreadID(id string) error {
	if !threadIDRe.MatchString(id) {
		return fmt.Errorf("%w: 线程 id %q 不合法：只允许 [A-Za-z0-9_-] 且长度 1..128"+
			"（它要当 URL 路径段与工作目录段，含分隔符会让资源归属与路径归属脱钩）", ErrInvalidThread, id)
	}
	return nil
}

// ValidateThreadRef 校验 session_ref / coordinator_session_ref / node_id 这类「外部标识」。
//
// 判据刻意只禁空白与 `/`：session_ref 由 dsh 的会话层给出，本平台没有它的语法（强行
// 加一套白名单，第一个不合规的真实会话就会被拒在门外）。禁空白是因为它会破坏日志与
// 指标的分列；禁 `/` 是因为这一列会与工作目录路径同时出现在排查输出里，两者混起来读
// 会让人以为会话落在目录里。
func ValidateThreadRef(field, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%w: %s 不可为空", ErrInvalidThread, field)
	}
	if strings.ContainsAny(value, " \t\r\n/") {
		return fmt.Errorf("%w: %s %q 含空白或 /", ErrInvalidThread, field, value)
	}
	if len(value) > 200 {
		return fmt.Errorf("%w: %s 过长（%d > 200）", ErrInvalidThread, field, len(value))
	}
	return nil
}

// ThreadWorkspaceDir 线程在承载节点上的工作目录（**相对节点工作区根**，§24.3.2）。
//
// 设计说明写的是 `thread/{threadId}/`，这里逐字实现——目录的物化（Provisioner 按制品
// digest 铺内容）不在本切片内：本切片只做「路径的归属与校验」。
func ThreadWorkspaceDir(id string) string {
	return "thread/" + id + "/"
}

// ValidateThreadWorkspace 工作目录的归属判据：**必须恰好等于**由本行 id 推出的相对路径。
//
// 为什么是**等值**而不是前缀匹配：前缀匹配会同时放过三种事故——
//
//   - `thread/t1/../../../etc/` 通过前缀检查却在解析后跑到根外；
//   - `thread/t10/` 与 `thread/t1` 都能匹配 `thread/t1` 前缀，于是两个不同 Thread 共用
//     （或嵌套）同一个目录，两边各自都认为目录是自己的；
//   - 归属不成立时无法给出「你到底占的是谁的目录」这个可读结论。
//
// 为什么必须是**相对**路径：绝对路径是**节点局部事实**。这一行会被别的节点读到
// （协调者、看板、终端的节点），把 `/data/ws/thread/t1/` 写进去，读的一方会以为那是它
// 自己的路径——这与「把句柄写进复制日志」是同一类错误（§24.3.2：目录不进复制日志），
// 也让「不假装可迁移」在数据面上破功。
func ValidateThreadWorkspace(id, workspace string) error {
	if workspace == "" {
		return fmt.Errorf("%w: workspace 不可为空（线程没有工作目录，等于没有一个不被别的线程踩的现场）", ErrInvalidThread)
	}
	if strings.HasPrefix(workspace, "/") || strings.Contains(workspace, `\`) || strings.Contains(workspace, ":") {
		return fmt.Errorf("%w: workspace %q 必须是相对路径（绝对路径是节点局部事实，写进被别的节点读的行里就成了「假装可迁移」）",
			ErrInvalidThread, workspace)
	}
	if strings.Contains(workspace, "..") {
		return fmt.Errorf("%w: workspace %q 不得含 ..（越出节点工作区根）", ErrInvalidThread, workspace)
	}
	want := ThreadWorkspaceDir(id)
	if workspace != want {
		return fmt.Errorf("%w: workspace %q 的归属不成立：本行 id=%s，它只能是 %q（等值判据，前缀判据会让两个线程共用或嵌套同一个目录）",
			ErrInvalidThread, workspace, id, want)
	}
	return nil
}

// ValidateThreadCreate 新建线程行之前的校验（纯函数，store 在写库前先跑一次）。
func ValidateThreadCreate(t Thread) error {
	if err := ValidateThreadID(t.ID); err != nil {
		return err
	}
	if strings.TrimSpace(t.Realm) == "" {
		return fmt.Errorf("%w: realm 不可为空（它是首要授权边界）", ErrInvalidThread)
	}
	if strings.TrimSpace(t.ProjectID) == "" {
		return fmt.Errorf("%w: project_id 不可为空（线程属于项目工作区，§11.1）", ErrInvalidThread)
	}
	if strings.TrimSpace(t.TaskID) == "" {
		return fmt.Errorf("%w: task_id 不可为空（一轮 = 一个 Run，而 Run 挂在任务上，§24.2.2）", ErrInvalidThread)
	}
	if err := ValidateThreadRef("coordinator_session_ref", t.CoordinatorSessionRef); err != nil {
		return err
	}
	if err := ValidateThreadRef("session_ref", t.SessionRef); err != nil {
		return err
	}
	if err := ValidateThreadRef("node_id", t.NodeID); err != nil {
		return err
	}
	if err := ValidateThreadWorkspace(t.ID, t.Workspace); err != nil {
		return err
	}
	if err := ValidThreadState(t.State); err != nil {
		return err
	}
	if t.State != ThreadStateIdle {
		// 新建必须 idle：一个一出生就 running 的线程意味着「还没放上承载节点就先报在跑」，
		// 而 awaiting 更糟——它会让读侧去找一个从未被 arm 的唤醒（§8.1）。
		return fmt.Errorf("%w: 新建线程必须是 %q，收到 %q（先建好再派发，状态由派发方推）",
			ErrInvalidThread, string(ThreadStateIdle), string(t.State))
	}
	return nil
}
