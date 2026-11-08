package store

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func progressUpdate(id string) domain.TaskProgressUpdate {
	return domain.TaskProgressUpdate{RunID: id + "-run-1", Status: "on_track", Percent: 40, Summary: "Implementation complete", NextStep: "Run integration checks"}
}

func progressTestStore(t *testing.T) *Store {
	t.Helper()
	s := taskTestStore(t)
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status) VALUES('realm','progress-writer','Progress writer','active');
	  INSERT INTO governance_role_permissions(realm,role_id,action,effect) VALUES
	  ('realm','progress-writer','task:delegate','allow'),('realm','progress-writer','task:execution:update','allow');
	  INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES
	  ('realm','manager','progress-writer','manager'),('realm','employee','progress-writer','manager')`); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestTaskProgressConcurrentCASAndAudit(t *testing.T) {
	s := progressTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "parent", "")
	seedResultTask(t, s, "child", "parent")
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.RecordTaskProgress(ctx, "realm", "child", progressUpdate("child"), "employee")
			if err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrConflict) {
				t.Errorf("unexpected write failure: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("CAS admitted %d writers", successes.Load())
	}
	view, err := s.TaskProgress(ctx, "realm", "child")
	if err != nil || view.Revision != 1 || len(view.History) != 1 || view.Progress == nil || view.Progress.Source != "user" {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	var audit, parent int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id='child' AND event='progress_updated'`).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id='parent' AND event='child_progress'`).Scan(&parent); err != nil {
		t.Fatal(err)
	}
	if audit != 1 || parent != 1 {
		t.Fatalf("audit=%d parent=%d", audit, parent)
	}
	collaboration, err := s.CollaborationProgress(ctx, "realm", "parent")
	if err != nil || len(collaboration.Children) != 1 || collaboration.Children[0].Progress == nil {
		t.Fatalf("collaboration=%+v err=%v", collaboration, err)
	}
}

func TestTaskProgressAttemptsTerminalStateAndRealm(t *testing.T) {
	s := progressTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	update := progressUpdate("task")
	update.Percent = 100
	if _, err := s.RecordTaskProgress(ctx, "realm", "task", update, "employee"); err != nil {
		t.Fatal(err)
	}
	task, err := s.GetDelegationTask(ctx, "realm", "task")
	if err != nil || task.BusinessState != domain.BusinessExecuting || task.State != domain.DelegationRunning {
		t.Fatalf("progress changed execution state: %+v %v", task, err)
	}
	if _, err := s.RecordTaskProgress(ctx, "another-realm", "task", update, "employee"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross realm write: %v", err)
	}
	if _, err := s.TaskProgress(ctx, "another-realm", "task"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross realm read: %v", err)
	}
	failed := resultFor("task")
	failed.State = domain.DelegationFailed
	if _, err := s.RecordTaskResult(ctx, "realm", failed, "runtime"); err != nil {
		t.Fatal(err)
	}
	update.ExpectedRevision = 1
	if _, err := s.RecordTaskProgress(ctx, "realm", "task", update, "employee"); !errors.Is(err, ErrConflict) {
		t.Fatalf("terminal write: %v", err)
	}
	if _, err := s.CreateNextTaskRun(ctx, "realm", "task", domain.TaskRun{ID: "run-2", WorkerID: "user:employee", State: domain.DelegationRunning}); err != nil {
		t.Fatal(err)
	}
	view, err := s.TaskProgress(ctx, "realm", "task")
	if err != nil || view.CurrentRunID != "run-2" || view.Progress != nil || view.Revision != 1 || len(view.History) != 1 {
		t.Fatalf("retry inherited stale progress: %+v %v", view, err)
	}
	if _, err := s.RecordTaskProgress(ctx, "realm", "task", update, "employee"); !errors.Is(err, ErrConflict) {
		t.Fatalf("late old run: %v", err)
	}
	update.RunID = "run-2"
	if p, err := s.RecordTaskProgress(ctx, "realm", "task", update, "employee"); err != nil || p.Revision != 2 {
		t.Fatalf("new run: %+v %v", p, err)
	}
}

func TestRuntimeProgressRequiresDurableIdentity(t *testing.T) {
	s := progressTestStore(t)
	ctx := context.Background()
	task := seedResultTask(t, s, "task", "")
	if _, err := s.pool.Exec(ctx, `UPDATE governance_task_runs SET scheduler_task_id=id,session_ref='session-1' WHERE id='task-run-1'`); err != nil {
		t.Fatal(err)
	}
	for _, binding := range [][2]string{{"device-b", "session-1"}, {"device-a", "wrong"}, {"", ""}} {
		if _, err := s.RecordRuntimeTaskProgress(ctx, "realm", "task", progressUpdate("task"), binding[0], binding[1]); !errors.Is(err, ErrForbidden) {
			t.Fatalf("mismatched runtime: %v", err)
		}
	}
	p, err := s.RecordRuntimeTaskProgress(ctx, "realm", "task", progressUpdate("task"), "device-a", "session-1")
	if err != nil || p.Source != "runtime" || p.UpdatedBy != "user:employee" {
		t.Fatalf("runtime=%+v err=%v", p, err)
	}
	items, err := s.TaskProgressItems(ctx, "realm", []domain.DelegatedTask{task})
	if err != nil || len(items) != 1 || items[0].Progress == nil || items[0].Run == nil {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	items, err = s.TaskProgressItems(ctx, "other-realm", []domain.DelegatedTask{task})
	if err != nil || len(items) != 1 || items[0].Progress != nil || items[0].Run != nil {
		t.Fatalf("cross-realm runtime leak: %+v %v", items, err)
	}
}
