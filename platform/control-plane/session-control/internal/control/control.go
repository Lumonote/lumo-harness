// Package control 是共享执行控制的**裁决器**（§8.4.2）：一条控制指令在这里走完
//
//	排队 → 鉴权（OPA）→ 状态机 → 落库（含审计）→ 下发
//
// 并产出一个可审计、可解释的结论。
//
// # 五层各自的职责（不要互相代劳）
//
//   - internal/queue：本实例内的顺序（同一会话同时只有一条脉冲在生效）。
//   - internal/policy：**唯一**的授权点。任何指令生效前都必须过它；引擎不可用即拒绝
//     （fail-closed），而不是放行。
//   - internal/state：跃迁合法性。控制台读面复用同一个 Apply，因此「按钮可点」与
//     「提交后被接受」不可能漂移。
//   - internal/store：跨实例仲裁（行锁 + revision 比较后交换）。
//   - 本包：把上面五件事按顺序串起来，并决定「哪一步的结论进审计、哪一步不进」。
//
// # 先落库、再下发（顺序是有意的）
//
// 生效的控制事件要送到真正执行该会话的地方（§8.1 的 suspend / `agent.inject()`）。
// 本包**先提交状态与审计，再调用 Dispatcher**。两种顺序各有代价，选这个是因为代价
// 不对称：
//
//   - 先下发后落库：下发成功而落库失败 → 会话真的被暂停了，控制面却一无所知，
//     审计里没有这条；之后谁都无法从记录里回答「谁暂停了它」。
//   - 先落库后下发：落库成功而下发失败 → 状态行说 paused 而会话还在跑。这是**可见、
//     可重试、可对账**的差异：响应里带 `effectuation=recorded` 与 `dispatch_error`，
//     指标计数，巡检能列出所有「记了没生效」的会话。
//
// 换句话说：宁可留下「记了但没做到」，也不要「做到了但没记」。前者是对账问题，
// 后者是审计问题。
//
// # 不下发也不假装下发
//
// 未配置 Dispatcher 时（本服务当前就是这样，见 cmd/session-control 的启动日志），
// 响应里的 `effectuation` 恒为 `recorded`：状态与审计是真的，会话执行面的暂停尚未
// 接线。**不允许**在这里回落成「已下发」——那会让控制台显示一个没人执行过的动作。
package control

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/lumo-harness/platform/session-control/internal/policy"
	"github.com/lumo-harness/platform/session-control/internal/queue"
	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

// EventType 是控制指令在复制式 SessionEvent 日志里的事件类型（§8.4.2）。
const EventType = "session/control"

// Effectuation 说明一条已生效的指令**实际做到哪一步**。
type Effectuation string

const (
	// EffectuationRecorded 只落了状态与审计，尚未下发到会话执行面。
	EffectuationRecorded Effectuation = "recorded"
	// EffectuationDispatched 已下发且下发成功。
	EffectuationDispatched Effectuation = "dispatched"
)

// Outcome 是一条控制指令的结论分类。读面按它选 HTTP 状态码，审计按它入库。
//
// 分成这么多种而不是「成功/失败」二分，是因为调用方的处置完全不同：
// `policy_denied` 要找管理员、`policy_unavailable` 要去看 OPA、`busy` 要重试、
// `conflict` 要重读、`state_rejected` 要去看当前状态。合成一个 403「控制失败」
// 会让这五种现场全部指向同一个错误的地方。
type Outcome string

const (
	// OutcomeApplied 状态确实变了。
	OutcomeApplied Outcome = "applied"
	// OutcomeNoOp 合法但没有任何副作用（终态的重复指令、挂起态重复 pause）。
	// 它不是失败：重复点击不该报错，但控制台要能显示「这次点击没改变什么」。
	OutcomeNoOp Outcome = "noop"
	// OutcomeStateRejected 状态机判否（例如 awaiting-approval 期间不接受 pause）。
	OutcomeStateRejected Outcome = "state_rejected"
	// OutcomePolicyDenied 策略引擎正常工作并判定不允许（永久：要找授权）。
	OutcomePolicyDenied Outcome = "policy_denied"
	// OutcomePolicyUnavailable 拿不到策略判定（临时：要去看 OPA）。
	OutcomePolicyUnavailable Outcome = "policy_unavailable"
	// OutcomeRealmMismatch 该会话的控制权已由另一个 realm 确立。
	OutcomeRealmMismatch Outcome = "realm_mismatch"
	// OutcomeConflict 重读重试若干次后，版本仍被并发变更。
	OutcomeConflict Outcome = "conflict"
	// OutcomeBusy 同一会话上已有别的脉冲在生效中，等待超时。
	OutcomeBusy Outcome = "busy"
)

