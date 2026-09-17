package server

import (
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 降级放置的准入判据。四条「不降级」里有三条各自对应一种「放行会比 503 更坏」的情形，
// 所以它们不是防御性代码，而是这个功能的定义本身。
func TestDegradedPlacementJudgement(t *testing.T) {
	local := &domain.Lease{Holder: "n", FencingToken: 1, Scope: "cluster-a"}
	cases := []struct {
		name   string
		server *Server
		target string
		want   bool
		why    string
	}{
		{
			name:   "没有集群身份不降级",
			server: &Server{clusterElec: fakeLeader{leader: true, lease: local}, log: discardLogger()},
			target: "cluster-a", want: false,
			why: "不知道自己属于哪个集群的实例无从判断「本地」是什么",
		},
		{
			name:   "没有本地租约不降级",
			server: &Server{localClusterID: "cluster-a", clusterElec: fakeLeader{}, log: discardLogger()},
			target: "cluster-a", want: false,
			why: "降级是换一把更小的锁；没有锁就放行等于取消围栏",
		},
		{
			name:   "跨集群不降级",
			server: &Server{localClusterID: "cluster-a", clusterElec: fakeLeader{leader: true, lease: local}, log: discardLogger()},
			target: "cluster-b", want: false,
			why: "用本地锁批准跨集群放置，会造出两个集群各自以为自己是决策者",
		},
		{
			name:   "未指定集群的全局任务不降级",
			server: &Server{localClusterID: "cluster-a", clusterElec: fakeLeader{leader: true, lease: local}, log: discardLogger()},
			target: "", want: false,
			why: "空 cluster_id 意味着「去哪个集群」还没决定——那正是全局决策者要回答的问题",
		},
		{
			name:   "本集群且持锁则降级",
			server: &Server{localClusterID: "cluster-a", clusterElec: fakeLeader{leader: true, lease: local}, log: discardLogger()},
			target: "cluster-a", want: true,
			why: "本集群的任务落在本集群的节点上，不需要任何跨集群信息",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.server.degradedPlacement(tc.target)
			if (got != nil) != tc.want {
				t.Fatalf("降级判据 = %v，期望 %v —— %s", got != nil, tc.want, tc.why)
			}
		})
	}
}

// 计数只在**真的走了降级**时增长。它在正常路径上也涨的话，那条指标就变成了
// 「放置总数」的另一个名字，而读它的人会以为系统一直在降级。
func TestDegradedPlacementCountsOnlyDegraded(t *testing.T) {
	local := &domain.Lease{Holder: "n", FencingToken: 1, Scope: "cluster-a"}
	srv := &Server{localClusterID: "cluster-a", clusterElec: fakeLeader{leader: true, lease: local}, log: discardLogger()}

	if srv.DegradedPlacements() != 0 {
		t.Fatalf("初始计数应为 0: %d", srv.DegradedPlacements())
	}
	// 三条不该计的：跨集群、无身份、无租约。
	_ = srv.degradedPlacement("cluster-b")
	_ = (&Server{clusterElec: fakeLeader{leader: true, lease: local}, log: discardLogger()}).degradedPlacement("cluster-a")
	_ = (&Server{localClusterID: "cluster-a", clusterElec: fakeLeader{}, log: discardLogger()}).degradedPlacement("cluster-a")
	if srv.DegradedPlacements() != 0 {
		t.Fatalf("未放行不该计数: %d", srv.DegradedPlacements())
	}
	// 两次真的降级 → 2。
	_ = srv.degradedPlacement("cluster-a")
	_ = srv.degradedPlacement("cluster-a")
	if srv.DegradedPlacements() != 2 {
		t.Fatalf("降级计数 = %d，期望 2", srv.DegradedPlacements())
	}
}
