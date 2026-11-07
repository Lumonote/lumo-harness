package store_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func TestThreadCommandFixedNodeDurableWakeAndSingleClaim(t *testing.T) {
	st, pool := roundStore(t)
	thread := roundThread(t, st, "command")
	deadline := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	c := store.ThreadCommand{ID: "command-1", Realm: thread.Realm, ThreadID: thread.ID, OwnerUserID: "owner", NodeID: thread.NodeID, CoordinatorSessionRef: thread.CoordinatorSessionRef, TaskID: thread.TaskID, Attempt: 1, Prompt: "immutable task", WakeKey: "ready", WakeDeadline: &deadline}
	ctx := context.Background()
	saved, created, err := st.EnqueueThreadCommand(ctx, c)
	if err != nil || !created || saved.State != "waiting" {
		t.Fatalf("enqueue: %+v %v", saved, err)
	}
	replay, created, err := st.EnqueueThreadCommand(ctx, c)
	if err != nil || created || replay.State != "waiting" {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	changed := c
	changed.Prompt = "changed"
	if _, _, err := st.EnqueueThreadCommand(ctx, changed); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatal("changed prompt accepted", err)
	}
	if command, err := st.ClaimThreadCommand(ctx, thread.Realm, thread.NodeID, "owner"); err != nil || command != nil {
		t.Fatal("waiting was claimed", err)
	}
	if _, err := st.WakeThreadCommand(ctx, thread.Realm, c.ID, "other", "ready", "event-1"); !errors.Is(err, store.ErrThreadRoundNotFound) {
		t.Fatal("wrong user", err)
	}
	if _, err := st.WakeThreadCommand(ctx, thread.Realm, c.ID, "owner", "bad", "event-1"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatal("wrong key", err)
	}
	if _, err := st.WakeThreadCommand(ctx, thread.Realm, c.ID, "owner", "ready", "event-1"); err != nil {
		t.Fatal(err)
	}
	// Restart both sides. The command and event remain persisted.
	st = store.NewPGOnly(pool)
	if c, err := st.ClaimThreadCommand(ctx, thread.Realm, "other", "owner"); err != nil || c != nil {
		t.Fatal("wrong node", err)
	}
	var wg sync.WaitGroup
	claimed := make(chan *store.ThreadCommand, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, e := st.ClaimThreadCommand(ctx, thread.Realm, thread.NodeID, "owner")
			if e != nil {
				t.Error(e)
			}
			if c != nil {
				claimed <- c
			}
		}()
	}
	wg.Wait()
	close(claimed)
	var winner *store.ThreadCommand
	for c := range claimed {
		if winner != nil {
			t.Fatal("multiple claimants")
		}
		winner = c
	}
	if winner == nil || len(winner.ClaimToken) != 64 {
		t.Fatal("missing unique token")
	}
	if _, err := st.WakeThreadCommand(ctx, thread.Realm, c.ID, "owner", "ready", "event-1"); err != nil {
		t.Fatal("same event replay", err)
	}
	if _, err := st.WakeThreadCommand(ctx, thread.Realm, c.ID, "owner", "ready", "event-2"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatal("new event accepted", err)
	}
	if _, err := st.FinishThreadCommand(ctx, thread.Realm, c.ID, thread.NodeID, "owner", strings.Repeat("0", 64), "completed", "run", "done"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatal("wrong token", err)
	}
	if _, err := st.FinishThreadCommand(ctx, thread.Realm, c.ID, thread.NodeID, "owner", winner.ClaimToken, "completed", "run", "done"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishThreadCommand(ctx, thread.Realm, c.ID, thread.NodeID, "owner", winner.ClaimToken, "completed", "run", "done"); err != nil {
		t.Fatal("finish replay", err)
	}
	if got, err := st.GetThreadCommand(ctx, thread.Realm, c.ID, "owner"); err != nil || got.ClaimToken != "" || got.State != "completed" {
		t.Fatal("safe read", got, err)
	}
}
func TestThreadCommandUncertainClaimNeverExpires(t *testing.T) {
	st, pool := roundStore(t)
	thread := roundThread(t, st, "uncertain-command")
	ctx := context.Background()
	c := store.ThreadCommand{ID: "uncertain", Realm: thread.Realm, ThreadID: thread.ID, OwnerUserID: "owner", NodeID: thread.NodeID, CoordinatorSessionRef: thread.CoordinatorSessionRef, TaskID: thread.TaskID, Attempt: 1, Prompt: "once"}
	if _, _, err := st.EnqueueThreadCommand(ctx, c); err != nil {
		t.Fatal(err)
	}
	if first, err := st.ClaimThreadCommand(ctx, thread.Realm, thread.NodeID, "owner"); err != nil || first == nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE thread_commands SET created_at=now()-interval '10 years'`); err != nil {
		t.Fatal(err)
	}
	restarted := store.NewPGOnly(pool)
	if c, err := restarted.ClaimThreadCommand(ctx, thread.Realm, thread.NodeID, "owner"); err != nil || c != nil {
		t.Fatal("uncertain work reclaimed", err)
	}
}

func TestThreadCommandReadExpiresWaitingWhenTargetNodeIsOffline(t *testing.T) {
	st, pool := roundStore(t)
	thread := roundThread(t, st, "offline-wake")
	ctx := context.Background()
	deadline := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	c := store.ThreadCommand{ID: "offline-command", Realm: thread.Realm, ThreadID: thread.ID, OwnerUserID: "owner", NodeID: thread.NodeID, CoordinatorSessionRef: thread.CoordinatorSessionRef, TaskID: thread.TaskID, Attempt: 1, Prompt: "wait for event", WakeKey: "ready", WakeDeadline: &deadline}
	if _, _, err := st.EnqueueThreadCommand(ctx, c); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE thread_commands SET wake_deadline=now()-interval '1 second' WHERE realm=$1 AND id=$2`, c.Realm, c.ID); err != nil {
		t.Fatal(err)
	}
	// No target-node poller or wake sender exists. A restarted source must
	// observe the deadline and release the Thread's active waiting slot.
	restarted := store.NewPGOnly(pool)
	got, err := restarted.GetThreadCommand(ctx, c.Realm, c.ID, "owner")
	if err != nil || got.State != "expired" || got.EventID != "" || got.ClaimToken != "" {
		t.Fatalf("offline expiry: %+v %v", got, err)
	}
	current, err := restarted.GetThread(ctx, c.Realm, c.ThreadID)
	if err != nil || current.State != "idle" {
		t.Fatalf("Thread after expiry: %+v %v", current, err)
	}
	if _, err := restarted.WakeThreadCommand(ctx, c.Realm, c.ID, "owner", "ready", "late-event"); !errors.Is(err, store.ErrThreadRoundConflict) {
		t.Fatalf("late event revived expired work: %v", err)
	}
	if _, err := restarted.GetThreadCommand(ctx, "foreign-realm", c.ID, "owner"); !errors.Is(err, store.ErrThreadRoundNotFound) {
		t.Fatalf("foreign realm command read: %v", err)
	}
	if _, err := restarted.GetThreadCommand(ctx, c.Realm, c.ID, "other-owner"); !errors.Is(err, store.ErrThreadRoundNotFound) {
		t.Fatalf("foreign owner command read: %v", err)
	}
}

