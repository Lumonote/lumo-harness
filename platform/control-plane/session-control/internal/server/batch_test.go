package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

type batchReader struct {
	fakeReader
	realm string
	refs  []string
}

func (f *batchReader) Controls(_ context.Context, realm string, refs []string) ([]store.Row, error) {
	f.realm, f.refs = realm, refs
	return []store.Row{
		{SessionRef: "s1", Realm: realm, State: state.StateAwaitingApproval, Revision: 7},
		{SessionRef: "foreign", Realm: "other", State: state.StatePaused},
	}, nil
}

func TestControlsBatch(t *testing.T) {
	f := &batchReader{}
	mux := http.NewServeMux()
	New(Options{Store: f}).Routes(mux)
	request := func(path, method, realm string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("X-Lumo-User", "caller")
		r.Header.Set("X-Lumo-Realm", realm)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		path, method, realm string
		status              int
	}{
		{"/v1/session-controls?session_ref=s1", "GET", "", 401},
		{"/v1/session-controls", "GET", "realm-a", 400},
		{"/v1/session-controls?session_ref=", "GET", "realm-a", 400},
		{"/v1/session-controls?" + strings.Repeat("session_ref=s1&", 101), "GET", "realm-a", 400},
		{"/v1/session-controls?session_ref=s1", "POST", "realm-a", 405},
	} {
		if got := request(tc.path, tc.method, tc.realm).Code; got != tc.status {
			t.Fatalf("%s: want %d, got %d", tc.path, tc.status, got)
		}
	}
	w := request("/v1/session-controls?realm=forged&session_ref=s1&session_ref=foreign&session_ref=missing&session_ref=s1", "GET", "realm-a")
	var body struct {
		Controls []controlSummary `json:"controls"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 {
		t.Fatalf("batch response %d %s, err=%v", w.Code, w.Body.String(), err)
	}
	if f.realm != "realm-a" || len(f.refs) != 3 || len(body.Controls) != 3 {
		t.Fatalf("identity/uniqueness mismatch: %+v %+v", f, body)
	}
	if body.Controls[0].State == nil || *body.Controls[0].State != state.StateAwaitingApproval || body.Controls[0].Revision != 7 {
		t.Fatal("registered control missing")
	}
	for _, item := range body.Controls[1:] {
		if item.Registered || item.State != nil {
			t.Fatal("unknown/foreign reference leaked a state")
		}
	}
}
