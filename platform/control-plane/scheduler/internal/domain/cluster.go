// 联邦注册表与两段式失联判定（spec §7.4.1 / 铁律 19：跨集群失联严禁秒级切换）。
//
// 为什么需要一张注册表而不是从节点目录派生：Nacos 目录**只返回健康实例**
// （catalog/nacos.go 的 healthy/enabled 过滤），于是一个失联的集群与一个从未部署的
// 集群在目录视图上**完全一样**（都是「没有它的节点」）。目录原理上回答不了
// 「这个集群是挂了还是没部署过」——这正是注册表存在的理由，不是从 spec 抄来的形式。
package domain

import (
	"fmt"
	"strings"
	"time"
)

// ClusterState 集群在联邦注册表里的状态。
//
// **没有「由上报方声明」的那一档。** 注册表里不存状态列，唯一被存下来的是
// 「最后一次自报的时刻」，状态一律由「年龄 + 阈值」派生（见 EvaluateCluster）。
// 理由是自报方只能声明「我还活着」，它无法声明自己「可疑」或「下线」——
// 那两档只有在时间上看得出来的判定方推得出来。若给表加一个 state 列，它就会变成
// 两个写入方共用的字段：上报方写 healthy、判定方写 down，谁后写谁赢，而「谁后写」
// 在不同副本上并不一致。（与 E4/D6 的 degraded 同一条判据：生效值只能派生，不能声明。）
type ClusterState string

const (
	// ClusterHealthy 最近一次自报在 suspect 阈值之内。
	ClusterHealthy ClusterState = "healthy"
	// ClusterSuspect 超过 suspect 阈值、未到 down 阈值。只挡新放置，不动既有任务。
	ClusterSuspect ClusterState = "suspect"
	// ClusterDown 超过 down 阈值。
	ClusterDown ClusterState = "down"
	// ClusterUnregistered 目录里有这个集群的节点，但注册表里没有它的记录。
	//
	// 它刻意是一个**独立取值**而不是 down：注册表没听说过它，说明「这个集群由谁
	// 负责自报」这件事还没有答案（配置事实，重试无用）；而 down 是「它本该在报、
	// 但没在报」（故障）。两者处置不同——前者去改配置，后者去查那个集群。
	ClusterUnregistered ClusterState = "unregistered"
	// ClusterUnjudged 零值：本实例没有参与判定（联邦注册表能力关闭）。
	//
	// 与 ClusterUnregistered 的区别是「本实例没有意见」与「注册表里没有这个集群」。
	// 闸门对两者都放行，但接口与日志必须把它们分开说，否则关掉能力的实例会报出
	// 一屏 unregistered，看起来像配置错误。
	ClusterUnjudged ClusterState = ""
)

// BlocksPlacement 该状态的集群是否拒绝新放置。
//
// 只有 suspect 与 down 拒绝（§7.4.1：suspect 期间停止向其新放置，已有任务不动）。
// 未知一律放行：判定不了不等于要停摆——把 unjudged / unregistered 也当成拒绝，
// 会让「注册表没配好」直接升级成「整个平台无法放置」。
func (s ClusterState) BlocksPlacement() bool {
	return s == ClusterSuspect || s == ClusterDown
}

// AllowsTaskMigration 该状态的集群是否允许把它上面的任务漂移走（§7.4.1）。
//
// **只有 down 允许。** suspect 刻意不允许：§7.4.1 明文「suspect 期间停止向其新
// 放置，已有任务不动」，而「不动」的全部意义就是不搬家——跨集群迁移的代价远高于
// 等待（铁律 19），suspect 只是到 down 阈值之间的等待期，在那段时间里动手等于把
// 一次网络抖动变成一轮全量迁移。
//
// 为什么不复用 BlocksPlacement（两者今天都是「suspect 或 down」的形状）：它们是
// **两条不同的时间线**——闸门在 suspect 就生效，漂移要等到 down（还要再过宽限）。
// 合成一个函数之后，任何一次「把闸门放宽成只挡 down」的改动都会**静默地**同时
// 放宽漂移，而漂移是不可逆动作（会重开 attempt）。分开写，让这种改动必须显式
// 改两处。
func (s ClusterState) AllowsTaskMigration() bool {
	return s == ClusterDown
}

