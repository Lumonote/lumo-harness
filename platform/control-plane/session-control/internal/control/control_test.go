package control

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/session-control/internal/policy"
	"github.com/lumo-harness/platform/session-control/internal/queue"
	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

// fakeStore 是内存实现，**刻意把 CAS 语义照抄一遍**：如果这里只是「写什么存什么」，
// 那么控制器的重试路径根本不会被走到，而版本冲突是真实部署里唯一会跨实例发生的路径。
type fakeStore struct {
	mu     sync.Mutex
	rows   map[string]store.Row
	audits []store.Commit
	// raceLeft > 0 时，**改状态**的提交先返回 ErrConflict（模拟另一个实例抢先提交）。
	// 只对 ChangeState 的提交生效：并发窗口是「读状态 → 提交」这一段，而重试用尽后
	// 那条补记的审计不再处在那个窗口里——让它也冲突会把模拟变成不现实的持续争抢。
	raceLeft int
	// beforeConflict 在返回冲突之前改写状态行，模拟「别的实例做了另一件事」。
	beforeConflict func(rows map[string]store.Row)
	loadErr        error
	commitErr      error
}

func newFakeStore() *fakeStore {
	return &fakeStore{rows: map[string]store.Row{}}
}

func (f *fakeStore) seed(row store.Row) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows[row.SessionRef] = row
}

func (f *fakeStore) Load(_ context.Context, sessionRef string) (store.Row, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.loadErr != nil {
		return store.Row{}, f.loadErr
	}
	row, ok := f.rows[sessionRef]
	if !ok {
		return store.Row{}, store.ErrNotFound
	}
	return row, nil
}

func (f *fakeStore) Commit(_ context.Context, in store.Commit) (store.CommitResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commitErr != nil {
		return store.CommitResult{}, f.commitErr
	}
	row, ok := f.rows[in.SessionRef]
	if !ok {
		// 与真实现同规（store.Commit 第 2 步）：**只有**变更路径才建立状态行；
		// 不改状态的结论只追一条审计。这一条必须照抄，否则测试会放过
		// 「被拒的尝试把会话绑到了错误 realm」这种真实缺陷。
		if !in.ChangeState {
			f.audits = append(f.audits, in)
			return store.CommitResult{
				Row: store.Row{
					SessionRef: in.SessionRef, Realm: in.Realm,
					State: InitialState, Revision: 0,
				},
				AuditID: int64(len(f.audits)),
			}, nil
		}
		row = store.Row{SessionRef: in.SessionRef, Realm: in.Realm, State: InitialState}
		f.rows[in.SessionRef] = row
	}
	if row.Realm != in.Realm {
		return store.CommitResult{}, store.ErrRealmMismatch
	}
	if f.raceLeft > 0 && in.ChangeState {
		f.raceLeft--
		if f.beforeConflict != nil {
			f.beforeConflict(f.rows)
		}
		return store.CommitResult{}, store.ErrConflict
	}
	if row.Revision != in.ExpectedRevision {
		return store.CommitResult{}, store.ErrConflict
	}
	if in.ChangeState {
		row.State = in.ToState
		row.Revision++
		row.LastCommand = in.Command
		row.LastActor = in.Actor
		row.LastReason = in.Reason
		row.CorrelationID = in.CorrelationID
		f.rows[in.SessionRef] = row
	}
	f.audits = append(f.audits, in)
	return store.CommitResult{Row: row, AuditID: int64(len(f.audits))}, nil
}

func (f *fakeStore) auditOutcomes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.audits))
	for _, a := range f.audits {
		out = append(out, a.Outcome)
	}
	return out
}

// fakeAuthorizer 按预设返回，并记录被调用的次数。
type fakeAuthorizer struct {
	decision policy.Decision
	err      error
	calls    int
	last     policy.Request
}

func (f *fakeAuthorizer) Authorize(_ context.Context, req policy.Request) (policy.Decision, error) {
	f.calls++
	f.last = req
	return f.decision, f.err
}

// fakeDispatcher 记录下发的事件。
type fakeDispatcher struct {
	events []Event
	err    error
}

