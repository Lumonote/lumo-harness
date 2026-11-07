package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestDelegationPagesTieBreakAndMutableUpdates(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	// All creation timestamps tie. More than two pages ensures that the ID is
	// part of the SQL cursor predicate as well as its ORDER BY.
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,requester_user_id,assignee_user_id,state,created_at,updated_at)
		SELECT 'page-'||lpad(n::text,4,'0'),'realm','Work','Work','manager','employee','QUEUED',
		'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM generate_series(1,405) n;
		INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,requester_user_id,assignee_user_id,state,created_at)
		VALUES ('foreign','other','Foreign','Work','manager','employee','QUEUED','2027-01-01T00:00:00Z'),
		('hidden','realm','Hidden','Work','other','other','QUEUED','2027-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	cursor := ""
	for page, wantSize := range []int{200, 200, 5} {
		rows, next, err := s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, cursor, 200)
		if err != nil || len(rows) != wantSize {
			t.Fatalf("page %d: %d rows, %v", page, len(rows), err)
		}
		for _, row := range rows {
			want := fmt.Sprintf("page-%04d", 405-len(seen))
			if seen[row.ID] || row.ID != want || row.Realm != "realm" {
				t.Fatalf("page %d: got %s, want %s", page, row.ID, want)
			}
			seen[row.ID] = true
		}
		if page < 2 && next == "" || page == 2 && next != "" {
			t.Fatalf("page %d: invalid continuation %q", page, next)
		}
		if page == 0 {
			// Both already-read and not-yet-read rows receive updates. Neither
			// should move across a cursor keyed by creation time.
			if _, err := s.pool.Exec(ctx, `UPDATE governance_delegation_tasks
				SET updated_at=now(),state='RUNNING' WHERE realm='realm'`); err != nil {
				t.Fatal(err)
			}
		}
		cursor = next
	}
	if len(seen) != 405 {
		t.Fatalf("incomplete traversal: %d", len(seen))
	}
}

func TestDelegationPagesInheritParentGrantsAndBoundCycles(t *testing.T) {
	s := taskTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The cycle is injected as legacy/corrupt data. Reading must terminate and
	// retain grants found on an ancestor, without following a cross-realm edge.
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,requester_user_id,assignee_user_id,state,intent_contract,created_at)
		VALUES
		('root','realm','Root','Work','other','other','QUEUED','{"parent_task_id":"child"}','2026-01-01T00:00:00Z'),
		('child','realm','Child','Work','other','other','QUEUED','{"parent_task_id":"root"}','2026-01-01T00:00:00Z'),
		('grandchild','realm','Grandchild','Work','other','other','QUEUED','{"parent_task_id":"child"}','2026-01-01T00:00:00Z'),
		('unrelated','realm','Unrelated','Work','other','other','QUEUED',NULL,'2026-01-01T00:00:00Z'),
		('foreign-root','foreign','Foreign','Work','other','other','QUEUED',NULL,'2026-01-01T00:00:00Z'),
		('foreign-edge','realm','Foreign edge','Work','other','other','QUEUED','{"parent_task_id":"foreign-root"}','2026-01-01T00:00:00Z');
		INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by)
		VALUES ('realm','root','user','manager','contributor','other'),
		('foreign','foreign-root','user','manager','contributor','other')`); err != nil {
		t.Fatal(err)
	}
	rows, next, err := s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, "", 200)
	if err != nil || next != "" || len(rows) != 3 {
		t.Fatalf("inherited list: %d rows, next=%q, %v", len(rows), next, err)
	}
	want := map[string]bool{"root": true, "child": true, "grandchild": true}
	for _, row := range rows {
		if !want[row.ID] {
			t.Fatalf("unrelated/cross-realm ancestor leaked: %+v", row)
		}
		access, err := s.TaskAccess(ctx, "realm", row.ID, "manager")
		if err != nil || access != "contributor" {
			t.Fatalf("inherited task detail %s: %q %v", row.ID, access, err)
		}
	}
	for _, id := range []string{"unrelated", "foreign-edge"} {
		access, err := s.TaskAccess(ctx, "realm", id, "manager")
		if err != nil || access != "" {
			t.Fatalf("inherited across unrelated/realm edge %s: %q %v", id, access, err)
		}
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_task_collaborators WHERE realm='realm'`); err != nil {
		t.Fatal(err)
	}
	rows, _, err = s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, "", 200)
	if err != nil || len(rows) != 0 {
		t.Fatalf("revoked parent grant still visible: %d %v", len(rows), err)
	}
	access, err := s.TaskAccess(ctx, "realm", "grandchild", "manager")
	if err != nil || access != "" {
		t.Fatalf("revoked parent grant still grants detail: %q %v", access, err)
	}
}

