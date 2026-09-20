package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
)

// 承载节点失联的判定与上报（§24.2.3(4) 信号链的**上报腿**）。
//
// ## 为什么是「两段式」而不是一个超时值
//
// §7.4.1（铁律 19）对整条平台只有一个口径：失联先入 `suspect`（30s，**停止向其新放置，
// 已有工作不动**），持续失联再入 `down`（90s）才允许判定为不可恢复。理由在设计说明里写得
// 很直白：跨节点迁移的代价远高于等待，秒级阈值会让一次网络抖动触发全量任务大迁移，
// 反而制造故障。**线程比任务更贵**——线程的现场（工作目录、PTY、进程）随节点消失且不迁移，
// 所以这里的阈值只会更保守，不会更激进。
//
// 阈值与 `control-plane/scheduler/internal/domain.DefaultClusterThresholds()` **同源**
// （30s/90s）：那边判的是集群，这边判的是节点，但两个判定描述的是同一个物理现象，
// 各自维护一套数字必然在某个夜里分叉，而分叉的表现是「调度器认为集群还在，线程却已经被
// 判死」——两边的日志都对，现场无从下手。
//
// ## 本包只给结论，不做动作
//
// `EvaluateNode` 是纯函数（阈值与年龄进、状态出），因此「多老算失联」这件事可以逐条测边界，
// 而不必起一个集群。**上报**（`NodeLossReporter`）只把结论交给调用方提供的 sink；
// 「重不重派」不在本包、也不在协作服务里——那是协调者的判断（§7.1 R2：不可恢复 ≠ 可重试，
// 两件事分开）。

// NodeState 承载节点的存活档位（闭集）。三段半开区间，见 EvaluateNode。
type NodeState string

const (
	// NodeHealthy 最近一次自报在可疑阈值之内。
	NodeHealthy NodeState = "healthy"
	// NodeSuspect 超过可疑阈值、未到确认阈值。**只停止新放置，已有线程不动**（§7.4.1）。
	NodeSuspect NodeState = "suspect"
	// NodeDown 超过确认阈值。此时才允许认定现场已消失，线程转入 failed 并等待协调者决定重派。
	NodeDown NodeState = "down"
)

// NodeStates 闭集的有序快照（错误信息与测试共用，避免两处手抄）。
var NodeStates = []NodeState{NodeHealthy, NodeSuspect, NodeDown}

// 默认阈值。取值与 scheduler 的 DefaultClusterThresholds() 逐字一致，理由见文件头。
const (
	// DefaultSuspectAfter 距最后一次自报超过它即视为可疑（30s）。
	DefaultSuspectAfter = 30 * time.Second
	// DefaultDownAfter 距最后一次自报超过它才允许判定失联（90s）。
	DefaultDownAfter = 90 * time.Second
	// DefaultNodeService 节点在心跳表里上报时使用的 service 名。
	//
	// 承载节点（dsh-node）以这个 service 名自报，`instance` 就是 `threads.node_id` ——
	// 线程行里的 node_id 与心跳行里的 instance 是**同一个标识**，正因为如此，本包不需要
	// 任何映射表：判定失联的标识可以直接拿去问协作服务「这个节点上有哪些线程」。
	DefaultNodeService = "dsh-node"
)

// NodeLiveness 一个节点的存活判定结果（结论 + 可读理由）。
type NodeLiveness struct {
	NodeID string
	State  NodeState
	// Age 距最后一次自报的时长（由**库端时钟**算出，见包注释：多处主机上报，跨机比较
	// 本地时钟的偏差无界，会让判定结果无法复现）。
	Age time.Duration
	// Reason 供上报与看板引用。
	Reason string
}