func (f *fakeDispatcher) Dispatch(_ context.Context, ev Event) error {
	f.events = append(f.events, ev)
	return f.err
}

func allowAll() *fakeAuthorizer {
	return &fakeAuthorizer{decision: policy.Decision{Allowed: true}}
}

// newController 造一个控制器。队列的等待上限给足，避免测试里无意中踩到 busy 路径
// （busy 有自己的用例）。
func newController(t *testing.T, st StateStore, auth Authorizer, opts ...func(*Options)) *Controller {
	t.Helper()
	o := Options{
		Store: st, Auth: auth,
		Queue:  queue.NewManager(queue.Options{MaxHold: time.Minute, WaitLimit: 5 * time.Second}),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, fn := range opts {
		fn(&o)
	}
	return New(o)
}

func pauseRequest() Request {
	return Request{
		SessionRef: "sess-1", Command: state.CmdPause,
		Realm: "dev", Role: "operator", Actor: "u-7",
		Reason: "long tool loop", CorrelationID: "corr-1",
	}
}

// TestInitialStateMatchesStoreDefault 把「控制器眼里的起点」与「存储层建行时的默认值」
// 钉在一起。
//
// 两个包各写一个 running 字面量是很容易发生的（store 的 INSERT 用 state.StateRunning，
// 控制器用 InitialState）。一旦漂移：未登记会话的读面显示 running，而首条指令实际
// 从另一个状态起算——那时 Apply 会给出与读面完全不同的可用性。
func TestInitialStateMatchesStoreDefault(t *testing.T) {
	if InitialState != state.StateRunning {
		t.Fatalf("InitialState=%q 与 store 建行默认值 %q 不一致", InitialState, state.StateRunning)
	}
}

func TestAppliedPauseChangesStateAndAudits(t *testing.T) {
	st := newFakeStore()
	c := newController(t, st, allowAll())

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeApplied {
		t.Fatalf("期望 applied，实际 %s（%s）", res.Outcome, res.Reason)
	}
	if res.FromState != state.StateRunning || res.ToState != state.StatePaused {
		t.Fatalf("跃迁不符：%s → %s", res.FromState, res.ToState)
	}
	if res.Revision != 1 {
		t.Fatalf("revision 应为 1，实际 %d", res.Revision)
	}
	if !res.Registered {
		t.Fatal("提交后该会话已是登记状态")
	}
	if got := st.auditOutcomes(); len(got) != 1 || got[0] != string(OutcomeApplied) {
		t.Fatalf("审计应为一条 applied，实际 %v", got)
	}
}

// TestNoOpIsNotAnErrorAndDoesNotMoveRevision 钉住「重复点击」的语义。
//
// 幂等如果实现成「再写一次」，revision 会被推高，而 revision 参与 CAS ——两个坐在
// 同一状态上的操作者会互相把对方的重试判成过期，谁也提交不了。
func TestNoOpIsNotAnErrorAndDoesNotMoveRevision(t *testing.T) {
	st := newFakeStore()
	st.seed(store.Row{SessionRef: "sess-1", Realm: "dev", State: state.StatePaused, Revision: 3})
	c := newController(t, st, allowAll())

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeNoOp || !res.NoOp {
		t.Fatalf("期望 noop，实际 %s（noOp=%v）", res.Outcome, res.NoOp)
	}
	if res.Revision != 3 {
		t.Fatalf("noop 不应推高 revision，实际 %d", res.Revision)
	}
	if res.ToState != state.StatePaused {
		t.Fatalf("noop 的落点应保持原状态，实际 %s", res.ToState)
	}
	if got := st.auditOutcomes(); len(got) != 1 {
		t.Fatalf("noop 也要入审计（它解释了「点下去没变化」），实际 %v", got)
	}
}

func TestStateRejectionIsRecorded(t *testing.T) {
	st := newFakeStore()
	st.seed(store.Row{SessionRef: "sess-1", Realm: "dev", State: state.StateAwaitingApproval})
	c := newController(t, st, allowAll())

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeStateRejected {
		t.Fatalf("期望 state_rejected，实际 %s", res.Outcome)
	}
	if res.Reason == "" {
		t.Fatal("状态拒绝必须带可读原因（它要显示在控制台上）")
	}
	if row, _ := st.Load(context.Background(), "sess-1"); row.State != state.StateAwaitingApproval {
		t.Fatalf("被拒的指令不该改状态，实际 %s", row.State)
	}
	if got := st.auditOutcomes(); len(got) != 1 || got[0] != string(OutcomeStateRejected) {
		t.Fatalf("被拒也要入审计，实际 %v", got)
	}
}

// TestPolicyDeniedVersusUnavailable 是本服务最容易被做错的一处：两种拒绝必须给出
// **不同的结论值**，否则运维会去查权限，而问题在 OPA 起没起来。
func TestPolicyDeniedVersusUnavailable(t *testing.T) {
	cases := []struct {
		name    string
		auth    *fakeAuthorizer
		outcome Outcome
	}{
		{"策略判定不允许", &fakeAuthorizer{decision: policy.Decision{Allowed: false, Reason: "role 未授权"}}, OutcomePolicyDenied},
		{"策略引擎不可用", &fakeAuthorizer{err: fmt.Errorf("%w: 连接被拒", policy.ErrUnavailable)}, OutcomePolicyUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			c := newController(t, st, tc.auth)
			res, err := c.Execute(context.Background(), pauseRequest())
			if err != nil {
				t.Fatalf("报错: %v", err)
			}
			if res.Outcome != tc.outcome {
				t.Fatalf("期望 %s，实际 %s", tc.outcome, res.Outcome)
			}
			if res.Reason == "" {
				t.Fatal("拒绝必须带原因")
			}
			if got := st.auditOutcomes(); len(got) != 1 || got[0] != string(tc.outcome) {
				t.Fatalf("审计应记 %s，实际 %v", tc.outcome, got)
			}
			if row, err := st.Load(context.Background(), "sess-1"); err == nil && row.State != InitialState {
				t.Fatalf("被策略拒绝不该改状态，实际 %s", row.State)
			}
		})
	}
}

