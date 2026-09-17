package domain

import (
	"strings"
	"testing"
)

// declared 一个声明了版本的健康集群。version 非空**就是**那次声明本身——
// version 没有配套的 declared 标记，判据见 Cluster.Version 的注释。
func declared(id, version string, ageMS int64) Cluster {
	return Cluster{ClusterID: id, Version: version, AgeMS: ageMS}
}

func undeclared(id string, ageMS int64) Cluster {
	return Cluster{ClusterID: id, AgeMS: ageMS}
}

// TestEvaluateVersionConsistency 判定集合、唯一版本与那处**刻意的不对称**。
//
// 不对称指的是：无人声明 → 一致（放行），两个不同版本 → 不一致（拦）。
// 前者是「没有信息」，后者是「信息互相矛盾」——没有信息时拦下来等于让「没人配版本」
// 升级成全平台停摆，而矛盾的信息恰恰是我们**能**做出判断的那种情况。
func TestEvaluateVersionConsistency(t *testing.T) {
	th := DefaultClusterThresholds()
	healthy := int64(1000)
	down := th.DownMS + 1000

	tests := []struct {
		name        string
		clusters    []Cluster
		healthGate  bool
		wantFleet   string
		wantCount   int
		wantConsist bool
	}{
		{"空注册表 → 一致但无信息", nil, true, "", 0, true},
		{"只有一个集群声明 → 它就是 fleet 版本", []Cluster{declared("c1", "v1", healthy)}, true, "v1", 1, true},
		{
			"两个集群声明同一个版本 → 一致",
			[]Cluster{declared("c1", "v2", healthy), declared("c2", "v2", healthy)},
			true, "v2", 2, true,
		},
		{
			"两个集群声明不同版本 → 不一致且 fleet 版本为空",
			[]Cluster{declared("c1", "v1", healthy), declared("c2", "v2", healthy)},
			true, "", 2, false,
		},
		{
			"未声明的集群不进判定集合（既不贡献版本也不拉低计数）",
			[]Cluster{declared("c1", "v2", healthy), undeclared("c2", healthy)},
			true, "v2", 1, true,
		},
		{
			"存活闸门开着时 down 集群不进判定集合：它的旧版本不该让全局放置停摆",
			[]Cluster{declared("c1", "v2", healthy), declared("c2", "v1", down)},
			true, "v2", 1, true,
		},
		{
			"存活闸门关着时 down 集群**仍然**在判定集合里：它照样能接新放置",
			[]Cluster{declared("c1", "v2", healthy), declared("c2", "v1", down)},
			false, "", 2, false,
		},
		{
			"suspect 与 down 同理：闸门开着时它们都不算",
			[]Cluster{declared("c1", "v2", healthy), declared("c2", "v1", th.SuspectMS)},
			true, "v2", 1, true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := EvaluateVersionConsistency(tc.clusters, th, tc.healthGate)
			if got.FleetVersion != tc.wantFleet {
				t.Fatalf("FleetVersion = %q, 期望 %q", got.FleetVersion, tc.wantFleet)
			}
			if got.Declared != tc.wantCount {
				t.Fatalf("Declared = %d, 期望 %d", got.Declared, tc.wantCount)
			}
			if got.Consistent != tc.wantConsist {
				t.Fatalf("Consistent = %v, 期望 %v", got.Consistent, tc.wantConsist)
			}
		})
	}
}

