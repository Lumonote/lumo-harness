package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

func TestReportHTTPAuthorizesActualTaskProject(t *testing.T) {
	ts, pool := newTestServerWithPool(t)
	ctx := context.Background()
	one := createProject(t, ts, "owner1", "realm", "One")
	two := createProject(t, ts, "owner2", "realm", "Two")
	if _, err := pool.Exec(ctx, `CREATE TABLE governance_delegation_tasks(id TEXT NOT NULL,realm TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(realm,id))`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_delegation_tasks VALUES('task','realm',$1)`, one); err != nil {
		t.Fatal(err)
	}
	// The test server's intentionally minimal metering table lacks report columns;
	// no evidence references means report cost hydration correctly has no query.
	sections := make([]domain.ReportSection, 0, len(domain.ReportSectionNames))
	for _, name := range domain.ReportSectionNames {
		sections = append(sections, domain.ReportSection{Name: name, Content: json.RawMessage(`{}`)})
	}
	body, _ := json.Marshal(map[string]any{"sections": sections})
	foreign := ts.URL + "/v1/tasks/task/report?project_id=" + two
	for _, method := range []string{"GET", "POST"} {
		resp, out := do(t, method, foreign, string(body), auth("owner2", "realm"))
		if resp.StatusCode != 404 {
			t.Fatalf("foreign %s: %d %s", method, resp.StatusCode, out)
		}
	}
	resp, out := do(t, "POST", ts.URL+"/v1/tasks/task/report?project_id="+one, string(body), auth("owner1", "realm"))
	if resp.StatusCode != 201 {
		t.Fatalf("valid create: %d %s", resp.StatusCode, out)
	}
	var report domain.TaskReport
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/tasks/task/report/confirm?project_id=" + two, "/v1/reports/" + report.ID + "/confirm?project_id=" + two} {
		resp, out := do(t, "POST", ts.URL+path, fmt.Sprintf(`{"report_id":%q}`, report.ID), auth("owner2", "realm"))
		if resp.StatusCode != 404 {
			t.Fatalf("foreign confirm: %d %s", resp.StatusCode, out)
		}
	}
	for _, task := range []string{"missing", "task"} {
		realm := "realm"
		if task == "task" {
			realm = "foreign"
		}
		resp, out := do(t, "GET", ts.URL+"/v1/tasks/"+task+"/report?project_id="+one, "", auth("owner1", realm))
		if resp.StatusCode != 404 {
			t.Fatalf("unknown/foreign task: %d %s", resp.StatusCode, out)
		}
	}
	resp, out = do(t, "POST", ts.URL+"/v1/projects/"+one+"/members", `{"userId":"viewer","role":"viewer"}`, auth("owner1", "realm"))
	if resp.StatusCode != 201 {
		t.Fatal(out)
	}
	resp, out = do(t, "POST", ts.URL+"/v1/tasks/task/report?project_id="+one, string(body), auth("viewer", "realm"))
	if resp.StatusCode != 403 {
		t.Fatalf("viewer write: %d %s", resp.StatusCode, out)
	}
	resp, out = do(t, "GET", ts.URL+"/v1/tasks/task/report?project_id="+one+"&live_head=1junk", "", auth("owner1", "realm"))
	if resp.StatusCode != 400 {
		t.Fatalf("invalid live head: %d %s", resp.StatusCode, out)
	}
}

func TestReportHTTPFailsClosedWithoutGovernance(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner", "realm", "One")
	resp, out := do(t, "GET", ts.URL+"/v1/tasks/task/report?project_id="+id, "", auth("owner", "realm"))
	if resp.StatusCode != 404 {
		t.Fatalf("missing task authority: %d %s", resp.StatusCode, out)
	}
}