func TestDelegationPagesRecheckVisibilityAndCursorScope(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,requester_user_id,assignee_user_id,state,created_at)
		SELECT 'shared-'||n,'realm','Work','Work','other','other','QUEUED','2026-01-01T00:00:00Z'
		FROM generate_series(1,3) n;
		INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by)
		SELECT 'realm',id,'user','manager','viewer','other' FROM governance_delegation_tasks`); err != nil {
		t.Fatal(err)
	}
	first, cursor, err := s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, "", 1)
	if err != nil || len(first) != 1 || cursor == "" {
		t.Fatalf("first page: %v %q %v", first, cursor, err)
	}
	for _, scope := range []struct {
		realm, user string
		all, dept   bool
	}{{"foreign", "manager", false, false}, {"realm", "employee", false, false}, {"realm", "manager", true, false}, {"realm", "manager", false, true}} {
		if _, _, err := s.ListDelegationTasksPage(ctx, scope.realm, scope.user, scope.all, scope.dept, cursor, 1); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("cursor reused in %+v: %v", scope, err)
		}
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_task_collaborators WHERE subject_id='manager'`); err != nil {
		t.Fatal(err)
	}
	rows, next, err := s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, cursor, 1)
	if err != nil || len(rows) != 0 || next != "" {
		t.Fatalf("revoked visibility survived on next page: %v %q %v", rows, next, err)
	}
	// A cursor is a bounded position, not an authorization credential. Even a
	// syntactically valid caller-edited cursor cannot revive revoked grants.
	raw, _ := base64.RawURLEncoding.DecodeString(cursor)
	var value delegationCursor
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	value.ID = "zzzz"
	raw, _ = json.Marshal(value)
	rows, _, err = s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, base64.RawURLEncoding.EncodeToString(raw), 1)
	if err != nil || len(rows) != 0 {
		t.Fatalf("edited cursor granted access: %v %v", rows, err)
	}
	for _, bad := range []string{"!invalid", base64.RawURLEncoding.EncodeToString([]byte(`{}`)), strings.Repeat("a", 4097)} {
		if _, _, err := s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, bad, 1); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("bad cursor accepted: %v", err)
		}
	}
	for _, badLimit := range []int{-1, 0, 201} {
		if _, _, err := s.ListDelegationTasksPage(ctx, "realm", "manager", false, false, "", badLimit); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("bad limit %d: %v", badLimit, err)
		}
	}
}

func TestDelegationPagesInheritParentParticipationLikeTaskAccess(t *testing.T) {
	s := taskTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// No explicit collaborator grants exist. Participation in an ancestor must
	// expose the same descendants as the detail/operation TaskAccess predicate.
	// A legacy parent cycle still terminates and never crosses the realm edge.
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,requester_user_id,assignee_user_id,state,intent_contract,created_at)
		VALUES
		('participant-root','realm','Root','Work','manager','employee','QUEUED','{"parent_task_id":"participant-child"}','2026-01-01T00:00:00Z'),
		('participant-child','realm','Child','Work','other','other','QUEUED','{"parent_task_id":"participant-root"}','2026-01-01T00:00:00Z'),
		('participant-grandchild','realm','Grandchild','Work','other','other','QUEUED','{"parent_task_id":"participant-child"}','2026-01-01T00:00:00Z'),
		('participant-unrelated','realm','Unrelated','Work','other','other','QUEUED',NULL,'2026-01-01T00:00:00Z'),
		('participant-foreign-root','foreign','Foreign','Work','manager','employee','QUEUED',NULL,'2026-01-01T00:00:00Z'),
		('participant-foreign-edge','realm','Foreign edge','Work','other','other','QUEUED','{"parent_task_id":"participant-foreign-root"}','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"manager", "employee"} {
		seen := map[string]bool{}
		cursor := ""
		for {
			rows, next, err := s.ListDelegationTasksPage(ctx, "realm", user, false, false, cursor, 1)
			if err != nil {
				t.Fatal(err)
			}
			for _, row := range rows {
				if seen[row.ID] {
					t.Fatalf("duplicate participant page for %s: %s", user, row.ID)
				}
				seen[row.ID] = true
				access, err := s.TaskAccess(ctx, "realm", row.ID, user)
				if err != nil || access != "contributor" {
					t.Fatalf("list/detail differ for %s on %s: %q %v", user, row.ID, access, err)
				}
			}
			if next == "" {
				break
			}
			cursor = next
		}
		for _, id := range []string{"participant-root", "participant-child", "participant-grandchild"} {
			if !seen[id] {
				t.Fatalf("ancestor participant %s cannot list %s: %v", user, id, seen)
			}
		}
		if len(seen) != 3 {
			t.Fatalf("ancestor participant %s leaked unrelated/realm edge: %v", user, seen)
		}
		for _, id := range []string{"participant-unrelated", "participant-foreign-edge"} {
			access, err := s.TaskAccess(ctx, "realm", id, user)
			if err != nil || access != "" {
				t.Fatalf("task detail leaked unrelated/realm edge to %s on %s: %q %v", user, id, access, err)
			}
		}
		legacy, err := s.ListDelegationTasks(ctx, "realm", user, false, false)
		if err != nil || len(legacy) != 3 {
			t.Fatalf("legacy list differs for participant %s: %d %v", user, len(legacy), err)
		}
	}
}