// Authorizer 是授权入口（消费方定义接口，实现见 internal/policy）。
type Authorizer interface {
	Authorize(ctx context.Context, req policy.Request) (policy.Decision, error)
}

// StateStore 是状态与审计的落点（消费方定义接口，实现见 internal/store）。
//
// 只用两个方法而不是把 store.Store 整个拿进来：本包能对状态与审计做的事**只有**
// 「读一行」与「提交一次裁决」，接口宽了就会有地方绕过 CAS 直接写。
type StateStore interface {
	Load(ctx context.Context, sessionRef string) (store.Row, error)
	Commit(ctx context.Context, in store.Commit) (store.CommitResult, error)
}

// Event 是 §8.4.2 的 `session/control` 载荷。
type Event struct {
	Type          string        `json:"type"`
	SessionRef    string        `json:"sessionRef"`
	Command       state.Command `json:"command"`
	FromState     state.State   `json:"fromState"`
	ToState       state.State   `json:"toState"`
	Actor         string        `json:"actor"`
	Role          string        `json:"role"`
	Realm         string        `json:"realm"`
	Reason        string        `json:"reason,omitempty"`
	CorrelationID string        `json:"correlationId"`
	Revision      int64         `json:"revision"`
	NoOp          bool          `json:"noOp,omitempty"`
	At            time.Time     `json:"at"`
}

// Dispatcher 把已生效的控制事件送到会话执行面。nil 表示未接线（只记录，见包注释）。
type Dispatcher interface {
	Dispatch(ctx context.Context, ev Event) error
}

// Request 是一次控制请求。身份三件套（Realm/Role/Actor）都是**必填**：
// OPA 的策略以它们为判据，缺一个就等于没有主体，而「没有主体」不该有任何控制权。
type Request struct {
	SessionRef    string
	Command       state.Command
	Realm         string
	Role          string
	Actor         string
	Reason        string
	CorrelationID string
}

// Result 是一条控制指令的完整结论（HTTP 响应体就是它）。
type Result struct {
	SessionRef   string        `json:"session_ref"`
	Command      state.Command `json:"command"`
	Outcome      Outcome       `json:"outcome"`
	Reason       string        `json:"reason,omitempty"`
	Registered   bool          `json:"registered"`
	FromState    state.State   `json:"from_state"`
	ToState      state.State   `json:"to_state"`
	NoOp         bool          `json:"no_op"`
	Revision     int64         `json:"revision"`
	AuditID      int64         `json:"audit_id,omitempty"`
	Effectuation Effectuation  `json:"effectuation"`
	// DispatchError 只在「记了但没做到」时出现（见包注释的顺序取舍）。
	DispatchError string `json:"dispatch_error,omitempty"`
	// Queued / WaitedMS 说明这条指令在本实例的队列里排了多久。它要能看出来：
	// 「生效了，但等了 2 秒」与「立刻生效」是两种不同的现场。
	Queued        bool   `json:"queued"`
	WaitedMS      int64  `json:"waited_ms"`
	Attempts      int    `json:"attempts"`
	CorrelationID string `json:"correlation_id"`
}

// Options 装配裁决器。
type Options struct {
	Store StateStore
	Auth  Authorizer
	// Queue 为 nil 时不做进程内排队——**只允许测试这样用**：生产上漏配它等于
	// 放弃了「同一会话同时只有一条脉冲」的约束。New 会因此 panic（见下）。
	Queue      *queue.Manager
	Dispatcher Dispatcher
	Logger     *slog.Logger
	// MaxAttempts 是 CAS 冲突后的重读重试上限。<=0 取 3。
	MaxAttempts int
	// Now 便于测试注入时钟；nil 用 time.Now。
	Now func() time.Time
}

// Controller 是裁决器。
type Controller struct {
	opts Options
	log  *slog.Logger
}

