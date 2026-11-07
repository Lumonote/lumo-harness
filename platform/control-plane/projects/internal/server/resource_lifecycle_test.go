package server_test

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestResourceLifecycleHTTP(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner", "realm", "Project")
	base := ts.URL + "/v1/projects/" + id
	for _, role := range []string{"editor", "viewer"} {
		resp, out := do(t, "POST", base+"/members", fmt.Sprintf(`{"userId":%q,"role":%q}`, role, role), auth("owner", "realm"))
		if resp.StatusCode != 201 {
			t.Fatal(out)
		}
	}
	steps := []struct {
		method, path, body, user string
		status                   int
	}{
		{"POST", "/spaces", `{"spaceId":"space","name":"Before"}`, "editor", 201},
		{"PATCH", "/spaces/space", `{"name":"After","expectedName":"Before"}`, "viewer", 403},
		{"PATCH", "/spaces/space", `{"name":"After","expectedName":"Before"}`, "editor", 200},
		{"DELETE", "/spaces/space", `{"expectedName":"Before"}`, "editor", 409},
		{"DELETE", "/spaces/space", `{}`, "editor", 400},
		{"DELETE", "/spaces/space", `{"expectedName":"After"}`, "editor", 204},
		{"PUT", "/artifacts/skill/review", `{"version":"1","expectedVersion":""}`, "editor", 200},
		{"PUT", "/artifacts/skill/review", `{"version":"2","expectedVersion":""}`, "editor", 409},
		{"DELETE", "/artifacts/skill/review", `{"expectedVersion":"1"}`, "viewer", 403},
		{"DELETE", "/artifacts/skill/review", `{"expectedVersion":"old"}`, "editor", 409},
		{"DELETE", "/artifacts/skill/review", `{"expectedVersion":"1"}`, "editor", 204},
		{"POST", "/automations", `{"automationId":"rule","triggerKind":"event","triggerSpec":"task.done","flowRef":"flow","enabled":false}`, "editor", 201},
		{"POST", "/automations", `{"automationId":"rule","triggerKind":"event","triggerSpec":"x","flowRef":"flow"}`, "editor", 409},
		{"PATCH", "/automations/rule", `{"triggerKind":"event","triggerSpec":"x","flowRef":"flow","enabled":true}`, "editor", 400},
		{"PATCH", "/automations/rule", `{"triggerKind":"event","triggerSpec":"x","flowRef":"flow","enabled":true,"expectedRevision":1}`, "editor", 200},
		{"PATCH", "/automations/rule", `{"triggerKind":"event","triggerSpec":"x","flowRef":"flow","enabled":true,"expectedRevision":1}`, "editor", 409},
		{"DELETE", "/automations/rule?expectedRevision=1", "", "editor", 409},
		{"DELETE", "/automations/rule?expectedRevision=bad", "", "editor", 400},
		{"DELETE", "/automations/rule?expectedRevision=2", "", "editor", 204},
	}
	for _, step := range steps {
		resp, out := do(t, step.method, base+step.path, step.body, auth(step.user, "realm"))
		if resp.StatusCode != step.status {
			t.Fatalf("%s %s got %d want %d: %s", step.method, step.path, resp.StatusCode, step.status, out)
		}
		if step.path == "/automations" && step.status == 201 {
			var row struct {
				Revision int64 `json:"revision"`
				Enabled  bool  `json:"enabled"`
			}
			if err := json.Unmarshal([]byte(out), &row); err != nil || row.Revision != 1 || row.Enabled {
				t.Fatalf("%s %v", out, err)
			}
		}
	}
	for _, body := range []string{`{"automationId":"bad","triggerKind":"missing","triggerSpec":"x","flowRef":"flow"}`, `{"automationId":"bad","triggerKind":"cron","triggerSpec":"invalid","flowRef":"flow"}`, `{"automationId":"bad","triggerKind":"event","triggerSpec":"\n","flowRef":"flow"}`} {
		resp, out := do(t, "POST", base+"/automations", body, auth("editor", "realm"))
		if resp.StatusCode != 400 {
			t.Fatalf("invalid rule: %d %s", resp.StatusCode, out)
		}
	}
	for _, invalid := range []string{"unroutable rule", "slash/rule", "colon:rule", ".", "..", "换行\nrule"} {
		for _, resource := range []string{"spaces", "automations"} {
			body := map[string]any{"spaceId": invalid, "name": "Invalid"}
			if resource == "automations" {
				body = map[string]any{"automationId": invalid, "triggerKind": "event", "triggerSpec": "event", "flowRef": "flow"}
			}
			encoded, _ := json.Marshal(body)
			resp, out := do(t, "POST", base+"/"+resource, string(encoded), auth("editor", "realm"))
			if resp.StatusCode != 400 {
				t.Fatalf("unroutable %s ID %q: %d %s", resource, invalid, resp.StatusCode, out)
			}
		}
	}
}