// JudgedStates 判定会产出的状态全集（不含 unregistered / unjudged）。
//
// 单独导出是为了让「导出成指标的维度集合」与判定函数取自同一个枚举：指标侧
// 手写一份列表，判定侧加一档时指标就会少一维，而少的那一维恰恰是没人看得见的那档。
func JudgedStates() []ClusterState {
	return []ClusterState{ClusterHealthy, ClusterSuspect, ClusterDown}
}

// ClusterThresholds 两段式判定的阈值。
type ClusterThresholds struct {
	// SuspectMS 距最后一次自报超过它即视为可疑（默认 30s）。
	SuspectMS int64 `json:"suspect_ms"`
	// DownMS 超过它即视为下线（默认 90s）。
	DownMS int64 `json:"down_ms"`
}

// DefaultClusterThresholds spec §7.4.1 的两段式阈值。
func DefaultClusterThresholds() ClusterThresholds {
	return ClusterThresholds{SuspectMS: 30000, DownMS: 90000}
}

// Validate 校验阈值关系，非法时点名变量。
//
// 关系反了（suspect ≥ down）时**拒绝启动**而不是 clamp：反了的后果是 suspect
// 状态永远不可达，而「没有可疑集群」与「一切健康」在指标上长得一模一样——
// 一个静默失效的状态机比一个起不来的进程危险得多。
func (t ClusterThresholds) Validate() error {
	// 下限 1s 直接来自铁律 19 的「严禁秒级切换」：比一秒还短的 suspect 阈值意味着
	// 一次网络抖动就能让整个集群停止接受新放置，而跨集群迁移的代价远高于等待。
	// 另外它也是 ReportInterval 的分母——suspect 小于 3ms 时派生出的自报周期是 0，
	// 那会退化成忙循环。
	if t.SuspectMS < 1000 {
		return fmt.Errorf("LUMO_CLUSTER_SUSPECT_MS 必须 ≥ 1000ms（铁律 19：严禁秒级切换），当前 %d", t.SuspectMS)
	}
	if t.DownMS <= 0 {
		return fmt.Errorf("LUMO_CLUSTER_DOWN_MS 必须为正数，当前 %d", t.DownMS)
	}
	if t.SuspectMS >= t.DownMS {
		return fmt.Errorf(
			"LUMO_CLUSTER_SUSPECT_MS(%d) 必须小于 LUMO_CLUSTER_DOWN_MS(%d)：反了会让 suspect 永远不可达，"+
				"而「没有可疑集群」与「一切健康」在指标上长得一样", t.SuspectMS, t.DownMS)
	}
	return nil
}

// ReportInterval 自报周期，由阈值派生而不是单独配置。
//
// 取 suspect/3：连丢三次自报才被判成可疑。做成可配置项会引入一个必然被配错的
// 失败模式——把周期配得比 suspect 还长，本集群就会在两次自报之间被判成可疑，
// 于是**把自己挡在放置之外**。
func (t ClusterThresholds) ReportInterval() time.Duration {
	if t.SuspectMS <= 0 {
		return 0
	}
	return time.Duration(t.SuspectMS/3) * time.Millisecond
}

// Evaluate 把年龄映射成状态（等价于 EvaluateCluster）。
func (t ClusterThresholds) Evaluate(ageMS int64) ClusterState {
	return EvaluateCluster(ageMS, t.SuspectMS, t.DownMS)
}

