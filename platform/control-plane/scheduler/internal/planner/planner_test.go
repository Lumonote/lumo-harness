package planner

import (
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

func reqs(keys ...string) []domain.Requirement {
	out := make([]domain.Requirement, len(keys))
	for i, k := range keys {
		out[i] = domain.Requirement{Key: k}
	}
	return out
}

func TestPickFiltersByCapability(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 4, Capabilities: []string{"llm"}},
		{NodeID: "b", Capacity: 4, Capabilities: []string{"doris"}},
	}
	task := domain.Task{Requires: reqs("llm")}
	got := Pick(task, nodes, map[string]int{})
	if got == nil || got.NodeID != "a" {
		t.Fatalf("应按能力过滤, got %+v", got)
	}
}

func TestPickSkipsFullNodes(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 1, Capabilities: []string{"llm"}},
		{NodeID: "b", Capacity: 2, Capabilities: []string{"llm"}},
	}
	task := domain.Task{Requires: reqs("llm")}
	got := Pick(task, nodes, map[string]int{"a": 1})
	if got == nil || got.NodeID != "b" {
		t.Fatalf("满槽节点应跳过, got %+v", got)
	}
}

func TestPickBalancesAndTiesDeterministically(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 2, Capabilities: []string{"llm"}},
		{NodeID: "b", Capacity: 2, Capabilities: []string{"llm"}},
	}
	task := domain.Task{Requires: reqs("llm")}
	if got := Pick(task, nodes, map[string]int{}); got == nil || got.NodeID != "a" {
		t.Fatalf("空载应选字典序最小, got %+v", got)
	}
	if got := Pick(task, nodes, map[string]int{"a": 1}); got == nil || got.NodeID != "b" {
		t.Fatalf("应选负载低者, got %+v", got)
	}
}

func TestPickNilWhenNoCandidate(t *testing.T) {
	nodes := []domain.Node{{NodeID: "a", Capacity: 1, Capabilities: []string{"llm"}}}
	task := domain.Task{Requires: reqs("doris")}
	if got := Pick(task, nodes, map[string]int{}); got != nil {
		t.Fatalf("无候选应为 nil, got %+v", got)
	}
}

func TestFullEligibleNodesKeepsHardConstraintsForPreemption(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "eligible-full", Realm: "r1", ClusterID: "c1", Capacity: 1, Residency: "cn-east", Capabilities: []string{"llm"}},
		{NodeID: "eligible-free", Realm: "r1", ClusterID: "c1", Capacity: 2, Residency: "cn-east", Capabilities: []string{"llm"}},
		{NodeID: "wrong-realm", Realm: "r2", ClusterID: "c1", Capacity: 1, Residency: "cn-east", Capabilities: []string{"llm"}},
		{NodeID: "wrong-capability", Realm: "r1", ClusterID: "c1", Capacity: 1, Residency: "cn-east", Capabilities: []string{"doris"}},
	}
	task := domain.Task{Realm: "r1", ClusterID: "c1", Residency: "cn-east", Requires: reqs("llm")}
	full := FullEligibleNodes(task, nodes, map[string]int{"eligible-full": 1, "eligible-free": 1, "wrong-realm": 1, "wrong-capability": 1})
	if len(full) != 1 || full[0].NodeID != "eligible-full" {
		t.Fatalf("抢占只应考虑同 realm 的已满兼容节点, got %+v", full)
	}
}

func TestPickEnforcesDataResidency(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "outside", Capacity: 4, Residency: "eu", Capabilities: []string{"llm"}},
		{NodeID: "inside", Capacity: 4, Residency: "cn-east", Capabilities: []string{"llm"}},
	}
	got := Pick(domain.Task{Requires: reqs("llm"), Residency: "cn-east"}, nodes, nil)
	if got == nil || got.NodeID != "inside" {
		t.Fatalf("应拒绝驻留域外节点, got %+v", got)
	}
}

func TestPickEnforcesCluster(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "other", ClusterID: "cluster-b", Capacity: 4, Capabilities: []string{"llm"}},
		{NodeID: "target", ClusterID: "cluster-a", Capacity: 4, Capabilities: []string{"llm"}},
	}
	got := Pick(domain.Task{ClusterID: "cluster-a", Requires: reqs("llm")}, nodes, nil)
	if got == nil || got.NodeID != "target" {
		t.Fatalf("应拒绝目标集群外节点, got %+v", got)
	}
}

func TestPickEnforcesRealm(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "other-realm", Realm: "r2", Capacity: 4, Capabilities: []string{"llm"}},
		{NodeID: "same-realm", Realm: "r1", Capacity: 4, Capabilities: []string{"llm"}},
	}
	got := Pick(domain.Task{Realm: "r1", Requires: reqs("llm")}, nodes, nil)
	if got == nil || got.NodeID != "same-realm" {
		t.Fatalf("应拒绝其他 realm 的节点, got %+v", got)
	}
}

func TestPickEnforcesAntiAffinityAndRequirementValue(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 4, Capabilities: []string{"subagent", "gpu=a10"}},
		{NodeID: "b", Capacity: 4, Capabilities: []string{"subagent", "gpu=a100"}},
	}
	task := domain.Task{Requires: []domain.Requirement{{Key: "subagent", Value: ""}, {Key: "gpu", Value: "a100"}}, AvoidNodes: []string{"b"}}
	if got := Pick(task, nodes, nil); got != nil {
		t.Fatalf("反亲和应拒绝唯一匹配节点, got %+v", got)
	}
	task.AvoidNodes = nil
	if got := Pick(task, nodes, nil); got == nil || got.NodeID != "b" {
		t.Fatalf("应匹配 capability value, got %+v", got)
	}
}

