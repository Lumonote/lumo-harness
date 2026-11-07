package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func roundStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN is required for real PostgreSQL thread round tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("thread_round_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE")
		if err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	st := store.NewPGOnly(pool)
	if err := st.Init(ctx); err != nil {
		t.Fatal(err)
	}
	return st, pool
}

func roundThread(t *testing.T, st *store.Store, id string) domain.Thread {
	t.Helper()
	thread, err := st.CreateThread(context.Background(), domain.Thread{
		ID: id, Realm: "realm", ProjectID: "project", TaskID: "task", NodeID: "node",
		CoordinatorSessionRef: "coordinator", SessionRef: "session-" + id,
		Workspace: domain.ThreadWorkspaceDir(id), State: domain.ThreadStateIdle,
	})
	if err != nil {
		t.Fatal(err)
	}
	return thread
}

func roundIdentity() store.ThreadRoundIdentity {
	return store.ThreadRoundIdentity{OwnerUserID: "owner", AgentID: "agent", PresetRevision: 3, MaxConcurrency: 2, Provider: "provider", Model: "model"}
}

func admitRound(st *store.Store, thread domain.Thread, attempt int, runID string, identity store.ThreadRoundIdentity) (store.ThreadRoundReceipt, bool, error) {
	return st.AdmitThreadRound(context.Background(), thread.Realm, thread.ID, thread.NodeID,
		thread.CoordinatorSessionRef, thread.TaskID, attempt, strings.Repeat("a", 64), runID, identity)
}