// New 构造裁决器。Queue 缺失时 panic：那是装配错误，不是运行时状况——让它安静地
// 退化成「没有排队约束」等于把并发丢更新悄悄放回生产。
func New(opts Options) *Controller {
	if opts.Queue == nil {
		panic("control: 必须提供 queue.Manager（缺它等于放弃同会话串行化）")
	}
	if opts.Store == nil || opts.Auth == nil {
		panic("control: 必须提供 Store 与 Auth")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = 3
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Controller{opts: opts, log: opts.Logger}
}

// ErrInvalidRequest 是请求本身不合法（缺字段、未知指令）。它不是裁决结论，
// 因此不入审计：没有任何主体提出过一条可识别的控制指令。
var ErrInvalidRequest = errors.New("控制请求不合法")

// Execute 裁决一条控制指令。
//
// 返回值语义（调用方必须分清）：
//   - (Result, nil)：**拿到了结论**——包括被拒、被挤掉、版本冲突。按 Outcome 处置。
//   - (Result{}, err)：**没拿到结论**（存储/队列基础设施失败、请求非法）。
func (c *Controller) Execute(ctx context.Context, req Request) (Result, error) {
	if err := req.validate(); err != nil {
		return Result{}, err
	}
	if req.CorrelationID == "" {
		req.CorrelationID = newCorrelationID()
	}

	grant, err := c.opts.Queue.Acquire(ctx, req.SessionRef, req.CorrelationID, req.Command)
	if err != nil {
		var busy *queue.BusyError
		if errors.As(err, &busy) {
			// 没轮到的尝试也进审计：审计要回答的是「谁想对某会话做什么、结果如何」，
			// 把被挤掉的尝试排除在外，会让「有人在猛点按钮」从记录里消失。
			res := Result{
				SessionRef: req.SessionRef, Command: req.Command, Outcome: OutcomeBusy,
				Reason: busy.Error(), Effectuation: EffectuationRecorded,
				CorrelationID: req.CorrelationID, Attempts: 0,
			}
			c.recordVerdict(ctx, req, res.Outcome, res.Reason)
			return res, nil
		}
		return Result{}, err
	}
	defer grant.Release()

	res := Result{
		SessionRef: req.SessionRef, Command: req.Command, Registered: true,
		Queued: grant.Queued(), WaitedMS: grant.Waited().Milliseconds(),
		Effectuation: EffectuationRecorded, CorrelationID: req.CorrelationID,
	}

	for attempt := 1; attempt <= c.opts.MaxAttempts; attempt++ {
		res.Attempts = attempt

		row, registered, err := c.load(ctx, req)
		if err != nil {
			return Result{}, err
		}
		base := row.State
		res.Registered = registered
		res.FromState = base
		res.ToState = base
		res.Revision = row.Revision

		v := c.decide(ctx, req, row, registered)
		res.Outcome = v.outcome
		res.Reason = v.reason

		if !v.auditable {
			// 越权尝试：结论是「拒绝」，但不写审计表（理由见 decide 的注释）。
			// 它必须留下痕迹，因此走日志与指标两条路。
			c.log.Warn("控制指令跨 realm 被拒",
				"session", req.SessionRef, "command", req.Command,
				"sessionRealm", row.Realm, "actorRealm", req.Realm,
				"actor", req.Actor, "role", req.Role,
				"correlationId", req.CorrelationID)
			ObserveOutcome(v.outcome, req.Command)
			return res, nil
		}

		cr, err := c.opts.Store.Commit(ctx, store.Commit{
			SessionRef: req.SessionRef, Realm: req.Realm,
			Actor: req.Actor, ActorRole: req.Role,
			Command: req.Command, ExpectedRevision: row.Revision,
			ChangeState: v.change, ToState: v.toState,
			Outcome: string(v.outcome), Reason: v.reason,
			FromState: base, CorrelationID: req.CorrelationID,
		})
		switch {
		case errors.Is(err, store.ErrConflict):
			// 前提过期：重读、重新裁决、再提交。这条指令本身可能仍然合法，
			// 所以不能把它变成失败返回给用户。
			c.log.Info("控制指令遇到并发变更，重读重试",
				"session", req.SessionRef, "command", req.Command, "attempt", attempt)
			continue
		case errors.Is(err, store.ErrRealmMismatch):
			// 极小窗口：我们读过之后、提交之前，有别的 realm 把这一行建立了。
			res.Outcome = OutcomeRealmMismatch
			res.Reason = store.ErrRealmMismatch.Error()
			c.log.Warn("控制指令跨 realm 被拒（提交期发现）",
				"session", req.SessionRef, "actorRealm", req.Realm,
				"correlationId", req.CorrelationID)
			ObserveOutcome(res.Outcome, req.Command)
			return res, nil
		case err != nil:
			return Result{}, err
		}

		res.ToState = cr.Row.State
		res.Revision = cr.Row.Revision
		// 提交成功即意味着状态行已存在（变更路径会建行），读面的 registered 与此一致。
		res.Registered = true
		res.AuditID = cr.AuditID
		res.NoOp = v.noOp
		ObserveOutcome(v.outcome, req.Command)

		// 下发：只在真的有副作用时做。noop / 被拒 / 版本冲突都不是「要别人做事」。
		if v.change {
			c.dispatch(ctx, req, &res, v)
		}
		return res, nil
	}

	// 重试用尽。这条结论仍然要入审计：它解释了「为什么这次没生效」。
	res.Outcome = OutcomeConflict
	res.Reason = fmt.Sprintf("重读重试 %d 次后版本仍被并发变更", c.opts.MaxAttempts)
	c.recordVerdict(ctx, req, res.Outcome, res.Reason)
	ObserveOutcome(res.Outcome, req.Command)
	return res, nil
}

// verdict 是一次裁决的内部结果：结论 + 要不要改状态 + 要不要入审计。
type verdict struct {
	outcome Outcome
	reason  string
	toState state.State
	// change 为 true 表示状态确实要变（对应 store.Commit.ChangeState）。
	change bool
	noOp   bool
	// auditable 为 false 时结论不入审计表（目前只有跨 realm 越权一种）。
	auditable bool
}

// decide 依据当前状态给出结论。它**没有副作用**（除了对 OPA 的调用），因此可以在
// CAS 冲突后反复调用；落库由调用方在拿到 revision 之后做。
func (c *Controller) decide(ctx context.Context, req Request, row store.Row, registered bool) verdict {
	// 隔离先于授权：realm 是首要隔离边界，一个 realm 的调用方连「这条指令是否被
	// 允许」都不该问出来。放在 OPA 之前也让跨 realm 的尝试不消耗策略引擎。
	if registered && row.Realm != req.Realm {
		return verdict{
			outcome: OutcomeRealmMismatch,
			reason: fmt.Sprintf("该会话的控制权已由 realm %q 确立，%q 无权控制",
				row.Realm, req.Realm),
			// 不入审计：审计行属于会话的 realm，而写审计行要先能操作该会话的行。
			// 为「记下越权尝试」给隔离检查开后门，会让**唯一**守住 realm 边界的
			// 地方变成可选的；越权尝试改由 WARN 日志与 realm_mismatch 指标留痕。
			auditable: false,
		}
	}

	dec, err := c.opts.Auth.Authorize(ctx, policy.Request{
		// policy 包不认识 state.Command（依赖方向：状态机是纯内层，策略是与 OPA 的
		// 边界）。在这里显式转成字符串，而不是让 policy 反向 import state。
		Command: string(req.Command), SessionRef: req.SessionRef,
		Principal: policy.Principal{Realm: req.Realm, Role: req.Role, Subject: req.Actor},
		Reason:    req.Reason, CorrelationID: req.CorrelationID,
	})
	if err != nil {
		// 拿不到判定 ≠ 判定为否。两者都要拒，但原因不同、处置不同（见 internal/policy），
		// 所以审计里也必须是两个不同的结论值。
		return verdict{outcome: OutcomePolicyUnavailable, reason: err.Error(), auditable: true}
	}
	if !dec.Allowed {
		return verdict{outcome: OutcomePolicyDenied, reason: dec.Reason, auditable: true}
	}

	out := state.Apply(row.State, req.Command)
	if !out.OK {
		return verdict{outcome: OutcomeStateRejected, reason: out.Reason, auditable: true}
	}
	if out.NoOp {
		return verdict{outcome: OutcomeNoOp, reason: "指令合法但没有副作用", auditable: true, noOp: true}
	}
	return verdict{
		outcome: OutcomeApplied, toState: out.Next, change: true, auditable: true,
	}
}

// load 读状态行。未登记返回初始化状态（running, revision 0）并 registered=false
// ——**不是**把 running 当成事实上报，而是声明「首条指令将以它为起点」。
func (c *Controller) load(ctx context.Context, req Request) (store.Row, bool, error) {
	row, err := c.opts.Store.Load(ctx, req.SessionRef)
	if err == nil {
		return row, true, nil
	}
	if errors.Is(err, store.ErrNotFound) {
		return store.Row{
			SessionRef: req.SessionRef, Realm: req.Realm,
			State: InitialState, Revision: 0,
		}, false, nil
	}
	return store.Row{}, false, err
}

// InitialState 是未登记会话的起点（首条控制指令把它建立为这个状态）。
// 与 store 的建行默认值必须是同一个值——它是「未登记时控制器看到的状态」。
const InitialState = state.StateRunning

// dispatch 下发已生效的控制事件。失败**不**回滚状态：见包注释的顺序取舍——
// 记了但没做到是可对账的，做到但没记是不可审的。
func (c *Controller) dispatch(ctx context.Context, req Request, res *Result, v verdict) {
	if c.opts.Dispatcher == nil {
		return
	}
	ev := Event{
		Type: EventType, SessionRef: req.SessionRef, Command: req.Command,
		FromState: res.FromState, ToState: res.ToState,
		Actor: req.Actor, Role: req.Role, Realm: req.Realm, Reason: req.Reason,
		CorrelationID: req.CorrelationID, Revision: res.Revision,
		NoOp: v.noOp, At: c.opts.Now(),
	}
	if err := c.opts.Dispatcher.Dispatch(ctx, ev); err != nil {
		res.DispatchError = err.Error()
		ObserveDispatchFailure(req.Command)
		c.log.Warn("控制指令已记录但下发失败",
			"session", req.SessionRef, "command", req.Command,
			"correlationId", req.CorrelationID, "err", err)
		return
	}
	res.Effectuation = EffectuationDispatched
}

// recordVerdict 处理「还没有读过状态行就要记审计」的结论（目前只有 busy）。
// 它自己读一次版本号走 CAS，避免为这条路径给 Commit 开一个「跳过版本校验」的口子。
func (c *Controller) recordVerdict(ctx context.Context, req Request, outcome Outcome, reason string) {
	row, _, err := c.load(ctx, req)
	if err != nil {
		c.log.Warn("记录控制结论失败（读状态）", "session", req.SessionRef, "err", err)
		return
	}
	_, err = c.opts.Store.Commit(ctx, store.Commit{
		SessionRef: req.SessionRef, Realm: req.Realm,
		Actor: req.Actor, ActorRole: req.Role,
		Command: req.Command, ExpectedRevision: row.Revision,
		ChangeState: false, Outcome: string(outcome), Reason: reason,
		FromState: row.State, CorrelationID: req.CorrelationID,
	})
	if err != nil {
		// 记不上只是少一条旁证，不该把已经拿到的结论变成失败。
		c.log.Warn("记录控制结论失败（CAS 冲突或库不可用）",
			"session", req.SessionRef, "outcome", outcome, "err", err)
		return
	}
	ObserveOutcome(outcome, req.Command)
}

func (r Request) validate() error {
	if r.SessionRef == "" {
		return fmt.Errorf("%w: sessionRef 必填", ErrInvalidRequest)
	}
	if r.Realm == "" || r.Role == "" || r.Actor == "" {
		return fmt.Errorf("%w: realm / role / actor 三件套必填（策略以它们为判据）", ErrInvalidRequest)
	}
	for _, c := range state.AllCommands {
		if r.Command == c {
			return nil
		}
	}
	return fmt.Errorf("%w: 未知控制指令 %q", ErrInvalidRequest, r.Command)
}

// newCorrelationID 生成关联 id。用 crypto/rand 而不是时间戳：控制指令会跨进程
// 出现在审计、日志与下发的消息里，可预测的 id 会让人工构造的记录混进真实链路。
func newCorrelationID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand 失败是系统级异常，退回纳秒时间戳至少还能保证本次进程内唯一。
		return fmt.Sprintf("ctl-%d", time.Now().UnixNano())
	}
	return "ctl-" + hex.EncodeToString(buf[:])
}
