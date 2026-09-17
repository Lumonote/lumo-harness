package domain

import (
	"strings"
	"testing"
)

// TestEvaluateClusterBoundaries 逐点钉住两段式判定的边界归属。
//
// 半开区间 [0,suspect) / [suspect,down) / [down,∞) 的意义全在边界那两个点上，
// 所以这里必须逐点断言而不是只测「中间值」。边界写反的后果不是「差一点」，
// 而是闸门早/晚一个整段开始拦放置。
func TestEvaluateClusterBoundaries(t *testing.T) {
	const suspect, down = 30000, 90000
	cases := []struct {
		name  string
		ageMS int64
		want  ClusterState
	}{
		{"负年龄（库端时钟回拨/未来时间戳）按健康处理", -1, ClusterHealthy},
		{"年龄 0", 0, ClusterHealthy},
		{"suspect 前 1ms", suspect - 1, ClusterHealthy},
		{"恰好等于 suspect 阈值", suspect, ClusterSuspect},
		{"down 前 1ms", down - 1, ClusterSuspect},
		{"恰好等于 down 阈值", down, ClusterDown},
		{"down 之后", down + 1, ClusterDown},
		{"极大年龄", 1 << 62, ClusterDown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EvaluateCluster(tc.ageMS, suspect, down); got != tc.want {
				t.Fatalf("age=%d suspect=%d down=%d: want %s, got %s",
					tc.ageMS, suspect, down, tc.want, got)
			}
			// 方法与纯函数必须同源，否则「谁来算」会变成两个答案。
			th := ClusterThresholds{SuspectMS: suspect, DownMS: down}
			if got := th.Evaluate(tc.ageMS); got != tc.want {
				t.Fatalf("ClusterThresholds.Evaluate 与 EvaluateCluster 不一致: want %s, got %s", tc.want, got)
			}
		})
	}
}

