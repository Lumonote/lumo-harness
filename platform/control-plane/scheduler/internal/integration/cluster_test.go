package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// 这些用例的价值集中在两件活库才能证明的事上：
//
//  ① 年龄**由 SQL 算**（改库里的 last_seen_at，年龄随之变化）——这是「时间基准在库端」
//     唯一可验证的形式，应用侧任何时钟相减都会在跨主机时钟不一致时产出 flake。
//  ② 闸门端到端生效：注册表 → 目录注解 → planner → HTTP 响应码。分段测试各自通过而
//     接线断掉是这类功能的典型故障，只有走一遍全链路才看得出来。

func clusterThresholds() domain.ClusterThresholds {
	return domain.ClusterThresholds{SuspectMS: 30000, DownMS: 90000}
}

// clusterAnnotation 存活闸门开、版本闸门关（本文件钉的是存活链路；
// 版本闸门的端到端用例单独写在下面，混在一起会让两种失败分不开）。
func clusterAnnotation() domain.ClusterAnnotation {
	return domain.ClusterAnnotation{Thresholds: clusterThresholds(), HealthGate: true}
}

// backdateCluster 把某集群的最后自报时刻往前推，模拟「它已经不再自报」。
//
// 刻意直接改库而不是「等 90 秒」：这条用例要证明的是**年龄从哪里来**，
// 等待只会让用例变慢而不增加证明力。
func backdateCluster(t *testing.T, st *store.Store, clusterID string, age time.Duration) {
	t.Helper()
	if _, err := st.Pool().Exec(context.Background(),
		`UPDATE scheduler_clusters SET last_seen_at = last_seen_at - $2 WHERE cluster_id = $1`,
		clusterID, age.Milliseconds()); err != nil {
		t.Fatalf("回拨集群自报时刻失败: %v", err)
	}
}

// TestClusterAgeIsComputedByTheDatabase 年龄来自库端时钟，而不是读取方的本地时钟。
func TestClusterAgeIsComputedByTheDatabase(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	c, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "r1", Namespace: "ns"})
	if err != nil {
		t.Fatalf("注册集群失败: %v", err)
	}
	if c.AgeMS < 0 || c.AgeMS > 5000 {
		t.Fatalf("刚自报的集群年龄应接近 0, got %d", c.AgeMS)
	}
	if c.RegisteredAt != c.LastSeenAt {
		t.Fatalf("首次注册时 registered_at 应等于 last_seen_at: %d vs %d", c.RegisteredAt, c.LastSeenAt)
	}

	// 再自报一次：last_seen_at 前进，registered_at **不动**（「刚上线」与
	// 「注册很久一直在报」是两件不同的事，合并成一个时间戳就再也分不出来）。
	time.Sleep(20 * time.Millisecond)
	again, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "r1"})
	if err != nil {
		t.Fatalf("二次自报失败: %v", err)
	}
	if again.RegisteredAt != c.RegisteredAt {
		t.Fatalf("registered_at 不应被自报刷新: %d → %d", c.RegisteredAt, again.RegisteredAt)
	}
	if again.LastSeenAt <= c.LastSeenAt {
		t.Fatalf("last_seen_at 应前进: %d → %d", c.LastSeenAt, again.LastSeenAt)
	}

	// 把自报时刻回拨 45 秒：年龄必须跟着变成 ~45s，并因此落到 suspect 档。
	backdateCluster(t, st, "c1", 45*time.Second)
	clusters, err := st.ClusterAges(ctx)
	if err != nil {
		t.Fatalf("列集群失败: %v", err)
	}
	if len(clusters) != 1 {
		t.Fatalf("应只有 1 个集群: %+v", clusters)
	}
	age := clusters[0].AgeMS
	if age < 44000 || age > 47000 {
		t.Fatalf("年龄应由库端算出约 45000ms, got %d", age)
	}
	if got := clusterThresholds().Evaluate(age); got != domain.ClusterSuspect {
		t.Fatalf("45s 应判为 suspect, got %s", got)
	}

	// 单条读取走上同一条路径（否则两个端点会各算各的）。
	single, err := st.ClusterByID(ctx, "c1")
	if err != nil {
		t.Fatalf("读单个集群失败: %v", err)
	}
	if single.AgeMS < 44000 || single.AgeMS > 47000 {
		t.Fatalf("单条读取的年龄不符: %d", single.AgeMS)
	}
}

