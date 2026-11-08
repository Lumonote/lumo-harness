package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/server"
)

func TestProjectDirectoryRejectsInvalidQueriesBeforeDatabase(t *testing.T) {
	mux := http.NewServeMux()
	server.New(nil, nil).Register(mux)
	for _, query := range []string{
		"status=unknown", "role=admin", "sort=name%20DESC", "limit=0", "limit=101", "limit=", "limit=1.5",
		"offset=-1", "offset=100001", "offset=99999999999999999999999999999", "q=" + strings.Repeat("x", 201), "q=line%0Abreak",
	} {
		t.Run(query, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/v1/projects/directory?"+query, nil)
			req.Header.Set("X-Lumo-User", "user")
			req.Header.Set("X-Lumo-Realm", "realm")
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, req)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
		})
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/v1/projects/directory", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous directory: %d", response.Code)
	}
}

func TestProjectDirectoryMembershipFiltersAndLiteralSearch(t *testing.T) {
	ts, pool := newTestServerWithPool(t)
	ownerID := createProject(t, ts, "alice", "r1", "Alpha 100%_launch")
	editorID := createProject(t, ts, "bob", "r1", "Beta")
	viewerID := createProject(t, ts, "bob", "r1", "Gamma")
	createProject(t, ts, "bob", "r1", "Private")
	createProject(t, ts, "alice", "r2", "Other realm")
	for id, role := range map[string]string{editorID: "editor", viewerID: "viewer"} {
		response, body := do(t, "POST", ts.URL+"/v1/projects/"+id+"/members", fmt.Sprintf(`{"userId":"alice","role":%q}`, role), auth("bob", "r1"))
		if response.StatusCode != 201 {
			t.Fatalf("add member: %d %s", response.StatusCode, body)
		}
	}
	response, body := do(t, "POST", ts.URL+"/v1/projects/"+viewerID+"/archive", "", auth("bob", "r1"))
	if response.StatusCode != 200 {
		t.Fatalf("archive: %d %s", response.StatusCode, body)
	}
	// Force equal timestamps to exercise the final id tie-breaker as well.
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET created_at='2026-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	read := func(user, realm, query string) domain.ProjectDirectory {
		t.Helper()
		response, body := do(t, "GET", ts.URL+"/v1/projects/directory?"+query, "", auth(user, realm))
		if response.StatusCode != 200 {
			t.Fatalf("directory %s: %d %s", query, response.StatusCode, body)
		}
		var result domain.ProjectDirectory
		if err := json.Unmarshal([]byte(body), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	all := read("alice", "r1", "sort=name")
	if all.Total != 3 || all.Summary.Total != 3 || all.Summary.Active != 2 || all.Summary.Archived != 1 || all.Limit != 20 || all.HasMore {
		t.Fatalf("visible counts: %+v", all)
	}
	if len(all.Projects) != 3 || all.Projects[0].ID != ownerID || all.Projects[1].ID != editorID || all.Projects[2].ID != viewerID {
		t.Fatalf("name order: %+v", all.Projects)
	}
	if all.Projects[0].YourRole != "owner" || all.Projects[0].MemberCount != 1 || all.Projects[1].YourRole != "editor" || all.Projects[1].MemberCount != 2 {
		t.Fatalf("directory member projections: %+v", all.Projects)
	}
	for _, tc := range []struct{ query, id string }{
		{"q=" + url.QueryEscape("%_"), ownerID},
		{"q=" + url.QueryEscape(strings.ToUpper(ownerID)), ownerID},
		{"q=" + url.QueryEscape(" beta ") + "&role=editor&status=active", editorID},
		{"status=archived&role=viewer", viewerID},
	} {
		result := read("alice", "r1", tc.query)
		if result.Total != 1 || len(result.Projects) != 1 || result.Projects[0].ID != tc.id || result.Summary.Total != 3 {
			t.Fatalf("filter %s: %+v", tc.query, result)
		}
	}
	for _, args := range [][3]string{{"alice", "r1", "q=Private"}, {"outsider", "r1", ""}, {"alice", "missing-realm", ""}} {
		result := read(args[0], args[1], args[2])
		if result.Total != 0 || result.Projects == nil || len(result.Projects) != 0 {
			t.Fatalf("visibility %v: %+v", args, result)
		}
	}
	first, second := read("alice", "r1", "sort=recent&limit=2"), read("alice", "r1", "sort=recent&limit=2&offset=2")
	if first.Total != 3 || len(first.Projects) != 2 || !first.HasMore || len(second.Projects) != 1 || second.HasMore {
		t.Fatalf("pages: %+v %+v", first, second)
	}
	if first.Projects[0].ID >= first.Projects[1].ID || first.Projects[1].ID >= second.Projects[0].ID {
		t.Fatal("equal timestamps must retain deterministic id order across pages")
	}
	empty := read("alice", "r1", "limit=2&offset=20")
	if empty.Total != 3 || len(empty.Projects) != 0 || empty.HasMore || empty.Summary.Total != 3 {
		t.Fatalf("out of range retains counts: %+v", empty)
	}
}
