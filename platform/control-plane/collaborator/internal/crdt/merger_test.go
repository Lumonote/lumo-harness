package crdt

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

func TestUpdateSetMergerConvergesAndDeduplicates(t *testing.T) {
	first := []domain.Update{{DocID: "d", Seq: 2, Actor: "b", Payload: []byte("two")}, {DocID: "d", Seq: 1, Actor: "a", Payload: []byte("one")}}
	second := []domain.Update{{DocID: "d", Seq: 1, Actor: "a", Payload: []byte("one")}, {DocID: "d", Seq: 2, Actor: "b", Payload: []byte("two")}, {DocID: "d", Seq: 2, Actor: "b", Payload: []byte("two")}}
	m := UpdateSetMerger{}
	a, err := m.Merge(nil, first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Merge(nil, second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("merge did not converge:\n%s\n%s", a, b)
	}
	var state updateSetState
	if err := json.Unmarshal(a, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Updates) != 2 || state.Updates[0].Seq != 1 || state.Updates[1].Seq != 2 {
		t.Fatalf("state = %+v", state)
	}
}

func TestUpdateSetMergerRejectsUnknownState(t *testing.T) {
	if _, err := (UpdateSetMerger{}).Merge([]byte(`{"version":99}`), nil); err == nil {
		t.Fatal("expected version error")
	}
}