// ValidateNodeThresholds 阈值自证。
//
// 两条拒绝各自的理由（与 scheduler 的同名校验逐条同源）：
//
//   - **suspect 不得小于 1s**：铁律 19 明文「严禁秒级切换」。比一秒还短的阈值意味着一次
//     正常的 GC 停顿或网络重传就能让一个健康节点被判可疑。
//   - **suspect 必须小于 down**：反了会让 `suspect` **永远不可达**，于是「没有任何节点可疑」
//     与「全部节点都到了 down 阈值边缘」在指标上长得一样——而这两件事的处置完全相反。
func ValidateNodeThresholds(suspectAfter, downAfter time.Duration) error {
	if suspectAfter < time.Second {
		return fmt.Errorf("心跳：可疑阈值必须 >= 1s（铁律 19：严禁秒级切换），当前 %s", suspectAfter)
	}
	if suspectAfter >= downAfter {
		return fmt.Errorf("心跳：可疑阈值(%s)必须小于确认阈值(%s)：反了会让 suspect 永远不可达，"+
			"而「没有可疑节点」与「一切健康」在指标上无法区分", suspectAfter, downAfter)
	}
	return nil
}

// EvaluateNode 单节点的存活判定（纯函数，边界可逐条测）。
//
// 时间线是三段的半开区间（与 scheduler 的 `EvaluateCluster` 同款）：
//
//	[0, suspect)         healthy
//	[suspect, down)       suspect —— 只挡新放置
//	[down, ∞)             down    —— 现场认定已消失
//
// # 两处刻意「不判 down」的输入
//
//   - **年龄为负**（库端 `now()` 早于 `observed_at`，只可能来自手工写入或时钟回拨）：
//     拿不到一个像样的判定时，本函数既不说它健康（会让看板说它还在），也不说它 down
//     （会终止一条其实还在跑的线程）—— `suspect` 是唯一安全的档：它只影响新放置，不动现场。
//   - **阈值不合法**（`suspectAfter <= 0` 或 `suspectAfter >= downAfter`）：一个配错的阈值
//     （例如 down 小于 suspect）会让**所有节点同时被判失联**，一次配置错误就终止全集群的线程。
//     启动期由 `ValidateNodeThresholds` 拒绝，这里是运行期的第二道闸。
func EvaluateNode(nodeID string, age, suspectAfter, downAfter time.Duration) NodeLiveness {
	node := NodeLiveness{NodeID: nodeID, Age: age}
	if suspectAfter <= 0 || downAfter <= 0 || suspectAfter >= downAfter {
		node.State = NodeSuspect
		node.Reason = fmt.Sprintf("阈值不合法（可疑 %s / 确认 %s）：无法判定，按可疑处理（不动已有线程）",
			suspectAfter, downAfter)
		return node
	}
	switch {
	case age < 0:
		node.State = NodeSuspect
		node.Reason = fmt.Sprintf("最近一次自报的时间在库端时钟之后（%s）：无法判定，按可疑处理", age)
	case age < suspectAfter:
		node.State = NodeHealthy
		node.Reason = fmt.Sprintf("距最后一次自报 %s（可疑阈值 %s）", roundDuration(age), roundDuration(suspectAfter))
	case age < downAfter:
		node.State = NodeSuspect
		node.Reason = fmt.Sprintf("距最后一次自报 %s，已超过可疑阈值 %s：停止向其新放置，"+
			"但已有线程不动（§7.4.1：跨节点迁移的代价远高于等待）", roundDuration(age), roundDuration(suspectAfter))
	default:
		node.State = NodeDown
		node.Reason = fmt.Sprintf("距最后一次自报 %s，已超过确认阈值 %s：承载其上的线程现场已消失"+
			"（工作目录不迁移），线程转入 failed 并交给协调者决定是否重派新 Run",
			roundDuration(age), roundDuration(downAfter))
	}
	return node
}

