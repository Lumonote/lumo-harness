package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func TestConcurrentOwnerChangesRetainOneOwner(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		t.Run(fmt.Sprint("mixed=", mixed), func(t *testing.T) {
			st, pool := newStore(t)
			ctx := context.Background()
			if _, err := st.CreateProject(ctx, "project", "realm", "Project", "one"); err != nil {
				t.Fatal(err)
			}
			if err := st.AddMember(ctx, "project", "two", domain.RoleOwner); err != nil {
				t.Fatal(err)
			}
			// Delay the actual member mutation after the owner's count has been read.
			// Without the common project lock, both transactions see two owners.
			if _, err := pool.Exec(ctx, `CREATE FUNCTION delay_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.25); IF TG_OP='UPDATE' THEN RETURN NEW; END IF; RETURN OLD; END $$;
    CREATE TRIGGER delay_owner_change BEFORE DELETE OR UPDATE ON project_members FOR EACH ROW EXECUTE FUNCTION delay_owner_change()`); err != nil {
				t.Fatal(err)
			}
			var wg sync.WaitGroup
			wg.Add(2)
			start := make(chan struct{})
			outcomes := make(chan error, 2)
			go func() { defer wg.Done(); <-start; outcomes <- st.RemoveMember(ctx, "project", "one") }()
			go func() {
				defer wg.Done()
				<-start
				if mixed {
					outcomes <- st.UpdateMemberRole(ctx, "project", "two", domain.RoleViewer)
				} else {
					outcomes <- st.RemoveMember(ctx, "project", "two")
				}
			}()
			close(start)
			wg.Wait()
			close(outcomes)
			successes, conflicts := 0, 0
			for err := range outcomes {
				if err == nil {
					successes++
				} else if errors.Is(err, store.ErrLastOwner) {
					conflicts++
				} else {
					t.Fatal(err)
				}
			}
			if successes != 1 || conflicts != 1 {
				t.Fatalf("success=%d last-owner=%d", successes, conflicts)
			}
			var owners int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_members WHERE project_id='project' AND role='owner'`).Scan(&owners); err != nil || owners != 1 {
				t.Fatalf("owners=%d err=%v", owners, err)
			}
		})
	}
}

func TestResourceIDsCannotUpdateAnotherProject(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	for _, id := range []string{"one", "two"} {
		if _, err := st.CreateProject(ctx, id, "realm", id, "owner"); err != nil {
			t.Fatal(err)
		}
	}
	space := domain.Space{ID: "space", ProjectID: "one", Realm: "realm", Name: "Original"}
	if err := st.UpsertSpace(ctx, space); err != nil {
		t.Fatal(err)
	}
	attack := space
	attack.ProjectID = "two"
	attack.Name = "Forged"
	if err := st.UpsertSpace(ctx, attack); !errors.Is(err, store.ErrResourceConflict) {
		t.Fatalf("scope collision: %v", err)
	}
	spaces, err := st.ListSpaces(ctx, "one")
	if err != nil || len(spaces) != 1 || spaces[0].Name != "Original" {
		t.Fatalf("foreign space modified: %+v %v", spaces, err)
	}
	space.Name = "Updated"
	if err := st.UpsertSpace(ctx, space); err != nil {
		t.Fatal(err)
	}
	a := domain.Automation{ID: "auto", ProjectID: "one", TriggerKind: "event", TriggerSpec: "original", FlowRef: "flow", Enabled: true}
	if err := st.UpsertAutomation(ctx, a); err != nil {
		t.Fatal(err)
	}
	a.ProjectID = "two"
	a.TriggerSpec = "forged"
	if err := st.UpsertAutomation(ctx, a); !errors.Is(err, store.ErrResourceConflict) {
		t.Fatalf("automation collision: %v", err)
	}
	items, err := st.ListAutomations(ctx, "one")
	if err != nil || len(items) != 1 || items[0].TriggerSpec != "original" {
		t.Fatalf("foreign automation modified: %+v %v", items, err)
	}
	a.ProjectID = "one"
	a.TriggerSpec = "updated"
	if err := st.UpsertAutomation(ctx, a); err != nil {
		t.Fatal(err)
	}
}

func TestArchivedWritesAndOptimisticRename(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	if _, err := st.CreateProject(ctx, "project", "realm", "Before", "owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RenameProject(ctx, "project", "After", "Before"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RenameProject(ctx, "project", "Overwrite", "Before"); !errors.Is(err, store.ErrNameStale) {
		t.Fatalf("stale rename: %v", err)
	}
	if _, err := st.Transition(ctx, "project", "archive"); err != nil {
		t.Fatal(err)
	}
	operations := []func() error{
		func() error { _, err := st.RenameProject(ctx, "project", "Archived", "After"); return err },
		func() error {
			return st.UpsertArtifact(ctx, domain.Artifact{ProjectID: "project", Kind: "skill", Name: "skill", Version: "1"})
		},
		func() error {
			return st.UpsertSpace(ctx, domain.Space{ID: "space", ProjectID: "project", Realm: "realm", Name: "space"})
		},
		func() error {
			return st.UpsertAutomation(ctx, domain.Automation{ID: "auto", ProjectID: "project", TriggerKind: "event", TriggerSpec: "x", FlowRef: "flow"})
		},
		func() error { return st.DeleteAutomation(ctx, "project", "auto") },
		func() error {
			_, err := st.AppendActiveDecision(ctx, domain.Decision{ID: "decision", Realm: "realm", ProjectID: "project", Kind: "decision", Summary: "Summary", Body: "Body"})
			return err
		},
	}
	for i, operation := range operations {
		if err := operation(); !errors.Is(err, store.ErrArchived) {
			t.Fatalf("archived mutation %d: %v", i, err)
		}
	}
	if err := st.AddMember(ctx, "project", "new", domain.RoleEditor); err != nil {
		t.Fatalf("archived member management: %v", err)
	}
	if _, err := st.Transition(ctx, "project", "unarchive"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RenameProject(ctx, "project", "Restored", "After"); err != nil {
		t.Fatal(err)
	}
}

func reportSections() []domain.ReportSection {
	sections := make([]domain.ReportSection, 0, len(domain.ReportSectionNames))
	for _, name := range domain.ReportSectionNames {
		sections = append(sections, domain.ReportSection{Name: name, Content: json.RawMessage(`{}`), Evidence: []domain.ReportEvidence{{SessionRef: "shared", Seq: 1}}})
	}
	return sections
}

func TestReportsUseAuthoritativeTaskProjectAndScopedCost(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	for _, id := range []string{"one", "two"} {
		if _, err := st.CreateProject(ctx, id, "realm", id, "owner"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE governance_delegation_tasks (id TEXT NOT NULL,realm TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(realm,id));
 INSERT INTO governance_delegation_tasks VALUES('task','realm','one'),('unknown-project','realm','');
 INSERT INTO usage_ledger(ts,user_id,dept_id,role,project_id,agent_id,component_id,feature,session_ref,cost_type,qty,cost_usd,tokens)
 VALUES(now(),'u','d','r','one','a','c','f','shared','model',1,2,10), (now(),'u','d','r','two','a','c','f','shared','model',1,999,9000)`); err != nil {
		t.Fatal(err)
	}
	makeReport := func(id string) domain.TaskReport {
		return domain.TaskReport{ID: id, Realm: "realm", TaskID: "task", CreatedBy: "owner", Sections: reportSections()}
	}
	if _, err := st.CreateTaskReport(ctx, "two", makeReport("forged"), nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-project create: %v", err)
	}
	report, err := st.CreateTaskReport(ctx, "one", makeReport("report"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, section := range report.Sections {
		if section.Name == "cost" {
			var cost struct {
				CostUSD float64 `json:"cost_usd"`
				Tokens  int64   `json:"tokens"`
			}
			if err := json.Unmarshal(section.Content, &cost); err != nil {
				t.Fatal(err)
			}
			if cost.CostUSD != 2 || cost.Tokens != 10 {
				t.Fatalf("unscoped cost: %+v", cost)
			}
		}
	}
	if _, err := st.GetTaskReport(ctx, "realm", "two", "task", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-project read: %v", err)
	}
	if _, err := st.ConfirmTaskReport(ctx, "realm", "two", "task", "report", "owner"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-project confirm: %v", err)
	}
	if _, err := st.ConfirmTaskReportByID(ctx, "realm", "two", "report", "owner"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-project confirm by ID: %v", err)
	}
	for _, task := range []string{"missing", "unknown-project"} {
		if _, err := st.GetTaskReport(ctx, "realm", "one", task, nil); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("unknown task %s: %v", task, err)
		}
	}
	if _, err := st.GetTaskReport(ctx, "other-realm", "one", "task", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign realm: %v", err)
	}
	if _, err := st.ConfirmTaskReportByID(ctx, "realm", "one", "report", "owner"); err != nil {
		t.Fatal(err)
	}
}