// TestRealmIsolationRunsBeforeAuthorizationAndSkipsAudit 同时钉住两件事：
//
//  1. 隔离先于授权——跨 realm 的调用方连「这条指令是否被允许」都不该问出来
//     （authorizer 的调用次数必须为 0）；
//  2. 这类尝试**不写审计表**（审计行属于会话的 realm，写它要先能操作那一行，
//     为它开后门等于把 realm 边界变成可选的），因此它必须由日志与指标留痕——
//     见 metrics.go 的 MetricRealmMismatch。
func TestRealmIsolationRunsBeforeAuthorizationAndSkipsAudit(t *testing.T) {
	st := newFakeStore()
	st.seed(store.Row{SessionRef: "sess-1", Realm: "realm-a", State: state.StateRunning})
	auth := allowAll()
	c := newController(t, st, auth)

	req := pauseRequest()
	req.Realm = "realm-b"
	res, err := c.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeRealmMismatch {
		t.Fatalf("期望 realm_mismatch，实际 %s", res.Outcome)
	}
	if auth.calls != 0 {
		t.Fatalf("跨 realm 的请求不该到达策略引擎（实际调用 %d 次）", auth.calls)
	}
	if got := st.auditOutcomes(); len(got) != 0 {
		t.Fatalf("跨 realm 尝试不入审计表（改由日志 + 指标留痕），实际 %v", got)
	}
	if row, _ := st.Load(context.Background(), "sess-1"); row.State != state.StateRunning {
		t.Fatalf("状态不该被改动，实际 %s", row.State)
	}
}

