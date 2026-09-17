// Package queue 实现 §8.4.2 的并发约束：**同一 session 同一时刻只有一条「生效中」的控制脉冲**。
//
// # 它到底在保护什么
//
// 控制指令是「读当前状态 → 算目标状态 → 写回」的复合动作。两条指令并发跑这一段时，
// 两边都读到 `running`，然后分别写 `paused` 与 `aborted`——后写的赢，而先写的那次
// 在审计里看起来「生效过」。这类丢失更新在事后完全无法从日志里还原，所以必须在
// 进入这段复合动作之前就把 session 维度串行化。
//
// # 为什么不是简单的 per-session 互斥锁
//
// 三点必须同时成立，`sync.Mutex` 只给得起第一点：
//
//  1. **互斥**：同一 session 只有一条在生效。
//  2. **FIFO 公平**：队列可见顺序。用一把锁 + 随机唤醒（Go 的 `chan`/`Cond` 唤醒顺序
//     不保证）会出现「后来的先执行」，而人在面板上看到的是自己排在第二、结果第二
//     先跑了——这不是性能问题，是**控制台的顺序显示与事实不符**。
//  3. **不能永久堵住**：持锁方是「一个人正在处理的 HTTP 请求」。如果它所在进程被 SIGKILL、
//     或者卡在一次不返回的数据库调用上，锁不会被释放，之后**该 session 上的所有控制
//     指令永久失败**。所以持有时长必须有一个上限，超时由别人强制接管并把这次接管
//     记成可见的事件（`deadline_exceeded`），而不是无声地放行。
//
// # 与库端的关系（重要的边界）
//
// 本队列是**进程内**的：它给出「本实例观测到的顺序」。多实例部署下，跨实例的互斥
// 由 store 层承担——状态行的 `SELECT ... FOR UPDATE` 是真正的仲裁者（见 internal/store）。
// 本队列不会、也不该假装自己是分布式锁：它排在前面，库端锁再兜一次底。两层的分工
// 写在这里，是因为「看起来像分布式锁的单机组件」是最容易被误信的一类东西。
package queue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/lumo-harness/platform/session-control/internal/state"
)

// ErrBusy 表示等待超时：该 session 上已有别的脉冲在生效中，且没在等待上限内让出。
//
// 调用方应把它映射成一个**可重试**的响应（503 + Retry-After），而不是「拒绝」：
// 指令本身没有问题，只是这一刻轮不到它。这里返回错误而不是排队等下去，是因为
// 「等」已经有了上限，超过上限还继续挂着只会把调用方的连接一起耗死。
var ErrBusy = errors.New("该会话上已有控制脉冲在生效中")

// BusyError 在 ErrBusy 之上带上现场信息，好让响应与日志能回答「谁在挡着」。
type BusyError struct {
	Holder        string // 生效中脉冲的 correlationId
	HolderCommand state.Command
	HeldFor       time.Duration
	Waited        time.Duration
	QueueDepth    int // 排在我前面的等待者数量（含被挡住的自己在内则在 / 不含见实现）
}

func (e *BusyError) Error() string {
	return fmt.Sprintf("%s：生效中=%s（指令 %s，已持有 %s），本次等待 %s，前方排队 %d 条",
		ErrBusy.Error(), e.Holder, e.HolderCommand, e.HeldFor.Round(time.Millisecond),
		e.Waited.Round(time.Millisecond), e.QueueDepth)
}

// Unwrap 让调用方仍可用 errors.Is(err, ErrBusy) 判断，不必知道具体类型。
func (e *BusyError) Unwrap() error { return ErrBusy }

// Options 配置队列的时间上限。两个上限都有缺省值，但**必须显式设置**——
// 缺省值在这里是给「忘了配」兜底的，而不是推荐值：合适的 MaxHold 取决于 store 的
// 超时设置，配错了会变成「正常慢请求被误判为卡死」或「真卡死时队列被堵很久」。
type Options struct {
	// MaxHold 是单条脉冲允许持有的最长时间。超过后**别人**可以强制接管（见 Sweep/Acquire）。
	MaxHold time.Duration
	// WaitLimit 是 Acquire 最多等待多久。超过即返回 BusyError。
	WaitLimit time.Duration
	// Now 便于测试注入时钟；nil 用 time.Now。
	Now func() time.Time
}

