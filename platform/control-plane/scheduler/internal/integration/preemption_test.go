package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/server"
)

// TestPreemptionWaitsForTerminalReport verifies the critical safety boundary:
// a higher-priority task is accepted as PENDING, but its victim continues to
// consume the slot while CANCELLING. Only the executor's terminal ABORTED
// report lets the usual drain placement proceed.
func TestPreemptionWaitsForTerminalReport(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	lease, err := st.Acquire(ctx, "scheduler-test", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}
	lower := domain.Task{TaskID: "low", Realm: "r1", ClusterID: "c1", Requires: []domain.Requirement{{Key: "llm"}}, Priority: 1}
	higher := domain.Task{TaskID: "high", Realm: "r1", ClusterID: "c1", Requires: []domain.Requirement{{Key: "llm"}}, Priority: 9}
	if _, err := st.PlaceTask(ctx, lease, lower, "N1"); err != nil {
		t.Fatalf("放置低优先级任务失败: %v", err)
	}
	if state, err := st.QueueTask(ctx, lease, higher); err != nil || state != domain.StatePending {
		t.Fatalf("高优先级任务应先安全排队: state=%s err=%v", state, err)
	}
	nodes, err := cat.List(ctx)
	if err != nil {
		t.Fatalf("列节点失败: %v", err)
	}
	active, err := st.ActiveCounts(ctx)
	if err != nil {
		t.Fatalf("读取活跃数失败: %v", err)
	}
	full := planner.FullEligibleNodes(higher, nodes, active)
	if len(full) != 1 || full[0].NodeID != "N1" {
		t.Fatalf("应识别唯一已满兼容节点: %+v", full)
	}
	victim, err := st.FindPreemptionVictim(ctx, higher, []string{"N1"})
	if err != nil || victim == nil || victim.TaskID != "low" || victim.Priority != 1 {
		t.Fatalf("应选择低优先级任务作为抢占候选: %+v err=%v", victim, err)
	}
	if accepted, err := st.RecordPreemptionIntent(ctx, victim.TaskID, victim.Attempt, higher.TaskID); err != nil || !accepted {
		t.Fatalf("抢占意图应持久化: accepted=%v err=%v", accepted, err)
	}
	if duplicate, err := st.FindPreemptionVictim(ctx, higher, []string{"N1"}); err != nil || duplicate != nil {
		t.Fatalf("已有停止命令在途的任务不可重复抢占: %+v err=%v", duplicate, err)
	}
	p, err := st.ConfirmPreemption(ctx, victim.TaskID, victim.Attempt)
	if err != nil || p.State != domain.StateCancelling {
		t.Fatalf("节点接受停止后必须仍为 CANCELLING: %+v err=%v", p, err)
	}
	var status, detail string
	if err := st.Pool().QueryRow(ctx, `SELECT status,detail FROM scheduler_control_commands WHERE task_id='low' AND command='PREEMPT'`).Scan(&status, &detail); err != nil {
		t.Fatalf("读取抢占审计失败: %v", err)
	}
	if status != "ACKNOWLEDGED" || detail != "preempted_by=high" {
		t.Fatalf("抢占审计应保留原因: status=%q detail=%q", status, detail)
	}
	active, err = st.ActiveCounts(ctx)
	if err != nil || active["N1"] != 1 {
		t.Fatalf("CANCELLING 仍应占用槽位: active=%v err=%v", active, err)
	}
	if pending, err := st.PendingTasks(ctx, 10); err != nil || len(pending) != 1 || pending[0].TaskID != "high" {
		t.Fatalf("高优先级任务必须等终态，不可假装已放置: %+v err=%v", pending, err)
	}

	if _, err := st.CompleteTaskAttempt(ctx, victim.TaskID, victim.Attempt, domain.StateAborted); err != nil {
		t.Fatalf("回报被抢占任务终态失败: %v", err)
	}
	pending, err := st.PendingTasks(ctx, 10)
	if err != nil || len(pending) != 1 || pending[0].TaskID != "high" {
		t.Fatalf("终态后 drain 应能看到高优先级任务: %+v err=%v", pending, err)
	}
	active, err = st.ActiveCounts(ctx)
	if err != nil {
		t.Fatalf("终态后读取活跃数失败: %v", err)
	}
	n := planner.Pick(pending[0], nodes, active)
	if n == nil {
		t.Fatal("终态释放槽位后应能规划高优先级任务")
	}
	placed, err := st.PlaceTask(ctx, lease, pending[0], n.NodeID)
	if err != nil || placed.State != domain.StatePlaced {
		t.Fatalf("drain 应放置等待任务: %+v err=%v", placed, err)
	}
}

// TestHTTPPreemptionUsesExactNodeStopEndpoint proves the HTTP path does not
// manufacture cancellation: the placement request is only annotated after the
// owning node accepts POST /subagent/stop for the selected child ID.
func TestHTTPPreemptionUsesExactNodeStopEndpoint(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	var mu sync.Mutex
	var stoppedChild string
	executor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/subagent/stop" || r.Header.Get("X-Lumo-Realm") != "r1" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var body struct {
			ChildID string `json:"childId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ChildID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		stoppedChild = body.ChildID
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer executor.Close()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}, ControlURL: executor.URL}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	elec := &election.State{}
	electionCtx, cancelElection := context.WithCancel(ctx)
	defer cancelElection()
	go election.Run(electionCtx, elec, st, "scheduler-http-test", 5*time.Second, func(bool) {})
	waitFor(t, 2*time.Second, elec.IsLeader)
	scheduler := httptest.NewServer(server.New(st, elec, cat, discardLogger()).Routes())
	defer scheduler.Close()

	post := func(body string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, scheduler.URL+"/v1/placements", strings.NewReader(body))
		if err != nil {
			t.Fatalf("构造请求失败: %v", err)
		}
		req.Header.Set("X-Lumo-Realm", "r1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("发送请求失败: %v", err)
		}
		defer res.Body.Close()
		payload, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatalf("读取响应失败: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatalf("解析响应失败: %v body=%s", err, payload)
		}
		return res.StatusCode, decoded
	}

	if status, body := post(`{"task_id":"low","cluster_id":"c1","requires":[{"key":"llm"}],"priority":1}`); status != http.StatusCreated || body["state"] != "PLACED" {
		t.Fatalf("低优先级任务应直接放置: status=%d body=%v", status, body)
	}
	status, body := post(`{"task_id":"high","cluster_id":"c1","requires":[{"key":"llm"}],"priority":9}`)
	if status != http.StatusAccepted || body["state"] != "PENDING" || body["preemption_requested_task_id"] != "low" {
		t.Fatalf("高优先级任务应排队并返回真实停止请求: status=%d body=%v", status, body)
	}
	mu.Lock()
	gotStopped := stoppedChild
	mu.Unlock()
	if gotStopped != "low" {
		t.Fatalf("抢占必须仅停止候选任务，got %q", gotStopped)
	}
	placement, err := st.GetPlacement(ctx, "low")
	if err != nil || placement.State != domain.StateCancelling {
		t.Fatalf("节点确认后低优先级任务应为 CANCELLING: %+v err=%v", placement, err)
	}
}