// TestClusterRealmCannotBeOverwritten 跨 realm 的同名注册被拒，且不留半截写入。
func TestClusterRealmCannotBeOverwritten(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	first, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "dev", Version: "1.0"})
	if err != nil {
		t.Fatalf("首次注册失败: %v", err)
	}

	if _, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "other", Version: "9.9"}); !errors.Is(err, store.ErrClusterRealmConflict) {
		t.Fatalf("跨 realm 覆盖应报 ErrClusterRealmConflict, got %v", err)
	}
	got, err := st.ClusterByID(ctx, "c1")
	if err != nil {
		t.Fatalf("读集群失败: %v", err)
	}
	if got.Realm != "dev" || got.Version != "1.0" {
		t.Fatalf("被拒的写入不得留下任何痕迹: %+v", got)
	}
	if got.LastSeenAt != first.LastSeenAt {
		t.Fatalf("被拒的写入连 last_seen_at 都不该动: %d → %d", first.LastSeenAt, got.LastSeenAt)
	}

	// 未声明 realm 的写入不算归属：首次带 realm 的注册成为该集群的归属。
	if _, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c2"}); err != nil {
		t.Fatalf("无 realm 注册失败: %v", err)
	}
	adopted, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c2", Realm: "dev"})
	if err != nil {
		t.Fatalf("首次声明 realm 应被接受: %v", err)
	}
	if adopted.Realm != "dev" {
		t.Fatalf("realm 应被采纳为 dev, got %q", adopted.Realm)
	}
}

// TestClusterMetadataSurvivesAPureHeartbeat 空心跳不得抹掉元数据。
//
// 一个集群有**多个上报方**（调度实例与集群侧的承载节点各报各的，见 dsh-node 的
// cluster-reporter.ts），而心跳远比声明频繁。按「谁后写谁赢」处理的话，
// namespace / capabilities / version 将长期等于最后一次心跳的空值——声明得再准也会在
// 下一次心跳时丢掉，而丢掉之后没有任何迹象：列还是那三列，只是变空了。
// 与 E8 的配置面写入口径同一条判据：可选字段省略即保持原值。
func TestClusterMetadataSurvivesAPureHeartbeat(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	if _, err := st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "dev", Namespace: "ns-a",
		Capabilities: []string{"subagent", "seam"}, Version: "3.1.4",
	}); err != nil {
		t.Fatalf("声明式注册失败: %v", err)
	}

	// 纯心跳：请求体里一个声明都没有（空体与空字段在协议上等价，见 server.clusterReport）。
	beaten, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "dev"})
	if err != nil {
		t.Fatalf("纯心跳失败: %v", err)
	}
	if beaten.Namespace != "ns-a" || beaten.Version != "3.1.4" {
		t.Fatalf("纯心跳抹掉了元数据：namespace=%q version=%q", beaten.Namespace, beaten.Version)
	}
	if len(beaten.Capabilities) != 2 || beaten.Capabilities[0] != "subagent" {
		t.Fatalf("纯心跳抹掉了 capabilities: %v", beaten.Capabilities)
	}
	if beaten.AgeMS < 0 || beaten.AgeMS > 5000 {
		t.Fatalf("自报时刻必须无论如何都被刷新（否则集群会被误判失联）: %d", beaten.AgeMS)
	}

	// 但**显式**声明仍然覆盖：省略即保持，不等于不能改。
	updated, err := st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "dev", Namespace: "ns-b", Version: "3.2.0",
	})
	if err != nil {
		t.Fatalf("更新声明失败: %v", err)
	}
	if updated.Namespace != "ns-b" || updated.Version != "3.2.0" {
		t.Fatalf("显式声明应覆盖: %+v", updated)
	}
	if len(updated.Capabilities) != 2 {
		t.Fatalf("未声明的字段仍应保持原值: %v", updated.Capabilities)
	}
}

// TestClusterNotRegisteredIsDistinctFromDown 「不在注册表里」与「已注册但失联」是两件事。
func TestClusterNotRegisteredIsDistinctFromDown(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	if _, err := st.ClusterByID(ctx, "nope"); !errors.Is(err, store.ErrClusterNotRegistered) {
		t.Fatalf("未注册应报 ErrClusterNotRegistered, got %v", err)
	}
	if _, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "r1"}); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	backdateCluster(t, st, "c1", 5*time.Minute)
	c, err := st.ClusterByID(ctx, "c1")
	if err != nil {
		t.Fatalf("已注册的集群即使失联也必须读得到: %v", err)
	}
	if state := clusterThresholds().Evaluate(c.AgeMS); state != domain.ClusterDown {
		t.Fatalf("5 分钟未自报应判为 down, got %s", state)
	}
}