// EvaluateNodes 从心跳行里筛出节点行并逐个判定（结果按 node_id 排序，便于测试与日志比对）。
//
// `service` 为空时取 `DefaultNodeService`：节点行与控面服务的行**同一张表**，用 service 名
// 区分。混在一起判会有一个极坏的后果——某个控面服务重启（`stopping` + 过期）会被当成
// 「承载节点失联」，于是它上面**根本没有**线程的节点名被拿去上报，而真正失联的节点没人报。
func EvaluateNodes(rows []Heartbeat, service string, suspectAfter, downAfter time.Duration) []NodeLiveness {
	if strings.TrimSpace(service) == "" {
		service = DefaultNodeService
	}
	out := make([]NodeLiveness, 0, 8)
	for _, row := range rows {
		if row.Service != service {
			continue
		}
		out = append(out, EvaluateNode(row.Instance, row.Age, suspectAfter, downAfter))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NodeID < out[j].NodeID })
	return out
}

// NodeLossReceipt 一次上报的结果（由协作服务返回）。
type NodeLossReceipt struct {
	// Failed 本次真的被终止（转 failed）的线程数。
	Failed int `json:"failed"`
	// Ignored 本来就已终态、被幂等忽略的线程数。
	Ignored int `json:"ignored"`
}

// NodeLossSink 上报的出口。由调用方提供实现（生产是协作服务的 HTTP 客户端，
// 测试用一个记录调用的假实现）。
//
// 为什么是「按节点」而不是「按线程」：上报方手里只有**节点**这个事实——它无从知道该节点
// 上此刻挂着哪些线程。硬要它先列出线程再逐个上报，等于把「谁在哪台机器上」这份真相复制到
// 第二个地方，而两份清单之间的时间差里漏掉的线程会永远停在 running。
type NodeLossSink interface {
	ReportNodeLoss(ctx context.Context, nodeID, reason string) (NodeLossReceipt, error)
}

// CollaboratorSinkOptions 协作服务上报客户端的配置。
type CollaboratorSinkOptions struct {
	// BaseURL 协作服务基址（`control-plane/collaborator`）。必填。
	BaseURL string
	// Realm 与 UserID 走请求头（协作服务**不接受**请求体里的 realm：一个能自报 realm 的
	// 写入口等于没有租户边界）。生产由边缘网关注入，这里由配置给出——因此一个上报器
	// **只服务一个 realm**；多 realm 部署要按 realm 各起一个（如实登记在报告里）。
	Realm  string
	UserID string
	// HTTPClient 可注入（测试用）。缺省 `http.DefaultClient`。
	HTTPClient *http.Client
	// Timeout 单次上报的上限。缺省 5s。
	Timeout time.Duration
}

// CollaboratorSink 把节点失联上报到协作服务（`threads` 的唯一写入方）。
type CollaboratorSink struct {
	opts   CollaboratorSinkOptions
	client *http.Client
}

// NewCollaboratorSink 构造上报客户端；配置不全即报错（缺了它上报只会 401，而 401 在日志里
// 看起来像「协作服务出问题了」）。
func NewCollaboratorSink(opts CollaboratorSinkOptions) (*CollaboratorSink, error) {
	base := strings.TrimSpace(opts.BaseURL)
	if base == "" {
		return nil, fmt.Errorf("心跳：节点失联上报缺少协作服务地址")
	}
	if strings.TrimSpace(opts.Realm) == "" || strings.TrimSpace(opts.UserID) == "" {
		return nil, fmt.Errorf("心跳：节点失联上报必须给出 realm 与调用者身份（协作服务按请求头授权）")
	}
	client := opts.HTTPClient
	if client == nil {
		timeout := opts.Timeout
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		client = &http.Client{Timeout: timeout}
	}
	opts.BaseURL = strings.TrimRight(base, "/")
	return &CollaboratorSink{opts: opts, client: client}, nil
}

