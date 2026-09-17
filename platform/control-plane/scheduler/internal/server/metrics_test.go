package server

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// stubCatalog 固定的目录实现，让节点快照的用例不必连 Nacos 或 PG。
type stubCatalog struct {
	nodes []domain.Node
	err   error
}

func (c *stubCatalog) List(context.Context) ([]domain.Node, error) { return c.nodes, c.err }
func (c *stubCatalog) Upsert(context.Context, domain.Node) error   { return nil }

func metricsServer(cat catalog.Catalog) *Server {
	return &Server{catalog: cat, log: slog.New(slog.DiscardHandler)}
}

func TestRefreshNodeSnapshotCountsByCluster(t *testing.T) {
	cat := &stubCatalog{nodes: []domain.Node{
		{NodeID: "n1", ClusterID: "cn-north"},
		{NodeID: "n2", ClusterID: "cn-north"},
		{NodeID: "n3", ClusterID: "cn-south"},
	}}
	srv := metricsServer(cat)
	srv.RefreshNodeSnapshot(context.Background())

	snap := srv.snapshot()
	if !snap.ok {
		t.Fatal("成功读取后 ok 应为 true")
	}
	if snap.at.IsZero() {
		t.Fatal("成功读取后应记下时刻")
	}
	if snap.counts["cn-north"] != 2 || snap.counts["cn-south"] != 1 {
		t.Fatalf("按集群计数不符: %v", snap.counts)
	}
	if _, ok := snap.ids["n3"]; !ok {
		t.Fatalf("节点 id 集合应包含全部节点: %v", snap.ids)
	}
}

// TestRefreshNodeSnapshotKeepsLastKnownSetOnFailure 是这一层最关键的安全属性：
// 目录读不到时**不能**把节点集合当成空的。
//
// 若失败即清空，一次目录抖动会让全部活跃任务都被判成孤儿，进而触发大规模死信
// 迁移——spec §7.4.1 要求「迁移前必须确认 fencing」正是要挡住这件事。所以失败
// 只翻 ok=0 并冻结时刻，让 staleness 自己成为信号。
func TestRefreshNodeSnapshotKeepsLastKnownSetOnFailure(t *testing.T) {
	cat := &stubCatalog{nodes: []domain.Node{{NodeID: "n1", ClusterID: "cn-north"}}}
	srv := metricsServer(cat)
	srv.RefreshNodeSnapshot(context.Background())
	before := srv.snapshot()

	cat.err = errors.New("nacos unreachable")
	cat.nodes = nil
	srv.RefreshNodeSnapshot(context.Background())
	after := srv.snapshot()

	if after.ok {
		t.Fatal("读取失败后 ok 应为 false")
	}
	if after.counts["cn-north"] != 1 {
		t.Fatalf("失败时节点集合必须保留上一份，实际 %v", after.counts)
	}
	if len(after.ids) != 1 {
		t.Fatalf("失败时节点 id 集合必须保留上一份，实际 %v", after.ids)
	}
	if !after.at.Equal(before.at) {
		t.Fatalf("失败时时刻必须冻结（age 才会一直涨），%v -> %v", before.at, after.at)
	}
}

func TestDeriveTaskSeriesFillsZeroForMissingCombinations(t *testing.T) {
	counts := []store.TaskStateCount{{State: "PENDING", ClusterID: "cn-north", Count: 4}}
	points := deriveTaskSeries(counts, []string{"cn-north"})

	got := make(map[string]float64, len(points))
	for _, point := range points {
		if len(point.Labels) != 2 {
			t.Fatalf("任务序列必须同时带 state 与 cluster_id: %v", point.Labels)
		}
		got[point.Labels["state"]] = point.Value
	}
	if len(got) != len(nonTerminalStates) {
		t.Fatalf("每个集群都应展开出全部非终态，实际 %d 条: %v", len(got), got)
	}
	if got["PENDING"] != 4 {
		t.Fatalf("有数据的组合应为真实计数: %v", got)
	}
	// 缺的组合补 0 而不是不导出：某集群 PENDING 归零而 RUNNING 还有任务时，
	// 撤掉序列会让 rate 断档，而「值为 0」才是正确的语义。
	for _, state := range nonTerminalStates {
		if _, ok := got[state]; !ok {
			t.Fatalf("缺失的组合必须补 0，而不是不导出: %v", state)
		}
	}
}

