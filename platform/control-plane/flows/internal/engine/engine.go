// Package engine executes a validated flow DAG.
// Operators are injected: the engine owns topology, ordering and failure
// propagation; components own business behavior.
package engine

import (
	"context"
	"fmt"
	"sort"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

type Operator func(context.Context, any) (any, error)

type Engine struct{ operators map[string]Operator }

type Result struct {
	Outputs map[string]any `json:"outputs"`
	Order   []string       `json:"order"`
}

func New() *Engine {
	e := &Engine{operators: map[string]Operator{}}
	e.Register("identity", func(_ context.Context, input any) (any, error) { return input, nil })
	e.Register("echo", func(_ context.Context, input any) (any, error) { return input, nil })
	return e
}

func (e *Engine) Register(name string, op Operator) {
	if name != "" && op != nil {
		e.operators[name] = op
	}
}

func (e *Engine) Run(ctx context.Context, def *domain.Definition, input any) (*Result, error) {
	if err := domain.ValidateDefinition(def); err != nil {
		return nil, err
	}
	nodes := make(map[string]string, len(def.Nodes))
	indeg := make(map[string]int, len(def.Nodes))
	incoming := make(map[string][]string, len(def.Nodes))
	adj := make(map[string][]string, len(def.Nodes))
	for _, node := range def.Nodes {
		nodes[node.ID] = node.Operator
		indeg[node.ID] = 0
	}
	for _, edge := range def.Edges {
		indeg[edge.To]++
		adj[edge.From] = append(adj[edge.From], edge.To)
		incoming[edge.To] = append(incoming[edge.To], edge.From)
	}
	ready := make([]string, 0)
	for id, degree := range indeg {
		if degree == 0 {
			ready = append(ready, id)
		}
	}
	sort.Strings(ready)
	result := &Result{Outputs: map[string]any{}, Order: make([]string, 0, len(nodes))}
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		operator, ok := e.operators[nodes[id]]
		if !ok {
			return nil, fmt.Errorf("flow engine: 未注册算子 %q（节点 %s）", nodes[id], id)
		}
		var nodeInput any = input
		parents := incoming[id]
		if len(parents) == 1 {
			nodeInput = result.Outputs[parents[0]]
		}
		if len(parents) > 1 {
			values := map[string]any{}
			for _, parent := range parents {
				values[parent] = result.Outputs[parent]
			}
			nodeInput = values
		}
		output, err := operator(ctx, nodeInput)
		if err != nil {
			return nil, fmt.Errorf("flow engine: 节点 %s 执行失败: %w", id, err)
		}
		result.Outputs[id] = output
		result.Order = append(result.Order, id)
		for _, next := range adj[id] {
			indeg[next]--
			if indeg[next] == 0 {
				ready = append(ready, next)
			}
		}
		sort.Strings(ready)
	}
	if len(result.Order) != len(nodes) {
		return nil, fmt.Errorf("flow engine: DAG 执行未收敛")
	}
	return result, nil
}