// ReportNodeLoss 上报一个节点失联（幂等：协作服务对已终态的线程是空操作）。
func (s *CollaboratorSink) ReportNodeLoss(ctx context.Context, nodeID, _ string) (NodeLossReceipt, error) {
	body, err := json.Marshal(map[string]string{"node_id": nodeID})
	if err != nil {
		return NodeLossReceipt{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.BaseURL+"/threads/node-loss", bytes.NewReader(body))
	if err != nil {
		return NodeLossReceipt{}, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-lumo-user", s.opts.UserID)
	request.Header.Set("x-lumo-realm", s.opts.Realm)
	response, err := s.client.Do(request)
	if err != nil {
		return NodeLossReceipt{}, fmt.Errorf("心跳：上报节点 %s 失联失败: %w", nodeID, err)
	}
	defer func() { _ = response.Body.Close() }()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode != http.StatusOK {
		return NodeLossReceipt{}, fmt.Errorf("心跳：上报节点 %s 失联失败: HTTP %d: %s",
			nodeID, response.StatusCode, strings.TrimSpace(string(payload)))
	}
	var decoded struct {
		Failed  []json.RawMessage `json:"failed"`
		Ignored []json.RawMessage `json:"ignored"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return NodeLossReceipt{}, fmt.Errorf("心跳：上报节点 %s 失联的返回体无法解析: %w", nodeID, err)
	}
	return NodeLossReceipt{Failed: len(decoded.Failed), Ignored: len(decoded.Ignored)}, nil
}

// NodeLossReporterOptions 上报器的配置。
type NodeLossReporterOptions struct {
	// Sink 上报出口。必填——没有它这个判定就只能写日志。
	Sink NodeLossSink
	// Service 节点在心跳表里的 service 名。缺省 DefaultNodeService。
	Service string
	// SuspectAfter / DownAfter 两段式阈值。缺省 30s / 90s。
	SuspectAfter time.Duration
	DownAfter    time.Duration
	Logger       *slog.Logger
}

// NodeLossReporter 把「判定为 down」的节点上报一次（**只在转入 down 的那一次**）。
//
// # 为什么必须去重
//
// §7.1 的原话是「**绝不无限重投**：把『不可恢复』误判成『可重试』会放大外部副作用」。
// 节点失联是**至少一次投递**的事实：一个节点会持续满足 down 条件很多轮，每轮都上报一次
// 就是拿同一件事反复敲协作服务——而每敲一次都会在通知表里留下一行（去重靠唯一索引挡住），
// 上报量却随掉线时长线性增长。所以口径定成：**转入 down 时上报一次**，节点重新自报
// （回到 healthy / suspect）后清掉标记，下次再掉线才重新上报。
//
// # 上报失败不标记为已上报
//
// 失败（协作服务不可达、401、5xx）时必须**保留重试**：否则一次网络抖动会让这台机器上的
// 线程**永远**停在 running —— 没有任何人再想起它们，而系统看起来一切正常（正是本设计要
// 消灭的形状）。因此标记只在成功后落下。
type NodeLossReporter struct {
	opts     NodeLossReporterOptions
	log      *slog.Logger
	reported map[string]bool
}

// NodeLossReport 一轮上报的账（进日志与指标）。
type NodeLossReport struct {
	// Down 本轮判定为 down 的节点（含已上报过的）。
	Down []string `json:"down"`
	// Reported 本轮**真的上报成功**的节点（只在转入 down 的那一次）。
	Reported []string `json:"reported"`
	// Retried 本轮上报失败、留待下一轮的节点。
	Retried []string `json:"retried"`
	// Recovered 本轮从 down 回到健康/可疑的节点（去重标记已清掉）。
	Recovered []string `json:"recovered"`
}

// NewNodeLossReporter 构造上报器。`Sink` 缺失即报错：一个不接出口的判定器只会安静地
// 什么都不做，而「什么都没做」与「一切都好」在监控上是一样的。
func NewNodeLossReporter(opts NodeLossReporterOptions) (*NodeLossReporter, error) {
	if opts.Sink == nil {
		return nil, fmt.Errorf("心跳：节点失联上报器缺少上报出口（sink）")
	}
	if strings.TrimSpace(opts.Service) == "" {
		opts.Service = DefaultNodeService
	}
	if opts.SuspectAfter <= 0 {
		opts.SuspectAfter = DefaultSuspectAfter
	}
	if opts.DownAfter <= 0 {
		opts.DownAfter = DefaultDownAfter
	}
	if err := ValidateNodeThresholds(opts.SuspectAfter, opts.DownAfter); err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &NodeLossReporter{opts: opts, log: log, reported: map[string]bool{}}, nil
}

// ReportOnce 判定一轮并按需要上报。ctx 取消时停止（未上报的节点留待下一轮）。
func (r *NodeLossReporter) ReportOnce(ctx context.Context, rows []Heartbeat) NodeLossReport {
	report := NodeLossReport{Down: []string{}, Reported: []string{}, Retried: []string{}, Recovered: []string{}}
	alive := make(map[string]bool, len(rows))
	for _, node := range EvaluateNodes(rows, r.opts.Service, r.opts.SuspectAfter, r.opts.DownAfter) {
		alive[node.NodeID] = true
		if node.State != NodeDown {
			if r.reported[node.NodeID] {
				// 节点回来了：清掉标记，下次再掉线要能再报一次（否则一台机器只能被报告一次失联，
				// 而真实世界里它会掉第二次）。
				delete(r.reported, node.NodeID)
				report.Recovered = append(report.Recovered, node.NodeID)
			}
			continue
		}
		report.Down = append(report.Down, node.NodeID)
		if r.reported[node.NodeID] {
			// 已报过，这一轮静默（绝不无限重投）。
			continue
		}
		if ctx.Err() != nil {
			report.Retried = append(report.Retried, node.NodeID)
			continue
		}
		receipt, err := r.opts.Sink.ReportNodeLoss(ctx, node.NodeID, node.Reason)
		if err != nil {
			// 失败**不**落下标记：留待下一轮重试。一次抖动不该让线程永远停在 running。
			r.log.Warn("上报节点失联失败，下一轮重试",
				"node", node.NodeID, "age", roundDuration(node.Age), "err", err)
			report.Retried = append(report.Retried, node.NodeID)
			continue
		}
		r.reported[node.NodeID] = true
		report.Reported = append(report.Reported, node.NodeID)
		r.log.Info("节点失联已上报",
			"node", node.NodeID, "age", roundDuration(node.Age),
			"threads_failed", receipt.Failed, "threads_already_terminal", receipt.Ignored)
	}
	// 从心跳表里整个消失的节点（行被清理）：不清标记会在内存里留下一条永不回收的条目；
	// 但它也**不**触发上报——没有行就没有年龄，没有年龄就不能判定（fail-safe，见 EvaluateNode）。
	for nodeID := range r.reported {
		if !alive[nodeID] {
			delete(r.reported, nodeID)
		}
	}
	return report
}

// RunNodeLossLoop 按间隔读心跳、判定并上报，直到 ctx 取消。
//
// 读的是**心跳表**而不是别的服务的私有表：判定年龄必须来自同一个时钟源（库端 `now()`），
// 而心跳表就是平台里唯一一处「谁还活着」的权威记录。
func RunNodeLossLoop(ctx context.Context, reader Reader, reporter *NodeLossReporter, interval time.Duration, log *slog.Logger) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	if log == nil {
		log = slog.Default()
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		queryCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
		rows, err := ReadAll(queryCtx, reader)
		cancel()
		if err != nil {
			// 读不到心跳时**不上报任何节点**：把「读不到」当成「全都失联」，一次数据库抖动
			// 就会终止全集群的线程。这正是两段式要挡的那类反应。
			if ctx.Err() == nil {
				log.Warn("节点失联判定跳过：读取心跳失败", "err", err)
			}
			continue
		}
		reporter.ReportOnce(ctx, rows)
	}
}
