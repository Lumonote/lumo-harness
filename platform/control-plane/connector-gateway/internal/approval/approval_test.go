package approval

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

func TestInvocationHashBindsTargetFieldsButNotAuditCorrelation(t *testing.T) {
	base := domain.Invocation{
		ConnectorID: "billing", Operation: "refund", PathParams: map[string]string{"id": "inv-1"},
		Query: map[string]string{"dryRun": "false"}, Headers: map[string]string{"Accept": "application/json"},
		Body: json.RawMessage(`{"amount":100}`), CorrelationID: "trace-a",
	}
	first, err := InvocationHash(base, 3)
	if err != nil {
		t.Fatal(err)
	}
	correlated := base
	correlated.CorrelationID = "trace-b"
	if got, err := InvocationHash(correlated, 3); err != nil || got != first {
		t.Fatalf("audit-only correlation must not change approval binding: got=%q err=%v", got, err)
	}
	mutated := base
	mutated.Body = json.RawMessage(`{"amount":101}`)
	if got, err := InvocationHash(mutated, 3); err != nil || got == first {
		t.Fatalf("body mutation must invalidate approval: got=%q err=%v", got, err)
	}
	if got, err := InvocationHash(base, 4); err != nil || got == first {
		t.Fatalf("manifest version change must invalidate approval: got=%q err=%v", got, err)
	}
}

func TestEffectiveStatusMarksOnlyLiveApprovalStatesExpired(t *testing.T) {
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		status  string
		expires time.Time
		want    string
	}{
		{status: "pending", expires: now, want: "expired"},
		{status: "approved", expires: now.Add(-time.Second), want: "expired"},
		{status: "pending", expires: now.Add(time.Second), want: "pending"},
		{status: "consumed", expires: now.Add(-time.Second), want: "consumed"},
		{status: "rejected", expires: now.Add(-time.Second), want: "rejected"},
	} {
		if got := effectiveStatus(test.status, test.expires, now); got != test.want {
			t.Errorf("effectiveStatus(%q, %s) = %q, want %q", test.status, test.expires, got, test.want)
		}
	}
}
