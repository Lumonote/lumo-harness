package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// schedulerReplica 一个调度副本：独立连接池 + 独立选举状态 + 独立 HTTP 面。
// 两个副本共用同一个库，正是双副本部署的形态。
type schedulerReplica struct {
	st   *store.Store
	elec *election.State
	api  *server.Server
	ts   *httptest.Server
	hits *atomic.Int64
}

const forwardTestToken = "forward-test-token"

func newReplica(t *testing.T, st *store.Store) *schedulerReplica {
	t.Helper()
	r := &schedulerReplica{st: st, elec: &election.State{}, hits: &atomic.Int64{}}
	api := server.New(st, r.elec, &catalog.Pg{Pool: st.Pool()}, discardLogger())
	r.api = api
	inner := observability.RequireControlPlaneToken(forwardTestToken)(api.Routes())
	r.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodPost {
			r.hits.Add(1)
		}
		inner.ServeHTTP(w, req)
	}))
	t.Cleanup(r.ts.Close)
	// 广播地址必须在选举开始之前就位：它与租约在同一条语句里落库。
	st.SetAdvertiseURL(r.ts.URL)
	return r
}

func secondStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.New(context.Background(), testDSN(t))
	if err != nil {
		t.Fatalf("连接 PG 失败: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}

func (r *schedulerReplica) post(t *testing.T, path, body string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, r.ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.Header.Set("X-Lumo-Realm", "r1")
	req.Header.Set("Authorization", "Bearer "+forwardTestToken)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

// 双副本：leader 与 follower 共用一个库。返回 (leader, follower)。
func leaderAndFollower(t *testing.T) (*schedulerReplica, *schedulerReplica) {
	t.Helper()
	leader := newReplica(t, newStore(t))
	follower := newReplica(t, secondStore(t))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go election.Run(ctx, leader.elec, leader.st, "sched-leader", 5*time.Second, func(bool) {})
	waitFor(t, 2*time.Second, leader.elec.IsLeader)
	if err := leader.st.SyncNodeSnapshot(context.Background(), domain.Node{
		NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 2, Capabilities: []string{"llm"},
	}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	return leader, follower
}

// 负载均衡把新放置打到 follower 时，调用方必须拿到与直连 leader 相同的结果，
// 而不是一个它无从处理的 503。
func TestFollowerForwardsNewPlacementToLeader(t *testing.T) {
	leader, follower := leaderAndFollower(t)

	resp, body := follower.post(t, "/v1/placements", `{"task_id":"fwd-1","cluster_id":"c1"}`, nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("经 follower 的放置应由 leader 完成: %d %s", resp.StatusCode, body)
	}
	var p domain.Placement
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("解析放置响应失败: %v", err)
	}
	if p.NodeID != "N1" || p.Attempt != 1 || p.State != domain.StatePlaced {
		t.Fatalf("放置响应不符: %+v", p)
	}
	if leader.hits.Load() != 1 {
		t.Fatalf("leader 应恰好收到一次转发: %d", leader.hits.Load())
	}
	if n := rowCount(t, leader.st, `SELECT count(*) FROM scheduler_tasks WHERE task_id='fwd-1' AND state='PLACED'`); n != 1 {
		t.Fatalf("任务应已落库为 PLACED: %d", n)
	}
}

// A cluster follower can independently hold a live local lease. Both immediate
// placement and capacity queuing still belong to the advertised global leader.
func TestClusterFollowerPrefersGlobalLeaderOverLocalLease(t *testing.T) {
	leader, follower := leaderAndFollower(t)
	local := &election.State{}
	follower.api.SetClusterPlacement("c1", local)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go election.RunCluster(ctx, local, follower.st, "c1", "sched-follower", 5*time.Second, func(bool) {})
	waitFor(t, 2*time.Second, local.IsLeader)

	for _, tc := range []struct {
		taskID string
		status int
	}{
		{"cluster-forward-1", http.StatusCreated},
		{"cluster-forward-2", http.StatusCreated},
		{"cluster-forward-queue", http.StatusAccepted},
	} {
		body := `{"task_id":"` + tc.taskID + `","cluster_id":"c1"}`
		resp, reply := follower.post(t, "/v1/placements", body, nil)
		if resp.StatusCode != tc.status || strings.Contains(reply, `"degraded":true`) {
			t.Fatalf("%s: want global response %d, got %d %s", tc.taskID, tc.status, resp.StatusCode, reply)
		}
	}
	if n := leader.hits.Load(); n != 3 {
		t.Fatalf("leader should receive all three submissions: got %d", n)
	}
	if n := outboxCount(t, leader.st, "cluster-forward-queue"); n != 0 {
		t.Fatalf("queued task should have no dispatch: got %d", n)
	}
}

func TestFollowerForwardsReconcileToLeader(t *testing.T) {
	_, follower := leaderAndFollower(t)

	resp, body := follower.post(t, "/v1/reconcile",
		`{"entries":[{"entry_id":"e-fwd","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`, nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"recorded":1`) {
		t.Fatalf("经 follower 的对账应由 leader 完成: %d %s", resp.StatusCode, body)
	}
}

// 已经转发过一次的请求落到非 leader 上时必须就地失败：两个都自认不是 leader 的
// 副本互相转发会变成环。
func TestForwardedRequestIsNotForwardedAgain(t *testing.T) {
	leader, follower := leaderAndFollower(t)

	resp, body := follower.post(t, "/v1/placements", `{"task_id":"fwd-loop","cluster_id":"c1"}`,
		map[string]string{server.ForwardedHeader: "1"})
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("已转发的请求在非 leader 上应 503 no-leader: %d %s", resp.StatusCode, body)
	}
	if leader.hits.Load() != 0 {
		t.Fatalf("不得二次转发: leader 收到 %d 次请求", leader.hits.Load())
	}
}

// 租约仍有效但 leader 进程已不可达（刚崩溃、TTL 未到）：follower 不能挂起，
// 也不能把连接错误当成放置结果，只能快速失败并告诉调用方稍后重试。
func TestFollowerFailsFastWhenLeaderUnreachable(t *testing.T) {
	leader, follower := leaderAndFollower(t)
	leader.ts.Close()

	resp, body := follower.post(t, "/v1/placements", `{"task_id":"fwd-dead","cluster_id":"c1"}`, nil)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("leader 不可达应 503 no-leader: %d %s", resp.StatusCode, body)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatalf("应带 Retry-After，调用方才知道这是可重试的瞬态")
	}
	if n := rowCount(t, follower.st, `SELECT count(*) FROM scheduler_tasks WHERE task_id='fwd-dead'`); n != 0 {
		t.Fatalf("未被 leader 接受的任务不得落库: %d", n)
	}
}

// 没有广播地址的 leader（旧版本进程或未配置）不可转发：行为保持为原先的 503。
func TestFollowerDoesNotForwardWithoutAdvertisedURL(t *testing.T) {
	leaderStore := newStore(t)
	leader := newReplica(t, leaderStore)
	leaderStore.SetAdvertiseURL("")
	follower := newReplica(t, secondStore(t))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go election.Run(ctx, leader.elec, leader.st, "sched-leader", 5*time.Second, func(bool) {})
	waitFor(t, 2*time.Second, leader.elec.IsLeader)

	resp, body := follower.post(t, "/v1/placements", `{"task_id":"fwd-nourl","cluster_id":"c1"}`, nil)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("无广播地址应 503 no-leader: %d %s", resp.StatusCode, body)
	}
}
