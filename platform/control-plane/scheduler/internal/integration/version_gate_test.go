package integration_test

import (
	"context"
	"encoding/json"
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

// 本文件钉的是版本一致性前置与偏好打分在**真库**上才成立的那几件事：
//
//  ① 「省略即保持原值」与「显式声明空集」的区别只有真 SQL 能证明——它落在
//     `ON CONFLICT ... DO UPDATE` 的 CASE 与 declared 列的 OR 上，阅读代码看不出来
//     两次写入叠加之后到底是什么。
//  ② 版本闸门的端到端（注册表 → 目录注解 → planner → HTTP 状态码）：分段测试各自
//     通过而接线断掉是这类功能的典型故障，与 C1 存活闸门那条用例同源。
//  ③ 项目亲和的输入来自一条 GROUP BY，只有真库能证明它按 realm 隔离、只算活跃态。

// versionGateServer 装配一条完整的「注册表 → 目录注解 → 放置」链路。
//
// 与 main 的装配保持一致（两个闸门独立、注解在目录层），否则用例证明的是一条
// 生产上不存在的链路。
func versionGateServer(t *testing.T, st *store.Store, enforce, versionGate bool) *httptest.Server {
	t.Helper()
	ctx := context.Background()
	elec := &election.State{}
	annotation := domain.ClusterAnnotation{
		Thresholds:  clusterThresholds(),
		HealthGate:  enforce,
		VersionGate: versionGate,
	}
	cat := catalog.WithClusterStates(&catalog.Pg{Pool: st.Pool()}, st, annotation, discardLogger())
	srv := server.New(st, elec, cat, discardLogger())
	srv.SetClusterRegistry(st, clusterThresholds(), enforce, versionGate)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)

	eCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		election.Run(eCtx, elec, st, "version-gate-test", 5*time.Second, func(bool) {})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
		if err := st.Release(context.Background(), "version-gate-test"); err != nil {
			t.Errorf("释放租约失败: %v", err)
		}
	})
	waitFor(t, 2*time.Second, elec.IsLeader)
	return ts
}

func postJSON(t *testing.T, ts *httptest.Server, path, body string) (int, string) {
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

// TestClusterMetadataOmittedKeepsDeclaredValue 「省略即保持原值」与标记的单调性。
//
// 心跳远比声明频繁，而一个集群有多个上报方（调度实例 + 集群侧节点各报各的）。
// 若一次空心跳能把别人声明的版本清掉，注册表里那条记录将长期等于最后一次心跳的空值
// ——而版本闸门读的正是它。
//
// 同时钉住 capabilities 与 version 的**不对称**：capabilities 有显式 declared 标记
// （空集是一种声明），version 没有（空版本号不是）。见 domain.Cluster 的注释。
func TestClusterMetadataOmittedKeepsDeclaredValue(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	// ① 声明版本与能力。
	got, err := st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "r1", Namespace: "ns", Version: "v2",
		Capabilities: []string{"gpu"}, CapabilitiesDeclared: true,
	})
	if err != nil {
		t.Fatalf("首次注册失败: %v", err)
	}
	if got.Version != "v2" || !got.CapabilitiesDeclared {
		t.Fatalf("首次注册应写入声明: %+v", got)
	}

	// ② 纯心跳（什么都不给）：值保持。
	got, err = st.RegisterCluster(ctx, domain.Cluster{ClusterID: "c1", Realm: "r1"})
	if err != nil {
		t.Fatalf("心跳失败: %v", err)
	}
	if got.Version != "v2" {
		t.Fatalf("心跳不得清掉版本声明: %+v", got)
	}
	if !got.CapabilitiesDeclared || len(got.Capabilities) != 1 || got.Capabilities[0] != "gpu" {
		t.Fatalf("心跳不得清掉能力声明: %+v", got)
	}
	if got.Namespace != "ns" {
		t.Fatalf("心跳不得清掉 namespace: %+v", got)
	}

	// ③ 显式声明空能力集：**这一次真的能清空**——此前靠值反推「其实就是没给」时
	// 做不到，这一档差异正是 capabilities 必须有 declared 标记的原因。
	got, err = st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "r1", Capabilities: []string{}, CapabilitiesDeclared: true,
	})
	if err != nil {
		t.Fatalf("声明空能力集失败: %v", err)
	}
	if len(got.Capabilities) != 0 {
		t.Fatalf("显式声明空能力集必须真的清空: %+v", got)
	}
	if !got.CapabilitiesDeclared {
		t.Fatal("声明过就是声明过，标记不得回落")
	}
	if got.Version != "v2" {
		t.Fatalf("清空能力不该影响版本: %+v", got)
	}

	// ④ 版本升级：**只给版本串**（不带任何额外标记）就必须写进去。
	// 第一版给 version 也加了 declared 列，于是这一档静默变成空操作——
	// 而所有既有调用方写的正是这种形式。
	got, err = st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "r1", Version: "v3",
	})
	if err != nil {
		t.Fatalf("升级版本失败: %v", err)
	}
	if got.Version != "v3" {
		t.Fatalf("非空版本号本身就是一次声明，必须覆盖旧值: %+v", got)
	}
}

