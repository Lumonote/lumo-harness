package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func waitProgressWriteThenRevoke(t *testing.T, s *Store, tx pgx.Tx, taskID, actor string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var blocker int32
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := s.RecordTaskProgress(ctx, "realm", taskID, progressUpdate(taskID), actor)
		result <- err
	}()
	for {
		var waiting bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("progress write never waited for authority lock")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked actor wrote progress: %v", err)
	}
	view, err := s.TaskProgress(ctx, "realm", taskID)
	if err != nil || view.Revision != 0 || len(view.History) != 0 {
		t.Fatalf("revoked write persisted: %+v %v", view, err)
	}
}

func TestTaskProgressRechecksCollaboratorAfterTaskLock(t *testing.T) {
	for _, inherited := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "inherited"}[inherited], func(t *testing.T) {
			s := progressTestStore(t)
			ctx := context.Background()
			seedResultTask(t, s, "parent", "")
			seedResultTask(t, s, "child", "parent")
			grantTask := "child"
			if inherited {
				grantTask = "parent"
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,status) VALUES('realm','collaborator','Collaborator','active');`); err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('realm','collaborator','progress-writer','manager')`); err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by) VALUES('realm',$1,'user','collaborator','contributor','manager')`, grantTask); err != nil {
				t.Fatal(err)
			}
			if access, err := s.TaskAccess(ctx, "realm", "child", "collaborator"); err != nil || access != "contributor" {
				t.Fatalf("fixture access: %s %v", access, err)
			}
			tx, err := s.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm='realm' AND id='child' FOR UPDATE`); err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec(ctx, `DELETE FROM governance_task_collaborators WHERE realm='realm' AND task_id=$1 AND subject_id='collaborator'`, grantTask); err != nil {
				t.Fatal(err)
			}
			waitProgressWriteThenRevoke(t, s, tx, "child", "collaborator")
		})
	}
}

func TestTaskProgressRechecksAccountAfterOrganizationLock(t *testing.T) {
	s := progressTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "task", "")
	tx, err := s.beginOrganizationChange(ctx, "realm")
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE governance_users SET status='suspended' WHERE realm='realm' AND id='employee'`); err != nil {
		t.Fatal(err)
	}
	waitProgressWriteThenRevoke(t, s, tx, "task", "employee")
}

func TestTaskProgressRechecksCurrentRolePolicyAfterOrganizationLock(t *testing.T) {
	for name, mutation := range map[string]string{
		"execution-deny": `UPDATE governance_role_permissions SET effect='deny' WHERE realm='realm' AND role_id='progress-writer' AND action='task:execution:update'`,
		"delegate-deny":  `UPDATE governance_role_permissions SET effect='deny' WHERE realm='realm' AND role_id='progress-writer' AND action='task:delegate'`,
		"revoked-grant":  `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='employee'`,
		"expired-grant":  `UPDATE governance_user_roles SET expires_at=clock_timestamp()-interval '1 second' WHERE realm='realm' AND user_id='employee'`,
		"disabled-role":  `UPDATE governance_roles SET status='disabled' WHERE realm='realm' AND id='progress-writer'`,
		"inherited-deny": `INSERT INTO governance_roles(realm,id,name,status) VALUES('realm','blocked-parent','Blocked parent','active');
		 INSERT INTO governance_role_permissions(realm,role_id,action,effect) VALUES('realm','blocked-parent','task:execution:update','deny');
		 UPDATE governance_roles SET parent_role_id='blocked-parent' WHERE realm='realm' AND id='progress-writer'`,
	} {
		t.Run(name, func(t *testing.T) {
			s := progressTestStore(t)
			ctx := context.Background()
			seedResultTask(t, s, "task", "")
			tx, err := s.beginOrganizationChange(ctx, "realm")
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, mutation); err != nil {
				t.Fatal(err)
			}
			waitProgressWriteThenRevoke(t, s, tx, "task", "employee")
			if access, err := s.TaskAccess(ctx, "realm", "task", "employee"); err != nil || access != "contributor" {
				t.Fatalf("fixture must retain contributor access: %s %v", access, err)
			}
		})
	}
}
