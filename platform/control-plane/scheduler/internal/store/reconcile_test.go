package store

import "testing"

func TestReconcileStateOrderIsMonotonic(t *testing.T) {
	ordered := []string{"PENDING", "PLACED", "RUNNING", "COMPLETED"}
	for i, state := range ordered {
		if !validState(state) {
			t.Fatalf("%s should be valid", state)
		}
		if stateRank(state) != i {
			t.Fatalf("rank(%s) = %d, want %d", state, stateRank(state), i)
		}
	}
	if stateRank("RUNNING") <= stateRank("PLACED") {
		t.Fatal("running must dominate placed")
	}
	if validState("BROKEN") {
		t.Fatal("unknown state must be rejected")
	}
}
