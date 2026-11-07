package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/server"
)

type threadPageAuth struct{}

func (threadPageAuth) Authenticate(r *http.Request) (server.Identity, error) {
	if r.Header.Get("X-Lumo-Realm") == "" {
		return server.Identity{}, errors.New("missing realm")
	}
	return server.Identity{UserID: "reader", Realm: domain.RealmID(r.Header.Get("X-Lumo-Realm"))}, nil
}

func TestThreadPagesFilterBeforeLimitAndTraverseBeyond500(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	// The unrelated rows sort before the visible task's rows. A filter applied
	// after LIMIT would incorrectly report that the visible task has no threads.
	if _, err := pool.Exec(ctx, `INSERT INTO threads
		(id,realm,project_id,task_id,coordinator_session_ref,session_ref,node_id,workspace,state)
		SELECT 't'||lpad(n::text,4,'0'),'realm-1','proj-1','visible','coord',
		's'||n,'node','thread/t'||lpad(n::text,4,'0')||'/','idle' FROM generate_series(1,507) n;
		INSERT INTO threads
		(id,realm,project_id,task_id,coordinator_session_ref,session_ref,node_id,workspace,state)
		SELECT 'h'||lpad(n::text,4,'0'),'realm-1','proj-1','hidden','coord',
		'hs'||n,'node','thread/h'||lpad(n::text,4,'0')||'/','idle' FROM generate_series(1,600) n;
		INSERT INTO threads
		(id,realm,project_id,task_id,coordinator_session_ref,session_ref,node_id,workspace,state)
		VALUES ('foreign','realm-2','proj-1','visible','coord','foreign-s','node','thread/foreign/','idle')`); err != nil {
		t.Fatal(err)
	}
	first, err := st.ListThreadsAfter(ctx, "realm-1", "proj-1", "", 500, "", []string{"visible"})
	if err != nil || len(first) != 500 {
		t.Fatalf("first page: %d %v", len(first), err)
	}
	seen := map[string]bool{}
	for index, row := range first {
		if row.ID != fmt.Sprintf("t%04d", index+1) || row.TaskID != "visible" || row.Realm != "realm-1" {
			t.Fatalf("wrong filtered row: %+v", row)
		}
		seen[row.ID] = true
	}
	// Changes to thread state/updated_at do not move an ID-keyed page boundary.
	if _, err := pool.Exec(ctx, `UPDATE threads SET state='running',updated_at=now() WHERE task_id='visible'`); err != nil {
		t.Fatal(err)
	}
	second, err := st.ListThreadsAfter(ctx, "realm-1", "proj-1", "", 500, first[499].ID, []string{"visible"})
	if err != nil || len(second) != 7 {
		t.Fatalf("second page: %d %v", len(second), err)
	}
	for index, row := range second {
		if seen[row.ID] || row.ID != fmt.Sprintf("t%04d", index+501) {
			t.Fatalf("duplicate/missing row on second page: %+v", row)
		}
		seen[row.ID] = true
	}
	last, err := st.ListThreadsAfter(ctx, "realm-1", "proj-1", "", 500, second[6].ID, []string{"visible"})
	if err != nil || len(last) != 0 || len(seen) != 507 {
		t.Fatalf("traversal did not finish: %d seen, %d remaining, %v", len(seen), len(last), err)
	}
	for _, tc := range []struct {
		realm, project string
		tasks          []string
	}{
		{"realm-1", "proj-1", []string{}},
		{"realm-1", "another-project", []string{"visible"}},
		{"unknown", "proj-1", []string{"visible"}},
	} {
		rows, err := st.ListThreadsAfter(ctx, tc.realm, tc.project, "", 500, "", tc.tasks)
		if err != nil || len(rows) != 0 {
			t.Fatalf("filter leaked for %+v: %d %v", tc, len(rows), err)
		}
	}
	if rows, err := st.ListThreadsAfter(ctx, "realm-2", "proj-1", "", 500, "", []string{"visible"}); err != nil || len(rows) != 1 || rows[0].ID != "foreign" {
		t.Fatalf("foreign realm isolated page: %+v %v", rows, err)
	}
	for _, tc := range []struct {
		after string
		tasks []string
	}{
		{strings.Repeat("a", 201), []string{"visible"}},
		{"", make([]string, 201)},
	} {
		if _, err := st.ListThreadsAfter(ctx, "realm-1", "", "", 500, tc.after, tc.tasks); !errors.Is(err, domain.ErrInvalidThread) {
			t.Fatalf("invalid page accepted: %v", err)
		}
	}

	// Exercise production HTTP parsing as well as the direct SQL entry point.
	handler := server.New(nil, st, nil, threadPageAuth{}, nil).Routes()
	request := func(path, realm string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("X-Lumo-Realm", realm)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	var rows []domain.Thread
	for _, tc := range []struct {
		path, realm string
		want, count int
	}{
		{"/threads?limit=500&task_id=visible", "realm-1", 200, 500},
		{"/threads?limit=500&after=t0500&task_id=visible", "realm-1", 200, 7},
		{"/threads?limit=500&after=t0500&task_id=visible", "realm-2", 200, 0},
		{"/threads?limit=500&task_id=visible&realm=realm-1", "realm-2", 200, 1},
		{"/threads?limit=500&task_id=absent", "realm-1", 200, 0},
		{"/threads?limit=500&task_id=visible", "", 401, 0},
		{"/threads?after=" + strings.Repeat("a", 201), "realm-1", 400, 0},
		{"/threads?task_id=" + strings.Repeat("x&task_id=", 200) + "x", "realm-1", 400, 0},
	} {
		response := request(tc.path, tc.realm)
		if response.Code != tc.want {
			t.Fatalf("HTTP %s realm=%s: %d want %d: %s", tc.path, tc.realm, response.Code, tc.want, response.Body)
		}
		if tc.want == http.StatusOK {
			if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil || len(rows) != tc.count {
				t.Fatalf("HTTP %s: %d rows want %d, %v", tc.path, len(rows), tc.count, err)
			}
			for _, row := range rows {
				if row.Realm != tc.realm || row.TaskID != "visible" {
					t.Fatalf("HTTP filter leaked: %+v", row)
				}
			}
		}
	}
}
