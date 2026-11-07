package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/server"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func TestSpaceGrantManagementOwnerScopeCASAuditAndRevocation(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE TABLE projects(id text PRIMARY KEY,realm text NOT NULL,status text NOT NULL);
	 CREATE TABLE project_members(project_id text,user_id text,role text);
	 CREATE TABLE project_spaces(space_id text PRIMARY KEY,project_id text,realm text,incarnation uuid NOT NULL DEFAULT gen_random_uuid());
	 CREATE TABLE governance_users(realm text,id text,status text,PRIMARY KEY(realm,id));
	 INSERT INTO projects VALUES('p1','r1','active'),('p2','r1','active'),('foreign','r2','active');
	 INSERT INTO project_spaces(space_id,project_id,realm) VALUES('s1','p1','r1'),('s2','p2','r1'),('foreign-space','foreign','r2');
	 INSERT INTO governance_users VALUES('r1','alice','active'),('r1','bob','active'),('r1','disabled','disabled'),('r1','outsider','active');
	 INSERT INTO project_members VALUES('p1','alice','owner'),('p1','bob','editor'),('p1','disabled','viewer');`)
	if err != nil {
		t.Fatal(err)
	}
	api := server.New(nil, st, nil, threadRoundHTTPAuth{}, slog.Default())
	api.ConfigureSpaceAuthorization("token")
	handler := api.Routes()
	path := "/v1/projects/p1/spaces/s1/grants"
	call := func(method, route, user, realm, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, route, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer token")
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-User", user)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct{ route, user, realm string }{{path, "bob", "r1"}, {path, "alice", "r2"}, {"/v1/projects/p2/spaces/s1/grants", "alice", "r1"}, {"/v1/projects/p1/spaces/s2/grants", "alice", "r1"}} {
		roundHTTPStatus(t, call("GET", tc.route, tc.user, tc.realm, ""), 403)
	}
	roundHTTPStatus(t, call("GET", path, "alice", "r1", ""), 200)
	for _, body := range []string{`{"permissions":["admin"],"expectedRevision":0}`, `{"permissions":["read","read"],"expectedRevision":0}`, `{"permissions":null,"expectedRevision":0}`, `{"permissions":["read"]}`, `{"permissions":["read"],"expectedRevision":0,"actor":"alice"}`, `{"permissions":["read"],"expectedRevision":0} {}`} {
		roundHTTPStatus(t, call("PUT", path+"/bob", "alice", "r1", body), 400)
	}
	for _, target := range []string{"disabled", "outsider"} {
		roundHTTPStatus(t, call("PUT", path+"/"+target, "alice", "r1", `{"permissions":["read"],"expectedRevision":0}`), 400)
	}
	body := `{"permissions":["read","edit"],"expectedRevision":0}`
	roundHTTPStatus(t, call("PUT", path+"/bob", "bob", "r1", body), 403)
	roundHTTPStatus(t, call("PUT", path+"/bob?user_id=alice", "alice", "r1", body), 400)
	created := call("PUT", path+"/bob", "alice", "r1", body)
	roundHTTPStatus(t, created, 200)
	var grant struct {
		Revision    int64    `json:"revision"`
		Permissions []string `json:"permissions"`
	}
	if err = json.Unmarshal(created.Body.Bytes(), &grant); err != nil || grant.Revision != 1 || len(grant.Permissions) != 2 {
		t.Fatalf("created: %s", created.Body)
	}
	roundHTTPStatus(t, call("PUT", path+"/bob", "alice", "r1", body), 409)
	revoked := call("PUT", path+"/bob", "alice", "r1", `{"permissions":[],"expectedRevision":1}`)
	roundHTTPStatus(t, revoked, 200)
	if err = json.Unmarshal(revoked.Body.Bytes(), &grant); err != nil || grant.Revision != 2 || len(grant.Permissions) != 0 {
		t.Fatalf("revoked: %s", revoked.Body)
	}
	perms, err := st.Permissions(ctx, "r1", "s1", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("revoked permissions: %v %v", perms, err)
	}
	// A grant is a CAS record even after revocation; concurrent owners cannot
	// overwrite a new revision or recycle the subject as a fresh revision zero.
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- call("PUT", path+"/bob", "alice", "r1", `{"permissions":["read"],"expectedRevision":2}`).Code
		}()
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for code := range results {
		if code == 200 {
			ok++
		}
		if code == 409 {
			conflicts++
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("concurrent writes: ok=%d conflicts=%d", ok, conflicts)
	}
	var auditCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM collab_space_grant_audit WHERE realm='r1' AND space='s1' AND subject='bob' AND actor_user_id='alice' AND project_id='p1'`).Scan(&auditCount); err != nil || auditCount != 3 {
		t.Fatalf("audit count=%d err=%v", auditCount, err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM project_members WHERE user_id='bob'`); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r1", "s1", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("departed member retained access: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_members VALUES('p1','bob','editor');UPDATE governance_users SET status='disabled' WHERE id='bob'`); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r1", "s1", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("disabled user retained access: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `UPDATE governance_users SET status='active' WHERE id='bob'`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE projects SET status='archived' WHERE id='p1'`); err != nil {
		t.Fatal(err)
	}
	roundHTTPStatus(t, call("PUT", path+"/bob", "alice", "r1", `{"permissions":[],"expectedRevision":3}`), 403)
	roundHTTPStatus(t, call("GET", path, "alice", "r1", ""), 200)
	perms, err = st.Permissions(ctx, "r1", "s1", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("archived project retained access: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `UPDATE projects SET status='active' WHERE id='p1';DELETE FROM project_members WHERE user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	roundHTTPStatus(t, call("PUT", path+"/bob", "alice", "r1", `{"permissions":[],"expectedRevision":3}`), 403)
}