func TestThreadCommandDeadlineCannotBeExtendedByThreadLockWait(t *testing.T) {
	for _, operation := range []string{"enqueue", "wake"} {
		t.Run(operation, func(t *testing.T) {
			st, pool := roundStore(t)
			thread := roundThread(t, st, "deadline-lock-"+operation)
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			var deadline time.Time
			if err := pool.QueryRow(ctx, `SELECT clock_timestamp()+interval '3 seconds'`).Scan(&deadline); err != nil {
				t.Fatal(err)
			}
			c := store.ThreadCommand{ID: "deadline-command", Realm: thread.Realm, ThreadID: thread.ID, OwnerUserID: "owner", NodeID: thread.NodeID, CoordinatorSessionRef: thread.CoordinatorSessionRef, TaskID: thread.TaskID, Attempt: 1, Prompt: "execute only before the registered deadline", WakeKey: "ready", WakeDeadline: &deadline}
			if operation == "wake" {
				if _, _, err := st.EnqueueThreadCommand(ctx, c); err != nil {
					t.Fatal(err)
				}
			}
			blocker, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.Background()) }()
			var blockerPID int
			if err = blocker.QueryRow(ctx, `SELECT pg_backend_pid() FROM threads WHERE realm=$1 AND id=$2 FOR UPDATE`, thread.Realm, thread.ID).Scan(&blockerPID); err != nil {
				t.Fatal(err)
			}
			finished := make(chan error, 1)
			go func() {
				if operation == "wake" {
					_, err := st.WakeThreadCommand(ctx, c.Realm, c.ID, "owner", "ready", "arrived-before-deadline")
					finished <- err
				} else {
					_, _, err := st.EnqueueThreadCommand(ctx, c)
					finished <- err
				}
			}()
			// Observe a real PostgreSQL row-lock wait before crossing the
			// deadline. A scheduler delay alone cannot make this test pass.
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for {
				var waiting, startedBeforeDeadline bool
				if err = pool.QueryRow(ctx, `SELECT count(*)>0,COALESCE(bool_and(xact_start<$2::timestamptz),false) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, blockerPID, deadline).Scan(&waiting, &startedBeforeDeadline); err != nil {
					t.Fatal(err)
				}
				if waiting {
					if !startedBeforeDeadline {
						t.Fatal("request started after its deadline; the lock-wait boundary was not exercised")
					}
					break
				}
				select {
				case err := <-finished:
					t.Fatalf("request did not wait for the locked Thread: %v", err)
				case <-ticker.C:
				case <-ctx.Done():
					t.Fatal("request never reached the Thread lock")
				}
			}
			// Database wall time determines the expiry; application clock
			// skew cannot authorize this delayed operation.
			if _, err = pool.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)`, deadline); err != nil {
				t.Fatal(err)
			}
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-finished; !errors.Is(err, store.ErrThreadRoundConflict) {
				t.Fatalf("%s crossed the deadline while waiting and was accepted: %v", operation, err)
			}
			var state string
			err = pool.QueryRow(ctx, `SELECT COALESCE((SELECT state FROM thread_commands WHERE realm=$1 AND id=$2),'missing')`, c.Realm, c.ID).Scan(&state)
			want := "missing"
			if operation == "wake" {
				want = "expired"
			}
			if err != nil || state != want {
				t.Fatalf("command state after expiry = %q, want %q: %v", state, want, err)
			}
		})
	}
}