// TestDeniedAttemptCannotBindTheSessionRealm 是一条防「拒绝即伤害」的用例。
//
// 状态行的 realm 写后不可变，所以「谁能建立这一行」等于「谁能决定这个会话属于哪个
// realm」。若被拒的尝试也建行，任何人都能用一条 realm 拼错的或被策略拒绝的请求，
// 把别人的会话永久绑到错误边界上——之后真正的主人每条指令都收到 realm_mismatch，
// 而这是一次**本应无副作用**的拒绝带来的。所以：拒绝要留审计，但绝不能建行。
func TestDeniedAttemptCannotBindTheSessionRealm(t *testing.T) {
	st := newFakeStore()
	auth := &fakeAuthorizer{decision: policy.Decision{Allowed: false, Reason: "role 未授权"}}
	c := newController(t, st, auth)

	req := pauseRequest()
	req.Realm = "realm-b" // 一个并不拥有该会话的 realm 发起的尝试
	res, err := c.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomePolicyDenied {
		t.Fatalf("期望 policy_denied，实际 %s", res.Outcome)
	}
	if got := st.auditOutcomes(); len(got) != 1 {
		t.Fatalf("被拒也要留审计，实际 %v", got)
	}
	if _, err := st.Load(context.Background(), "sess-1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("被拒的尝试**不得**建立状态行——否则它就把会话绑到了 realm-b")
	}

	// 随后真正的主人（realm-a）应当能正常控制它。
	c2 := newController(t, st, allowAll())
	req2 := pauseRequest()
	req2.Realm = "realm-a"
	res2, err := c2.Execute(context.Background(), req2)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res2.Outcome != OutcomeApplied {
		t.Fatalf("合法主人应能控制该会话，实际 %s（%s）", res2.Outcome, res2.Reason)
	}
	if row, _ := st.Load(context.Background(), "sess-1"); row.Realm != "realm-a" {
		t.Fatalf("realm 应由首个**生效**的指令确立，实际 %q", row.Realm)
	}
}

// TestConflictRetriesWithFreshState 是本服务跨实例正确性的核心用例。
//
// 场景：两个实例都读到 running。A 提交了 pause（状态变 paused）。
// B 手里那条是 stop，它在**过期前提**上算出的结论是「running → stopped」。若没有
// 版本比较，B 会把 stopped 写下去，而审计里两条都写着 applied。正确结果是：B 重读、
// 发现现在是 paused、重新裁决，stop 从 paused 出发依然合法（落点还是 stopped），
// 但**前提**已经是新的了。
func TestConflictRetriesWithFreshState(t *testing.T) {
	st := newFakeStore()
	st.seed(store.Row{SessionRef: "sess-1", Realm: "dev", State: state.StateRunning})
	// 第一次提交前，模拟另一个实例抢先把它 pause 了。
	st.raceLeft = 1
	st.beforeConflict = func(rows map[string]store.Row) {
		row := rows["sess-1"]
		row.State = state.StatePaused
		row.Revision++
		rows["sess-1"] = row
	}
	c := newController(t, st, allowAll())

	req := pauseRequest()
	req.Command = state.CmdStop
	res, err := c.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeApplied {
		t.Fatalf("冲突后重读重试应成功，实际 %s（%s）", res.Outcome, res.Reason)
	}
	if res.Attempts != 2 {
		t.Fatalf("应为第 2 次尝试成功，实际 %d 次", res.Attempts)
	}
	if res.FromState != state.StatePaused {
		t.Fatalf("重试后应从**新**状态出发（paused），实际 %s", res.FromState)
	}
	if res.ToState != state.StateStopped || res.Revision != 2 {
		t.Fatalf("落点/版本不符：%s rev=%d", res.ToState, res.Revision)
	}
}

// TestConflictExhaustionIsAVerdict 重试用尽也必须给结论并留审计——它要能回答
// 「为什么这次没生效」。
func TestConflictExhaustionIsAVerdict(t *testing.T) {
	st := newFakeStore()
	st.seed(store.Row{SessionRef: "sess-1", Realm: "dev", State: state.StateRunning})
	st.raceLeft = 99
	c := newController(t, st, allowAll(), func(o *Options) { o.MaxAttempts = 3 })

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("冲突不再是「没拿到结论」，不该报错: %v", err)
	}
	if res.Outcome != OutcomeConflict {
		t.Fatalf("期望 conflict，实际 %s", res.Outcome)
	}
	if res.Attempts != 3 {
		t.Fatalf("应按上限尝试 3 次，实际 %d", res.Attempts)
	}
	if got := st.auditOutcomes(); len(got) != 1 || got[0] != string(OutcomeConflict) {
		t.Fatalf("结论要入审计，实际 %v", got)
	}
}