// TestDeriveTaskSeriesExportsUnregisteredStates 防的是「按已知状态列表展开」这种
// 写法：库里出现一个本层没登记的状态时，那样写会让它连一条序列都不产生——
// 而「任务卡在一个我们没在看的 state」恰恰是最该被看见的一类。
func TestDeriveTaskSeriesExportsUnregisteredStates(t *testing.T) {
	counts := []store.TaskStateCount{{State: "QUARANTINED", ClusterID: "cn-north", Count: 2}}
	points := deriveTaskSeries(counts, []string{"cn-north"})

	found := false
	for _, point := range points {
		if point.Labels["state"] == "QUARANTINED" {
			found = true
			if point.Value != 2 {
				t.Fatalf("未登记状态的值应为真实计数，实际 %v", point.Value)
			}
		}
	}
	if !found {
		t.Fatalf("未登记的状态必须仍然导出: %v", points)
	}
}

func TestDeriveOldestPendingZeroForIdleCluster(t *testing.T) {
	waits := []store.PendingWait{{ClusterID: "cn-north", Seconds: 412.5}}
	points := deriveOldestPending(waits, []string{"cn-north", "cn-south"})

	got := make(map[string]float64, len(points))
	for _, point := range points {
		got[point.Labels["cluster_id"]] = point.Value
	}
	if got["cn-north"] != 412.5 {
		t.Fatalf("排队时长不符: %v", got)
	}
	// 队列清空时必须落回 0，否则排队告警永不解除。
	if value, ok := got["cn-south"]; !ok || value != 0 {
		t.Fatalf("没有排队任务的集群应为 0，实际 %v (存在=%v)", value, ok)
	}
}

// TestKnownClustersUnionsCatalogAndTasks 两侧缺一不可：只取目录会漏掉
// 「节点全没了但还有排队任务」的集群（node_down 要抓的正是那一态），
// 只取任务会漏掉「有节点但当前没有任何任务」的集群。
func TestKnownClustersUnionsCatalogAndTasks(t *testing.T) {
	snap := nodeSnapshot{counts: map[string]int{"cn-north": 2}}
	counts := []store.TaskStateCount{{State: "RUNNING", ClusterID: "cn-east", Count: 1}}
	waits := []store.PendingWait{{ClusterID: "cn-west", Seconds: 9}}

	got := knownClusters(counts, waits, snap)
	want := map[string]bool{"cn-north": true, "cn-east": true, "cn-west": true}
	if len(got) != len(want) {
		t.Fatalf("集群集合应为三者之并，实际 %v", got)
	}
	for _, cluster := range got {
		if !want[cluster] {
			t.Fatalf("多出了不该有的集群: %v", got)
		}
	}
}

func TestOrphanedActiveCountsOnlyUnknownNodes(t *testing.T) {
	active := map[string]int{"n1": 2, "gone": 3, "also-gone": 1}
	ids := map[string]struct{}{"n1": {}, "n2": {}}
	if got := orphanedActive(active, ids); got != 4 {
		t.Fatalf("孤儿活跃任务数应为 4（gone 3 + also-gone 1），实际 %d", got)
	}
	if got := orphanedActive(active, nil); got != 6 {
		// 空节点集合意味着「全部未知」。调用方必须自己保证只有拿到过快照
		// 才走到这里（见 publishSchedulerMetrics），这条断言把该前提钉住。
		t.Fatalf("空节点集合下全部活跃任务都算未知，实际 %d", got)
	}
}

func TestRunMetricsRefreshStopsWithContext(t *testing.T) {
	cat := &stubCatalog{nodes: []domain.Node{{NodeID: "n1", ClusterID: "cn-north"}}}
	srv := metricsServer(cat)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.RunMetricsRefresh(ctx, time.Hour)
	}()
	// 首次刷新是同步的（循环开始前先刷一次），所以不必等 ticker。
	deadline := time.Now().Add(2 * time.Second)
	for srv.snapshot().at.IsZero() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if srv.snapshot().at.IsZero() {
		t.Fatal("进入循环前应先刷一次快照，否则首个抓取周期内节点数是空的")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后刷新循环必须退出")
	}
}

func TestBoolGauge(t *testing.T) {
	if boolGauge(true) != 1 || boolGauge(false) != 0 {
		t.Fatal("布尔量必须落成 1/0，否则 Prometheus 侧无法比较")
	}
}