func TestThreadRoundConcurrentAdmissionAndRestartReplay(t *testing.T) {
	st, pool := roundStore(t)
	thread := roundThread(t, st, "concurrent")
	const n = 12
	type outcome struct {
		receipt store.ThreadRoundReceipt
		admit   bool
		err     error
	}
	outcomes := make(chan outcome, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, admitted, err := admitRound(st, thread, 7, "run-7", roundIdentity())
			outcomes <- outcome{r, admitted, err}
		}()
	}
	wg.Wait()
	close(outcomes)
	winners := 0
	var first store.ThreadRoundReceipt
	for result := range outcomes {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.admit {
			winners++
			first = result.receipt
			if len(first.Token) != 64 || first.SessionMode != "create" {
				t.Fatalf("invalid first-round authority: %+v", first)
			}
		} else if result.receipt.Token != "" {
			t.Fatal("replay disclosed the execution capability")
		}
	}
	if winners != 1 {
		t.Fatalf("admitted %d executions for one round", winners)
	}
	// A restarted service and an old timestamp must not reclaim an uncertain
	// turn. There is deliberately no lease-expiry or retry path for execution.
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE thread_rounds SET created_at=now()-interval '1 year'`); err != nil {
		t.Fatal(err)
	}
	restarted := store.NewPGOnly(pool)
	replay, admitted, err := admitRound(restarted, thread, 7, "run-7", roundIdentity())
	if err != nil || admitted || replay.Token != "" || replay.State != "running" {
		t.Fatalf("uncertain round was reclaimed: %+v %v %v", replay, admitted, err)
	}
	read, err := restarted.GetThreadRound(ctx, thread.Realm, thread.ID, first.RunID)
	if err != nil || read.Token != "" || read.ThreadRoundIdentity != roundIdentity() {
		t.Fatalf("read leaked token or lost identity: %+v %v", read, err)
	}
	raw, _ := json.Marshal(first)
	if strings.Contains(string(raw), first.Token) || strings.Contains(string(raw), "token") {
		t.Fatal("generic JSON serialization leaked the capability")
	}
	var storedTokenHash string
	if err := pool.QueryRow(ctx, `SELECT token_hash FROM thread_rounds`).Scan(&storedTokenHash); err != nil || storedTokenHash == first.Token {
		t.Fatalf("raw capability must not be stored: %v", err)
	}
	for _, state := range []domain.ThreadState{domain.ThreadStateAwaiting, domain.ThreadStateStopped, domain.ThreadStateDone, domain.ThreadStateFailed, domain.ThreadStateIdle} {
		if _, err := st.TransitionThread(ctx, thread.Realm, thread.ID, state); !errors.Is(err, store.ErrThreadConflict) {
			t.Fatalf("ordinary transition %q bypassed active execution: %v", state, err)
		}
	}
	if _, _, err := admitRound(st, thread, 8, "run-8", roundIdentity()); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatalf("parallel attempt admitted: %v", err)
	}
}

func TestThreadRoundImmutableRequestOwnershipAndRunIdentity(t *testing.T) {
	st, _ := roundStore(t)
	thread := roundThread(t, st, "ownership")
	if _, _, err := admitRound(st, thread, 1, "run-1", roundIdentity()); err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"hash", "run", "node", "coordinator", "task", "identity"} {
		node, coordinator, task, hash, runID := thread.NodeID, thread.CoordinatorSessionRef, thread.TaskID, strings.Repeat("a", 64), "run-1"
		identity := roundIdentity()
		switch change {
		case "hash":
			hash = strings.Repeat("b", 64)
		case "run":
			runID = "different-run"
		case "node":
			node = "other-node"
		case "coordinator":
			coordinator = "other-coordinator"
		case "task":
			task = "other-task"
		case "identity":
			identity.Model = "other-model"
		}
		if _, _, err := st.AdmitThreadRound(context.Background(), thread.Realm, thread.ID, node, coordinator, task, 1, hash, runID, identity); !errors.Is(err, store.ErrThreadRoundConflict) {
			t.Fatalf("changed %s was accepted: %v", change, err)
		}
	}
	crossRealm := thread
	crossRealm.Realm = "other-realm"
	if _, _, err := admitRound(st, crossRealm, 1, "run-1", roundIdentity()); !errors.Is(err, store.ErrThreadNotFound) {
		t.Fatalf("cross-realm thread must look absent: %v", err)
	}
	if _, err := st.GetThreadRound(context.Background(), crossRealm.Realm, thread.ID, "run-1"); !errors.Is(err, store.ErrThreadRoundNotFound) {
		t.Fatalf("cross-realm receipt was visible: %v", err)
	}
	other := roundThread(t, st, "other-thread")
	if _, _, err := admitRound(st, other, 1, "run-1", roundIdentity()); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatalf("same run was assigned to a second thread: %v", err)
	}
	otherRead, _ := st.GetThread(context.Background(), other.Realm, other.ID)
	if otherRead.State != domain.ThreadStateIdle {
		t.Fatal("conflicting admission changed the second thread")
	}
}

func TestThreadRoundFinishAndNextAttemptPreserveIdentity(t *testing.T) {
	st, _ := roundStore(t)
	thread := roundThread(t, st, "continuation")
	ctx := context.Background()
	first, _, err := admitRound(st, thread, 7, "run-7", roundIdentity())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, strings.Repeat("0", 64), "completed", "result"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatalf("wrong execution token accepted: %v", err)
	}
	finished, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "completed", "result")
	if err != nil || finished.State != "completed" || finished.FinishedAt == nil || finished.Token != "" {
		t.Fatalf("finish: %+v %v", finished, err)
	}
	replayed, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "completed", "result")
	if err != nil || !replayed.FinishedAt.Equal(*finished.FinishedAt) {
		t.Fatalf("finish was not idempotent: %+v %v", replayed, err)
	}
	if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "completed", "changed"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatalf("terminal summary was mutable: %v", err)
	}
	if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "failed", "result"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatalf("terminal state was mutable: %v", err)
	}
	current, _ := st.GetThread(ctx, thread.Realm, thread.ID)
	if current.State != domain.ThreadStateIdle {
		t.Fatalf("successful round did not release thread: %+v", current)
	}
	for _, attempt := range []int{6, 9} {
		if _, _, err := admitRound(st, thread, attempt, fmt.Sprintf("run-%d", attempt), roundIdentity()); !errors.Is(err, store.ErrThreadRoundConflict) {
			t.Fatalf("attempt %d bypassed monotonic sequencing: %v", attempt, err)
		}
	}
	for _, mutate := range []func(*store.ThreadRoundIdentity){
		func(i *store.ThreadRoundIdentity) { i.OwnerUserID = "other-owner" },
		func(i *store.ThreadRoundIdentity) { i.AgentID = "other-agent" },
		func(i *store.ThreadRoundIdentity) { i.PresetRevision++ },
		func(i *store.ThreadRoundIdentity) { i.MaxConcurrency++ },
		func(i *store.ThreadRoundIdentity) { i.Provider = "other-provider" },
		func(i *store.ThreadRoundIdentity) { i.Model = "other-model" },
	} {
		identity := roundIdentity()
		mutate(&identity)
		if _, _, err := admitRound(st, thread, 8, "run-8", identity); !errors.Is(err, store.ErrThreadRoundConflict) {
			t.Fatalf("continuation changed its execution identity: %+v %v", identity, err)
		}
	}
	next, admitted, err := admitRound(st, thread, 8, "run-8", roundIdentity())
	if err != nil || !admitted || next.SessionMode != "resume" || next.Token == first.Token {
		t.Fatalf("next round: %+v %v %v", next, admitted, err)
	}
	// A previous finish replay must not release the newer running round.
	if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "completed", "result"); err != nil {
		t.Fatal(err)
	}
	current, _ = st.GetThread(ctx, thread.Realm, thread.ID)
	if current.State != domain.ThreadStateRunning {
		t.Fatal("old result replay released the current round")
	}
}

func TestThreadRoundAgentConcurrencyAcrossThreadsAndReplicas(t *testing.T) {
	for _, limit := range []int{1, 2} {
		t.Run(fmt.Sprintf("limit-%d", limit), func(t *testing.T) {
			st, pool := roundStore(t)
			ctx := context.Background()
			identity := roundIdentity()
			identity.MaxConcurrency = limit
			const n = 10
			threads := make([]domain.Thread, n)
			for i := range threads {
				threads[i] = roundThread(t, st, fmt.Sprintf("agent-thread-%d", i))
			}
			// Admission must explicitly select READ COMMITTED. If it inherits a
			// repeatable-read snapshot taken before the Agent lock, queued
			// contenders can each see stale capacity and oversubscribe it.
			replicaConfig := pool.Config()
			replicaConfig.ConnConfig.RuntimeParams["default_transaction_isolation"] = "repeatable read"
			replicaPool, err := pgxpool.NewWithConfig(ctx, replicaConfig)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(replicaPool.Close)
			type outcome struct {
				index   int
				receipt store.ThreadRoundReceipt
				admit   bool
				err     error
			}
			outcomes := make(chan outcome, n)
			var wg sync.WaitGroup
			start := make(chan struct{})
			for i, thread := range threads {
				wg.Add(1)
				go func(i int, thread domain.Thread) {
					defer wg.Done()
					<-start
					// Distinct Store instances share no process-local lock or map.
					replica := store.NewPGOnly(replicaPool)
					r, admitted, err := admitRound(replica, thread, 1, fmt.Sprintf("run-%d", i), identity)
					outcomes <- outcome{i, r, admitted, err}
				}(i, thread)
			}
			close(start)
			wg.Wait()
			close(outcomes)
			winners := make([]outcome, 0, limit)
			loser := -1
			for result := range outcomes {
				if result.err == nil && result.admit {
					winners = append(winners, result)
				} else if errors.Is(result.err, store.ErrThreadRoundConflict) {
					loser = result.index
				} else {
					t.Fatalf("unexpected concurrent admission: %+v", result)
				}
			}
			if len(winners) != limit || loser < 0 {
				t.Fatalf("Agent limit %d admitted %d concurrent Threads", limit, len(winners))
			}
			for _, winner := range winners {
				r, admitted, err := admitRound(st, threads[winner.index], 1, winner.receipt.RunID, identity)
				if err != nil || admitted || r.Token != "" || r.MaxConcurrency != limit {
					t.Fatalf("full-capacity replay was rejected or reacquired a slot: %+v %v %v", r, admitted, err)
				}
			}
			// Loss of the caller/receipt remains unknown, even years later. A
			// restarted replica must keep these running slots occupied.
			if _, err := pool.Exec(ctx, `UPDATE thread_rounds SET created_at=now()-interval '2 years'`); err != nil {
				t.Fatal(err)
			}
			restarted := store.NewPGOnly(pool)
			if _, _, err := admitRound(restarted, threads[loser], 1, fmt.Sprintf("run-%d", loser), identity); !errors.Is(err, store.ErrThreadRoundConflict) {
				t.Fatalf("uncertain running slots were reclaimed: %v", err)
			}
			// Another Agent and another realm have separate slot namespaces.
			otherAgent := roundIdentity()
			otherAgent.AgentID = "other-agent"
			otherAgent.MaxConcurrency = 1
			if _, _, err := admitRound(st, roundThread(t, st, "other-agent-thread"), 1, "other-agent-run", otherAgent); err != nil {
				t.Fatalf("unrelated Agent was blocked: %v", err)
			}
			otherRealm := threads[loser]
			otherRealm.ID, otherRealm.Realm, otherRealm.SessionRef = "other-realm-thread", "other-realm", "other-realm-session"
			otherRealm.Workspace = domain.ThreadWorkspaceDir(otherRealm.ID)
			if _, err := st.CreateThread(ctx, otherRealm); err != nil {
				t.Fatal(err)
			}
			if _, _, err := admitRound(st, otherRealm, 1, "other-realm-run", identity); err != nil {
				t.Fatalf("unrelated realm was blocked: %v", err)
			}
			first := winners[0]
			if _, err := st.FinishThreadRound(ctx, "realm", first.receipt.ThreadID, first.receipt.RunID, first.receipt.Token, "completed", "complete"); err != nil {
				t.Fatal(err)
			}
			if _, admitted, err := admitRound(st, threads[loser], 1, fmt.Sprintf("run-%d", loser), identity); err != nil || !admitted {
				t.Fatalf("completed round did not release its Agent slot: %v %v", admitted, err)
			}
			var active int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM thread_rounds WHERE realm='realm' AND agent_id='agent' AND state='running'`).Scan(&active); err != nil || active != limit {
				t.Fatalf("running slots %d, want %d: %v", active, limit, err)
			}
		})
	}
}

