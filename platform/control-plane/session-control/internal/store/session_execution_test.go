package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func executionRequest(process string) ExecutionNodeRequest {
	return ExecutionNodeRequest{Realm: "r", NodeID: "node", ProjectID: "p", ProcessID: process, Endpoint: "https://node.example", Token: strings.Repeat("a", 64)}
}
func TestSessionExecutionFencesExpiredProcessesAndKeepsGenerations(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	first := executionRequest("first")
	n, err := s.AcquireExecutionNode(ctx, first)
	if err != nil || n.Fence != 1 {
		t.Fatalf("node %+v %v", n, err)
	}
	if _, err = s.AcquireExecutionNode(ctx, executionRequest("second")); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("stole live node: %v", err)
	}
	owner, _, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node"})
	if err != nil {
		t.Fatal(err)
	}
	in := ExecutionLeaseRequest{ExecutionNodeRequest: first, WriterHolder: "writer:first"}
	l, err := s.SessionExecutionLease(ctx, owner.SessionRef, in, "acquire")
	if err != nil || l.FencingToken != 1 {
		t.Fatalf("lease %+v %v", l, err)
	}
	in.FencingToken = l.FencingToken
	if _, err = s.SessionExecutionLease(ctx, owner.SessionRef, in, "renew"); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"token", "project", "realm", "writer", "fence"} {
		bad := in
		switch field {
		case "token":
			bad.Token = strings.Repeat("b", 64)
		case "project":
			bad.ProjectID = "foreign"
		case "realm":
			bad.Realm = "foreign"
		case "writer":
			bad.WriterHolder = "forged"
		case "fence":
			bad.FencingToken++
		}
		if _, err = s.SessionExecutionLease(ctx, owner.SessionRef, bad, "renew"); !errors.Is(err, ErrExecutionFenced) {
			t.Fatalf("accepted forged %s: %v", field, err)
		}
	}
	if _, err = s.pool.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"renew", "acquire", "release"} {
		if _, err = s.SessionExecutionLease(ctx, owner.SessionRef, in, mode); !errors.Is(err, ErrExecutionFenced) {
			t.Fatalf("expired session revived via %s: %v", mode, err)
		}
	}
	if _, err = s.pool.Exec(ctx, `UPDATE session_execution_nodes SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireExecutionNode(ctx, first); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("expired node revived: %v", err)
	}
	second := executionRequest("second")
	n2, err := s.AcquireExecutionNode(ctx, second)
	if err != nil || n2.Fence != 2 {
		t.Fatalf("node takeover %+v %v", n2, err)
	}
	newIn := ExecutionLeaseRequest{ExecutionNodeRequest: second, WriterHolder: "writer:second"}
	l2, err := s.SessionExecutionLease(ctx, owner.SessionRef, newIn, "acquire")
	if err != nil || l2.FencingToken != 2 || l2.NodeFence != 2 {
		t.Fatalf("Session takeover %+v %v", l2, err)
	}
	if _, err = s.SessionExecutionLease(ctx, owner.SessionRef, in, "renew"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("old execution renewed: %v", err)
	}
	if _, err = s.RenewExecutionNode(ctx, first, true); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("old process released successor: %v", err)
	}
	restored, err := New(s.pool).ExecutionNode(ctx, "r", "node", "p")
	if err != nil || restored.ProcessID != "second" || restored.Fence != 2 {
		t.Fatalf("restart %+v %v", restored, err)
	}
	if _, err = s.ExecutionNode(ctx, "foreign", "node", "p"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("cross Realm route: %v", err)
	}
	if _, err = s.ExecutionNode(ctx, "r", "node", "foreign"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("cross project route: %v", err)
	}
}
func TestSessionExecutionNodeConcurrencyHasOneWinner(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.AcquireExecutionNode(ctx, executionRequest(fmt.Sprintf("process-%d", i)))
			if err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			} else if !errors.Is(err, ErrExecutionFenced) {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("winners %d", wins)
	}
}
func TestSessionExecutionRejectsUnregisteredSessionAndInvalidCredential(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	node := executionRequest("process")
	bad := node
	bad.Token = "secret"
	if _, err := s.AcquireExecutionNode(ctx, bad); !errors.Is(err, ErrOwnerInvalid) {
		t.Fatal(err)
	}
	if _, err := s.AcquireExecutionNode(ctx, node); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionExecutionLease(ctx, "legacy", ExecutionLeaseRequest{ExecutionNodeRequest: node, WriterHolder: "writer"}, "acquire"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("legacy adoption %v", err)
	}
}

func waitExecutionLock(t *testing.T, ctx context.Context, tx pgx.Tx) {
	t.Helper()
	deadline := time.Now().Add(800 * time.Millisecond)
	for time.Now().Before(deadline) {
		if _, err := tx.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		var waiting bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE pg_backend_pid()=ANY(pg_blocking_pids(a.pid)))`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("lease operation did not reach the held database row lock before its deadline")
}
func TestExecutionRenewalCannotReviveLeasesThatExpireWhileWaitingForLocks(t *testing.T) {
	for _, kind := range []string{"node-renew", "session-renew", "session-node-expiry", "session-acquire-node-expiry"} {
		t.Run(kind, func(t *testing.T) {
			s := newStore(t)
			ctx := context.Background()
			node := executionRequest("process")
			if _, err := s.AcquireExecutionNode(ctx, node); err != nil {
				t.Fatal(err)
			}
			owner, _, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node"})
			if err != nil {
				t.Fatal(err)
			}
			in := ExecutionLeaseRequest{ExecutionNodeRequest: node, WriterHolder: "writer"}
			lease, err := s.SessionExecutionLease(ctx, owner.SessionRef, in, "acquire")
			if err != nil {
				t.Fatal(err)
			}
			in.FencingToken = lease.FencingToken
			table := "session_execution_leases"
			if kind == "node-renew" {
				table = "session_execution_nodes"
			}
			expiring := "session_execution_nodes"
			if kind == "session-renew" {
				expiring = "session_execution_leases"
			}
			if _, err = s.pool.Exec(ctx, `UPDATE `+expiring+` SET expires_at=clock_timestamp()+interval '1 second'`); err != nil {
				t.Fatal(err)
			}
			tx, err := s.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `SELECT 1 FROM `+table+` FOR UPDATE`); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if kind == "node-renew" {
					_, err := s.RenewExecutionNode(ctx, node, false)
					result <- err
				} else {
					mode := "renew"
					if kind == "session-acquire-node-expiry" {
						mode = "acquire"
					}
					_, err := s.SessionExecutionLease(ctx, owner.SessionRef, in, mode)
					result <- err
				}
			}()
			waitExecutionLock(t, ctx, tx)
			if _, err = tx.Exec(ctx, `SELECT pg_sleep(1.1)`); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-result; !errors.Is(err, ErrExecutionFenced) {
				t.Fatalf("expired %s resumed after lock: %v", kind, err)
			}
		})
	}
}
