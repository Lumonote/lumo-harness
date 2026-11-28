package engine

import (
	"context"
	"errors"
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

type testRecorder struct {
	start  func(domain.FlowNode) error
	finish func(domain.FlowNode) error
}

func (r testRecorder) Started(_ context.Context, node domain.FlowNode) error { return r.start(node) }
func (r testRecorder) Finished(_ context.Context, node domain.FlowNode, _ any, _ error) error {
	return r.finish(node)
}

func TestRecorderFailureStopsEffectsAndKeepsConfirmedResults(t *testing.T) {
	for _, phase := range []string{"start", "finish"} {
		t.Run(phase, func(t *testing.T) {
			e := New()
			calls := 0
			e.Register("effect", func(_ context.Context, input any) (any, error) {
				calls++
				return input, nil
			})
			def := &domain.Definition{Nodes: []domain.FlowNode{{ID: "a", Operator: "echo"}, {ID: "b", Operator: "effect"}, {ID: "c", Operator: "effect"}}, Edges: []domain.FlowEdge{{From: "a", To: "b"}, {From: "b", To: "c"}}}
			fail := errors.New("receipt unavailable")
			record := func(p string, node domain.FlowNode) error {
				if node.ID == "b" && p == phase {
					return fail
				}
				return nil
			}
			result, err := e.RunWithRecorder(context.Background(), def, "confirmed", testRecorder{
				start:  func(node domain.FlowNode) error { return record("start", node) },
				finish: func(node domain.FlowNode) error { return record("finish", node) },
			})
			wantCalls := 0
			if phase == "finish" {
				wantCalls = 1
			}
			if !errors.Is(err, fail) || calls != wantCalls || result == nil || len(result.Outputs) != 1 || result.Outputs["a"] != "confirmed" {
				t.Fatalf("phase=%s calls=%d result=%+v err=%v", phase, calls, result, err)
			}
		})
	}
}

func TestNodeFailureReturnsPartialResult(t *testing.T) {
	e := New()
	fail := errors.New("operator failed")
	e.Register("fail", func(context.Context, any) (any, error) { return nil, fail })
	def := &domain.Definition{Nodes: []domain.FlowNode{{ID: "a", Operator: "echo"}, {ID: "b", Operator: "fail"}}, Edges: []domain.FlowEdge{{From: "a", To: "b"}}}
	result, err := e.Run(context.Background(), def, "confirmed")
	if !errors.Is(err, fail) || result == nil || len(result.Outputs) != 1 || result.Outputs["a"] != "confirmed" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}