// MigrateEligible 该集群是否已经越过了「可以漂移它的任务」的时间线。
//
// 时间线是三段的：`suspect` 处**停止新放置**（闸门），`down + grace` 处才**漂移
// 已有任务**。grace 是 down 阈值之上的额外等待，默认非零（见 main 的
// LUMO_MIGRATE_GRACE_MS）：down 阈值只能回答「多久没自报」，回答不了「为什么
// 没自报」——集群真的挂了与**自报方重启**在这一列上完全一样，而不动手的代价
// 远低于误搬家的代价（后者会重开 attempt）。
//
// 阈值只从 t.DownMS 取，不再写一遍字面量：阈值是可配置的，抄一份会让
// 「告警/闸门/漂移」三条线各自按不同阈值动作，而它们看起来都对。
func (t ClusterThresholds) MigrateEligible(ageMS, graceMS int64) bool {
	return ageMS >= t.DownMS+graceMS
}

// ValidateMigrationGrace 校验漂移宽限期。
//
// 负数**拒绝启动**而不是 clamp 成 0：`-1` 在本仓库的约定里表示「显式关闭」
// （见 RunStallReaper 的 maxStall），但那是**循环开关**的语义，宽限期是**时间量**。
// 两个含义挤进同一个数值会让人以为「宽限=0」等于「漂移关着」——它其实是
// 「down 即漂移」，是这个功能最激进的档位。关闭走 LUMO_MIGRATE_MS 的负值。
func ValidateMigrationGrace(graceMS int64) error {
	if graceMS < 0 {
		return fmt.Errorf(
			"LUMO_MIGRATE_GRACE_MS 必须 ≥ 0（关闭漂移请用 LUMO_MIGRATE_MS 的负值），当前 %d", graceMS)
	}
	return nil
}

// ClusterEnforcement 本实例是否参与失联判定（闸门 + 集群维度指标）的生效值。
type ClusterEnforcement struct {
	// Enabled 生效值。false 时闸门恒放行、不出集群维度指标。
	Enabled bool
	// Explicit 意图是否由配置显式给出。false 表示 Enabled 是从身份派生的，
	// 只用来让启动日志说清「这个值是怎么来的」。
	Explicit bool
}

// ResolveClusterEnforcement 解析「本实例判不判别人」。
//
// 为什么要把「意图」从「身份」里拆出来：`LUMO_SCHEDULER_CLUSTER_ID` 原先一个变量承担
// 两件事——「我代表哪个集群」（身份，决定要不要自报）与「我判不判别人」（意图）。
// 在真实拓扑里这两个问题的答案不同：**一个全局调度实例服务多个集群时，它不该代表
// 其中任何一个去自报**（那是在替别人宣称存活，且它只能认领一个），但它必须判定——
// 否则集群侧报得再准也没人在看。绑在一起的结果是运维只有**撒一个谎**（随便认领一个
// 集群）才能把判定打开，而谎言一旦落进配置，注册表里就多出一行语义错误的记录
// （一个「正在自报、但它其实不归属于任何特定集群」的集群）。
//
// 与 E4/D6 同一条判据：一个开关同时承担「是不是这种部署」与「现在能不能用」时，
// 必须拆成意图 + 派生。这里 `LUMO_CLUSTER_ENFORCE` 是意图（三态：未设 / true / false），
// 未设时**按身份派生**（保住了旧的单集群用法不必改配置），生效值只此一个来源。
//
// 非法取值返回错误而不是静默当 false：一个打错字的 `LUMO_CLUSTER_ENFORCE=ture` 会
// 让判定悄悄关掉，而「判定关着」与「一切集群都健康」在面板上长得一模一样。
func ResolveClusterEnforcement(explicit string, identity string) (ClusterEnforcement, error) {
	switch strings.ToLower(strings.TrimSpace(explicit)) {
	case "":
		return ClusterEnforcement{Enabled: identity != "", Explicit: false}, nil
	case "true", "1", "yes":
		return ClusterEnforcement{Enabled: true, Explicit: true}, nil
	case "false", "0", "no":
		return ClusterEnforcement{Enabled: false, Explicit: true}, nil
	default:
		return ClusterEnforcement{}, fmt.Errorf(
			"LUMO_CLUSTER_ENFORCE 只能是 true/false（留空=由 LUMO_SCHEDULER_CLUSTER_ID 派生），当前 %q", explicit)
	}
}