// TestEvaluateVersionConsistencyTreatsBlankVersionAsNoInformation 空版本号不是一种版本值。
//
// 判定侧是闸门的最后一道，所以这里再挡一次空串（写路径 store.RegisterCluster 的
// `CASE WHEN EXCLUDED.version = ”` 已经挡过一次，那是**保持原值**这一半）。放一个
// 空版本值进来会让它成为「唯一版本」，于是**所有**声明了真版本的集群都被判成不一致
// ——全局放置整片停摆，而根因只是一次字段归一漏了。
//
// 这条同时钉住「version 不需要 declared 标记」这个决定：如果有一个独立的标记，
// 就会出现「标记为真但值为空」这一档，而它没有任何合法含义。
func TestEvaluateVersionConsistencyTreatsBlankVersionAsNoInformation(t *testing.T) {
	th := DefaultClusterThresholds()
	blank := Cluster{ClusterID: "c-blank", Version: "", AgeMS: 1000}
	real := declared("c-real", "v2", 1000)
	got := EvaluateVersionConsistency([]Cluster{blank, real}, th, true)
	if got.Declared != 1 || got.FleetVersion != "v2" || !got.Consistent {
		t.Fatalf("空版本必须被忽略，得到 %+v", got)
	}
	// 单独一个空版本 = 无信息 = 放行，而不是「fleet 版本是空串」。
	only := EvaluateVersionConsistency([]Cluster{blank}, th, true)
	if only.Declared != 0 || !only.Consistent || only.FleetVersion != "" {
		t.Fatalf("只有一个空版本时应视为无信息，得到 %+v", only)
	}
}

// TestAnnotateClusterStatesVersionGate 版本闸门的裁决落到节点上。
func TestAnnotateClusterStatesVersionGate(t *testing.T) {
	th := DefaultClusterThresholds()
	nodes := []Node{
		{NodeID: "n1", ClusterID: "c1"},
		{NodeID: "n2", ClusterID: "c2"},
		{NodeID: "n3", ClusterID: "c3"}, // 未声明版本
		{NodeID: "n4", ClusterID: "c-never-registered"},
	}
	annotation := ClusterAnnotation{Thresholds: th, HealthGate: true, VersionGate: true}

	t.Run("版本一致：声明了该版本的放行，未声明的排除", func(t *testing.T) {
		got := append([]Node(nil), nodes...)
		AnnotateClusterStates(got, []Cluster{
			declared("c1", "v2", 1000), declared("c2", "v2", 1000), undeclared("c3", 1000),
		}, annotation)
		want := []bool{false, false, true, true}
		for i := range got {
			if got[i].ClusterVersionUnproven != want[i] {
				t.Fatalf("%s: ClusterVersionUnproven = %v, 期望 %v（集群版本 %q）",
					got[i].NodeID, got[i].ClusterVersionUnproven, want[i], got[i].ClusterVersion)
			}
		}
		if got[0].ClusterVersion != "v2" {
			t.Fatalf("节点必须带上所属集群声明的版本，得到 %q", got[0].ClusterVersion)
		}
	})

	t.Run("版本分叉：整体拒绝（含等于多数版本的那些）", func(t *testing.T) {
		got := append([]Node(nil), nodes...)
		AnnotateClusterStates(got, []Cluster{
			declared("c1", "v1", 1000), declared("c2", "v2", 1000), declared("c3", "v2", 1000),
		}, annotation)
		for i := range got {
			if !got[i].ClusterVersionUnproven {
				t.Fatalf("%s 在版本分叉时必须被排除（v2 是多数也不行）", got[i].NodeID)
			}
		}
	})

	t.Run("无人声明版本：放行（无信息 ≠ 不一致）", func(t *testing.T) {
		got := append([]Node(nil), nodes...)
		AnnotateClusterStates(got, []Cluster{undeclared("c1", 1000), undeclared("c2", 1000)}, annotation)
		for i := range got {
			if got[i].ClusterVersionUnproven {
				t.Fatalf("%s 在无人声明版本时必须放行", got[i].NodeID)
			}
		}
	})

	t.Run("未注册的集群被排除（版本闸门对未知 fail-closed，与存活闸门相反）", func(t *testing.T) {
		got := append([]Node(nil), nodes...)
		AnnotateClusterStates(got, []Cluster{declared("c1", "v2", 1000)}, annotation)
		if !got[3].ClusterVersionUnproven {
			t.Fatal("fleet 有版本而某集群未注册时，该集群必须被排除——否则不注册就能绕过闸门")
		}
		// 与存活闸门对比：同一个节点在存活闸门下是 unregistered，但那是**放行**的。
		if got[3].ClusterState != ClusterUnregistered {
			t.Fatalf("存活侧仍应是 unregistered，得到 %q", got[3].ClusterState)
		}
		if got[3].ClusterState.BlocksPlacement() {
			t.Fatal("存活闸门对 unregistered 必须是放行——两处方向相反是刻意的")
		}
	})

	t.Run("无人声明版本时未注册的集群也放行（fail-open 的那一半）", func(t *testing.T) {
		got := append([]Node(nil), nodes...)
		AnnotateClusterStates(got, []Cluster{undeclared("c1", 1000)}, annotation)
		for i := range got {
			if got[i].ClusterVersionUnproven {
				t.Fatalf("%s：无人声明版本时闸门没有可比的东西，必须放行", got[i].NodeID)
			}
		}
	})
}