func TestRecreatedSpaceRequiresExplicitGrantReauthorization(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE TABLE projects(id text PRIMARY KEY,realm text NOT NULL,status text NOT NULL);
	 CREATE TABLE project_members(project_id text,user_id text,role text);
	 CREATE TABLE project_spaces(space_id text PRIMARY KEY,project_id text,realm text,incarnation uuid NOT NULL DEFAULT gen_random_uuid());
	 CREATE TABLE project_space_claims(realm text,space_id text,PRIMARY KEY(realm,space_id));
	 CREATE TABLE governance_users(realm text,id text,status text,PRIMARY KEY(realm,id));
	 INSERT INTO projects VALUES('p','r','active');
	 INSERT INTO project_spaces(space_id,project_id,realm) VALUES('s','p','r');
	 INSERT INTO governance_users VALUES('r','alice','active'),('r','bob','active');
	 INSERT INTO project_members VALUES('p','alice','owner'),('p','bob','viewer');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.Grant(ctx, "legacy", "r", "bob", []domain.Permission{domain.PermRead}); err != nil {
		t.Fatal(err)
	}
	perms, err := st.Permissions(ctx, "r", "legacy", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("integrated deployment must not assume unrecorded legacy history: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_spaces(space_id,project_id,realm)VALUES('legacy','p','r');INSERT INTO project_space_claims VALUES('r','legacy')`); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r", "legacy", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("managed Space inherited legacy permissions: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM project_spaces WHERE space_id='legacy'`); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r", "legacy", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("legacy permissions revived after detach: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_spaces(space_id,project_id,realm)VALUES('legacy','p','r')`); err != nil {
		t.Fatal(err)
	}
	legacy, err := st.ListSpaceGrants(ctx, "r", "p", "legacy", "alice")
	if err != nil || len(legacy) != 1 || len(legacy[0].Permissions) != 0 || legacy[0].Revision != 1 {
		t.Fatalf("legacy upgrade must be explicit: %+v %v", legacy, err)
	}
	if _, err = st.SetSpaceGrant(ctx, "r", "p", "legacy", "alice", "bob", []string{"read"}, 0); !errors.Is(err, store.ErrSpaceGrantConflict) {
		t.Fatalf("legacy upgrade requires current CAS revision: %v", err)
	}
	if _, err = st.SetSpaceGrant(ctx, "r", "p", "legacy", "alice", "bob", []string{"read"}, 1); err != nil {
		t.Fatal(err)
	}
	grant, err := st.SetSpaceGrant(ctx, "r", "p", "s", "alice", "bob", []string{"read"}, 0)
	if err != nil || grant.Revision != 1 {
		t.Fatalf("initial grant: %+v %v", grant, err)
	}
	perms, err = st.Permissions(ctx, "r", "s", "bob")
	if err != nil || len(perms) != 1 {
		t.Fatalf("initial permissions: %v %v", perms, err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM project_spaces WHERE space_id='s'; INSERT INTO project_spaces(space_id,project_id,realm)VALUES('s','p','r')`); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r", "s", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("recreated Space inherited permissions: %v %v", perms, err)
	}
	listed, err := st.ListSpaceGrants(ctx, "r", "p", "s", "alice")
	if err != nil || len(listed) != 1 || listed[0].Revision != 1 || len(listed[0].Permissions) != 0 {
		t.Fatalf("stale revision must remain visible without active permissions: %+v %v", listed, err)
	}
	if _, err = st.SetSpaceGrant(ctx, "r", "p", "s", "alice", "bob", []string{"read"}, 0); !errors.Is(err, store.ErrSpaceGrantConflict) {
		t.Fatalf("stale grant must require CAS: %v", err)
	}
	if _, err = st.SetSpaceGrant(ctx, "r", "p", "s", "alice", "bob", []string{"read"}, 1); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r", "s", "bob")
	if err != nil || len(perms) != 1 {
		t.Fatalf("explicit reauthorization: %v %v", perms, err)
	}
	var incarnations int
	if err = pool.QueryRow(ctx, `SELECT count(DISTINCT space_incarnation) FROM collab_space_grant_audit WHERE realm='r' AND space='s' AND subject='bob'`).Scan(&incarnations); err != nil || incarnations != 2 {
		t.Fatalf("audit must retain both incarnations: %d %v", incarnations, err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO projects VALUES('p2','r','active'); INSERT INTO project_members VALUES('p2','alice','owner'),('p2','bob','viewer'); DELETE FROM project_spaces WHERE space_id='s'; INSERT INTO project_spaces(space_id,project_id,realm)VALUES('s','p2','r')`); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r", "s", "bob")
	if err != nil || len(perms) != 0 {
		t.Fatalf("cross-project recreation inherited permissions: %v %v", perms, err)
	}
	listed, err = st.ListSpaceGrants(ctx, "r", "p2", "s", "alice")
	if err != nil || len(listed) != 1 || len(listed[0].Permissions) != 0 || listed[0].Revision != 2 {
		t.Fatalf("cross-project reauthorization must expose old CAS without old permissions: %+v %v", listed, err)
	}
	if _, err = st.SetSpaceGrant(ctx, "r", "p2", "s", "alice", "bob", []string{"read"}, 0); !errors.Is(err, store.ErrSpaceGrantConflict) {
		t.Fatalf("cross-project reauthorization requires CAS: %v", err)
	}
	if _, err = st.SetSpaceGrant(ctx, "r", "p2", "s", "alice", "bob", []string{"read"}, 2); err != nil {
		t.Fatal(err)
	}
	perms, err = st.Permissions(ctx, "r", "s", "bob")
	if err != nil || len(perms) != 1 {
		t.Fatalf("cross-project explicit reauthorization: %v %v", perms, err)
	}
}

func TestLegacySpaceGrantRequiresCompleteProjectClaimAuthority(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	if err := st.Grant(ctx, "legacy", "r", "bob", []domain.Permission{domain.PermRead}); err != nil {
		t.Fatal(err)
	}
	if perms, err := st.Permissions(ctx, "r", "legacy", "bob"); err != nil || len(perms) != 1 {
		t.Fatalf("standalone compatibility: %v %v", perms, err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE project_spaces(realm text,space_id text)`); err != nil {
		t.Fatal(err)
	}
	if perms, err := st.Permissions(ctx, "r", "legacy", "bob"); err == nil || len(perms) != 0 {
		t.Fatalf("incomplete authority must fail closed: %v %v", perms, err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE project_space_claims(realm text,space_id text,PRIMARY KEY(realm,space_id)); INSERT INTO project_space_claims VALUES('r','legacy')`); err != nil {
		t.Fatal(err)
	}
	if perms, err := st.Permissions(ctx, "r", "legacy", "bob"); err != nil || len(perms) != 0 {
		t.Fatalf("detached historical claim must deny: %v %v", perms, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM project_space_claims`); err != nil {
		t.Fatal(err)
	}
	if perms, err := st.Permissions(ctx, "r", "legacy", "bob"); err != nil || len(perms) != 0 {
		t.Fatalf("unrecorded pre-upgrade history must not allow legacy grants: %v %v", perms, err)
	}
}
