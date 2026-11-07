package server

import (
	"context"
	"github.com/lumo-harness/platform/session-control/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type ownerFake struct {
	calls int
	in    store.ReserveSessionOwner
}

func (f *ownerFake) ReserveSessionOwner(_ context.Context, in store.ReserveSessionOwner) (store.SessionOwner, string, error) {
	f.calls++
	f.in = in
	return store.SessionOwner{SessionRef: "fresh", Realm: in.Realm, OwnerUserID: in.OwnerUserID}, "nonce", nil
}
func (f *ownerFake) ActivateSessionOwner(context.Context, string, string, string) (store.SessionOwner, error) {
	return store.SessionOwner{State: "active"}, nil
}
func (f *ownerFake) SessionOwner(context.Context, string, string) (store.SessionOwner, error) {
	return store.SessionOwner{}, store.ErrNotFound
}
func (f *ownerFake) SessionOwners(context.Context, string, string, string, string, int) ([]store.SessionOwner, error) {
	return []store.SessionOwner{}, nil
}
func TestSessionOwnerRoutesCannotClaimAnExistingIdentity(t *testing.T) {
	f := &ownerFake{}
	mux := http.NewServeMux()
	New(Options{Owners: f}).Routes(mux)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	for _, body := range []string{`{"realm":"r","session_ref":"legacy"}`, `{"realm":"r","creation_token":"fake"}`, `{} {}`, strings.Repeat("x", 9000)} {
		if w := call("POST", "/v1/session-owners", body); w.Code != 400 {
			t.Fatalf("claim %d %s", w.Code, w.Body.String())
		}
	}
	if f.calls != 0 {
		t.Fatal("untrusted creation reached store")
	}
	if w := call("POST", "/v1/session-owners", `{"realm":"r","owner_user_id":"u","project_id":"p","node_id":"n"}`); w.Code != 201 || !strings.Contains(w.Body.String(), "creation_token") {
		t.Fatalf("reserve %d %s", w.Code, w.Body.String())
	}
	if f.in.OwnerUserID != "u" {
		t.Fatal(f.in)
	}
	if w := call("GET", "/v1/session-owners/legacy?realm=r", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := call("PUT", "/v1/session-owners/legacy", `{"owner_user_id":"attacker"}`); w.Code != 405 {
		t.Fatal(w.Code)
	}
	if w := call("DELETE", "/v1/session-owners/legacy", ""); w.Code != 405 {
		t.Fatal(w.Code)
	}
	if w := call("POST", "/v1/session-owners/fresh/activate", `{"realm":"r","creation_token":"nonce","owner_user_id":"attacker"}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