func TestOrderPendingEDFAndWeightedFairQueue(t *testing.T) {
	now := time.UnixMilli(1000)
	tasks := []domain.Task{
		{TaskID: "slow-a", Queue: "a", Weight: 2, EnqueuedAt: now},
		{TaskID: "slow-b", Queue: "b", Weight: 1, EnqueuedAt: now},
		{TaskID: "urgent", Queue: "a", DeadlineMS: 900, EnqueuedAt: now},
		{TaskID: "slow-a2", Queue: "a", Weight: 2, EnqueuedAt: now.Add(time.Millisecond)},
	}
	got := OrderPending(tasks, now)
	if got[0].TaskID != "urgent" {
		t.Fatalf("过期任务应优先, got %+v", got)
	}
	if got[1].TaskID != "slow-a" || got[2].TaskID != "slow-b" || got[3].TaskID != "slow-a2" {
		t.Fatalf("权重队列顺序错误, got %+v", got)
	}
}

// TestPickSkipsClustersThatStoppedReporting 集群失联时不再接受新放置（§7.4.1）。
//
// suspect 与 down 都拦；未注册与本实例未判定（零值）都放行——判不了不等于要停摆，
// 把「注册表没配好」也当成拒绝会让整个平台停止放置。
func TestPickSkipsClustersThatStoppedReporting(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a-healthy", ClusterID: "c1", Capacity: 4, Capabilities: []string{"llm"}, ClusterState: domain.ClusterHealthy},
		{NodeID: "b-suspect", ClusterID: "c2", Capacity: 4, Capabilities: []string{"llm"}, ClusterState: domain.ClusterSuspect},
		{NodeID: "c-down", ClusterID: "c3", Capacity: 4, Capabilities: []string{"llm"}, ClusterState: domain.ClusterDown},
		{NodeID: "d-unregistered", ClusterID: "c4", Capacity: 4, Capabilities: []string{"llm"}, ClusterState: domain.ClusterUnregistered},
		{NodeID: "e-unjudged", ClusterID: "c5", Capacity: 4, Capabilities: []string{"llm"}},
	}
	eligible := EligibleNodes(domain.Task{Requires: reqs("llm")}, nodes)
	got := make([]string, 0, len(eligible))
	for _, n := range eligible {
		got = append(got, n.NodeID)
	}
	want := []string{"a-healthy", "d-unregistered", "e-unjudged"}
	if len(got) != len(want) {
		t.Fatalf("候选集不符: want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("候选集不符: want %v, got %v", want, got)
		}
	}
	// Pick 也不能返回被拦下的节点（它走的是同一个 EligibleNodes）。
	if picked := Pick(domain.Task{Requires: reqs("llm")}, nodes, nil); picked == nil || picked.NodeID != "a-healthy" {
		t.Fatalf("应选健康集群的节点, got %+v", picked)
	}
}

// TestPickDoesNotFallBackToAnotherCluster 失联集群的任务保持排队，不搬到别的集群。
//
// 这条是**边界**而不是实现细节：跨集群迁移是不可逆的状态变更，§7.4.1 要求迁移前
// 先确认 fencing，所以本轮只在放置路径上停手。若这里悄悄落到别的集群，等于用
// 「闸门」的名字做了迁移——一个没有审计、没有 fencing 的版本。
func TestPickDoesNotFallBackToAnotherCluster(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "in-target", ClusterID: "c-suspect", Capacity: 4, Capabilities: []string{"llm"}, ClusterState: domain.ClusterSuspect},
		{NodeID: "other-cluster", ClusterID: "c-healthy", Capacity: 4, Capabilities: []string{"llm"}, ClusterState: domain.ClusterHealthy},
	}
	task := domain.Task{ClusterID: "c-suspect", Requires: reqs("llm")}
	if got := Pick(task, nodes, nil); got != nil {
		t.Fatalf("显式指定集群的任务不应落到别的集群, got %+v", got)
	}
	// 放宽到「任意集群」时才允许落到健康集群（空 cluster_id 本来就是任意集群）。
	task.ClusterID = ""
	if got := Pick(task, nodes, nil); got == nil || got.NodeID != "other-cluster" {
		t.Fatalf("任意集群的任务应落到健康集群, got %+v", got)
	}
}

// TestFullEligibleNodesKeepsClusterHealthGate 抢占路径同样绕不过集群闸门。
//
// FullEligibleNodes 是「已满但兼容」的候选集，抢占只能从它里面挑受害者。集群失联
// 的节点若出现在这里，调度器就会为了腾槽位去停掉一个**已经联系不上**的集群上的任务。
func TestFullEligibleNodesKeepsClusterHealthGate(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "suspect-full", Realm: "r1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}, ClusterState: domain.ClusterSuspect},
		{NodeID: "down-full", Realm: "r1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}, ClusterState: domain.ClusterDown},
		{NodeID: "healthy-full", Realm: "r1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}, ClusterState: domain.ClusterHealthy},
	}
	active := map[string]int{"suspect-full": 1, "down-full": 1, "healthy-full": 1}
	full := FullEligibleNodes(domain.Task{Realm: "r1", Requires: reqs("llm")}, nodes, active)
	if len(full) != 1 || full[0].NodeID != "healthy-full" {
		t.Fatalf("抢占只应考虑健康集群的已满节点, got %+v", full)
	}
}