func TestThreadRoundAgentSlotReleasedOnlyByFencedFinish(t *testing.T) {
	for _, outcome := range []string{"failed", "cancelled"} {
		t.Run(outcome, func(t *testing.T) {
			st, _ := roundStore(t)
			ctx := context.Background()
			identity := roundIdentity()
			identity.MaxConcurrency = 1
			thread := roundThread(t, st, "slot-owner")
			waiting := roundThread(t, st, "slot-waiting")
			first, _, err := admitRound(st, thread, 1, "first-run", identity)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := st.FailThreadOnNodeLoss(ctx, thread.Realm, thread.ID, thread.NodeID); err != nil {
				t.Fatal(err)
			}
			if _, _, err := admitRound(st, waiting, 1, "waiting-run", identity); !errors.Is(err, store.ErrThreadRoundConflict) {
				t.Fatalf("node-loss must not free a possibly active execution slot: %v", err)
			}
			if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, outcome, "fully stopped"); err != nil {
				t.Fatal(err)
			}
			if _, admitted, err := admitRound(st, waiting, 1, "waiting-run", identity); err != nil || !admitted {
				t.Fatalf("fenced %s finish did not release the Agent slot: %v %v", outcome, admitted, err)
			}
		})
	}
}

func TestThreadRoundNodeLossFencesSuccessAndFailuresStayTerminal(t *testing.T) {
	for _, outcome := range []string{"failed", "cancelled"} {
		t.Run(outcome, func(t *testing.T) {
			st, _ := roundStore(t)
			thread := roundThread(t, st, "failure")
			ctx := context.Background()
			first, _, err := admitRound(st, thread, 1, "run-1", roundIdentity())
			if err != nil {
				t.Fatal(err)
			}
			if outcome == "failed" {
				if _, err := st.FailThreadOnNodeLoss(ctx, thread.Realm, thread.ID, thread.NodeID); err != nil {
					t.Fatal(err)
				}
				if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "completed", "late success"); !errors.Is(err, store.ErrThreadRoundConflict) {
					t.Fatalf("late success resurrected lost node: %v", err)
				}
			}
			if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, outcome, "stopped"); err != nil {
				t.Fatal(err)
			}
			current, _ := st.GetThread(ctx, thread.Realm, thread.ID)
			if current.State != domain.ThreadStateFailed {
				t.Fatalf("failed execution must terminate its stable session: %+v", current)
			}
			if _, _, err := admitRound(st, thread, 2, "run-2", roundIdentity()); !errors.Is(err, store.ErrThreadRoundConflict) {
				t.Fatalf("terminal thread was reused: %v", err)
			}
		})
	}
}

