package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestDelegationReceiptConcurrentAndReopened(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	receipt := DelegationReceipt{Key: "flow:1:node", Hash: strings.Repeat("a", 64)}
	var wg sync.WaitGroup
	ids := make(chan string, 24)
	for i := range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task, run, err := New(s.pool).CreateDelegatedTaskWithRun(ctx, receiptTask(fmt.Sprint("task-", i)), domain.TaskRun{ID: fmt.Sprint("run-", i), WorkerID: "user:employee", State: domain.DelegationQueued}, receipt)
			if err != nil {
				t.Error(err)
				return
			}
			ids <- task.ID + "/" + run.ID
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		seen[id] = true
	}
	if len(seen) != 1 {
		t.Fatalf("duplicate tasks/runs: %v", seen)
	}
	for _, table := range []string{"governance_delegation_tasks", "governance_task_runs", "governance_delegation_receipts"} {
		var n int
		if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%s: %d %v", table, n, err)
		}
	}
	_, _, err := New(s.pool).LookupDelegationReceipt(ctx, "realm", "manager", receipt)
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range [][2]string{{"other", "manager"}, {"realm", "employee"}} {
		if _, _, err := s.LookupDelegationReceipt(ctx, scope[0], scope[1], receipt); !errors.Is(err, ErrNotFound) {
			t.Fatalf("scope leak: %v", err)
		}
	}
	receipt.Hash = strings.Repeat("b", 64)
	if _, _, err := s.LookupDelegationReceipt(ctx, "realm", "manager", receipt); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed request: %v", err)
	}
}

func receiptTask(id string) domain.DelegatedTask {
	return domain.DelegatedTask{ID: id, Realm: "realm", Title: "Work", Intent: "produce evidence", RequesterUserID: "manager",
		AssigneeUserID: "employee", AssigneeWorkerID: "user:employee", State: domain.DelegationQueued, BusinessState: domain.BusinessAssigned}
}

func TestDelegationReceiptRollsBackWithRunAndRejectsBadKeys(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	receipt := DelegationReceipt{Key: "retry", Hash: strings.Repeat("a", 64)}
	if _, _, err := s.CreateDelegatedTaskWithRun(ctx, receiptTask("bad"), domain.TaskRun{ID: "bad-run", WorkerID: ""}, receipt); err == nil {
		t.Fatal("invalid run accepted")
	}
	if _, _, err := s.LookupDelegationReceipt(ctx, "realm", "manager", receipt); !errors.Is(err, ErrNotFound) {
		t.Fatalf("receipt survived rollback: %v", err)
	}
	if _, _, err := s.CreateDelegatedTaskWithRun(ctx, receiptTask("good"), domain.TaskRun{ID: "good-run", WorkerID: "user:employee"}, receipt); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []DelegationReceipt{{Key: "bad key", Hash: receipt.Hash}, {Key: "k", Hash: "invalid"}} {
		if _, _, err := s.CreateDelegatedTaskWithRun(ctx, receiptTask("invalid"), domain.TaskRun{ID: "invalid-run", WorkerID: "user:employee"}, invalid); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid key: %v", err)
		}
	}
}