// TestAnnotateClusterStatesVersionGateOffIsPermissive 闸门关着时零值必须是**放行**。
//
// 这条是安全属性：装饰器没装上、或注册表读不到时 `ClusterVersionUnproven` 保持零值。
// 若零值是「不放行」，一次装配缺失就会让整个平台的全局放置停摆——正是本设计反复
// 要避免的自伤。所以字段名取的是「阻断」而不是「放行」。
func TestAnnotateClusterStatesVersionGateOffIsPermissive(t *testing.T) {
	th := DefaultClusterThresholds()
	nodes := []Node{{NodeID: "n1", ClusterID: "c1"}, {NodeID: "n2", ClusterID: "c2"}}
	AnnotateClusterStates(nodes, []Cluster{
		declared("c1", "v1", 1000), declared("c2", "v2", 1000),
	}, ClusterAnnotation{Thresholds: th, HealthGate: true, VersionGate: false})
	for i := range nodes {
		if nodes[i].ClusterVersionUnproven {
			t.Fatalf("%s 在版本闸门关闭时必须放行", nodes[i].NodeID)
		}
	}
	// 零值节点（装饰器完全没装上）也必须是放行。
	if (Node{}).ClusterVersionUnproven {
		t.Fatal("零值节点的 ClusterVersionUnproven 必须是放行")
	}
}

// TestAnnotateClusterStatesHealthGateOffKeepsUnjudged 两个闸门真的独立。
//
// 只开版本闸门时，节点上**不能**留下存活判定结果：留着真状态而不拦，会让
// /v1/nodes 的读法看起来像存活闸门生效了（而它并没有），而「判定关着」与
// 「所有集群都健康」本来就长得一样。
func TestAnnotateClusterStatesHealthGateOffKeepsUnjudged(t *testing.T) {
	th := DefaultClusterThresholds()
	nodes := []Node{{NodeID: "n1", ClusterID: "c1"}}
	AnnotateClusterStates(nodes, []Cluster{declared("c1", "v2", th.DownMS+1000)},
		ClusterAnnotation{Thresholds: th, HealthGate: false, VersionGate: true})
	if nodes[0].ClusterState != ClusterUnjudged {
		t.Fatalf("存活闸门关着时状态必须是 unjudged，得到 %q", nodes[0].ClusterState)
	}
	if nodes[0].ClusterVersionUnproven {
		t.Fatal("存活闸门关着不影响版本闸门：c1 是唯一声明者，应放行")
	}
}

// TestResolveVersionGate 三态 + 打错字必须报错。
//
// 打错字（`ture`）若被静默当成 false，闸门就悄悄关掉了，而「闸门关着」与
// 「版本本来就一致」在观测面上长得一模一样（同 ResolveClusterEnforcement）。
func TestResolveVersionGate(t *testing.T) {
	tests := []struct {
		raw     string
		want    bool
		wantErr bool
	}{
		{"", false, false},
		{"false", false, false},
		{"0", false, false},
		{"no", false, false},
		{"FALSE", false, false},
		{"true", true, false},
		{"1", true, false},
		{"yes", true, false},
		{" True ", true, false},
		{"ture", false, true},
		{"on", false, true},
	}
	for _, tc := range tests {
		t.Run(tc.raw, func(t *testing.T) {
			got, err := ResolveVersionGate(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatal("非法取值必须报错")
				}
				if !strings.Contains(err.Error(), "LUMO_CLUSTER_VERSION_GATE") {
					t.Fatalf("错误信息必须点名变量，得到 %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("合法取值不该报错: %v", err)
			}
			if got != tc.want {
				t.Fatalf("ResolveVersionGate(%q) = %v, 期望 %v", tc.raw, got, tc.want)
			}
		})
	}
}
