package catalog

import (
	"encoding/json"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

func TestMetadataIsNacosJSON(t *testing.T) {
	raw := metadata(domain.Node{
		NodeID:       "node-a",
		ClusterID:    "cluster-a",
		Capacity:     4,
		Capabilities: []string{"llm", "web,fetch"},
		Residency:    "cn-east",
	})
	var got map[string]string
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("metadata must be JSON: %v", err)
	}
	if got["node_id"] != "node-a" || got["cluster_id"] != "cluster-a" || got["capacity"] != "4" {
		t.Fatalf("unexpected metadata: %#v", got)
	}
	if got["capabilities"] != `["llm","web,fetch"]` {
		t.Fatalf("unexpected capabilities: %#v", got["capabilities"])
	}
}

func TestSplitCapabilitiesJSON(t *testing.T) {
	got := split(`["llm","web,fetch"]`)
	if len(got) != 2 || got[1] != "web,fetch" {
		t.Fatalf("unexpected capabilities: %#v", got)
	}
}

func TestNacosDefaults(t *testing.T) {
	c := NewNacos("http://nacos:8848", "", "")
	if c.service != "lumo-dsh-node" || c.group != "DEFAULT_GROUP" {
		t.Fatalf("unexpected defaults: %#v", c)
	}
}
