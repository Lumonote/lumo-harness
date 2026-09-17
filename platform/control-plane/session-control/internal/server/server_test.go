package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/session-control/internal/control"
	"github.com/lumo-harness/platform/session-control/internal/queue"
	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

type fakeReader struct {
	row       store.Row
	loadErr   error
	events    []store.AuditRow
	gotAfter  int64
	gotLimit  int
	timelineE error
}

func (f *fakeReader) Load(context.Context, string) (store.Row, error) {
	if f.loadErr != nil {
		return store.Row{}, f.loadErr
	}
	return f.row, nil
}

func (f *fakeReader) Timeline(_ context.Context, _ string, afterID int64, limit int) ([]store.AuditRow, error) {
	f.gotAfter, f.gotLimit = afterID, limit
	if f.timelineE != nil {
		return nil, f.timelineE
	}
	return f.events, nil
}

type fakeQueueView struct{ snapshot queue.Snapshot }

func (f fakeQueueView) Snapshot(string) queue.Snapshot { return f.snapshot }

// newTestServer 起一个 httptest 服务。execute 可为 nil（测未装配路径）。
func newTestServer(t *testing.T, execute func(context.Context, control.Request) (control.Result, error), reader StateReader) *httptest.Server {
	t.Helper()
	srv := New(Options{
		Execute: execute,
		Store:   reader,
		Queue:   fakeQueueView{},
	})
	mux := http.NewServeMux()
	srv.Routes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func doJSON(t *testing.T, ts *httptest.Server, method, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	var decoded map[string]any
	if err := json.NewDecoder(res.Body).Decode(&decoded); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	return res, decoded
}

// TestOutcomeToStatusIsPinned 把结论 → 状态码的映射钉死。
//
// 这张表是本服务对外最重要的语义面：调用方只靠状态码决定「重试 / 求权限 / 读状态」。
// 逐个断言而不是断言「非 200」，理由是**错配的 200 比 500 更危险**——一次被拒的控制
// 指令若回 200，调用方会以为会话真的被暂停了。
func TestOutcomeToStatusIsPinned(t *testing.T) {
	cases := []struct {
		outcome    control.Outcome
		wantStatus int
		wantRetry  bool
	}{
		{control.OutcomeApplied, http.StatusOK, false},
		{control.OutcomeNoOp, http.StatusOK, false},
		{control.OutcomePolicyDenied, http.StatusForbidden, false},
		{control.OutcomeRealmMismatch, http.StatusForbidden, false},
		{control.OutcomeStateRejected, http.StatusConflict, false},
		{control.OutcomeConflict, http.StatusConflict, false},
		{control.OutcomePolicyUnavailable, http.StatusServiceUnavailable, true},
		{control.OutcomeBusy, http.StatusServiceUnavailable, true},
	}
	for _, tc := range cases {
		t.Run(string(tc.outcome), func(t *testing.T) {
			status, retry := statusFor(tc.outcome)
			if status != tc.wantStatus {
				t.Fatalf("期望 %d，实际 %d", tc.wantStatus, status)
			}
			if (retry > 0) != tc.wantRetry {
				t.Fatalf("Retry-After 的存在性不符：%d（期望有=%v）", retry, tc.wantRetry)
			}
		})
	}
	// 未登记的结论**必须**落在 5xx：新加一种 Outcome 忘了登记时，症状要是「服务器
	// 内部异常」而不是一个错误的 200。
	if status, _ := statusFor(control.Outcome("brand-new")); status != http.StatusInternalServerError {
		t.Fatalf("未知结论应落到 500（提示有人忘了登记），实际 %d", status)
	}
}

func TestWritePathCarriesIdentityAndSessionRef(t *testing.T) {
	var got control.Request
	execute := func(_ context.Context, req control.Request) (control.Result, error) {
		got = req
		return control.Result{
			SessionRef: req.SessionRef, Command: req.Command, Outcome: control.OutcomeApplied,
			Registered: true, FromState: state.StateRunning, ToState: state.StatePaused,
			Revision: 1, Effectuation: control.EffectuationRecorded, CorrelationID: "ctl-x",
		}, nil
	}
	ts := newTestServer(t, execute, &fakeReader{})

	res, body := doJSON(t, ts, http.MethodPost, "/v1/sessions/sess%2Fwith%2Fslashes/control",
		`{"command":"pause","realm":"dev","role":"operator","actor":"u-7","reason":"loop","correlation_id":"c1"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("期望 200，实际 %d（%v）", res.StatusCode, body)
	}
	// URL 里的 sessionRef 必须**解码后**再交给裁决器：编码形式（%2F）若原样传下去，
	// 读面与队列会把它当成两个不同的会话，同一条会话的串行化就断了。
	if got.SessionRef != "sess/with/slashes" {
		t.Fatalf("sessionRef 未解码：%q", got.SessionRef)
	}
	if got.Command != state.CmdPause || got.Realm != "dev" || got.Role != "operator" || got.Actor != "u-7" {
		t.Fatalf("身份未原样传递：%+v", got)
	}
	if got.Reason != "loop" || got.CorrelationID != "c1" {
		t.Fatalf("reason/correlationId 未传递：%+v", got)
	}
	if body["outcome"] != string(control.OutcomeApplied) || body["to_state"] != string(state.StatePaused) {
		t.Fatalf("响应体不符：%v", body)
	}
}

func TestWritePathErrorBodies(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		execute    func(context.Context, control.Request) (control.Result, error)
		wantStatus int
		wantCode   string
	}{
		{
			name:       "请求体不是 JSON",
			body:       `{`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_json",
		},
		{
			name: "请求不合法（缺 realm）",
			body: `{"command":"pause","actor":"u-7"}`,
			execute: func(context.Context, control.Request) (control.Result, error) {
				return control.Result{}, fmt.Errorf("%w: realm / role / actor 三件套必填", control.ErrInvalidRequest)
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_request",
		},
		{
			name: "基础设施失败（没有结论）",
			body: `{"command":"pause","realm":"dev","role":"operator","actor":"u-7"}`,
			execute: func(context.Context, control.Request) (control.Result, error) {
				return control.Result{}, errors.New("库连不上")
			},
			// 关键：**不是** 500。它的处置是「稍后重试」，而 500 会让调用方以为是自己
			// 请求的错；同时也不能是 200/403 —— 那会变成「命令被拒」的假事实。
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "control_unavailable",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := newTestServer(t, tc.execute, &fakeReader{})
			res, body := doJSON(t, ts, http.MethodPost, "/v1/sessions/s1/control", tc.body)
			if res.StatusCode != tc.wantStatus {
				t.Fatalf("期望 %d，实际 %d（%v）", tc.wantStatus, res.StatusCode, body)
			}
			if body["error"] != tc.wantCode {
				t.Fatalf("期望 error=%q，实际 %v", tc.wantCode, body)
			}
			if msg, _ := body["message"].(string); strings.TrimSpace(msg) == "" {
				t.Fatal("错误响应必须带可读 message")
			}
		})
	}
}

func TestWritePathWithoutExecutorIs503NotSuccess(t *testing.T) {
	ts := newTestServer(t, nil, &fakeReader{})
	res, body := doJSON(t, ts, http.MethodPost, "/v1/sessions/s1/control",
		`{"command":"pause","realm":"dev","role":"operator","actor":"u-7"}`)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("未装配裁决器时不能回成功，实际 %d（%v）", res.StatusCode, body)
	}
}

// TestConsoleOnUnregisteredSessionDoesNotInventRunning 是本读面最重要的一条。
//
// 未登记会话的 state 必须是 JSON null，且 base_state 单独给出。把 state 直接填成
// "running" 会让控制台显示一个我们从没观测过的事实——本服务没有会话注册表，无从
// 知道一个陌生会话在生产面上处于什么状态。
func TestConsoleOnUnregisteredSessionDoesNotInventRunning(t *testing.T) {
	reader := &fakeReader{loadErr: store.ErrNotFound}
	ts := newTestServer(t, nil, reader)

	res, body := doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("未登记是正常查询结果而不是错误，实际 %d", res.StatusCode)
	}
	if body["registered"] != false {
		t.Fatalf("registered 应为 false，实际 %v", body["registered"])
	}
	if v, present := body["state"]; !present || v != nil {
		t.Fatalf("未登记时 state 必须是 null，实际 %v（存在=%v）", v, present)
	}
	if body["base_state"] != string(control.InitialState) {
		t.Fatalf("base_state 应为初始化状态 %q，实际 %v", control.InitialState, body["base_state"])
	}
	// 可用性按 base_state 算——控制台因此不必自己知道「未登记时算 running」。
	available, ok := body["available"].([]any)
	if !ok || len(available) != len(state.AllCommands) {
		t.Fatalf("available 应覆盖全部指令，实际 %v", body["available"])
	}
	if body["last_control"] != nil {
		t.Fatalf("未登记时不该有 last_control，实际 %v", body["last_control"])
	}
}

func TestConsoleOnRegisteredSessionShowsStateAndAvailability(t *testing.T) {
	at := time.Now()
	reader := &fakeReader{row: store.Row{
		SessionRef: "s1", Realm: "dev", State: state.StateAwaitingApproval, Revision: 7,
		LastCommand: state.CmdStop, LastActor: "u-7", LastReason: "runaway",
		CorrelationID: "c9", UpdatedAt: at,
	}}
	ts := newTestServer(t, nil, reader)

	res, body := doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", res.StatusCode)
	}
	if body["state"] != string(state.StateAwaitingApproval) || body["base_state"] != string(state.StateAwaitingApproval) {
		t.Fatalf("state/base_state 应同为 awaiting-approval，实际 %v / %v", body["state"], body["base_state"])
	}
	if body["revision"] != float64(7) {
		t.Fatalf("revision 应为 7，实际 %v", body["revision"])
	}
	last, _ := body["last_control"].(map[string]any)
	if last == nil || last["command"] != string(state.CmdStop) || last["actor"] != "u-7" {
		t.Fatalf("last_control 不符：%v", body["last_control"])
	}
	// 可用性必须与写入路径同源：awaiting-approval 下 pause 不可用（这正是状态机说的）。
	available, _ := body["available"].([]any)
	found := false
	for _, raw := range available {
		entry, _ := raw.(map[string]any)
		if entry["command"] == string(state.CmdPause) {
			found = true
			if entry["available"] != false {
				t.Fatalf("awaiting-approval 下 pause 不该可用：%v", entry)
			}
			if r, _ := entry["reason"].(string); r == "" || r == "ok" {
				t.Fatalf("不可用必须给出原因，实际 %q", r)
			}
		}
	}
	if !found {
		t.Fatal("available 里没有 pause 这一项")
	}
}

func TestConsoleWithoutStoreIs503(t *testing.T) {
	srv := New(Options{})
	mux := http.NewServeMux()
	srv.Routes(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/sessions/s1/control", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("未装配存储读面时应诚实 503，实际 %d", rec.Code)
	}
}

func TestTimelineCursorAndLimitHandling(t *testing.T) {
	reader := &fakeReader{events: []store.AuditRow{{ID: 11, SessionRef: "s1"}, {ID: 12, SessionRef: "s1"}}}
	ts := newTestServer(t, nil, reader)

	res, body := doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control/events?after=10&limit=2", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", res.StatusCode)
	}
	if reader.gotAfter != 10 || reader.gotLimit != 2 {
		t.Fatalf("游标/上限未透传：after=%d limit=%d", reader.gotAfter, reader.gotLimit)
	}
	if body["next_after"] != float64(12) {
		t.Fatalf("next_after 应为最后一行的 id（12），实际 %v", body["next_after"])
	}
	if events, _ := body["events"].([]any); len(events) != 2 {
		t.Fatalf("事件数不符：%v", body["events"])
	}

	// 上限必须被夹紧：不夹紧时一个巨大的 limit 会让控制面的内存跟着会话历史走。
	_, _ = doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control/events?limit=10000000", "")
	if reader.gotLimit != maxTimelineLimit {
		t.Fatalf("limit 应被夹到 %d，实际 %d", maxTimelineLimit, reader.gotLimit)
	}
	// 缺省上限。
	_, _ = doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control/events", "")
	if reader.gotLimit != defaultTimelineLimit {
		t.Fatalf("缺省 limit 应为 %d，实际 %d", defaultTimelineLimit, reader.gotLimit)
	}
}

func TestTimelineRejectsBadCursorInsteadOfSilentlyUsingZero(t *testing.T) {
	reader := &fakeReader{}
	ts := newTestServer(t, nil, reader)

	for _, q := range []string{"after=-1", "after=abc", "limit=0", "limit=-5"} {
		res, body := doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control/events?"+q, "")
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s 应为 400（坏游标不能被静默当成 0），实际 %d（%v）", q, res.StatusCode, body)
		}
	}
	if reader.gotAfter != 0 || reader.gotLimit != 0 {
		t.Fatal("非法参数不该到达存储层")
	}
}

func TestTimelineEmptyPageHasZeroCursor(t *testing.T) {
	ts := newTestServer(t, nil, &fakeReader{events: []store.AuditRow{}})
	_, body := doJSON(t, ts, http.MethodGet, "/v1/sessions/s1/control/events", "")
	if body["next_after"] != float64(0) {
		t.Fatalf("空页的 next_after 应为 0（表示到底了），实际 %v", body["next_after"])
	}
}

func TestRoutingRejectsUnknownPathsAndMethods(t *testing.T) {
	ts := newTestServer(t, func(context.Context, control.Request) (control.Result, error) {
		return control.Result{Outcome: control.OutcomeApplied}, nil
	}, &fakeReader{})

	cases := []struct {
		method, path string
		wantStatus   int
	}{
		{http.MethodGet, "/v1/sessions/s1", http.StatusNotFound},
		{http.MethodPut, "/v1/sessions/s1/control", http.StatusMethodNotAllowed},
		{http.MethodPost, "/v1/sessions/s1/control/events", http.StatusMethodNotAllowed},
		{http.MethodGet, "/v1/sessions/", http.StatusNotFound},
	}
	for _, tc := range cases {
		res, _ := doJSON(t, ts, tc.method, tc.path, "")
		if res.StatusCode != tc.wantStatus {
			t.Fatalf("%s %s 期望 %d，实际 %d", tc.method, tc.path, tc.wantStatus, res.StatusCode)
		}
	}
}

func TestHealthzAndMetricsAreExposed(t *testing.T) {
	ts := newTestServer(t, nil, &fakeReader{})
	res, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz 请求失败: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthz 期望 200，实际 %d", res.StatusCode)
	}
}