// ResolveClusterSelfReport 解析「本实例是否替它的集群自报存活」。
//
// # 为什么必须把它从身份里拆出来
//
// `LUMO_SCHEDULER_CLUSTER_ID` 原本同时承担两件事：**我是本集群的本地决策者**（降级放置
// 要用它判断「本地」是什么）与**我替本集群自报存活**。Helm chart 想要的恰好是前者不要后者，
// 而两者绑死时它只能**两个都不要**——chart 里那段「刻意不设 LUMO_SCHEDULER_CLUSTER_ID」的
// 注释记的就是这个取舍：调度器活着不等于这个集群还能接放置（节点池缩到 0 时调度器照旧活着），
// 由它自报会让空集群一直显示健康。
//
// 这与 C1 那轮踩过的坑同源（当时拆的是身份与「判不判别人」），处置也相同：**一个开关承担
// 两件事时，运维只能撒一个谎**。拆开之后那个取舍就不必做了。
//
// 三态而不是「非空即真」：打错字的 `ture` 会让自报悄悄关掉或悄悄打开，而同 ResolveClusterEnforcement
// 的理由——两种错误的可见度都极低。
//
// **未设 = 由身份派生**（有身份就自报）。这条默认保住了既有拓扑的行为：compose 里那两个
// 每集群的实例不设这个变量，行为与拆开之前逐字相同。
func ResolveClusterSelfReport(explicit string, identity string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(explicit)) {
	case "":
		return identity != "", nil
	case "true", "1", "yes":
		return true, nil
	case "false", "0", "no":
		return false, nil
	default:
		return false, fmt.Errorf(
			"LUMO_CLUSTER_SELF_REPORT 只能是 true/false（留空=由 LUMO_SCHEDULER_CLUSTER_ID 派生），当前 %q", explicit)
	}
}

// ResolveVersionGate 解析版本一致性前置（§7.4.1）的生效开关。
//
// 三态（未设 / true / false）而不是「非空即真」：一个打错字的
// `LUMO_CLUSTER_VERSION_GATE=ture` 会让闸门悄悄关掉，而「闸门关着」与「版本本来
// 就一致」在观测面上长得一模一样——同 ResolveClusterEnforcement 的理由。
//
// **未设 = 关闭。** 打开它会让「有人在滚动升级」直接变成「全局任务排队」，那是产品
// 决策而不是正确性修复：一个团队可能刻意接受混合版本（比如灰度发布就是要让新旧并存），
// 那时把闸门打开反而挡住了他们想要的部署。所以它必须显式打开，而不是「有版本声明就自动生效」。
func ResolveVersionGate(explicit string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(explicit)) {
	case "", "false", "0", "no":
		return false, nil
	case "true", "1", "yes":
		return true, nil
	default:
		return false, fmt.Errorf("LUMO_CLUSTER_VERSION_GATE 只能是 true/false（留空=关闭），当前 %q", explicit)
	}
}

// EvaluateCluster 两段式判定的**纯函数**：年龄 → 状态。
//
// 区间取半开，边界归属写死在这里并由表驱动测试逐点钉住：
//
//	[0, suspect)    healthy
//	[suspect, down) suspect
//	[down, ∞)       down
//
// 负年龄按 healthy 处理：它意味着 last_seen_at 落在此刻之后（库端时钟回拨，
// 或写入方给了未来时间戳）。把「来自未来的自报」判成下线，会让一次时钟回拨
// 换掉一轮全量放置。
//
// 前置条件是阈值已过 Validate（suspect < down）。这里不再判一次：非法时不加分支
// 的后果是 suspect 不可达，而那是启动期已经被拒绝的配置，不是运行期状态。
func EvaluateCluster(ageMS, suspectMS, downMS int64) ClusterState {
	if ageMS < suspectMS {
		return ClusterHealthy
	}
	if ageMS < downMS {
		return ClusterSuspect
	}
	return ClusterDown
}

