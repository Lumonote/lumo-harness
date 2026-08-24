package integration_test

import (
	"context"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// TestCatalogRoundtrip upsert 后 List 读回，且重复 upsert 覆盖而非重复。
func TestCatalogRoundtrip(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}

	n := domain.Node{NodeID: "N1", ClusterID: "c1", Capacity: 4, Capabilities: []string{"llm", "pg"}}
	if err := cat.Upsert(ctx, n); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	n.Capacity = 8
	if err := cat.Upsert(ctx, n); err != nil {
		t.Fatalf("覆盖登记失败: %v", err)
	}

	nodes, err := cat.List(ctx)
	if err != nil {
		t.Fatalf("列节点失败: %v", err)
	}
	if len(nodes) != 1 {
		t.Fatalf("应有 1 个节点, got %d", len(nodes))
	}
	got := nodes[0]
	if got.NodeID != "N1" || got.Capacity != 8 || len(got.Capabilities) != 2 {
		t.Fatalf("节点读回不符: %+v", got)
	}
}
