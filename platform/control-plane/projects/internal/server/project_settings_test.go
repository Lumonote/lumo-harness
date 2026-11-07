package server_test

import (
	"fmt"
	"strings"
	"testing"
)

func TestRenameProjectPermissionsAndPrecondition(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner", "realm", "Original")
	path := ts.URL + "/v1/projects/" + id
	for _, role := range []string{"editor", "viewer"} {
		resp, out := do(t, "POST", path+"/members", fmt.Sprintf(`{"userId":%q,"role":%q}`, role, role), auth("owner", "realm"))
		if resp.StatusCode != 201 {
			t.Fatalf("member: %d %s", resp.StatusCode, out)
		}
	}
	for _, tc := range []struct {
		user, realm, body string
		status            int
	}{
		{"viewer", "realm", `{"name":"x","expectedName":"Original"}`, 403},
		{"outsider", "realm", `{"name":"x","expectedName":"Original"}`, 404},
		{"owner", "foreign", `{"name":"x","expectedName":"Original"}`, 404},
		{"owner", "realm", `{"name":" "}`, 400},
		{"owner", "realm", `{"name":"x"}`, 400},
		{"owner", "realm", `{"name":"x","expectedName":"Original","unknown":true}`, 400},
		{"owner", "realm", `{"name":"x","expectedName":"Original"} {}`, 400},
		{"owner", "realm", `{"name":"line\nbreak","expectedName":"Original"}`, 400},
		{"editor", "realm", `{"name":" Updated ","expectedName":"Original"}`, 200},
		{"owner", "realm", `{"name":"Overwrite","expectedName":"Original"}`, 409},
	} {
		resp, out := do(t, "PATCH", path, tc.body, auth(tc.user, tc.realm))
		if resp.StatusCode != tc.status {
			t.Fatalf("%+v got %d %s", tc, resp.StatusCode, out)
		}
	}
	other := createProject(t, ts, "owner", "realm", "Taken")
	_ = other
	resp, out := do(t, "PATCH", path, `{"name":"Taken","expectedName":"Updated"}`, auth("owner", "realm"))
	if resp.StatusCode != 409 {
		t.Fatalf("duplicate: %d %s", resp.StatusCode, out)
	}
	resp, out = do(t, "GET", path, "", auth("owner", "realm"))
	if resp.StatusCode != 200 || !strings.Contains(out, `"name":"Updated"`) {
		t.Fatalf("rename persisted: %d %s", resp.StatusCode, out)
	}
}

func TestArchivedProjectReadOnlyPreservesOwnerMembership(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner", "realm", "Project")
	path := ts.URL + "/v1/projects/" + id
	resp, out := do(t, "POST", path+"/archive", "", auth("owner", "realm"))
	if resp.StatusCode != 200 {
		t.Fatalf("archive: %d %s", resp.StatusCode, out)
	}
	for _, tc := range []struct{ method, suffix, body string }{
		{"PATCH", "", `{"name":"x","expectedName":"Project"}`},
		{"PUT", "/artifacts/skill/x", `{"version":"1"}`},
		{"POST", "/spaces", `{"name":"space"}`},
		{"PUT", "/automations/x", `{"triggerKind":"event","triggerSpec":"x","flowRef":"flow"}`},
		{"DELETE", "/automations/x", ""},
		{"POST", "/decisions", `{"kind":"decision","summary":"Summary","body":"Body"}`},
	} {
		resp, out := do(t, tc.method, path+tc.suffix, tc.body, auth("owner", "realm"))
		if resp.StatusCode != 409 {
			t.Fatalf("archived %s %s: %d %s", tc.method, tc.suffix, resp.StatusCode, out)
		}
	}
	resp, out = do(t, "POST", path+"/members", `{"userId":"new","role":"editor"}`, auth("owner", "realm"))
	if resp.StatusCode != 201 {
		t.Fatalf("archived owner can manage members: %d %s", resp.StatusCode, out)
	}
	resp, out = do(t, "GET", path+"/dashboard", "", auth("owner", "realm"))
	if resp.StatusCode != 200 {
		t.Fatalf("archived read: %d %s", resp.StatusCode, out)
	}
}
