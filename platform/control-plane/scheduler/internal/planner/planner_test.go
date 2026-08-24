package planner

import (
	"testing"

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
