package integration_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func TestGlobalLocalAdmissionNeverOversubscribes(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if err := (&catalog.Pg{Pool: st.Pool()}).Upsert(ctx, domain.Node{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	global, err := st.Acquire(ctx, "global", 60000)
	if err != nil {
		t.Fatal(err)
	}
	local, err := st.AcquireCluster(ctx, "c1", "local", 60000)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 24)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			l := global
			if i%2 == 1 {
				l = local
			}
			_, err := st.PlaceTask(ctx, l, domain.Task{TaskID: fmt.Sprintf("task-%d", i), Realm: "r1", ClusterID: "c1"}, "N1")
			results <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	succeeded := 0
	blockedLocal := 0
	for err := range results {
		if err == nil {
			succeeded++
		} else if errors.Is(err, domain.ErrGlobalLeaderActive) {
			blockedLocal++
		} else {
			var capacity *domain.NoCapacityError
			if !errors.As(err, &capacity) {
				t.Fatal(err)
			}
		}
	}
	if succeeded != 1 || blockedLocal != 12 {
		t.Fatalf("successful=%d blocked-local=%d", succeeded, blockedLocal)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE state='PLACED'`); n != 1 {
		t.Fatalf("capacity exceeded: %d", n)
	}
	if err := st.Release(ctx, "global"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET state='COMPLETED'`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PlaceTask(ctx, local, domain.Task{TaskID: "local-after-failover", Realm: "r1", ClusterID: "c1"}, "N1"); err != nil {
		t.Fatalf("local failover: %v", err)
	}
}

func TestResultRequiresAttemptAndAssignedNode(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	task := domain.Task{TaskID: "result", Realm: "r1", ClusterID: "c1"}
	if _, err := st.PlaceTask(ctx, l, task, "N1"); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.New(st, &election.State{}, &catalog.Pg{Pool: st.Pool()}, discardLogger()).Routes())
	defer ts.Close()
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"state":"COMPLETED"}`, 400}, {`{"state":"COMPLETED","attempt":0,"node_id":"N1"}`, 400},
		{`{"state":"COMPLETED","attempt":-1,"node_id":"N1"}`, 400}, {`{"state":"COMPLETED","attempt":1}`, 400},
		{`{"state":"COMPLETED","attempt":1,"node_id":"other"}`, 409},
		{`{"state":"COMPLETED","attempt":1,"node_id":"N1"}`, 200},
	} {
		req, _ := http.NewRequest("POST", ts.URL+"/v1/tasks/result/result", strings.NewReader(tc.body))
		req.Header.Set("X-Lumo-Realm", "r1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != tc.status {
			t.Fatalf("%s: status %d", tc.body, res.StatusCode)
		}
	}
	if _, err := st.PlaceTask(ctx, l, task, "N1"); err != nil {
		t.Fatal(err)
	}
	p, err := st.CompleteAssignedTask(ctx, "result", "r1", "N1", 1, domain.StateFailed)
	if err != nil || p.Attempt != 2 || p.State != domain.StatePlaced {
		t.Fatalf("stale result changed new assignment: %+v %v", p, err)
	}
}

func TestGlobalPlacementsRetainActualClusterForEveryFailover(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	if err := (&catalog.Pg{Pool: st.Pool()}).Upsert(ctx, domain.Node{NodeID: "N2", Realm: "r1", ClusterID: "c2", Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	task := domain.Task{TaskID: "global", Realm: "r1"}
	for i, assignment := range []struct{ node, cluster string }{{"N1", "c1"}, {"N2", "c2"}} {
		p, err := st.PlaceTask(ctx, l, task, assignment.node)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := st.MigratableActiveTasks(ctx, []string{assignment.cluster})
		if err != nil || len(rows) != 1 {
			t.Fatalf("global task missing from migration: %+v %v", rows, err)
		}
		if p.AssignedClusterID != assignment.cluster {
			t.Fatalf("wrong assigned cluster: %+v", p)
		}
		m, err := st.MigrateTask(ctx, store.MigrationRecord{TaskID: task.TaskID, Attempt: i + 1, Realm: "r1", FromClusterID: assignment.cluster, FromNodeID: assignment.node})
		if err != nil || !m.Applied {
			t.Fatalf("migration: %+v %v", m, err)
		}
	}
	var requested string
	if err := st.Pool().QueryRow(ctx, `SELECT requested_cluster_id FROM scheduler_tasks WHERE task_id='global'`).Scan(&requested); err != nil || requested != "" {
		t.Fatalf("requested cluster changed: %q %v", requested, err)
	}
}

func TestPendingCancelCannotBeResurrectedByStaleDrain(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: "queued", Realm: "r1", ClusterID: "c1"}); err != nil {
		t.Fatal(err)
	}
	batch, err := st.TakePending(ctx, l, 1, time.Second)
	if err != nil || len(batch) != 1 {
		t.Fatalf("selection: %+v %v", batch, err)
	}
	if p, err := st.CancelPending(ctx, "queued", "r1", 0); err != nil || p.State != domain.StateAborted {
		t.Fatalf("cancel: %+v %v", p, err)
	}
	p, err := st.PlaceTask(ctx, l, batch[0], "N1")
	if err != nil || p.State != domain.StateAborted {
		t.Fatalf("stale drain resurrected cancelled work: %+v %v", p, err)
	}
	if outboxCount(t, st, "queued") != 0 {
		t.Fatal("cancelled queued task was dispatched")
	}
	// A delayed submission retry is a different ingress from a stale drain.
	// Both must retain the cancellation tombstone for this task identity.
	original := domain.Task{TaskID: "queued", Realm: "r1", ClusterID: "c1"}
	if p, err := st.PlaceTask(ctx, l, original, "N1"); err != nil || p.State != domain.StateAborted {
		t.Fatalf("submission retry resurrected work: %+v %v", p, err)
	}
	if state, err := st.QueueTask(ctx, l, original); err != nil || state != domain.StateAborted {
		t.Fatalf("queue retry resurrected work: %s %v", state, err)
	}
	if p, err := st.ExistingPlacement(ctx, original); err != nil || p == nil || p.State != domain.StateAborted {
		t.Fatalf("HTTP replay lost cancellation: %+v %v", p, err)
	}
}

func TestCancelBeforeSubmissionCannotCreateLateOrphan(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	p, err := st.CancelUnseen(ctx, "late", "r1")
	if err != nil || p.State != domain.StateAborted {
		t.Fatalf("missing cancellation tombstone: %+v %v", p, err)
	}
	task := domain.Task{TaskID: "late", Realm: "r1", ClusterID: "c1"}
	if p, err := st.PlaceTask(ctx, l, task, "N1"); err != nil || p.State != domain.StateAborted {
		t.Fatalf("late submission created execution: %+v %v", p, err)
	}
	if _, err := st.ReconcileRealm(ctx, l, "r1", []store.ReconcileEntry{{EntryID: "late-running", TaskID: task.TaskID, ClusterID: "c1", NodeID: "N1", Attempt: 7, State: "RUNNING"}}); err != nil {
		t.Fatal(err)
	}
	if p, err := st.GetPlacement(ctx, task.TaskID); err != nil || p.State != domain.StateAborted {
		t.Fatalf("reconciliation undid cancellation: %+v %v", p, err)
	}
	if state, err := st.QueueTask(ctx, l, task); err != nil || state != domain.StateAborted {
		t.Fatalf("late queue submission: %s %v", state, err)
	}
	if outboxCount(t, st, "late") != 0 {
		t.Fatal("late orphan dispatched")
	}
	if _, err := st.CancelUnseen(ctx, "late", "other-realm"); err == nil {
		t.Fatal("tombstone escaped realm")
	}
	// When admission wins, cancellation must return the actual assignment so
	// the HTTP layer can get the executor's stop proof instead of claiming abort.
	if _, err := st.PlaceTask(ctx, l, domain.Task{TaskID: "already-placed", Realm: "r1", ClusterID: "c1"}, "N1"); err != nil {
		t.Fatal(err)
	}
	if p, err := st.CancelUnseen(ctx, "already-placed", "r1"); err != nil || p.State != domain.StatePlaced || p.NodeID != "N1" {
		t.Fatalf("lost existing assignment: %+v %v", p, err)
	}
}

func TestConcurrentInitSerializesCatalogDDL(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	start := make(chan struct{})
	results := make(chan error, 4)
	schema := fmt.Sprintf("scheduler_init_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`) })
	dsn, err := url.Parse(testDSN(t))
	if err != nil {
		t.Fatal(err)
	}
	query := dsn.Query()
	query.Set("search_path", schema)
	dsn.RawQuery = query.Encode()
	for i := 0; i < 4; i++ {
		go func() {
			current, err := store.New(ctx, dsn.String())
			if err != nil {
				results <- err
				return
			}
			defer current.Close()
			<-start
			results <- current.Init(ctx)
		}()
	}
	close(start)
	for i := 0; i < 4; i++ {
		if err := <-results; err != nil {
			t.Fatalf("concurrent init: %v", err)
		}
	}
	if n := rowCount(t, st, `SELECT count(*) FROM `+schema+`.scheduler_leader_lease WHERE id=1`); n != 1 {
		t.Fatalf("init lost singleton lease row: %d", n)
	}
}
