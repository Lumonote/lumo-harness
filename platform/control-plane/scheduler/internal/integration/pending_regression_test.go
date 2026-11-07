package integration_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func TestBlockedPrefixDoesNotHideReadyTask(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 33; i++ {
		task := domain.Task{TaskID: fmt.Sprintf("task-%02d", i), Realm: "r1", Queue: "same", Priority: 100 - i, Requires: []domain.Requirement{{Key: "gpu"}}}
		if i == 32 {
			task.Requires = nil
		}
		if _, err := st.QueueTask(ctx, l, task); err != nil {
			t.Fatal(err)
		}
	}
	first, err := st.TakePending(ctx, l, 32, time.Hour)
	if err != nil || len(first) != 32 {
		t.Fatalf("first batch: %d %v", len(first), err)
	}
	for _, task := range first {
		if err := st.DeferPending(ctx, task.TaskID, "no-compatible-node", time.Hour, time.Hour); err != nil {
			t.Fatal(err)
		}
	}
	second, err := st.TakePending(ctx, l, 32, time.Hour)
	if err != nil || len(second) != 1 || second[0].TaskID != "task-32" {
		t.Fatalf("ready task hidden behind blocked heads: %+v %v", second, err)
	}
	nodes := []domain.Node{{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 4}}
	if planner.Pick(second[0], nodes, map[string]int{}) == nil {
		t.Fatal("ready task should be eligible")
	}
	reasons, err := st.PendingReasons(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, reason := range reasons {
		if reason.Reason == "no-compatible-node" && reason.Count == 32 && reason.OldestSeconds >= 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("backoff causes missing from metrics source: %+v", reasons)
	}
}

func TestWeightedQueueServicePersistsAcrossBatchesAndRestart(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		for _, q := range []struct {
			name   string
			weight int
		}{{"a", 1}, {"b", 3}} {
			if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: fmt.Sprintf("%s-%02d", q.name, i), Realm: "r1", Queue: q.name, Weight: q.weight}); err != nil {
				t.Fatal(err)
			}
		}
	}
	counts := map[string]int{}
	for i := 0; i < 8; i++ {
		// A new Store has no in-memory cursor to preserve the previous batch.
		current, err := store.New(ctx, testDSN(t))
		if err != nil {
			t.Fatal(err)
		}
		batch, err := current.TakePending(ctx, l, 1, time.Hour)
		current.Close()
		if err != nil || len(batch) != 1 {
			t.Fatalf("batch %d: %+v %v", i, batch, err)
		}
		counts[batch[0].Queue]++
		if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET state='ABORTED' WHERE task_id=$1`, batch[0].TaskID); err != nil {
			t.Fatal(err)
		}
	}
	if counts["a"] != 2 || counts["b"] != 6 {
		t.Fatalf("weighted service lost across batches: %v", counts)
	}
}

func TestReactivatedQueueDoesNotAccumulateIdleCredit(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	queue := func(id, name string) {
		t.Helper()
		if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: id, Realm: "r1", Queue: name}); err != nil {
			t.Fatal(err)
		}
	}
	finishNext := func() domain.Task {
		t.Helper()
		batch, err := st.TakePending(ctx, l, 1, time.Hour)
		if err != nil || len(batch) != 1 {
			t.Fatalf("next task: %+v %v", batch, err)
		}
		if _, err := st.CancelPending(ctx, batch[0].TaskID, "r1", 0); err != nil {
			t.Fatal(err)
		}
		return batch[0]
	}
	queue("idle-first", "idle")
	finishNext()
	for i := 0; i < 10; i++ {
		queue(fmt.Sprintf("busy-%02d", i), "busy")
	}
	for i := 0; i < 8; i++ {
		finishNext()
	}
	queue("idle-returned", "idle")
	// A returning queue joins current service time. It cannot jump ahead of
	// older equally weighted work using credit from its inactive period.
	if first := finishNext(); first.Queue != "busy" {
		t.Fatalf("reactivated queue received idle credit: %+v", first)
	}
	if next := finishNext(); next.Queue != "idle" {
		t.Fatalf("reactivated queue was starved: %+v", next)
	}
}

func TestPendingBackoffIsBoundedAndCanRecover(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: "backoff", Realm: "r1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET schedule_checks=100 WHERE task_id='backoff'`); err != nil {
		t.Fatal(err)
	}
	if err := st.DeferPending(ctx, "backoff", "no-capacity", time.Millisecond, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	var delay int64
	if err := st.Pool().QueryRow(ctx, `SELECT next_check_at-(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint FROM scheduler_tasks WHERE task_id='backoff'`).Scan(&delay); err != nil || delay > 10 {
		t.Fatalf("unbounded delay: %d %v", delay, err)
	}
	// Advance the stored due time, avoiding a timing-sensitive wall-clock sleep.
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET next_check_at=0 WHERE task_id='backoff'`); err != nil {
		t.Fatal(err)
	}
	batch, err := st.TakePending(ctx, l, 1, time.Second)
	if err != nil || len(batch) != 1 {
		t.Fatalf("recovered task not reconsidered: %+v %v", batch, err)
	}
}
