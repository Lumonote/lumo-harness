package trigger

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/store"
)

type fakeOutbox struct {
	mu       sync.Mutex
	items    []store.TriggerRecord
	acked    []uint64
	claimed  bool
	token    int64
	renewErr error
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
func (f *fakeOutbox) AckTrigger(_ context.Context, id uint64, token int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acked = append(f.acked, id)
	f.token = token
	return nil
}

func (f *fakeOutbox) RenewTrigger(_ context.Context, _ uint64, token int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.token = token
	return f.renewErr
}

func TestWorkerPublishesAndAcksOnlyAfterHandlersSucceed(t *testing.T) {
	fake := &fakeOutbox{items: []store.TriggerRecord{{
		ID: 7, ClaimToken: 42, Realm: "r1", Name: "deploy", Payload: json.RawMessage(`{"value":1}`),
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
	if len(fake.acked) != 1 || fake.acked[0] != 7 || fake.token != 42 {
		t.Fatalf("expected one ack, got %v", fake.acked)
	}
}

func TestWorkerLosingClaimCancelsExecutionWithoutAcknowledging(t *testing.T) {
	fake := &fakeOutbox{items: []store.TriggerRecord{{ID: 9, ClaimToken: 3}}, renewErr: store.ErrClaimLost}
	bus := New()
	bus.Subscribe("*", func(ctx context.Context, _ Event) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
			t.Error("lost claim did not cancel execution")
			return nil
		}
	})
	worker := NewWorker(fake, bus, "test")
	worker.SetTiming(time.Millisecond, 6*time.Millisecond, 1)
	var reported error
	worker.SetErrorHandler(func(err error) { reported = err })
	worker.cycle(context.Background())
	if reported != store.ErrClaimLost || len(fake.acked) != 0 || fake.token != 3 {
		t.Fatalf("lost claim: err=%v, ack=%v, token=%d", reported, fake.acked, fake.token)
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