// TestBusyIsAuditedAndNeverReachesAdjudication 排队没轮到：结论是 busy（503 可重试），
// 且这条尝试要留痕（「有人在猛敲按钮」属于审计要回答的问题）。
func TestBusyIsAuditedAndNeverReachesAdjudication(t *testing.T) {
	st := newFakeStore()
	manager := queue.NewManager(queue.Options{MaxHold: time.Minute, WaitLimit: 30 * time.Millisecond})
	auth := allowAll()
	c := newController(t, st, auth, func(o *Options) { o.Queue = manager })

	// 先占住该会话的生效权（不释放）。
	holder, err := manager.Acquire(context.Background(), "sess-1", "holder", state.CmdPause)
	if err != nil {
		t.Fatalf("占位失败: %v", err)
	}
	defer holder.Release()

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeBusy {
		t.Fatalf("期望 busy，实际 %s", res.Outcome)
	}
	if auth.calls != 0 {
		t.Fatal("被挤掉的指令不该走到策略引擎")
	}
	if got := st.auditOutcomes(); len(got) != 1 || got[0] != string(OutcomeBusy) {
		t.Fatalf("busy 也要留痕，实际 %v", got)
	}
}

// TestDispatchHappensAfterCommit 钉住顺序取舍：先落库再下发。
//
// 下发失败时状态与审计**必须已经生效**（结果里带 dispatch_error 与 effectuation=recorded），
// 因为反过来「做到但没记」是不可审计的。
func TestDispatchHappensAfterCommit(t *testing.T) {
	st := newFakeStore()
	disp := &fakeDispatcher{err: errors.New("会话执行面连不上")}
	c := newController(t, st, allowAll(), func(o *Options) { o.Dispatcher = disp })

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Outcome != OutcomeApplied {
		t.Fatalf("下发失败不该改变裁决结论，实际 %s", res.Outcome)
	}
	if row, _ := st.Load(context.Background(), "sess-1"); row.State != state.StatePaused {
		t.Fatalf("状态必须已落库，实际 %s", row.State)
	}
	if len(st.auditOutcomes()) != 1 {
		t.Fatal("审计必须已经写下")
	}
	if res.Effectuation != EffectuationRecorded || res.DispatchError == "" {
		t.Fatalf("下发失败必须可见：effectuation=%q dispatchError=%q",
			res.Effectuation, res.DispatchError)
	}
	if len(disp.events) != 1 {
		t.Fatalf("应下发一次，实际 %d", len(disp.events))
	}
	ev := disp.events[0]
	if ev.Type != EventType || ev.Command != state.CmdPause || ev.ToState != state.StatePaused {
		t.Fatalf("事件载荷不符: %+v", ev)
	}
}

func TestDispatchSuccessReportsDispatched(t *testing.T) {
	st := newFakeStore()
	disp := &fakeDispatcher{}
	c := newController(t, st, allowAll(), func(o *Options) { o.Dispatcher = disp })

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Effectuation != EffectuationDispatched {
		t.Fatalf("成功下发应报 dispatched，实际 %q", res.Effectuation)
	}
}

// TestNoDispatcherMeansRecorded 未接线时如实回报，不假装下发。
func TestNoDispatcherMeansRecorded(t *testing.T) {
	st := newFakeStore()
	c := newController(t, st, allowAll())

	res, err := c.Execute(context.Background(), pauseRequest())
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.Effectuation != EffectuationRecorded {
		t.Fatalf("未配置下发时必须报 recorded，实际 %q", res.Effectuation)
	}
}

// TestNoOpIsNotDispatched：没有副作用的事不要惊动会话执行面。
func TestNoOpIsNotDispatched(t *testing.T) {
	st := newFakeStore()
	st.seed(store.Row{SessionRef: "sess-1", Realm: "dev", State: state.StatePaused})
	disp := &fakeDispatcher{}
	c := newController(t, st, allowAll(), func(o *Options) { o.Dispatcher = disp })

	if _, err := c.Execute(context.Background(), pauseRequest()); err != nil {
		t.Fatalf("报错: %v", err)
	}
	if len(disp.events) != 0 {
		t.Fatalf("noop 不该下发，实际 %d 次", len(disp.events))
	}
}

