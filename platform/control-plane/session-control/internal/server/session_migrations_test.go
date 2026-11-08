package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/session-control/internal/store"
)

type migrationFake struct {
	ownerFake
	calls int
}

func (f *migrationFake) SessionMigration(context.Context, string, string, string) (store.SessionMigration, error) {
	return store.SessionMigration{ID: "m", State: "checkpointed"}, nil
}
func (f *migrationFake) CheckpointSessionMigration(context.Context, string, store.SessionMigrationCheckpoint) (store.SessionMigration, error) {
	f.calls++
	return store.SessionMigration{State: "checkpointed"}, nil
}
func (f *migrationFake) ActivateSessionMigration(context.Context, string, string, store.SessionMigrationActivation) (store.SessionMigration, error) {
	f.calls++
	return store.SessionMigration{}, store.ErrOwnerConflict
}
func TestSessionMigrationHTTPStrictEnvelopesAndConflict(t *testing.T) {
	f := &migrationFake{}
	mux := http.NewServeMux()
	New(Options{Owners: f}).Routes(mux)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	if w := call("GET", "/v1/session-migrations/session?realm=r", ""); w.Code != 200 || !strings.Contains(w.Body.String(), "checkpointed") {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"session_ref":"forged"}`, `{} {}`, `{"execution":{"secret":"forged"}}`} {
		if w := call("POST", "/v1/session-migrations/session/checkpoint", body); w.Code != 400 {
			t.Fatalf("invalid %d %s", w.Code, w.Body)
		}
	}
	if f.calls != 0 {
		t.Fatal("untrusted envelope reached store")
	}
	if w := call("POST", "/v1/session-migrations/session/migration/activate", `{}`); w.Code != 409 {
		t.Fatalf("conflict %d %s", w.Code, w.Body)
	}
}
