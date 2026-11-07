package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/server"
	"github.com/lumo-harness/platform/projects/internal/store"
)

type delayedMutationBody struct {
	reader  *strings.Reader
	reading chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *delayedMutationBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.reading) })
	<-b.release
	return b.reader.Read(p)
}
func (*delayedMutationBody) Close() error { return nil }

func mutationFixture(t *testing.T) (*store.Store, *pgxpool.Pool, http.Handler, string) {
	t.Helper()
	ts, pool := newTestServerWithPool(t)
	id := createProject(t, ts, "keeper", "realm", "Project")
	st := store.New(pool, 1000)
	ctx := context.Background()
	for _, member := range []struct{ user, role string }{{"actor", "owner"}, {"target", "viewer"}} {
		if err := st.AddMember(ctx, id, member.user, member.role); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.UpsertSpace(ctx, domain.Space{ID: "space", ProjectID: id, Realm: "realm", Name: "Space"}); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertAutomation(ctx, domain.Automation{ID: "rule", ProjectID: id, TriggerKind: "event", TriggerSpec: "event", FlowRef: "flow", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertArtifact(ctx, domain.Artifact{ProjectID: id, Kind: "skill", Name: "skill", Version: "1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE governance_delegation_tasks(id TEXT NOT NULL,realm TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(realm,id));
        INSERT INTO governance_delegation_tasks VALUES('task','realm','`+id+`')`); err != nil {
		t.Fatal(err)
	}
	sections := []domain.ReportSection{}
	for _, name := range domain.ReportSectionNames {
		sections = append(sections, domain.ReportSection{Name: name, Content: json.RawMessage(`{}`), Verified: true, Evidence: []domain.ReportEvidence{{SessionRef: "session", Seq: 1}}})
	}
	encoded, _ := json.Marshal(sections)
	if _, err := pool.Exec(ctx, `INSERT INTO task_reports(id,realm,task_id,sections,status,created_by) VALUES('report','realm','task',$1,'draft','keeper')`, encoded); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	server.New(st, nil).Register(mux)
	return st, pool, mux, id
}

func startMutation(t *testing.T, handler http.Handler, method, path string, body io.Reader, headers map[string]string) (*httptest.ResponseRecorder, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(method, path, body).WithContext(ctx)
	for name, value := range auth("actor", "realm") {
		req.Header.Set(name, value)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); handler.ServeHTTP(recorder, req) }()
	// Failed assertions must release database work before the fixture closes its
	// pool. Callers defer releasing the slow body or rolling back their lock.
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("HTTP mutation did not stop during cleanup")
		}
	})
	return recorder, done
}

func awaitMutation(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP mutation did not finish")
	}
}

func TestHTTPMutationsRecheckMembershipAfterSlowBody(t *testing.T) {
	for _, mutation := range []struct{ name, method, path, body string }{
		{"rename", "PATCH", "/v1/projects/%s", `{"name":"Changed","expectedName":"Project"}`},
		{"space-create", "POST", "/v1/projects/%s/spaces", `{"spaceId":"new-space","name":"New"}`},
		{"space-rename", "PATCH", "/v1/projects/%s/spaces/space", `{"name":"Changed","expectedName":"Space"}`},
		{"space-delete", "DELETE", "/v1/projects/%s/spaces/space", `{"expectedName":"Space"}`},
		{"automation-create", "POST", "/v1/projects/%s/automations", `{"automationId":"new-rule","triggerKind":"event","triggerSpec":"event","flowRef":"flow"}`},
		{"automation-put", "PUT", "/v1/projects/%s/automations/rule", `{"triggerKind":"event","triggerSpec":"changed","flowRef":"flow","enabled":true}`},
		{"automation-patch", "PATCH", "/v1/projects/%s/automations/rule", `{"triggerKind":"event","triggerSpec":"changed","flowRef":"flow","enabled":true,"expectedRevision":1}`},
		{"artifact-put", "PUT", "/v1/projects/%s/artifacts/skill/skill", `{"version":"2","expectedVersion":"1"}`},
		{"artifact-delete", "DELETE", "/v1/projects/%s/artifacts/skill/skill", `{"expectedVersion":"1"}`},
		{"member-add", "POST", "/v1/projects/%s/members", `{"userId":"intruder","role":"owner"}`},
		{"member-update", "PATCH", "/v1/projects/%s/members/target", `{"role":"owner"}`},
		{"decision", "POST", "/v1/projects/%s/decisions", `{"kind":"decision","summary":"Changed","body":"Changed"}`},
		{"report-create", "POST", "/v1/tasks/task/report?project_id=%s", `{"sections":[{"name":"work_done","content":{}},{"name":"proof_of_work","content":{}},{"name":"verification","content":{}},{"name":"duration","content":{}},{"name":"cost","content":{}},{"name":"risk","content":{}}]}`},
		{"report-confirm", "POST", "/v1/tasks/task/report/confirm?project_id=%s", `{"report_id":"report"}`},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			st, pool, handler, id := mutationFixture(t)
			body := &delayedMutationBody{reader: strings.NewReader(mutation.body), reading: make(chan struct{}), release: make(chan struct{})}
			var release sync.Once
			defer release.Do(func() { close(body.release) })
			recorder, done := startMutation(t, handler, mutation.method, fmt.Sprintf(mutation.path, id), body, nil)
			select {
			case <-body.reading:
			case <-time.After(5 * time.Second):
				t.Fatal("handler never reached body after preflight")
			}
			// The request passed require(). A second owner's revocation commits while
			// its JSON body is paused, before the write transaction even starts.
			if err := st.UpdateMemberRole(context.Background(), id, "actor", domain.RoleViewer); err != nil {
				t.Fatal(err)
			}
			release.Do(func() { close(body.release) })
			awaitMutation(t, done)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("stale actor wrote after demotion: %d %s", recorder.Code, recorder.Body.String())
			}
			var name, spaceName, spec, version, targetRole, reportStatus string
			var decisions int
			if err := pool.QueryRow(context.Background(), `SELECT p.name,s.name,a.trigger_spec,f.version,m.role,r.status,(SELECT count(*) FROM project_decisions)
                 FROM projects p JOIN project_spaces s ON s.project_id=p.id JOIN project_automations a ON a.project_id=p.id
                 JOIN project_artifacts f ON f.project_id=p.id JOIN project_members m ON m.project_id=p.id AND m.user_id='target'
                 JOIN task_reports r ON r.id='report' WHERE p.id=$1`, id).Scan(&name, &spaceName, &spec, &version, &targetRole, &reportStatus, &decisions); err != nil {
				t.Fatal(err)
			}
			if name != "Project" || spaceName != "Space" || spec != "event" || version != "1" || targetRole != "viewer" || reportStatus != "draft" || decisions != 0 {
				t.Fatal("denied mutation changed persisted state")
			}
		})
	}
}

func TestHTTPMutationsRecheckMembershipAfterWaitingForParentLock(t *testing.T) {
	for _, mutation := range []struct {
		name, method, path string
		archived           bool
	}{
		{"archive", "POST", "/v1/projects/%s/archive", false},
		{"unarchive", "POST", "/v1/projects/%s/unarchive", true},
		{"delete-project", "DELETE", "/v1/projects/%s", true},
		{"delete-member", "DELETE", "/v1/projects/%s/members/target", false},
		{"delete-automation", "DELETE", "/v1/projects/%s/automations/rule?expectedRevision=1", false},
		{"confirm-report-by-id", "POST", "/v1/reports/report/confirm?project_id=%s", false},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			st, pool, handler, id := mutationFixture(t)
			ctx := context.Background()
			if mutation.archived {
				if _, err := st.Transition(ctx, id, "archive"); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			var pid int32
			if err = tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM projects WHERE id=$1 FOR UPDATE`, id).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id='actor'`, id); err != nil {
				t.Fatal(err)
			}
			recorder, done := startMutation(t, handler, mutation.method, fmt.Sprintf(mutation.path, id), nil, map[string]string{"X-Lumo-Confirm": id})
			deadline := time.Now().Add(5 * time.Second)
			for {
				var waiting bool
				if err = pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("mutation never waited for the locked parent")
				}
				time.Sleep(5 * time.Millisecond)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			awaitMutation(t, done)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("stale actor wrote after lock wait: %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
