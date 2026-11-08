package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestWorkforceFullSummaryFiltersAndCursor(t *testing.T) {
	now := time.Now().UTC()
	items := []domain.WorkforceProgressItem{}
	for i, id := range []string{"newest", "middle", "oldest"} {
		task := domain.DelegatedTask{ID: id, Title: id, CreatedAt: now.Add(-time.Duration(i) * time.Minute), State: domain.DelegationRunning, BusinessState: domain.BusinessExecuting, AssigneeWorkerID: "user:alice"}
		if i == 1 {
			task.AssigneeWorkerID = "agent:researcher"
		}
		items = append(items, domain.WorkforceProgressItem{Task: task, Progress: &domain.TaskProgress{Status: "at_risk", Summary: "Review required"}})
	}
	filter := domain.WorkforceProgressFilter{Query: " REVIEW ", Risk: "at_risk", WorkerKind: "all"}
	filter.Normalize()
	after, encode, err := WorkforceProgressCursor("realm", "alice", "mine", filter, "")
	if err != nil {
		t.Fatal(err)
	}
	first := BuildWorkforceProgressPage(items, filter, 1, after, encode)
	if first.Summary.Total != 3 || first.Summary.AtRisk != 3 || len(first.Items) != 1 || first.NextCursor == "" || first.SummaryScope != "filtered_scope" || first.ByWorkerKind["agent"].Total != 1 {
		t.Fatalf("first: %+v", first)
	}
	after, encode, err = WorkforceProgressCursor("realm", "alice", "mine", filter, first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	next := BuildWorkforceProgressPage(items, filter, 2, after, encode)
	if len(next.Items) != 2 || next.Items[0].Task.ID != "middle" || next.NextCursor != "" || next.Summary.Total != 3 {
		t.Fatalf("continuation: %+v", next)
	}
	for _, changed := range []struct {
		realm, user, scope string
		filter             domain.WorkforceProgressFilter
	}{
		{"other", "alice", "mine", filter}, {"realm", "bob", "mine", filter}, {"realm", "alice", "all", filter},
		{"realm", "alice", "mine", domain.WorkforceProgressFilter{Risk: "all", WorkerKind: "all"}},
	} {
		if _, _, err := WorkforceProgressCursor(changed.realm, changed.user, changed.scope, changed.filter, first.NextCursor); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("cursor crossed identity/filter: %v", err)
		}
	}
	filter.WorkerKind = "agent"
	after, encode, _ = WorkforceProgressCursor("realm", "alice", "mine", filter, "")
	if page := BuildWorkforceProgressPage(items, filter, 50, after, encode); page.Summary.Total != 1 || page.Items[0].Task.ID != "middle" {
		t.Fatalf("agent filter: %+v", page)
	}
}

func TestWorkforceSnapshotAppliesCurrentTaskACLBeforeTotals(t *testing.T) {
	s := progressTestStore(t)
	ctx := context.Background()
	seedResultTask(t, s, "shared", "")
	seedResultTask(t, s, "private", "")
	seedResultTask(t, s, "child", "shared")
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,status)VALUES('realm','reader','Reader','active');
 INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by)VALUES('realm','shared','user','reader','viewer','manager')`); err != nil {
		t.Fatal(err)
	}
	items, err := s.WorkforceProgressSnapshot(ctx, "realm", "reader", true, true, false)
	if err != nil || len(items) != 2 {
		t.Fatalf("ACL/inherited visibility: %+v %v", items, err)
	}
	for _, item := range items {
		if item.Task.ID == "private" {
			t.Fatal("private task leaked")
		}
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM governance_task_collaborators WHERE task_id='shared'`); err != nil {
		t.Fatal(err)
	}
	items, err = s.WorkforceProgressSnapshot(ctx, "realm", "reader", true, true, false)
	if err != nil || len(items) != 0 {
		t.Fatalf("revoked summary retained: %+v %v", items, err)
	}
	items, err = s.WorkforceProgressSnapshot(ctx, "other", "reader", true, true, true)
	if err != nil || len(items) != 0 {
		t.Fatalf("cross realm: %+v %v", items, err)
	}
}
