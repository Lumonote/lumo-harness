package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// clusterServerWith 装配一个可指定版本闸门开关的服务。
func clusterServerWith(t *testing.T, dir clusterDirectory, enforce, versionGate bool) *httptest.Server {
	t.Helper()
	srv := &Server{log: slog.New(slog.DiscardHandler)}
	srv.SetClusterRegistry(dir, domain.ClusterThresholds{SuspectMS: 30000, DownMS: 90000}, enforce, versionGate)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts
}

func putCluster(t *testing.T, ts *httptest.Server, id, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, ts.URL+"/v1/clusters/"+id, bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.Header.Set("X-Lumo-Realm", "dev")
	req.Header.Set("Content-Type", "application/json")
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

// TestReportClusterDeclaresMetadataExplicitly 「省略」与「声明了一个空值」必须分得开
// ——但**只有 capabilities 需要这条区分**。
//
// capabilities：注册表此前靠值反推「其实就是没给」（`capabilities IN (”, '[]', 'null')`），
// 于是「显式声明空能力集」根本做不到，而空能力集是一个真实约束（这个集群没有 GPU）。
// 现在标记与值分开，它才表达得出来。
//
// version：**不需要**标记。判据是「空值是不是一种有意义的声明」——空版本号不是，
// 所以「说没说版本」就是版本串是否非空。第一版按对称性也给 version 加了标记，
// 代价是 `{"version":"v2"}` 这种最自然的写法（不带标记）静默不写入，
// 而返回值看起来一切正常。这条用例就是钉住那件事别再回来。
func TestReportClusterDeclaresMetadataExplicitly(t *testing.T) {
	cases := []struct {
		name             string
		body             string
		wantCapsDeclared bool
		wantCaps         []string
		wantVersion      string
	}{
		{
			"纯心跳（空体）：什么都不声明",
			`{}`,
			false, nil, "",
		},
		{
			"显式 null：同样是不声明",
			`{"capabilities":null,"version":null}`,
			false, nil, "",
		},
		{
			"声明能力集与版本：版本**不需要**额外的标记就能写进去",
			`{"capabilities":["gpu"],"version":"v2"}`,
			true, []string{"gpu"}, "v2",
		},
		{
			"显式声明**空**能力集：这是一次声明（能清空），不是「没给」",
			`{"capabilities":[]}`,
			true, []string{}, "",
		},
		{
			"空字符串版本不是一种版本声明",
			`{"version":""}`,
			false, nil, "",
		},
		{
			"版本两边的空白被去掉（否则 ' v2' 会变成一个谁都比不上的版本值）",
			`{"version":"  v2  "}`,
			false, nil, "v2",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := &stubClusters{}
			ts := clusterServerWith(t, dir, true, false)
			res := putCluster(t, ts, "c1", tc.body)
			if res.StatusCode != http.StatusOK {
				t.Fatalf("状态码 %d", res.StatusCode)
			}
			if dir.regCalls != 1 {
				t.Fatalf("注册调用次数 %d", dir.regCalls)
			}
			got := dir.lastReg
			if got.CapabilitiesDeclared != tc.wantCapsDeclared {
				t.Fatalf("CapabilitiesDeclared = %v, 期望 %v", got.CapabilitiesDeclared, tc.wantCapsDeclared)
			}
			if tc.wantVersion != got.Version {
				t.Fatalf("Version = %q, 期望 %q", got.Version, tc.wantVersion)
			}
			// nil 与空切片在协议上是两件事（一个「没给」、一个「给了空集」），
			// 所以这里比的是长度与 nil 性，不是 DeepEqual 的宽松版本。
			if (got.Capabilities == nil) != (tc.wantCaps == nil) {
				t.Fatalf("Capabilities = %#v, 期望 %#v", got.Capabilities, tc.wantCaps)
			}
			if len(got.Capabilities) != len(tc.wantCaps) {
				t.Fatalf("Capabilities = %#v, 期望 %#v", got.Capabilities, tc.wantCaps)
			}
		})
	}
}

