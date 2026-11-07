package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

func identityRead(t *testing.T, opts Options, path, realm, user string) (int, map[string]any) {
	t.Helper()
	mux := http.NewServeMux()
	New(opts).Routes(mux)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("X-Lumo-Realm", realm)
	req.Header.Set("X-Lumo-User", user)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return rec.Code, body
}

func TestIdentityReadsRejectPartialIdentity(t *testing.T) {
	for _, path := range []string{"/v1/sessions/s1/control", "/v1/sessions/s1/control/events", "/v1/sessions/s1/action-reviews?realm=foreign"} {
		for _, identity := range [][2]string{{"a", ""}, {"", "user"}, {" ", "user"}} {
			status, _ := identityRead(t, Options{}, path, identity[0], identity[1])
			if status != http.StatusUnauthorized {
				t.Fatalf("%s with %v: status=%d", path, identity, status)
			}
		}
	}
}

func TestConsoleIdentityHidesForeignStateAndQueue(t *testing.T) {
	for _, loadErr := range []error{nil, store.ErrNotFound} {
		reader := &fakeReader{row: store.Row{SessionRef: "s1", Realm: "foreign", State: state.StateAwaitingApproval, Revision: 9}, loadErr: loadErr}
		status, body := identityRead(t, Options{Store: reader, Queue: fakeQueueView{}}, "/v1/sessions/s1/control?realm=foreign", "a", "user")
		if status != http.StatusOK || body["registered"] != false || body["state"] != nil || body["queue"] != nil || body["last_control"] != nil {
			t.Fatalf("foreign and missing sessions must be indistinguishable: %d %#v", status, body)
		}
	}
	reader := &fakeReader{row: store.Row{SessionRef: "s1", Realm: "a", State: state.StateAwaitingApproval}}
	status, body := identityRead(t, Options{Store: reader}, "/v1/sessions/s1/control", "a", "user")
	if status != http.StatusOK || body["registered"] != true || body["state"] != "awaiting-approval" {
		t.Fatalf("same realm must remain readable: %d %#v", status, body)
	}
}

func TestTimelineIdentityDoesNotReadForeignOrMissingHistory(t *testing.T) {
	for _, loadErr := range []error{nil, store.ErrNotFound} {
		reader := &fakeReader{row: store.Row{Realm: "foreign"}, loadErr: loadErr, timelineE: errors.New("history must not be queried")}
		status, body := identityRead(t, Options{Store: reader}, "/v1/sessions/s1/control/events", "a", "user")
		events, _ := body["events"].([]any)
		if status != http.StatusOK || len(events) != 0 || body["next_after"] != float64(0) || reader.gotLimit != 0 {
			t.Fatalf("foreign history leaked or queried: %d %#v", status, body)
		}
	}
}

func TestTimelineIdentityFiltersAuditRealmAndSession(t *testing.T) {
	reader := &fakeReader{row: store.Row{Realm: "a"}, events: []store.AuditRow{
		{ID: 1, SessionRef: "s1", Realm: "a"}, {ID: 2, SessionRef: "s1", Realm: "foreign"}, {ID: 3, SessionRef: "s2", Realm: "a"},
	}}
	status, body := identityRead(t, Options{Store: reader}, "/v1/sessions/s1/control/events?realm=foreign", "a", "user")
	events, _ := body["events"].([]any)
	if status != http.StatusOK || len(events) != 1 || body["next_after"] != float64(1) {
		t.Fatalf("unexpected timeline: %d %#v", status, body)
	}
	reader.loadErr = errors.New("database unavailable")
	status, _ = identityRead(t, Options{Store: reader}, "/v1/sessions/s1/control/events", "a", "user")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("failed ownership check must fail closed: %d", status)
	}
}

func TestActionReviewIdentityOverridesQueryRealm(t *testing.T) {
	reviews := &fakeReviews{}
	status, _ := identityRead(t, Options{Reviews: reviews}, "/v1/sessions/s1/action-reviews?realm=foreign", "a", "user")
	if status != http.StatusOK || reviews.gotRealm != "a" {
		t.Fatalf("query realm overrode trusted identity: status=%d realm=%s", status, reviews.gotRealm)
	}
}
