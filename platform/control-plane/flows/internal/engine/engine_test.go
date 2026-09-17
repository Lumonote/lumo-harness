package engine

import (
	"context"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

func TestRunUsesDeterministicTopologicalOrder(t *testing.T) {
	var def domain.Definition
	def.Nodes = append(def.Nodes,
		domain.FlowNode{ID: "a", Operator: "identity"},
		domain.FlowNode{ID: "b", Operator: "identity"},
		domain.FlowNode{ID: "c", Operator: "identity"})
	def.Edges = append(def.Edges,
		domain.FlowEdge{From: "a", To: "c"},
		domain.FlowEdge{From: "b", To: "c"})
	r, err := New().Run(context.Background(), &def, "seed")
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Order) != 3 || r.Order[0] != "a" || r.Order[1] != "b" || r.Order[2] != "c" {
		t.Fatalf("order = %v", r.Order)
	}
}