// Cluster 联邦注册表里的一条记录（附派生字段）。
type Cluster struct {
	ClusterID string `json:"cluster_id"`
	// Realm 由上报方的身份（网关注入的 X-Lumo-Realm）填写，是**写侧防跨域覆盖**的
	// 依据，不是读侧的过滤条件：集群是基础设施事实，不是租户数据，而本组端点整体
	// 在控制面令牌之后（realm 不是这里的鉴权边界，令牌才是）。
	Realm string `json:"realm"`
	// Namespace 与 Capabilities / Version 是**元数据声明**，只影响偏好与准入，
	// 不影响存活判定（存活只看 LastSeenAt）。
	Namespace    string   `json:"namespace"`
	Capabilities []string `json:"capabilities"`
	// CapabilitiesDeclared 是「这条元数据**被声明过**」的显式标记。
	//
	// 为什么必须显式：元数据列的口径是「省略即保持原值」（一个集群有多个上报方，
	// 心跳远比声明频繁），于是「声明了一个空能力集」与「根本没声明」在协议上都是
	// `capabilities` 缺席或空——**两者不可区分**。两者处置相反：前者是一个真实的
	// 约束（这个集群没有 GPU，别把要 GPU 的任务放过来），后者是「不知道」。
	// 所以标记与值分开存，值仍按「省略即保持」写，标记则**单调**（声明过就一直是
	// 声明过，心跳不会撤销它）。
	CapabilitiesDeclared bool `json:"capabilities_declared"`
	// Version 集群自报的组件版本。
	//
	// **刻意没有配套的 VersionDeclared 标记**，与 Capabilities 不对称。判据是
	// 「空值是不是一种有意义的声明」：空能力集有意义（且必须能表达），空版本号没有
	// ——「我声明我的版本是空字符串」不是一句话。于是「说没说版本」与「版本是不是
	// 空」在这里是同一件事，`Version != ""` 就是那个标记本身。
	//
	// 这个不对称是被一次真 bug 换来的：第一版按对称性也给 version 加了 declared 列，
	// 结果 `RegisterCluster(Version: "v3")`（不带标记，也就是**所有既有调用方**的写法）
	// 静默变成空操作——版本没写进去，而返回值看起来一切正常。更糟的是那一列在迁移上
	// 是 `DEFAULT false`：所有迁移前就有 version 的行会永远被判成「未声明」，而版本
	// 闸门读的正是它。冗余的字段不只是多余，它会制造一个能悄悄说「不」的第二真值源。
	Version string `json:"version"`
	// RegisteredAt 首次注册时刻（库端时钟，毫秒）。此后每次自报都不再改动它：
	// 「刚上线」与「注册了很久、一直在报」是两件不同的事。
	RegisteredAt int64 `json:"registered_at"`
	// LastSeenAt 最后一次自报时刻（库端时钟，毫秒）。
	LastSeenAt int64 `json:"last_seen_at"`
	// AgeMS 距最后一次自报的毫秒数，**由 SQL 用库端时钟算**（见 store.ClusterAges）。
	// 应用侧不做任何时钟相减：自报来自多台主机，拿读取方自己的时钟去减会引入
	// 无界偏差，产出任何测试都钉不住的 flake。
	AgeMS int64 `json:"age_ms"`
	// State 派生字段，不入库（见 ClusterState 的注释）。
	State ClusterState `json:"state"`
}