// TestEveryDomainStateIsClassified 是「状态集漂移」的兜底。
//
// 导出面把状态分成两组：非终态逐条导出，终态不导出（理由见
// store.NonTerminalStateCounts）。这两组分别写在 server 与 store 两个包里，
// 状态机将来多一个状态时，很容易只改 domain 而忘了分类——那会让新状态既不在
// 非终态列表里、也不在终态列表里，于是它对应的任务在指标上凭空消失。
// 这条用例不需要数据库，因此它永远在跑。
func TestEveryDomainStateIsClassified(t *testing.T) {
	all := []domain.TaskState{
		domain.StatePending, domain.StatePlaced, domain.StateRunning,
		domain.StateCancelling, domain.StateCompleted, domain.StateFailed, domain.StateAborted,
	}
	terminal := make(map[string]struct{})
	for _, state := range store.TerminalStates() {
		terminal[state] = struct{}{}
	}
	nonTerminal := make(map[string]struct{}, len(nonTerminalStates))
	for _, state := range nonTerminalStates {
		nonTerminal[state] = struct{}{}
	}
	for _, state := range all {
		name := string(state)
		_, isTerminal := terminal[name]
		_, isNonTerminal := nonTerminal[name]
		if isTerminal == isNonTerminal {
			t.Fatalf("状态 %s 必须恰好被分到一组（终态=%v，非终态=%v）："+
				"漏分类会让它在指标上静默消失", name, isTerminal, isNonTerminal)
		}
		// 分组必须与状态机自己的判断一致，否则「终态」这个词在两处含义不同。
		if state.Terminal() != isTerminal {
			t.Fatalf("状态 %s 的分组与 TaskState.Terminal() 不符", name)
		}
	}
}

// TestDeriveClusterAgesConvertsToSeconds 年龄以秒导出（Prometheus 的惯例单位）。
func TestDeriveClusterAgesConvertsToSeconds(t *testing.T) {
	points := deriveClusterAges([]domain.Cluster{
		{ClusterID: "c1", AgeMS: 45000},
		{ClusterID: "c2", AgeMS: 0},
	})
	if len(points) != 2 {
		t.Fatalf("每个集群一条序列: %+v", points)
	}
	got := map[string]float64{}
	for _, p := range points {
		got[p.Labels["cluster_id"]] = p.Value
	}
	if got["c1"] != 45 || got["c2"] != 0 {
		t.Fatalf("秒数换算不符: %+v", got)
	}
}

// TestDeriveClusterStatesIsOneHotPerCluster 每个集群恰好一条为 1，且与判定同源。
//
// 一簇一维而不是把状态编码成数值：数值枚举在 PromQL 里没法读也没法告警
// （`> 0.5` 是在猜哪一档是几），而一簇一维可以直接
// lumo_scheduler_cluster_state{state="down"} == 1。
func TestDeriveClusterStatesIsOneHotPerCluster(t *testing.T) {
	th := domain.ClusterThresholds{SuspectMS: 30000, DownMS: 90000}
	clusters := []domain.Cluster{
		{ClusterID: "c-healthy", AgeMS: 1000},
		{ClusterID: "c-suspect", AgeMS: 40000},
		{ClusterID: "c-down", AgeMS: 120000},
	}
	points := deriveClusterStates(clusters, th)
	if len(points) != len(clusters)*len(domain.JudgedStates()) {
		t.Fatalf("应为每个集群展开全部判定状态: got %d 条", len(points))
	}
	ones := map[string][]string{}
	for _, p := range points {
		cluster, state := p.Labels["cluster_id"], p.Labels["state"]
		switch p.Value {
		case 1:
			ones[cluster] = append(ones[cluster], state)
		case 0:
		default:
			t.Fatalf("一簇一维的值只能是 0/1: %+v", p)
		}
	}
	want := map[string]string{"c-healthy": "healthy", "c-suspect": "suspect", "c-down": "down"}
	for cluster, states := range ones {
		if len(states) != 1 {
			t.Fatalf("集群 %s 应有且只有一条为 1, got %v", cluster, states)
		}
		if states[0] != want[cluster] {
			t.Fatalf("集群 %s 的当前状态应为 %s, got %s", cluster, want[cluster], states[0])
		}
	}
	if len(ones) != len(clusters) {
		t.Fatalf("每个集群都必须有当前状态: %+v", ones)
	}
}

// TestDeriveClusterStatesEmptyRegistryHasNoSeries 空注册表导出零条序列。
//
// 零条而不是「每条状态各 0」：整体替换下零条等于**撤下全部序列**，那正是
// 「注册表里没有集群」应有的样子；若造出一堆 0，图上会出现一个「一切都健康」
// 的假象，而实际是一个集群都没注册。
func TestDeriveClusterStatesEmptyRegistryHasNoSeries(t *testing.T) {
	if points := deriveClusterStates(nil, domain.DefaultClusterThresholds()); len(points) != 0 {
		t.Fatalf("空注册表不应产生序列: %+v", points)
	}
}