func TestInvalidRequestsNeverReachStoreOrAudit(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Request)
	}{
		{"缺 sessionRef", func(r *Request) { r.SessionRef = "" }},
		{"缺 realm", func(r *Request) { r.Realm = "" }},
		{"缺 role", func(r *Request) { r.Role = "" }},
		{"缺 actor", func(r *Request) { r.Actor = "" }},
		{"未知指令", func(r *Request) { r.Command = "detonate" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			c := newController(t, st, allowAll())
			req := pauseRequest()
			tc.mut(&req)
			if _, err := c.Execute(context.Background(), req); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("应归为 ErrInvalidRequest，实际 %v", err)
			}
			if got := st.auditOutcomes(); len(got) != 0 {
				t.Fatalf("不合法的请求没有主体，不该入审计，实际 %v", got)
			}
		})
	}
}

func TestCorrelationIDIsGeneratedAndPrefixed(t *testing.T) {
	st := newFakeStore()
	c := newController(t, st, allowAll())
	req := pauseRequest()
	req.CorrelationID = ""
	res, err := c.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if len(res.CorrelationID) < 8 {
		t.Fatalf("必须生成关联 id，实际 %q", res.CorrelationID)
	}
	if res.CorrelationID == req.CorrelationID {
		t.Fatal("未生成新的关联 id")
	}
	// 调用方给的 id 必须原样保留（它就是用来跨系统对账的）。
	req.CorrelationID = "user-supplied"
	res, err = c.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if res.CorrelationID != "user-supplied" {
		t.Fatalf("调用方给的关联 id 被改写成了 %q", res.CorrelationID)
	}
}

// TestEveryMatrixCellAgreesWithTheStateMachine 是覆盖 5 状态 × 8 指令 = 40 格的性质测试。
//
// 它要钉的是一条**跨层不变量**：控制器「要不要改状态 / 落点在哪」必须与 state.Apply
// 的判定完全一致，且每一格都留下审计（含被拒的）。手写 40 条期望容易漏，而漏掉的
// 那一格正好是「控制器擅自放行了一个状态机拒绝的指令」时没人发现的地方。
func TestEveryMatrixCellAgreesWithTheStateMachine(t *testing.T) {
	checked := 0
	for _, from := range state.AllStates {
		for _, cmd := range state.AllCommands {
			t.Run(string(from)+"/"+string(cmd), func(t *testing.T) {
				st := newFakeStore()
				st.seed(store.Row{SessionRef: "sess-1", Realm: "dev", State: from})
				c := newController(t, st, allowAll())
				req := pauseRequest()
				req.Command = cmd

				res, err := c.Execute(context.Background(), req)
				if err != nil {
					t.Fatalf("报错: %v", err)
				}
				want := state.Apply(from, cmd)

				switch {
				case !want.OK:
					if res.Outcome != OutcomeStateRejected {
						t.Fatalf("状态机拒绝但控制器给了 %s（原因 %q）", res.Outcome, res.Reason)
					}
					if row, _ := st.Load(context.Background(), "sess-1"); row.State != from {
						t.Fatalf("被拒的指令改了状态：%s → %s", from, row.State)
					}
				case want.NoOp:
					if res.Outcome != OutcomeNoOp {
						t.Fatalf("状态机判 noop 但控制器给了 %s", res.Outcome)
					}
					if row, _ := st.Load(context.Background(), "sess-1"); row.Revision != 0 {
						t.Fatalf("noop 推高了 revision：%d", row.Revision)
					}
				default:
					if res.Outcome != OutcomeApplied {
						t.Fatalf("状态机放行但控制器给了 %s（%s）", res.Outcome, res.Reason)
					}
					if res.ToState != want.Next {
						t.Fatalf("落点不符：状态机 %s，控制器 %s", want.Next, res.ToState)
					}
				}

				// 40 格里没有一格可以不留审计。
				if got := st.auditOutcomes(); len(got) != 1 {
					t.Fatalf("每格都必须恰好留一条审计，实际 %v", got)
				}
				checked++
			})
		}
	}
	if want := len(state.AllStates) * len(state.AllCommands); checked != want {
		t.Fatalf("矩阵未走满：%d/%d", checked, want)
	}
}