// TestValidateClusterThresholds 阈值反了/缺失时必须报错，且**点名变量**。
//
// 只断言「返回了错误」是不够的：真出问题时要运维改哪一个环境变量，全靠这条文案。
func TestValidateClusterThresholds(t *testing.T) {
	cases := []struct {
		name       string
		th         ClusterThresholds
		wantMentio string
	}{
		{"默认值合法", DefaultClusterThresholds(), ""},
		{"suspect 小于下限（秒级切换）", ClusterThresholds{SuspectMS: 999, DownMS: 90000}, "LUMO_CLUSTER_SUSPECT_MS"},
		{"down 非正", ClusterThresholds{SuspectMS: 30000, DownMS: 0}, "LUMO_CLUSTER_DOWN_MS"},
		{"down 为负", ClusterThresholds{SuspectMS: 30000, DownMS: -1}, "LUMO_CLUSTER_DOWN_MS"},
		{"反了", ClusterThresholds{SuspectMS: 90000, DownMS: 30000}, "LUMO_CLUSTER_SUSPECT_MS"},
		{"相等（suspect 永不可达）", ClusterThresholds{SuspectMS: 30000, DownMS: 30000}, "LUMO_CLUSTER_SUSPECT_MS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.th.Validate()
			if tc.wantMentio == "" {
				if err != nil {
					t.Fatalf("应合法, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("应报错")
			}
			if !strings.Contains(err.Error(), tc.wantMentio) {
				t.Fatalf("错误文案应点名 %s, got %q", tc.wantMentio, err.Error())
			}
		})
	}
}

// TestBlocksPlacement 只有 suspect 与 down 拦新放置，未知一律放行。
//
// 未知放行是**安全属性**而不是偷懒：把 unregistered / unjudged 也当成拒绝，
// 「注册表没配好」就会升级成「整个平台无法放置」。
func TestBlocksPlacement(t *testing.T) {
	cases := map[ClusterState]bool{
		ClusterHealthy:      false,
		ClusterSuspect:      true,
		ClusterDown:         true,
		ClusterUnregistered: false,
		ClusterUnjudged:     false,
	}
	for state, want := range cases {
		if got := state.BlocksPlacement(); got != want {
			t.Fatalf("%q.BlocksPlacement() = %v, want %v", state, got, want)
		}
	}
}

// TestJudgedStatesCoversEvaluableOutput 指标维度集合必须覆盖判定能产出的状态。
//
// 派生指标（lumo_scheduler_cluster_state）按 JudgedStates 展开，所以判定侧新增一档
// 而枚举没跟上时，那一档会**连一条序列都不产生**——「某集群卡在一个我们没在看的
// 档上」恰恰最该被看见。这里把可判定区间扫一遍，把产出的集合与枚举对齐。
//
// 局限要说清楚：这是抽样扫，理论上漏掉一个极窄的新取值是有可能的；真正的兜底是
// EvaluateCluster 只有两个分支这一事实本身（它没有别的返回点）。
func TestJudgedStatesCoversEvaluableOutput(t *testing.T) {
	const suspect, down = 30000, 90000
	produced := map[ClusterState]bool{}
	for age := int64(-5000); age <= down+5000; age += 500 {
		produced[EvaluateCluster(age, suspect, down)] = true
	}
	// 边界点单独再扫一遍（步长可能跨过去）。
	for _, edge := range []int64{0, suspect - 1, suspect, down - 1, down} {
		produced[EvaluateCluster(edge, suspect, down)] = true
	}
	declared := map[ClusterState]bool{}
	for _, s := range JudgedStates() {
		declared[s] = true
	}
	for s := range produced {
		if !declared[s] {
			t.Fatalf("判定会产出 %q，但它不在 JudgedStates() 里——指标维度会少一条序列", s)
		}
	}
	for s := range declared {
		if !produced[s] {
			t.Fatalf("JudgedStates() 声明了 %q，但任何年龄都推不出它——指标里会有一条永远为 0 的序列", s)
		}
	}
}

// TestAnnotateClusterStates 节点上的状态必须区分「未注册」与「能力关闭」。
func TestAnnotateClusterStates(t *testing.T) {
	th := ClusterThresholds{SuspectMS: 30000, DownMS: 90000}
	clusters := []Cluster{
		{ClusterID: "c-healthy", AgeMS: 1000},
		{ClusterID: "c-suspect", AgeMS: 45000},
		{ClusterID: "c-down", AgeMS: 600000},
	}
	nodes := []Node{
		{NodeID: "n1", ClusterID: "c-healthy"},
		{NodeID: "n2", ClusterID: "c-suspect"},
		{NodeID: "n3", ClusterID: "c-down"},
		{NodeID: "n4", ClusterID: "c-never-registered"},
		{NodeID: "n5", ClusterID: ""},
	}
	AnnotateClusterStates(nodes, clusters, ClusterAnnotation{Thresholds: th, HealthGate: true})
	want := []ClusterState{
		ClusterHealthy, ClusterSuspect, ClusterDown, ClusterUnregistered, ClusterUnregistered,
	}
	for i, w := range want {
		if nodes[i].ClusterState != w {
			t.Fatalf("节点 %s: want %s, got %s", nodes[i].NodeID, w, nodes[i].ClusterState)
		}
		if nodes[i].ClusterState.BlocksPlacement() != (w == ClusterSuspect || w == ClusterDown) {
			t.Fatalf("节点 %s 的闸门语义与状态不符: %s", nodes[i].NodeID, nodes[i].ClusterState)
		}
	}
}

// TestAnnotateClusterStatesEmptyRegistry 空注册表 == 每个集群都未注册。
//
// 这一条同时是「能力关闭」与「注册表空」的分界：能力关闭时这个函数根本不会被调用，
// 节点上留的是零值 ClusterUnjudged；一旦调用了它而注册表是空的，结论就是
// 「注册表里一个集群都没有」——那时留下的必须是 unregistered，不能是别的。
func TestAnnotateClusterStatesEmptyRegistry(t *testing.T) {
	nodes := []Node{{NodeID: "n1", ClusterID: "c1"}}
	AnnotateClusterStates(nodes, nil, ClusterAnnotation{Thresholds: DefaultClusterThresholds(), HealthGate: true})
	if nodes[0].ClusterState != ClusterUnregistered {
		t.Fatalf("空注册表应填 unregistered, got %q", nodes[0].ClusterState)
	}
}

// TestReportIntervalStaysBelowSuspect 自报周期必须显著小于 suspect 阈值。
//
// 这条不变量值一条用例：周期 ≥ 阈值时，本实例会在两次自报之间把自己判成可疑，
// 进而在闸门上**把自己挡在放置之外**——一个纯配置就能造成的自伤。
func TestReportIntervalStaysBelowSuspect(t *testing.T) {
	for _, th := range []ClusterThresholds{
		DefaultClusterThresholds(),
		{SuspectMS: 3000, DownMS: 9000},
		{SuspectMS: 1000, DownMS: 2000},
	} {
		if err := th.Validate(); err != nil {
			t.Fatalf("用例阈值应合法: %v", err)
		}
		interval := th.ReportInterval().Milliseconds()
		if interval <= 0 {
			t.Fatalf("%+v 派生的自报周期非正: %d", th, interval)
		}
		if interval >= th.SuspectMS {
			t.Fatalf("%+v 派生的自报周期 %dms 不小于 suspect 阈值——会把自己判成可疑", th, interval)
		}
	}
	if got := DefaultClusterThresholds().ReportInterval().Milliseconds(); got != 10000 {
		t.Fatalf("默认阈值应派生 10s 自报周期, got %dms", got)
	}
}

// TestResolveClusterEnforcement 判定开关的三态解析。
//
// 这里要钉住的是**向后兼容**与**显式覆盖**两条：留空必须仍然按身份派生
// （否则升级一次就让所有既有单集群部署的判定静默失效），显式取值必须能压过身份
// （否则「判定开、本实例不自报」这一档在全局调度形态下无法表达）。
func TestResolveClusterEnforcement(t *testing.T) {
	cases := []struct {
		name       string
		explicit   string
		identity   string
		wantEnable bool
		wantExpli  bool
	}{
		{"留空+有身份：派生为开（旧的单集群用法）", "", "cluster-a", true, false},
		{"留空+无身份：派生为关", "", "", false, false},
		{"显式 true+无身份：判定开而不自报（全局调度形态）", "true", "", true, true},
		{"显式 true+有身份", "true", "cluster-a", true, true},
		{"显式 false+有身份：只自报不判定", "false", "cluster-a", false, true},
		{"显式 false+无身份", "false", "", false, true},
		{"大小写与空白宽容", "  TRUE  ", "", true, true},
		{"1/0 别名", "1", "", true, true},
		{"0 别名", "0", "cluster-a", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveClusterEnforcement(tc.explicit, tc.identity)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if got.Enabled != tc.wantEnable || got.Explicit != tc.wantExpli {
				t.Fatalf("want {Enabled:%v Explicit:%v}, got %+v", tc.wantEnable, tc.wantExpli, got)
			}
		})
	}
}