// TestClusterBlankVersionIsNormalizedToUndeclared 空版本号不是一种版本声明。
//
// 归一写在写路径上（store.RegisterCluster 的 `CASE WHEN EXCLUDED.version = ”`），
// 因为它只有一个地方能破。若放过去，空版本会成为一个「声明过的版本值」，判定侧拿它
// 当唯一版本时会把所有真版本判成分叉——全局放置整片停摆，而根因只是一次字段归一漏了。
func TestClusterBlankVersionIsNormalizedToUndeclared(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if _, err := st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "r1", Version: "v2",
	}); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	// 一次空版本心跳：既不是声明，也不得清掉已有的版本。
	got, err := st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c1", Realm: "r1", Version: "",
	})
	if err != nil {
		t.Fatalf("空版本心跳失败: %v", err)
	}
	if got.Version != "v2" {
		t.Fatalf("空版本必须按「省略」处理（保持原值）: %+v", got)
	}
	// 判定侧据此认为「无信息」而不是「版本是空串」。
	vc := domain.EvaluateVersionConsistency([]domain.Cluster{{ClusterID: "c9", Version: ""}},
		clusterThresholds(), true)
	if vc.Declared != 0 || !vc.Consistent || vc.FleetVersion != "" {
		t.Fatalf("空版本应被视为无信息: %+v", vc)
	}
}

// TestVersionGateEndToEnd 端到端：注册表 → 目录注解 → planner → HTTP。
//
// 断言的是**三种形状各自的状态码**，而不是「闸门有没有生效」这种笼统说法：
//   - 全局任务 + 版本分叉 → 202 + PENDING（转排队，不是报错）；
//   - 全局任务 + 指定 cluster_id → 201（显式意图不受闸门影响）；
//   - 全局任务 + 版本一致 → 201。
func TestVersionGateEndToEnd(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	ts := versionGateServer(t, st, true, true)

	if code, body := postJSON(t, ts, "/v1/nodes", `{"node_id":"N1","cluster_id":"c1","capacity":4,"capabilities":["llm"]}`); code != http.StatusOK {
		t.Fatalf("注册节点失败: %d %s", code, body)
	}
	if code, body := postJSON(t, ts, "/v1/nodes", `{"node_id":"N2","cluster_id":"c2","capacity":4,"capabilities":["llm"]}`); code != http.StatusOK {
		t.Fatalf("注册节点失败: %d %s", code, body)
	}

	// 两个集群声明**不同**版本 → 分叉。
	for _, c := range []domain.Cluster{
		{ClusterID: "c1", Realm: "r1", Version: "v1"},
		{ClusterID: "c2", Realm: "r1", Version: "v2"},
	} {
		if _, err := st.RegisterCluster(ctx, c); err != nil {
			t.Fatalf("注册集群失败: %v", err)
		}
	}

	code, body := postJSON(t, ts, "/v1/placements", `{"task_id":"t-global","requires":[{"key":"llm"}]}`)
	if code != http.StatusAccepted {
		t.Fatalf("版本分叉时全局任务应转排队（202）: %d %s", code, body)
	}
	var queued struct {
		State domain.TaskState `json:"state"`
	}
	if err := json.Unmarshal([]byte(body), &queued); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if queued.State != domain.StatePending {
		t.Fatalf("被版本闸门拦下的任务应是 PENDING, got %q", queued.State)
	}

	// 指定 cluster_id：闸门不该拦显式意图。
	code, body = postJSON(t, ts, "/v1/placements",
		`{"task_id":"t-pinned","cluster_id":"c1","requires":[{"key":"llm"}]}`)
	if code != http.StatusCreated {
		t.Fatalf("指定 cluster_id 的放置必须放行: %d %s", code, body)
	}
	var placed domain.Placement
	if err := json.Unmarshal([]byte(body), &placed); err != nil {
		t.Fatalf("解析放置响应失败: %v", err)
	}
	if placed.NodeID != "N1" {
		t.Fatalf("应落到 c1 的 N1: %+v", placed)
	}

	// 让 c2 也声明 v1 → 一致 → 全局任务可落地。
	if _, err := st.RegisterCluster(ctx, domain.Cluster{
		ClusterID: "c2", Realm: "r1", Version: "v1",
	}); err != nil {
		t.Fatalf("统一版本失败: %v", err)
	}
	code, body = postJSON(t, ts, "/v1/placements", `{"task_id":"t-global","requires":[{"key":"llm"}]}`)
	if code != http.StatusCreated {
		t.Fatalf("版本一致后同一任务应能放置: %d %s", code, body)
	}
}