func TestThreadRoundMigrationAndDDLConverge(t *testing.T) {
	st, pool := roundStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DROP TABLE thread_rounds`); err != nil {
		t.Fatal(err)
	}
	_, source, _, _ := runtime.Caller(0)
	migration, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../../../deploy/migrations/015_collaborator_thread_rounds.sql"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
		if err := st.Init(ctx); err != nil {
			t.Fatal(err)
		}
	}
	thread := roundThread(t, st, "migrated")
	first, _, err := admitRound(st, thread, 1, "run-1", roundIdentity())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishThreadRound(ctx, thread.Realm, thread.ID, first.RunID, first.Token, "completed", strings.Repeat("界", 16000)); err != nil {
		t.Fatalf("16k Unicode summary rejected: %v", err)
	}
}

func TestThreadRoundValidationBeforeDatabase(t *testing.T) {
	st := new(store.Store)
	thread := domain.Thread{ID: "thread", Realm: "realm", NodeID: "node", CoordinatorSessionRef: "coordinator", TaskID: "task"}
	for _, attempt := range []int{0, -1, 2147483648} {
		if _, _, err := admitRound(st, thread, attempt, "run", roundIdentity()); !errors.Is(err, domain.ErrInvalidThread) {
			t.Fatalf("attempt %d did not reject as invalid: %v", attempt, err)
		}
	}
	for _, limit := range []int{0, -1, 2147483648} {
		identity := roundIdentity()
		identity.MaxConcurrency = limit
		if _, _, err := admitRound(st, thread, 1, "run", identity); !errors.Is(err, domain.ErrInvalidThread) {
			t.Fatalf("Agent concurrency %d did not reject as invalid: %v", limit, err)
		}
	}
	if _, _, err := st.AdmitThreadRound(context.Background(), thread.Realm, thread.ID, thread.NodeID, thread.CoordinatorSessionRef, thread.TaskID, 1, "model-self-report", "run", roundIdentity()); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("invalid hash accepted: %v", err)
	}
	for _, state := range []string{"running", "done", "COMPLETED"} {
		if _, err := st.FinishThreadRound(context.Background(), "realm", "thread", "run", strings.Repeat("a", 64), state, "result"); !errors.Is(err, domain.ErrInvalidThread) {
			t.Fatalf("invalid outcome %q accepted: %v", state, err)
		}
	}
	if _, err := st.FinishThreadRound(context.Background(), "realm", "thread", "run", strings.Repeat("a", 64), "completed", strings.Repeat("界", 16001)); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("oversize summary accepted: %v", err)
	}
}