func (o Options) withDefaults() Options {
	if o.MaxHold <= 0 {
		o.MaxHold = 30 * time.Second
	}
	if o.WaitLimit <= 0 {
		o.WaitLimit = 5 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// pulse 是一条生效中（或等待中）的控制脉冲。
type pulse struct {
	correlationID string
	command       state.Command
	startedAt     time.Time // 进入生效的时刻（等待者被授予时才有意义）
	enqueuedAt    time.Time
}

// waiter 是一个正在等待进入生效的调用方。每个 waiter 独占一个 ready 通道，
// 由**释放方**负责交接——这才让顺序由显式的链表决定，而不是由运行时的唤醒顺序决定。
type waiter struct {
	pulse
	ready chan struct{}
	// granted 只在 s.mu 保护下读写：超时与授予可能同时发生，两者都要先拿 s.mu
	// 才能决定谁是赢家。这是本文件里唯一一处真正的竞态点，所以它写在字段旁边。
	granted bool
}

// sessionQueue 是单会话的队列状态。
type sessionQueue struct {
	// owner 是会话标识。队列结构需要它，是因为「放弃等待」那条路径可能要把已到手的
	// 生效权还回去，而归还需要一个 key——把 key 存在结构里，比在每个方法上多传一个
	// 参数更难写错（写错的那个调用点会去归还别人的锁）。
	owner string

	mu       sync.Mutex
	inflight *pulse
	waiting  []*waiter
	// forced 累计被强制接管的次数（持有时长超限）。计量用，也是「队列是不是在被堵」
	// 这个问题的唯一可观测证据——只看当前积压深度看不出历史。
	forced uint64
}

// Manager 是全部会话的队列集合。
type Manager struct {
	opts Options

	mu       sync.Mutex
	sessions map[string]*sessionQueue

	// onForceRelease 在强制接管发生时被调用（用于指标/告警）。不返回值：强制接管本身
	// 是必须发生的动作，不该因为观测回调出错而失败。
	onForceRelease func(sessionRef, correlationID string, held time.Duration)
}

// NewManager 构造队列。
func NewManager(opts Options) *Manager {
	return &Manager{opts: opts.withDefaults(), sessions: make(map[string]*sessionQueue)}
}

// OnForceRelease 注册强制接管的回调（供指标使用）。它有意在 Manager 构造之后设置：
// 指标注册在 main 里，而 Manager 可能被测试直接构造，构造期依赖会让测试被迫装配指标。
func (m *Manager) OnForceRelease(fn func(sessionRef, correlationID string, held time.Duration)) {
	m.onForceRelease = fn
}

// Grant 是「已进入生效」的凭证。必须成对调用 Release——建议 defer。
type Grant struct {
	sessionRef    string
	correlationID string
	command       state.Command
	// Waited 为 true 表示这条脉冲在队列里排过队（有前序脉冲）。它要进审计：
	// 「指令生效了，但它等了 2 秒」与「指令立刻就生效了」是两种不同的现场。
	queued bool
	waited time.Duration

	manager *Manager
	once    sync.Once
}

// Queued 报告该脉冲是否排过队。
//
// 三个访问器都用**指针**接收者：Grant 内含 sync.Once（不可拷贝），值接收者会让
// `go vet` 直接报「passes lock by value」——而那条警告是对的，按值传一次就复制了
// 一个锁，Release 的幂等性会在副本上失效。
func (g *Grant) Queued() bool { return g.queued }

// Waited 报告排队时长（未排队为 0）。
func (g *Grant) Waited() time.Duration { return g.waited }

// CorrelationID 便于日志与审计关联。
func (g *Grant) CorrelationID() string { return g.correlationID }

// Release 让出该会话的生效权并交接给下一个等待者。
//
// **幂等**：重复调用（比如 defer 与显式调用都跑到了）不会误伤后来者。判据是
// correlationID 比对，而不是「无条件清空 inflight」——后者会把已被强制接管后的
// 新持有者一起清掉，于是永远有两条脉冲同时在跑。
func (g *Grant) Release() {
	if g == nil || g.manager == nil {
		return
	}
	g.once.Do(func() { g.manager.release(g.sessionRef, g.correlationID) })
}

// Acquire 尝试让某条脉冲进入生效。它会等待至多 Options.WaitLimit。
//
// 等待期间遵守 ctx 取消（HTTP 客户端断开时不该继续占着队列位置）。
func (m *Manager) Acquire(ctx context.Context, sessionRef, correlationID string, command state.Command) (*Grant, error) {
	if sessionRef == "" || correlationID == "" {
		return nil, fmt.Errorf("queue: sessionRef 与 correlationID 都不能为空")
	}
	now := m.opts.Now()
	queue := m.session(sessionRef)

	queue.mu.Lock()
	// 先做一次过期清扫：把「持有过久」的脉冲在准入前摘掉，避免队列被一条卡死的
	// 脉冲挡住整个 WaitLimit。放在准入这一刻做而不是只靠后台 ticker，是因为
	// 后台周期与请求时刻无关——只在 ticker 里扫，等待者仍可能整段 WaitLimit 都被挡住。
	_, _ = m.sweepLocked(sessionRef, queue, now)

	if queue.inflight == nil {
		p := pulse{correlationID: correlationID, command: command, startedAt: now, enqueuedAt: now}
		queue.inflight = &p
		queue.mu.Unlock()
		return &Grant{sessionRef: sessionRef, correlationID: correlationID, command: command, manager: m}, nil
	}

	holder := *queue.inflight
	w := &waiter{
		pulse: pulse{correlationID: correlationID, command: command, enqueuedAt: now},
		ready: make(chan struct{}),
	}
	queue.waiting = append(queue.waiting, w)
	position := len(queue.waiting)
	queue.mu.Unlock()

	timer := time.NewTimer(m.opts.WaitLimit)
	defer timer.Stop()

	select {
	case <-w.ready:
		// 已被授予。授予方在 close 之前已经把 inflight 指向了我们，所以这里只需构造
		// Grant；startedAt 由授予方写入。
		return &Grant{
			sessionRef:    sessionRef,
			correlationID: correlationID,
			command:       command,
			queued:        true,
			waited:        m.opts.Now().Sub(w.enqueuedAt),
			manager:       m,
		}, nil
	case <-timer.C:
		return nil, m.abandon(queue, w, holder, position, now)
	case <-ctx.Done():
		err := m.abandon(queue, w, holder, position, now)
		if err == nil {
			return nil, ctx.Err()
		}
		// 放弃失败（说明此刻刚被授予）→ 以授予为准，但把 ctx 的错误也带上，
		// 让调用方能判断「要不要立刻还回去」。
		return nil, fmt.Errorf("%w（同时收到 %v）", err, ctx.Err())
	}
}

// abandon 处理等待者的两种放弃路径（超时 / ctx 取消）。
//
// 这里的竞态是本题的难点：放弃与授予可能同时发生。赢家由 s.mu 决定——
// 「拿到锁之后再看 granted」这一步是判据的唯一来源。
func (m *Manager) abandon(queue *sessionQueue, w *waiter, holder pulse, position int, now time.Time) error {
	queue.mu.Lock()
	if w.granted {
		// 已被授予（授予方在我们拿锁之前就已经交接）。此时**不能**说「没等到」，
		// 而必须把生效权还回去，否则这个 session 会被一条没人认领的脉冲永久占住
		// ——正是本包要防的那种死法。
		queue.mu.Unlock()
		m.release(queue.owner, w.correlationID)
		return ErrBusy
	}
	// 从等待链表里摘掉自己。不摘掉的话，将来释放方会把生效权交给一个已经回家的
	// 调用方，然后那条脉冲永远不会被 Release。
	for i, candidate := range queue.waiting {
		if candidate == w {
			queue.waiting = append(queue.waiting[:i], queue.waiting[i+1:]...)
			break
		}
	}
	depth := len(queue.waiting)
	queue.mu.Unlock()

	waited := now.Sub(w.enqueuedAt)
	return &BusyError{
		Holder:        holder.correlationID,
		HolderCommand: holder.command,
		HeldFor:       now.Sub(holder.startedAt),
		Waited:        waited,
		QueueDepth:    depth,
	}
}

// release 清空持有者并把生效权交给队首。correlationID 用于确认「当前持有者确实是它」。
func (m *Manager) release(sessionRef, correlationID string) {
	if sessionRef == "" {
		return
	}
	queue := m.session(sessionRef)
	now := m.opts.Now()

	queue.mu.Lock()
	defer queue.mu.Unlock()

	if queue.inflight == nil || queue.inflight.correlationID != correlationID {
		// 不是当前持有者（被强制接管过，或重复 Release）：**什么都不做**。
		// 无条件清空会误伤新持有者，让两条脉冲同时在跑——这比不释放更糟。
		return
	}
	queue.inflight = nil
	m.promoteLocked(queue, now)
}

// promoteLocked 把生效权交接给队首等待者。调用方必须已持有 queue.mu。
//
// 注意这里**不检查等待者是否还在等**（它可能已超时但在摘链之前）：摘链与授予都在
// queue.mu 之下，而等待者的「放弃」路径同样要拿这把锁，所以两者不会互相打断——
// 要么这里授予时它还在链上（那么它必然能观察到 granted），要么它已经把自己摘掉了。
func (m *Manager) promoteLocked(queue *sessionQueue, now time.Time) {
	if queue.inflight != nil || len(queue.waiting) == 0 {
		return
	}
	next := queue.waiting[0]
	queue.waiting = queue.waiting[1:]
	next.granted = true
	next.startedAt = now
	holder := next.pulse
	queue.inflight = &holder
	close(next.ready)
}

// ForcedRelease 描述一次强制接管：某条脉冲持有超过 MaxHold 被摘掉。
type ForcedRelease struct {
	SessionRef    string
	CorrelationID string
	Held          time.Duration
}

// sweepLocked 强制接管持有超限的脉冲。调用方必须已持有 queue.mu。
//
// 返回被摘掉的脉冲（没有则 forced=false）。返回值而不是让调用方回查：清扫会把
// inflight 清掉，回查时 victim 已经不在结构里了。
func (m *Manager) sweepLocked(sessionRef string, queue *sessionQueue, now time.Time) (ForcedRelease, bool) {
	if queue.inflight == nil {
		return ForcedRelease{}, false
	}
	held := now.Sub(queue.inflight.startedAt)
	if held <= m.opts.MaxHold {
		return ForcedRelease{}, false
	}
	victim := ForcedRelease{
		SessionRef:    sessionRef,
		CorrelationID: queue.inflight.correlationID,
		Held:          held,
	}
	queue.inflight = nil
	queue.forced++
	if m.onForceRelease != nil {
		m.onForceRelease(sessionRef, victim.CorrelationID, held)
	}
	m.promoteLocked(queue, now)
	return victim, true
}

// Sweep 对全部会话做一次强制接管检查，返回本次被接管的脉冲。供后台 ticker 调用。
//
// 准入时也会清扫（见 Acquire），为什么还要一个周期性入口：空转的会话可能很久没有
// 下一个请求，而积压指标不能一直挂着一个已经死掉的事实。两处清扫共用
// sweepLocked，判据只有一份。
func (m *Manager) Sweep() []ForcedRelease {
	now := m.opts.Now()
	m.mu.Lock()
	refs := make([]string, 0, len(m.sessions))
	for ref := range m.sessions {
		refs = append(refs, ref)
	}
	m.mu.Unlock()

	var forced []ForcedRelease
	for _, ref := range refs {
		queue := m.session(ref)
		queue.mu.Lock()
		victim, ok := m.sweepLocked(ref, queue, now)
		queue.mu.Unlock()
		if ok {
			forced = append(forced, victim)
		}
	}
	return forced
}

// Snapshot 返回某会话当前的队列现场，供只读 console 使用。
//
// 带 json tag：它会原样进控制台的 HTTP 响应（理由同 state.Available）。
type Snapshot struct {
	Inflight *Entry  `json:"inflight"`
	Waiting  []Entry `json:"waiting"`
	// Forced 是该会话历史上被强制接管的累计次数。
	Forced uint64 `json:"forced"`
}

// Entry 是队列现场里的一条。
type Entry struct {
	CorrelationID string        `json:"correlation_id"`
	Command       state.Command `json:"command"`
	EnqueuedAt    time.Time     `json:"enqueued_at"`
	StartedAt     time.Time     `json:"started_at"`
	// Position 从 1 开始：生效中的那条是 1，等待者依次递增。控制台直接展示它，
	// 所以它必须与 Waiting 的顺序一致（同一次加锁内取，不会各自算一遍）。
	Position int `json:"position"`
}

// Snapshot 取现场。未知会话返回零值而不是错误：控制台问一个还没有控制活动的会话
// 是正常查询，不是异常。
func (m *Manager) Snapshot(sessionRef string) Snapshot {
	m.mu.Lock()
	queue, ok := m.sessions[sessionRef]
	m.mu.Unlock()
	if !ok {
		return Snapshot{}
	}
	now := m.opts.Now()
	queue.mu.Lock()
	defer queue.mu.Unlock()
	// 取现场时顺手清扫一次：控制台看到的应该是剔除过期持有者之后的真相，
	// 否则面板上会显示一个其实已经被接管的持有者。
	_, _ = m.sweepLocked(sessionRef, queue, now)

	var snapshot Snapshot
	snapshot.Forced = queue.forced
	position := 1
	if queue.inflight != nil {
		snapshot.Inflight = &Entry{
			CorrelationID: queue.inflight.correlationID,
			Command:       queue.inflight.command,
			EnqueuedAt:    queue.inflight.enqueuedAt,
			StartedAt:     queue.inflight.startedAt,
			Position:      position,
		}
		position++
	}
	for _, w := range queue.waiting {
		snapshot.Waiting = append(snapshot.Waiting, Entry{
			CorrelationID: w.correlationID,
			Command:       w.command,
			EnqueuedAt:    w.enqueuedAt,
			Position:      position,
		})
		position++
	}
	return snapshot
}

// Totals 返回**全部会话**的生效中与等待中脉冲数之和，供指标聚合使用。
//
// 为什么不给每个会话各导一条序列：会话数是无界的，按 session_ref 下钻会把指标基数
// 顶穿上限（observability 的基数守卫会开始丢序列，于是「指标不见了」与「队列空了」
// 在面板上长得一样）。聚合值足够回答「这个实例上有没有堵」，下钻单会话请走
// Snapshot 的只读接口。
//
// 各会话逐个加锁取值，不做全局快照：这里要的是近似计数，为一个指标引入全局一致
// 快照不划算（且会与 snapshot 里的瞬时清扫互相影响）。
func (m *Manager) Totals() (inflight, waiting int) {
	// 只在这把锁里**取指针**，绝不调用 m.session()：那个方法自己也要拿 m.mu，
	// 在持锁状态下调它会在非可重入的互斥量上自锁——而这条路径由后台指标循环驱动，
	// 自锁的后果不是「指标不见了」，是**整个服务从此挂死**（后续每一个新会话的
	// Acquire 都会卡在同一把锁上）。这个坑正是被本包的用例抓出来的。
	m.mu.Lock()
	owners := make([]string, 0, len(m.sessions))
	for ref := range m.sessions {
		owners = append(owners, ref)
	}
	m.mu.Unlock()

	for _, owner := range owners {
		// 用 Snapshot 而不是直接读字段：它会在同一把锁内顺手清扫过期持有者，
		// 于是指标不会把一条已被接管的脉冲继续算成「生效中」。
		snapshot := m.Snapshot(owner)
		if snapshot.Inflight != nil {
			inflight++
		}
		waiting += len(snapshot.Waiting)
	}
	return inflight, waiting
}

// Depth 返回某会话的队列深度（生效中算 1）。用于指标。
func (m *Manager) Depth(sessionRef string) int {
	snapshot := m.Snapshot(sessionRef)
	depth := len(snapshot.Waiting)
	if snapshot.Inflight != nil {
		depth++
	}
	return depth
}

func (m *Manager) session(sessionRef string) *sessionQueue {
	m.mu.Lock()
	defer m.mu.Unlock()
	queue, ok := m.sessions[sessionRef]
	if !ok {
		queue = &sessionQueue{owner: sessionRef}
		m.sessions[sessionRef] = queue
	}
	return queue
}
