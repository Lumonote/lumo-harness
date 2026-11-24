package asks

import (
	"testing"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
)

func TestStatusMapping(t *testing.T) {
	for in, want := range map[string]string{"pending": "pending", "approved": "answered", "consumed": "answered", "rejected": "rejected", "cancelled": "cancelled", "expired": "expired"} {
		if got := StatusOf(in); got != want {
			t.Errorf("StatusOf(%q)=%q want %q", in, got, want)
		}
	}
}

func TestFromApproval(t *testing.T) {
	a := FromApproval(approval.Request{ID: "x1", Realm: "r", ConnectorID: "billing", Operation: "refund", Status: "rejected", ApproverUserID: "admin"})
	if a.ID != "connector:x1" || a.Kind != "approval" || a.Status != "rejected" || a.Answer == nil || a.Answer.Value != "reject" {
		t.Fatalf("unexpected projection: %+v", a)
	}
	if p := FromApproval(approval.Request{ID: "x2", Status: "pending"}); p.Answer != nil {
		t.Fatal("pending ask must not carry an answer")
	}
}

func TestParseConnectorID(t *testing.T) {
	if id, ok := ParseConnectorID("connector:abc_1"); !ok || id != "abc_1" {
		t.Fatal("prefixed id")
	}
	if id, ok := ParseConnectorID("abc_1"); !ok || id != "abc_1" {
		t.Fatal("legacy bare id")
	}
	if _, ok := ParseConnectorID("connector:../x"); ok {
		t.Fatal("must reject path chars")
	}
}

func TestBrokerRealmIsolation(t *testing.T) {
	b := NewBroker()
	mine, cancel := b.Subscribe("r1")
	defer cancel()
	other, cancel2 := b.Subscribe("r2")
	defer cancel2()
	b.Publish("ask.created", Ask{ID: "connector:a", Realm: "r1"})
	select {
	case ev := <-mine:
		if ev.Type != "ask.created" {
			t.Fatal(ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
	select {
	case <-other:
		t.Fatal("cross-realm leak")
	default:
	}
	var nilBroker *Broker
	nilBroker.Publish("ask.created", Ask{}) // must not panic
}