// TestResolveClusterSelfReport 自报开关与身份**分开**解析。
//
// 拆开的理由是「认领身份但不自报」这一档真实存在：Helm chart 的每个 release 是一个集群的
// 节点池 + 该集群的调度器，而「调度器还在跑」不等于「这个集群还能接放置」——节点池缩到 0 时
// 调度器照旧活着，由它自报会让一个空集群一直显示健康。两者绑死时那个取舍只能靠
// **两个都不要**来回避，于是连降级路径也一起没了。
func TestResolveClusterSelfReport(t *testing.T) {
	cases := []struct {
		name     string
		explicit string
		identity string
		want     bool
	}{
		{"留空+有身份：派生为开（既有拓扑的行为逐字不变）", "", "cluster-a", true},
		{"留空+无身份：派生为关", "", "", false},
		{"显式 false+有身份：认领身份但不自报（chart 要的那一档）", "false", "cluster-a", false},
		{"显式 true+有身份", "true", "cluster-a", true},
		// 无身份却把开关打开是无害的：没有身份就没有可报的东西，调用点还按身份再判一次。
		// 这里不报错是刻意的——它不是一个会导致静默错误状态的组合。
		{"显式 true+无身份：无身份可报，开关开着也不产生动作", "true", "", true},
		{"大小写与空白宽容", "  FALSE  ", "cluster-a", false},
		{"0 别名", "0", "cluster-a", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveClusterSelfReport(tc.explicit, tc.identity)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if got != tc.want {
				t.Fatalf("want %v, got %v", tc.want, got)
			}
		})
	}
}

// TestResolveClusterSelfReportRejectsTypos 同 enforcement 的理由：打错字不能让自报
// 悄悄开或悄悄关——两种错误的可见度都极低，而后果是「集群没人报」或「空集群显示健康」。
func TestResolveClusterSelfReportRejectsTypos(t *testing.T) {
	for _, bad := range []string{"ture", "flase", "on", "2", "enabled"} {
		t.Run(bad, func(t *testing.T) {
			_, err := ResolveClusterSelfReport(bad, "cluster-a")
			if err == nil {
				t.Fatalf("%q 应被拒绝", bad)
			}
			if !strings.Contains(err.Error(), "LUMO_CLUSTER_SELF_REPORT") {
				t.Fatalf("错误文案必须点名变量，实际: %v", err)
			}
		})
	}
}

// TestResolveClusterEnforcementRejectsTypos 打错字必须报错而不是当成 false。
//
// `LUMO_CLUSTER_ENFORCE=ture` 若被静默当成 false，判定就悄悄关掉了——而「判定关着」
// 与「所有集群都健康」在面板上长得一模一样，没人会去查。
func TestResolveClusterEnforcementRejectsTypos(t *testing.T) {
	for _, bad := range []string{"ture", "flase", "on", "2", "enabled"} {
		t.Run(bad, func(t *testing.T) {
			_, err := ResolveClusterEnforcement(bad, "cluster-a")
			if err == nil {
				t.Fatalf("%q 应被拒绝", bad)
			}
			if !strings.Contains(err.Error(), "LUMO_CLUSTER_ENFORCE") {
				t.Fatalf("错误文案必须点名变量，实际: %v", err)
			}
		})
	}
}

