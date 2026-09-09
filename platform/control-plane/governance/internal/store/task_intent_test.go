package store

import (
	"encoding/json"
	"testing"
)

func TestChildPlacementCannotWeakenParentBoundaries(t *testing.T) {
	parent := json.RawMessage(`{"cluster_id":"cluster-a","residency":"cn","trust_level":"managed","deadline_ms":100,"avoid_nodes":["revoked"]}`)
	for _, child := range []string{
		`{}`, `{"cluster_id":"cluster-b"}`,
		`{"cluster_id":"cluster-a","residency":"cn","trust_level":"managed","deadline_ms":101,"avoid_nodes":["revoked"]}`,
		`{"cluster_id":"cluster-a","residency":"cn","trust_level":"managed","deadline_ms":90,"avoid_nodes":[]}`,
	} {
		if err := preservesParentSchedule(parent, json.RawMessage(child)); err == nil {
			t.Fatalf("accepted weaker placement %s", child)
		}
	}
	if err := preservesParentSchedule(parent, json.RawMessage(`{"cluster_id":"cluster-a","residency":"cn","trust_level":"managed","deadline_ms":90,"avoid_nodes":["revoked","busy"]}`)); err != nil {
		t.Fatal(err)
	}
}
