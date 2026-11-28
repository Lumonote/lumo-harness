package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

func TestMutationRevalidatesStateAfterConcurrentDeprecation(t *testing.T) {
	for _, action := range []string{"submit", "target"} {
		t.Run(action, func(t *testing.T) {
			st, pool := newStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			f, err := st.CreateFlow(ctx, "race", "p", "r", "race", "a", def(t, "echo"))
			if err != nil {
				t.Fatal(err)
			}
			if action == "target" {
				if _, err := pool.Exec(ctx, `UPDATE flows SET status='published' WHERE id=$1`, f.ID); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			var pid int
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM flows WHERE id=$1 FOR UPDATE`, f.ID).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if action == "target" {
					_, err := st.Target(ctx, f.ID, &domain.Audience{Users: []string{"a"}}, domain.VisibilityTargeted)
					done <- err
				} else {
					_, err := st.Transition(ctx, f.ID, domain.EventSubmit)
					done <- err
				}
			}()
			for {
				var blocked bool
				if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("mutation did not wait for lock: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(10 * time.Millisecond):
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE flows SET status='deprecated' WHERE id=$1`, f.ID); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err == nil {
				t.Fatal("stale mutation revived deprecated flow")
			}
			got, err := st.GetFlow(ctx, f.ID, "r")
			if err != nil || got.Status != domain.StatusDeprecated {
				t.Fatalf("flow: %+v, %v", got, err)
			}
		})
	}
}