// VersionConsistency 版本一致性前置的判定结果（§7.4.1「同一 agent/组件版本先完成
// 全集群分发才允许全局调度」）。
//
// 判定集合 = **放置闸门当下真正允许的集群**（已注册、且未被存活闸门挡住）。这个
// 定义不是省事，而是唯一说得通的那个：闸门要回答的是「我现在可能把全局任务放到
// 哪些集群上，它们的版本一样吗」。一个已经 down 的集群本来就不接新放置，它的版本
// 不一致不该让全局任务停摆——否则一次失联会连带把版本闸门也点着。
type VersionConsistency struct {
	// FleetVersion 判定集合里**唯一**的声明版本；集合为空或出现多个不同版本时为空。
	FleetVersion string
	// Declared 判定集合里**声明过**版本的集群数。0 表示无人声明。
	Declared int
	// Consistent 版本是否可证明一致。
	//
	//	Declared == 0        → true（无信息：没有可比的东西）
	//	唯一版本              → true
	//	出现两个以上不同版本  → false
	//
	// 空集合取 true 是刻意的**不对称**：没有信息时闸门无从判断，拦下来等于让
	// 「没人配版本」升级成全平台停摆（同 BlocksPlacement 对 unjudged/unregistered
	// 放行的理由）。而两个版本是**互相矛盾的信息**——这时我们确实能做出判断，
	// 判断就是「不一致」，放行等于把闸门关掉。信息缺失 ≠ 信息矛盾。
	Consistent bool
}

// EvaluateVersionConsistency 计算版本一致性（纯函数，无库可测）。
//
// healthGate 参与判定是因为「判定集合 = 闸门真正允许的集群」这条定义：存活闸门
// 关着的时候，down 的集群照样能接新放置，它的版本就必须计入。把 healthGate 写成
// 常量会让「只开版本闸门、不开存活闸门」这个合法组合算错集合，而算错的方向是
// 悄悄少算一个集群——正是本设计反复要避免的静默失效。
func EvaluateVersionConsistency(clusters []Cluster, t ClusterThresholds, healthGate bool) VersionConsistency {
	versions := make(map[string]struct{}, len(clusters))
	declared := 0
	for _, c := range clusters {
		if healthGate && t.Evaluate(c.AgeMS).BlocksPlacement() {
			continue
		}
		// 空版本号不算一次版本声明。写路径（store.RegisterCluster）已经归过一次，
		// 这里再挡一次是**数据不变量**的兜底而不是配置纠正：判定侧是闸门的最后一道，
		// 放一个空版本值进来会让它成为「唯一版本」，于是所有声明了真版本的集群都被
		// 判成不一致——全局放置整片停摆，而根因只是一次字段归一漏了。
		if c.Version == "" {
			continue
		}
		declared++
		versions[c.Version] = struct{}{}
	}
	out := VersionConsistency{Declared: declared, Consistent: true}
	if len(versions) == 1 {
		for v := range versions {
			out.FleetVersion = v
		}
		return out
	}
	if len(versions) > 1 {
		out.Consistent = false
	}
	return out
}

// ClusterAnnotation 目录注解的开关与阈值。
//
// 把两个闸门做成显式开关而不是一个 bool：存活闸门与版本闸门是**两条独立的线**
// （一个拦「它可能不在了」，一个拦「它可能版本不对」），而它们共用同一份注册表读取。
// 合成一个开关会让「只想开版本闸门」的部署被迫连存活闸门一起开——那是把一个
// 部署决策偷换成另一个。
type ClusterAnnotation struct {
	Thresholds ClusterThresholds
	// HealthGate 是否按存活判定拦新放置。
	HealthGate bool
	// VersionGate 是否按版本一致性拦**全局**放置。
	VersionGate bool
}

