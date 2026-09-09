package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func seedScheduledTask(t *testing.T, s *Store, id string) domain.TaskRun {
	t.Helper()
	run := domain.TaskRun{ID: id + "-run-1", SchedulerTaskID: id + "-run-1", WorkerID: "user:employee", State: domain.DelegationQueued}
	_, stored, err := s.CreateDelegatedTaskWithRun(context.Background(), domain.DelegatedTask{
		ID: id, Realm: "realm", Title: id, Intent: "produce " + id, RequesterUserID: "manager",
		AssigneeUserID: "employee", AssigneeWorkerID: run.WorkerID, SchedulerTaskID: run.ID,
		State: domain.DelegationQueued, BusinessState: domain.BusinessAssigned,
	}, run)
	if err != nil {
		t.Fatal(err)
	}
	return stored
}

func TestSchedulingOutboxAndMonotonicPlacement(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	run := seedScheduledTask(t, s, "scheduled")
	pending, err := s.PendingRunSchedules(ctx)
	if err != nil || len(pending) != 1 || pending[0].RunID != run.ID {
		t.Fatalf("missing durable schedule: %#v, %v", pending, err)
	}
	if err := s.DeferRunSchedule(ctx, "realm", run.ID, "scheduler offline"); err != nil {
		t.Fatal(err)
	}
	if pending, err := s.PendingRunSchedules(ctx); err != nil || len(pending) != 0 {
		t.Fatalf("delivery backoff not applied: %#v, %v", pending, err)
	}
	for _, state := range []string{domain.DelegationAssigned, domain.DelegationQueued} {
		node := "device-a"
		if state == domain.DelegationQueued {
			node = ""
		}
		if err := s.RecordRunPlacement(ctx, "realm", run.ID, state, node); err != nil {
			t.Fatal(err)
		}
	}
	task, err := s.GetDelegationTask(ctx, "realm", run.TaskID)
	if err != nil || task.State != domain.DelegationAssigned || task.AssignedNodeID != "device-a" {
		t.Fatalf("late queued response regressed task: %#v, %v", task, err)
	}
	stored, err := s.GetTaskRun(ctx, "realm", run.ID)
	if err != nil || stored.State != task.State || stored.AssignedNodeID != task.AssignedNodeID {
		t.Fatalf("run projection differs: %#v, %v", stored, err)
	}
	var delivered bool
	if err := s.pool.QueryRow(ctx, `SELECT delivered_at IS NOT NULL FROM governance_task_scheduling WHERE run_id=$1`, run.ID).Scan(&delivered); err != nil || !delivered {
		t.Fatalf("placement was not acknowledged: %v", err)
	}
}

func TestConcurrentRetryHasOneDurableRunAndIgnoresOldPlacement(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	first := seedScheduledTask(t, s, "scheduled")
	if _, err := s.RecordTaskResult(ctx, "realm", domain.TaskResult{TaskID: first.TaskID, RunID: first.ID,
		State: domain.DelegationFailed, NodeID: "device-a", SessionRef: "old-session", Summary: "failed"}, "runtime"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var accepted atomic.Int32
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("retry-%d", i)
			_, err := s.CreateNextTaskRun(ctx, "realm", first.TaskID, domain.TaskRun{
				ID: id, SchedulerTaskID: id, WorkerID: first.WorkerID, State: domain.DelegationQueued,
			})
			if err == nil {
				accepted.Add(1)
			} else if !errors.Is(err, ErrConflict) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("concurrent retries allocated %d active runs", accepted.Load())
	}
	if err := s.RecordRunPlacement(ctx, "realm", first.ID, domain.DelegationAssigned, "old-node"); err != nil {
		t.Fatal(err)
	}
	task, err := s.GetDelegationTask(ctx, "realm", first.TaskID)
	if err != nil || task.State != domain.DelegationQueued || task.AssignedNodeID != "" || task.SchedulerTaskID == first.ID {
		t.Fatalf("old placement changed new run: %#v, %v", task, err)
	}
	pending, err := s.PendingRunSchedules(ctx)
	if err != nil || len(pending) != 1 || pending[0].RunID != task.SchedulerTaskID {
		t.Fatalf("retry schedule lost or duplicated: %#v, %v", pending, err)
	}
}
