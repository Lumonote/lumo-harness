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