// TestPlacementGateBlocksClusterThatStoppedReporting 端到端：注册表 → 目录注解 → 闸门 → HTTP。
func TestPlacementGateBlocksClusterThatStoppedReporting(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	elec := &election.State{}

	// 目录被包装成「读节点时带上集群状态」，与 main 的装配一致。
	cat := catalog.WithClusterStates(&catalog.Pg{Pool: st.Pool()}, st, clusterAnnotation(), discardLogger())
	srv := server.New(st, elec, cat, discardLogger())
	srv.SetClusterRegistry(st, clusterThresholds(), true, false)
	ts := httptest.NewServer(srv.Routes())
	defer ts.Close()

	post := func(path, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatalf("构造请求失败: %v", err)
		}
		req.Header.Set("X-Lumo-Realm", "r1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(out)
	}

	// 选举的关停必须**显式释放租约**，不能只 cancel：
	// `election.Run` 在 ctx 取消时直接 return，释放是关停方的责任（生产由
	// `cmd/scheduler/main.go` 在停服务时调 `st.Release`）。只 cancel 的话这条租约
	// 会以**未过期**的状态留在库里直到 TTL(此处 5s) 到点，同一轮运行里排在后面的用例
	// 去竞选 leader 时会拿到 not-acquired，卡在 `waitFor(IsLeader)` 上。
	// 顺序也有讲究：先 cancel 再等 goroutine 退出，最后才 Release；否则恰好在
	// 续租 tick 上的 goroutine 会在 Release 之后把租约重新抢回来。
	//
	// 注意这不等于「把租约行清空」：`Release` 只置 `expires_at = 0` 而保留 holder
	// （token 高水位的需要，见 `store.Release` 的注释）。所以它并不让
	// `ddl_test.go` 的「初始租约为空」成立，那条断言的前提由该用例自己复位。
	eCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		election.Run(eCtx, elec, st, "gate-test", 5*time.Second, func(bool) {})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
		if err := st.Release(context.Background(), "gate-test"); err != nil {
			t.Errorf("释放租约失败: %v", err)
		}
	})
	waitFor(t, 2*time.Second, elec.IsLeader)

	if code, body := post("/v1/nodes", `{"node_id":"N1","cluster_id":"c1","capacity":4,"capabilities":["llm"]}`); code != http.StatusOK {
		t.Fatalf("注册节点失败: %d %s", code, body)
	}
	// 集群从未注册（能力打开着）→ unregistered → 放行。
	code, body := post("/v1/placements", `{"task_id":"t-unregistered","cluster_id":"c1","requires":[{"key":"llm"}]}`)
	if code != http.StatusCreated {
		t.Fatalf("未注册集群应放行（判不了不等于要停摆）: %d %s", code, body)
	}

	// 注册该集群后让它失联：新任务必须停在排队，而不是落到这个集群。
	if _, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "r1"}); err != nil {
		t.Fatalf("注册集群失败: %v", err)
	}
	backdateCluster(t, st, "c1", 2*time.Minute)

	code, body = post("/v1/placements", `{"task_id":"t-blocked","cluster_id":"c1","requires":[{"key":"llm"}]}`)
	if code != http.StatusAccepted {
		t.Fatalf("失联集群应拒绝新放置并转排队（202）: %d %s", code, body)
	}
	var pending struct {
		State domain.TaskState `json:"state"`
	}
	if err := json.Unmarshal([]byte(body), &pending); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if pending.State != domain.StatePending {
		t.Fatalf("被闸门拦下的任务应是 PENDING, got %q", pending.State)
	}

	// 同一批任务在集群恢复后必须能落地（证明只是停手，不是把任务丢了）。
	// 断言到 PLACED 而不是「201」：PendingTask 的幂等回放对 PENDING 任务返回 nil，
	// 所以这里必须真的走了一遍放置，只看状态码会把「其实没放成」也算通过。
	if _, err := st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "r1"}); err != nil {
		t.Fatalf("恢复自报失败: %v", err)
	}
	code, body = post("/v1/placements", `{"task_id":"t-blocked","cluster_id":"c1","requires":[{"key":"llm"}]}`)
	if code != http.StatusCreated {
		t.Fatalf("集群恢复后同一任务应能放置: %d %s", code, body)
	}
	var placed domain.Placement
	if err := json.Unmarshal([]byte(body), &placed); err != nil {
		t.Fatalf("解析放置响应失败: %v", err)
	}
	if placed.State != domain.StatePlaced || placed.NodeID != "N1" || placed.Attempt != 1 {
		t.Fatalf("集群恢复后应真正落到 N1: %+v", placed)
	}
}
