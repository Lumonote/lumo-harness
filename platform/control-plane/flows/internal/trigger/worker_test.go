package trigger

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/store"
)

type fakeOutbox struct {
	mu      sync.Mutex
	items   []store.TriggerRecord
	acked   []uint64
	claimed bool
}

func (f *fakeOutbox) RequeueStaleTriggers(context.Context, int64) error { return nil }
func (f *fakeOutbox) ClaimTriggers(_ context.Context, _ string, _ int) ([]store.TriggerRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimed {
		return nil, nil
	}
	f.claimed = true
	return f.items, nil
}
func (f *fakeOutbox) AckTrigger(_ context.Context, id uint64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acked = append(f.acked, id)
	return nil
}

func TestWorkerPublishesAndAcksOnlyAfterHandlersSucceed(t *testing.T) {
	fake := &fakeOutbox{items: []store.TriggerRecord{{
		ID: 7, Realm: "r1", Name: "deploy", Payload: json.RawMessage(`{"value":1}`),
		ReplayAutomationID: "deploy-prod", ReplayFlowID: "flow-deploy", ReplayFlowVersion: 3, ReplayOfRunID: 41,
	}}}
	bus := New()
	var got Event
	bus.Subscribe("deploy", func(_ context.Context, event Event) error { got = event; return nil })
	worker := NewWorker(fake, bus, "test")
	worker.cycle(context.Background())
	if got.ID != 7 || got.Realm != "r1" || got.Name != "deploy" || !got.IsReplay() ||
		got.ReplayAutomationID != "deploy-prod" || got.ReplayFlowID != "flow-deploy" || got.ReplayFlowVersion != 3 || got.ReplayOfRunID != 41 {
		t.Fatalf("unexpected event: %+v", got)
	}
	if len(fake.acked) != 1 || fake.acked[0] != 7 {
		t.Fatalf("expected one ack, got %v", fake.acked)
	}
}

func TestWorkerLeavesFailedDeliveryUnacked(t *testing.T) {
	fake := &fakeOutbox{items: []store.TriggerRecord{{ID: 8, Realm: "r1", Name: "deploy", Payload: json.RawMessage(`{}`)}}}
	bus := New()
	bus.Subscribe("deploy", func(context.Context, Event) error { return context.Canceled })
	worker := NewWorker(fake, bus, "test")
	worker.cycle(context.Background())
	if len(fake.acked) != 0 {
		t.Fatalf("failed delivery must remain unacked: %v", fake.acked)
	}
}
