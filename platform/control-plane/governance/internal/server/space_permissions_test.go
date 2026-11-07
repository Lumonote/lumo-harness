package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestSpacePermissionAdapterRejectsUntrustedResponses(t *testing.T) {
	for _, raw := range []string{"https://user:pass@host", "https://host?q=x", "https://host#fragment", "file:///tmp/socket", "/relative"} {
		if _, err := New(nil, Config{CollaboratorURL: raw, ControlPlaneToken: "token"}, nil); err == nil {
			t.Fatalf("accepted URL %s", raw)
		}
	}
	if _, err := New(nil, Config{CollaboratorURL: "https://host"}, nil); err == nil {
		t.Fatal("accepted missing service credential")
	}
	c := caller{realm: "r1", userID: "alice"}
	for _, body := range []string{
		`{"realm":"r2","space_id":"s1","user_id":"alice","permissions":["read","edit"]}`,
		`{"realm":"r1","space_id":"s2","user_id":"alice","permissions":["read","edit"]}`,
		`{"realm":"r1","space_id":"s1","user_id":"bob","permissions":["read","edit"]}`,
		`{"realm":"r1","space_id":"s1","user_id":"alice","permissions":null}`,
		`{"realm":"r1","space_id":"s1","user_id":"alice","permissions":["read","edit","admin"]}`,
		`not-json`, strings.Repeat("x", 17<<10),
	} {
		t.Run(body[:min(len(body), 40)], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer token" || r.Header.Get("X-Lumo-Realm") != "r1" || r.Header.Get("X-Lumo-User") != "alice" || r.Header.Get("Cookie") != "" {
					t.Error("untrusted request attribution")
				}
				_, _ = w.Write([]byte(body))
			}))
			defer upstream.Close()
			s, err := New(nil, Config{CollaboratorURL: upstream.URL, ControlPlaneToken: "token"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if allowed, err := s.currentSpacePermission(context.Background(), c, "s1"); allowed != nil || !errors.Is(err, errSpaceAuthorizationUnavailable) {
				t.Fatalf("unsafe response accepted: %v %v", allowed, err)
			}
		})
	}
	redirected := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected = true }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	s, err := New(nil, Config{CollaboratorURL: redirect.URL, ControlPlaneToken: "token"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.currentSpacePermission(context.Background(), c, "s1"); !errors.Is(err, errSpaceAuthorizationUnavailable) || redirected {
		t.Fatal("followed authorization-source redirect")
	}
}

func TestSpacePermissionIntersectsAuthoritativeProjectAndCurrentGrant(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE projects(id text PRIMARY KEY, realm text NOT NULL,status TEXT NOT NULL DEFAULT 'active');
	 CREATE TABLE project_spaces(space_id text PRIMARY KEY,project_id text NOT NULL,realm text NOT NULL);
	 CREATE TABLE project_members(project_id text,user_id text);
	 INSERT INTO projects(id,realm) VALUES('p1','r1'),('p2','r1'),('foreign','r2');
	 INSERT INTO project_spaces VALUES('s1','p1','r1'),('other-space','p2','r1'),('foreign-space','foreign','r2');
	 INSERT INTO project_members VALUES('p1','u1');`); err != nil {
		t.Fatal(err)
	}
	var permissions atomic.Value
	permissions.Store([]string{"read", "edit"})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/")
		_ = json.NewEncoder(w).Encode(map[string]any{"realm": r.Header.Get("X-Lumo-Realm"), "space_id": parts[len(parts)-2], "user_id": r.Header.Get("X-Lumo-User"), "permissions": permissions.Load().([]string)})
	}))
	defer upstream.Close()
	s, err := New(st, Config{CollaboratorURL: upstream.URL, ControlPlaneToken: "token", DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := caller{realm: "r1", userID: "u1", roles: map[string]bool{"operator": true}}
	check := func(resource domain.PermissionResource, want bool) {
		t.Helper()
		decision, err := s.permissionDecision(ctx, c, actionDelegate, resource)
		if err != nil || decision.Allowed != want {
			t.Fatalf("resource=%+v decision=%+v err=%v", resource, decision, err)
		}
	}
	check(domain.PermissionResource{Realm: "r1", SpaceID: "s1"}, true)
	check(domain.PermissionResource{Realm: "r1", ProjectID: "p2", SpaceID: "s1"}, false)
	check(domain.PermissionResource{Realm: "r1", SpaceID: "other-space"}, false)
	check(domain.PermissionResource{Realm: "r1", SpaceID: "foreign-space"}, false)
	check(domain.PermissionResource{Realm: "r1", SpaceID: "missing"}, false)
	for _, perms := range [][]string{{"read"}, {"edit"}, {"comment", "publish"}, {}} {
		permissions.Store(perms)
		check(domain.PermissionResource{Realm: "r1", SpaceID: "s1"}, false)
	}
	permissions.Store([]string{"read", "edit"})
	c.roles = map[string]bool{}
	check(domain.PermissionResource{Realm: "r1", SpaceID: "s1"}, false)
	c.roles = map[string]bool{"operator": true}
	if _, err := pool.Exec(ctx, `DELETE FROM project_members WHERE user_id='u1'`); err != nil {
		t.Fatal(err)
	}
	check(domain.PermissionResource{Realm: "r1", SpaceID: "s1"}, false)
	// An unavailable source returns 503 rather than a cached authorization.
	upstream.Close()
	mux := http.NewServeMux()
	s.Register(mux)
	r := httptest.NewRequest("POST", "/v1/permission-explain", strings.NewReader(`{"action":"task:delegate","resource":{"realm":"r1","space_id":"s1"}}`))
	r.Header.Set("X-Lumo-Realm", "r1")
	r.Header.Set("X-Lumo-User", "u1")
	r.Header.Set("X-Lumo-Roles", "operator")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "space_authorization_unavailable") {
		t.Fatalf("unavailable source: %d %s", w.Code, w.Body)
	}
}