// TestAllowsTaskMigration 只有 down 允许漂移。
//
// suspect 与 down 在这一点上**必须不同**：闸门（BlocksPlacement）在 suspect 就生效，
// 而漂移要等到 down。两者今天形状相似，但合成一个函数之后，任何一次「把闸门放宽成
// 只挡 down」的改动都会静默地同时放宽漂移——而漂移是不可逆动作。
func TestAllowsTaskMigration(t *testing.T) {
	cases := map[ClusterState]bool{
		ClusterHealthy:      false,
		ClusterSuspect:      false, // 关键：suspect 只挡新放置，已有任务不动
		ClusterDown:         true,
		ClusterUnregistered: false, // 配置事实，去改配置而不是搬家
		ClusterUnjudged:     false, // 本实例没有意见
	}
	for state, want := range cases {
		if got := state.AllowsTaskMigration(); got != want {
			t.Fatalf("%q.AllowsTaskMigration() = %v, want %v", state, got, want)
		}
	}
}

// TestMigrateEligibleTimeline 漂移时间线的边界逐点。
//
// 三段是**在同一条年龄轴上**依次发生的：suspect(默认 30s) 停止新放置 →
// down(默认 90s) → down+grace 才漂移已有任务。这里把每个拐点的两侧都钉住，
// 因为「早一个 tick 漂移」与「晚一个 tick」的差别是**一次全量任务搬家**。
func TestMigrateEligibleTimeline(t *testing.T) {
	const suspect, down = 30000, 90000
	th := ClusterThresholds{SuspectMS: suspect, DownMS: down}
	const grace = 300000

	cases := []struct {
		age  int64
		want bool
		note string
	}{
		{-1, false, "负年龄（时钟回拨）不漂移"},
		{0, false, "刚自报"},
		{suspect - 1, false, "healthy 档"},
		{suspect, false, "suspect 档起点——只挡新放置，绝不漂移"},
		{down - 1, false, "suspect 档末尾"},
		{down, false, "down 档起点：宽限还没过，仍不漂移"},
		{down + grace - 1, false, "宽限差 1ms"},
		{down + grace, true, "宽限刚过"},
		{down + grace + 1, true, "已过漂移点"},
		{1 << 40, true, "极长失联"},
	}
	for _, c := range cases {
		if got := th.MigrateEligible(c.age, grace); got != c.want {
			t.Fatalf("age=%d grace=%d：MigrateEligible=%v, want %v（%s）",
				c.age, grace, got, c.want, c.note)
		}
	}

	// grace=0 时漂移点就是 down 阈值——这是「忠于架构字面」的那一档，
	// 参数存在正是为了让运维能显式选择它。
	if !th.MigrateEligible(down, 0) {
		t.Fatal("grace=0 时 down 阈值本身就该是可漂移点")
	}
	if th.MigrateEligible(down-1, 0) {
		t.Fatal("grace=0 时 down 阈值之前仍不可漂移")
	}

	// **安全性质**：任何 grace ≥ 0 的组合下，允许漂移都蕴含该集群处于 down 档。
	// 这条把「漂移可能发生在 suspect 档」这个类别整体排除掉，而不是逐点验证。
	for _, g := range []int64{0, 1, 1000, grace, 10 * grace} {
		for age := int64(-2000); age <= down+grace+2000; age += 997 {
			if th.MigrateEligible(age, g) && th.Evaluate(age) != ClusterDown {
				t.Fatalf("age=%d grace=%d 允许漂移，但判定为 %q——漂移只能在 down 档发生",
					age, g, th.Evaluate(age))
			}
		}
	}
}

// TestValidateMigrationGrace 负数宽限拒绝启动，且点名变量。
//
// `-1` 在本仓库的约定里表示「显式关闭」（见 RunStallReaper 的 maxStall），但那是
// **循环开关**的语义，宽限期是**时间量**。两个含义挤进同一个数值会让人以为
// 「宽限=0」等于「漂移关着」——它其实是「down 即漂移」，最激进的那一档。
func TestValidateMigrationGrace(t *testing.T) {
	for _, ok := range []int64{0, 1, 300000} {
		if err := ValidateMigrationGrace(ok); err != nil {
			t.Fatalf("grace=%d 应合法: %v", ok, err)
		}
	}
	for _, bad := range []int64{-1, -300000} {
		err := ValidateMigrationGrace(bad)
		if err == nil {
			t.Fatalf("grace=%d 应被拒绝", bad)
		}
		if !strings.Contains(err.Error(), "LUMO_MIGRATE_GRACE_MS") {
			t.Fatalf("错误文案必须点名变量，实际: %v", err)
		}
	}
}