// TestVersionGateOffIsPermissive 闸门关着时版本分叉不拦任何东西。
//
// 这是「默认关」这个决定的可执行版本：打开它会让「有人在滚动升级」变成「全局任务
// 排队」，那是产品决策而不是正确性修复，所以它必须显式打开。
func TestVersionGateOffIsPermissive(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	ts := versionGateServer(t, st, true, false)

	if code, body := postJSON(t, ts, "/v1/nodes", `{"node_id":"N1","cluster_id":"c1","capacity":4,"capabilities":["llm"]}`); code != http.StatusOK {
		t.Fatalf("注册节点失败: %d %s", code, body)
	}
	for _, c := range []domain.Cluster{
		{ClusterID: "c1", Realm: "r1", Version: "v1"},
		{ClusterID: "c2", Realm: "r1", Version: "v2"},
	} {
		if _, err := st.RegisterCluster(ctx, c); err != nil {
			t.Fatalf("注册集群失败: %v", err)
		}
	}
	code, body := postJSON(t, ts, "/v1/placements", `{"task_id":"t-global","requires":[{"key":"llm"}]}`)
	if code != http.StatusCreated {
		t.Fatalf("闸门关着时全局任务应照常放置: %d %s", code, body)
	}
}

// TestActiveClusterCountsByProjects 项目亲和的输入：按 realm 隔离、只算活跃态。
func TestActiveClusterCountsByProjects(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	seed := func(taskID, realm, project, cluster, state string) {
		t.Helper()
		if _, err := st.Pool().Exec(ctx, `
			INSERT INTO scheduler_tasks
				(task_id, realm, cluster_id, requires, priority, residency, deadline_ms, queue,
				 weight, avoid_nodes, preferred_clusters, state, attempt, node_id, fencing_token,
				 created_at, updated_at, worker_id, project_id)
			VALUES ($1,$2,$3,'[]',0,'',0,'default',1,'[]','[]',$4,1,$5,0,
			        (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint,'',$6)`,
			taskID, realm, cluster, state, "n-"+taskID, project); err != nil {
			t.Fatalf("播种任务失败: %v", err)
		}
	}
	seed("t1", "r1", "p1", "c1", "RUNNING")
	seed("t2", "r1", "p1", "c1", "PLACED")
	seed("t3", "r1", "p1", "c2", "RUNNING")
	seed("t4", "r1", "p1", "c1", "COMPLETED") // 终态不算
	seed("t5", "r1", "p2", "c2", "RUNNING")   // 别的项目
	seed("t6", "r2", "p1", "c1", "RUNNING")   // 别的 realm（隔离维度只信身份）

	got, err := st.ActiveClusterCountsByProjects(ctx, "r1", []string{"p1", "p2"})
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if got["p1"]["c1"] != 2 || got["p1"]["c2"] != 1 {
		t.Fatalf("p1 的分布不对: %+v", got["p1"])
	}
	if got["p2"]["c2"] != 1 {
		t.Fatalf("p2 的分布不对: %+v", got["p2"])
	}
	if len(got["p1"]) != 2 {
		t.Fatalf("别的 realm 不得计入: %+v", got["p1"])
	}

	// 空项目列表不查库也不报错：放置路径在没有项目归属时不该产生任何额外往返。
	empty, err := st.ActiveClusterCountsByProjects(ctx, "r1", nil)
	if err != nil {
		t.Fatalf("空列表失败: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("空列表应返回空 map: %+v", empty)
	}
}

// TestTaskPreferredClustersRoundTrip preferred_clusters 必须随任务持久化。
//
// 不持久化的后果只在 drain 路径上显形：HTTP 提交时带了偏好、被 drain 接续时偏好
// 消失，而两次放置的差别在响应里完全看不出来（都是 201/PLACED）。
func TestTaskPreferredClustersRoundTrip(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	lease, err := st.Acquire(ctx, "preferred-roundtrip", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}
	t.Cleanup(func() {
		if err := st.Release(context.Background(), "preferred-roundtrip"); err != nil {
			t.Errorf("释放租约失败: %v", err)
		}
	})

	task := domain.Task{
		TaskID: "t-pref", Realm: "r1", ClusterID: "", ProjectID: "p1",
		PreferredClusters: []string{"c2", "c3"},
	}
	if _, err := st.QueueTask(ctx, lease, task); err != nil {
		t.Fatalf("排队失败: %v", err)
	}
	pending, err := st.PendingTasks(ctx, 10)
	if err != nil {
		t.Fatalf("取排队任务失败: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("应有一条排队任务，得到 %d", len(pending))
	}
	if len(pending[0].PreferredClusters) != 2 ||
		pending[0].PreferredClusters[0] != "c2" || pending[0].PreferredClusters[1] != "c3" {
		t.Fatalf("偏好未往返: %+v", pending[0].PreferredClusters)
	}
}