// TestListClustersReportsVersionGateState 集合级结论必须与集群列表一起给出。
//
// 只给每个集群的 version 字段，读的人无从知道闸门会怎么裁：「A 报 v1、B 报 v2」是
// 分叉，而「A 报 v1、B 什么都没说」在列表上看起来是同一件事，闸门却都拦。
func TestListClustersReportsVersionGateState(t *testing.T) {
	dir := &stubClusters{clusters: []domain.Cluster{
		{ClusterID: "c1", Version: "v2", AgeMS: 1000},
		{ClusterID: "c2", Version: "v2", AgeMS: 1000},
		{ClusterID: "c3", AgeMS: 1000},
	}}
	ts := clusterServerWith(t, dir, true, true)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/clusters", nil)
	req.Header.Set("X-Lumo-Realm", "dev")
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer res.Body.Close()
	var got struct {
		VersionGate             bool   `json:"version_gate"`
		FleetVersion            string `json:"fleet_version"`
		VersionConsistent       bool   `json:"version_consistent"`
		VersionDeclaredClusters int    `json:"version_declared_clusters"`
		Enforced                bool   `json:"enforced"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if !got.VersionGate || !got.Enforced {
		t.Fatalf("两个开关都要如实回报: %+v", got)
	}
	if got.FleetVersion != "v2" || !got.VersionConsistent || got.VersionDeclaredClusters != 2 {
		t.Fatalf("版本一致性结论不对: %+v", got)
	}
}

// TestListClustersVersionGateOffIsReportedAsOff 闸门关着时必须如实说「关着」。
//
// 「闸门关着」与「版本本来就一致」在只看结论时长得一样（都是放行），所以开关本身
// 必须出现在响应里——否则运维无法区分「我配了没生效」与「我根本没配」。
func TestListClustersVersionGateOffIsReportedAsOff(t *testing.T) {
	dir := &stubClusters{clusters: []domain.Cluster{
		{ClusterID: "c1", Version: "v1", AgeMS: 1000},
		{ClusterID: "c2", Version: "v2", AgeMS: 1000},
	}}
	ts := clusterServerWith(t, dir, true, false)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/clusters", nil)
	req.Header.Set("X-Lumo-Realm", "dev")
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer res.Body.Close()
	var got struct {
		VersionGate       bool   `json:"version_gate"`
		VersionConsistent bool   `json:"version_consistent"`
		FleetVersion      string `json:"fleet_version"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if got.VersionGate {
		t.Fatal("闸门关着时 version_gate 必须是 false")
	}
	// 结论字段仍然如实给出（它是注册表的事实，不是闸门的裁决）：
	// c1 与 c2 版本不同 → 不一致。把它藏起来会让运维看不到「一旦打开就会拦」。
	if got.VersionConsistent || got.FleetVersion != "" {
		t.Fatalf("结论字段应如实反映分叉: %+v", got)
	}
}

// TestReportVersionBlockCountsOnlyWhenGateOnAndLogsOnce 版本拦截的计数与**状态跃迁**日志。
//
// 为什么值得一条用例：被版本闸门拦住的任务走的是与「没有容量」完全相同的排队路径
// （202 + PENDING），只看响应分不开。计数与日志是唯一能分开两者的东西，
// 而「逐次打日志」会把真正要看的那条刷屏埋掉（同 RunClusterReporter 的理由）。
func TestReportVersionBlockCountsOnlyWhenGateOnAndLogsOnce(t *testing.T) {
	resetVersionBlockState()
	blocked := domain.Node{NodeID: "n1", Realm: "dev", ClusterID: "c1", ClusterVersionUnproven: true}
	nodes := []domain.Node{blocked}
	task := domain.Task{TaskID: "t1", Realm: "dev"}

	t.Run("闸门关着：不计数", func(t *testing.T) {
		srv := &Server{log: slog.New(slog.DiscardHandler)}
		srv.reportVersionBlock(context.Background(), task, nodes)
		if got := readVersionBlocked(); got != 0 {
			t.Fatalf("闸门关着时不该计数，得到 %d", got)
		}
	})

	t.Run("闸门开着：计数，且只记一条跃迁日志", func(t *testing.T) {
		var buf bytes.Buffer
		srv := &Server{log: slog.New(slog.NewTextHandler(&buf, nil)), versionGate: true}
		for i := 0; i < 5; i++ {
			srv.reportVersionBlock(context.Background(), task, nodes)
		}
		if got := readVersionBlocked(); got != 5 {
			t.Fatalf("每一次被拦都要计数，得到 %d", got)
		}
		if n := bytes.Count(buf.Bytes(), []byte("版本闸门拦住")); n != 1 {
			t.Fatalf("只应在状态跃迁时打日志，实际 %d 条：\n%s", n, buf.String())
		}
		// 恢复（放置成功）后再被拦，必须重新打一条——否则「被拦 → 恢复 → 又被拦」
		// 只有第一条会被说出来。
		clearVersionBlock()
		srv.reportVersionBlock(context.Background(), task, nodes)
		if n := bytes.Count(buf.Bytes(), []byte("版本闸门拦住")); n != 2 {
			t.Fatalf("恢复后再被拦应重新打一条，实际 %d 条", n)
		}
	})

	t.Run("指定了 cluster_id 的任务不算被版本闸门拦住", func(t *testing.T) {
		resetVersionBlockState()
		srv := &Server{log: slog.New(slog.DiscardHandler), versionGate: true}
		pinned := domain.Task{TaskID: "t2", Realm: "dev", ClusterID: "c1"}
		srv.reportVersionBlock(context.Background(), pinned, nodes)
		if got := readVersionBlocked(); got != 0 {
			t.Fatalf("固定放置不该计入版本拦截，得到 %d", got)
		}
	})
}

var versionBlockResetMu sync.Mutex

func resetVersionBlockState() {
	versionBlockResetMu.Lock()
	defer versionBlockResetMu.Unlock()
	placementStats.mu.Lock()
	placementStats.versionBlocked = 0
	placementStats.mu.Unlock()
	clearVersionBlock()
}

func readVersionBlocked() int64 {
	placementStats.mu.Lock()
	defer placementStats.mu.Unlock()
	return placementStats.versionBlocked
}
