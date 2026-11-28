package server_test

import (
	"context"
	"net/http"
	"testing"
)

func TestLegacyMutationsRecheckProjectAuthority(t *testing.T) {
	for _, change := range []string{"removed", "viewer", "archived"} {
		t.Run(change, func(t *testing.T) {
			ts, pool, seed := newTestServer(t)
			seed("p", map[string]string{"author": "editor", "owner": "owner", "reviewer": "editor"})
			id := createFlow(t, ts, "author", "r1", "p", "flow", goodDAG)
			query := map[string]string{
				"removed":  `DELETE FROM project_members WHERE user_id='author'`,
				"viewer":   `UPDATE project_members SET role='viewer' WHERE user_id='author'`,
				"archived": `UPDATE projects SET status='archived' WHERE id='p'`,
			}[change]
			if _, err := pool.Exec(context.Background(), query); err != nil {
				t.Fatal(err)
			}
			for _, mutation := range []struct{ method, path, body string }{
				{"PUT", "/definition", `{"definition":` + goodDAG + `}`},
				{"POST", "/submit", ``},
				{"POST", "/deprecate", ``},
			} {
				resp, body := do(t, mutation.method, ts.URL+"/v1/flows/"+id+mutation.path, mutation.body, auth("author", "r1", nil))
				if resp.StatusCode != http.StatusForbidden {
					t.Fatalf("%s %s: %d %s", change, mutation.path, resp.StatusCode, body)
				}
			}
		})
	}
}

func TestPublishedAuthorRequiresGovernanceRoleToDeprecate(t *testing.T) {
	ts, pool, seed := newTestServer(t)
	seed("p", map[string]string{"author": "editor", "owner": "owner"})
	id := createFlow(t, ts, "author", "r1", "p", "flow", goodDAG)
	if _, err := pool.Exec(context.Background(), `UPDATE flows SET status='published' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	resp, body := do(t, "POST", ts.URL+"/v1/flows/"+id+"/deprecate", "", auth("author", "r1", nil))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("author deprecation: %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "POST", ts.URL+"/v1/flows/"+id+"/deprecate", "", auth("owner", "r1", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner deprecation: %d %s", resp.StatusCode, body)
	}
}