// AnnotateClusterStates 把注册表里的集群状态与版本闸门结论填到节点上（原地修改）。
//
// 为什么状态挂在节点上而不是给放置函数加参数：EligibleNodes / Pick /
// FullEligibleNodes 共有 4 个调用点，加参数会扩散到每一处与每一份测试；而
// 「作为候选节点的当下可放置性」本来就是目录视图的一部分（与 resident、realm
// 同源），填一次即可，闸门那边只看一个字段。
//
// 注册表里没有的集群填 ClusterUnregistered，不是留空：留空与「能力关闭」不可分，
// 而这两件事的处置相反（一个去补配置，一个什么都不用做）。
func AnnotateClusterStates(nodes []Node, clusters []Cluster, a ClusterAnnotation) {
	states := make(map[string]ClusterState, len(clusters))
	versions := make(map[string]string, len(clusters))
	for _, c := range clusters {
		states[c.ClusterID] = a.Thresholds.Evaluate(c.AgeMS)
		versions[c.ClusterID] = c.Version
	}
	// 版本一致性是**集合级**结论，算一次即可；逐节点各算一次既慢又可能因为
	// 遍历顺序不同而给出不同答案。
	vc := VersionConsistency{}
	if a.VersionGate {
		vc = EvaluateVersionConsistency(clusters, a.Thresholds, a.HealthGate)
	}
	for i := range nodes {
		state, ok := states[nodes[i].ClusterID]
		if !ok {
			state = ClusterUnregistered
		}
		if !a.HealthGate {
			// 存活闸门关着时不留状态：零值 ClusterUnjudged 是「本实例没有意见」，
			// 与 ClusterUnregistered（注册表里没有它）分开说。留着真状态而不拦，
			// 会让 /v1/nodes 的读法看起来像闸门生效了。
			state = ClusterUnjudged
		}
		nodes[i].ClusterState = state
		nodes[i].ClusterVersion = versions[nodes[i].ClusterID]
		nodes[i].ClusterVersionUnproven = a.VersionGate &&
			!versionProvenForFleet(vc, versions[nodes[i].ClusterID])
	}
}

// versionProvenForFleet 该集群的版本是否可证明与 fleet 一致（纯函数）。
//
// 这是一条**事实**（这个集群能不能被证明版本对），不是一条裁决（要不要拦这个任务）：
// 裁决由 planner 做，因为只有它知道任务是不是全局的。分开的理由写在
// Node.ClusterVersionUnproven 上——实现的第一版把两者揉进字段名里，于是
// 「显式指定了 cluster_id 的放置」也被拦了。
//
// 无人声明版本时返回 true（可证明）——其实是无信息，但闸门在无信息时的方向是放行，
// 而拦下来是让「没人配 LUMO_CLUSTER_VERSION」升级成全平台无法全局放置。
//
// 版本分叉时**整体返回 false**（包括那些确实等于多数版本的集群）：这正是架构字面
// 「先完成全集群分发才允许全局调度」的意思——滚动升级进行到一半时，全局任务
// 落到哪一边都是错的一半。落在「多数版本」上看起来更聪明，但那是把一个发布流程的
// 决策偷偷换成一个调度器的启发式。
//
// **未声明版本的集群不可证明，这是与存活闸门刻意相反的一处。** 存活闸门对未知一律放行
// （unregistered / unjudged 都不拦），因为拦下来会把「注册表没配好」升级成全平台
// 停摆。版本闸门在这里 fail-closed，理由是：闸门的全部意义就是「不让全局任务落到
// 版本不确定的集群上」，而「不注册 / 不声明版本」恰恰是最容易做到的那种不确定。
// 放行它等于给闸门留一个一行配置就能绕过的后门——而绕过它的人不会觉得自己绕过了，
// 只会觉得「这个集群没配上报而已」。
//
// 两处 fail-open 与这一处 fail-closed 不矛盾，因为它们防的是不同的东西：
// 存活闸门防的是「配置问题变成全平台停摆」，版本闸门防的是「版本不确定的集群
// 混进全局放置」。前者的代价是全平台，后者的代价是单个集群被排除——而它随时可以
// 靠声明版本、显式指定 cluster_id、或关掉闸门回来。
//
// 空版本（`version == ""`）就是「未声明」，不需要额外的标记：见 Cluster.Version 上
// 关于「为什么 version 没有 declared 标记」的注释。
func versionProvenForFleet(vc VersionConsistency, version string) bool {
	if vc.Declared == 0 {
		return true
	}
	if !vc.Consistent {
		return false
	}
	// vc.FleetVersion 在 Declared > 0 时必然非空，所以这里不必再判一次「非空」。
	return version == vc.FleetVersion
}
