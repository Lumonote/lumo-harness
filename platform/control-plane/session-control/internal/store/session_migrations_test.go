package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

func migrationFixture(t *testing.T) (*Store, string, ExecutionLeaseRequest, ExecutionLeaseRequest, SessionMigrationCheckpoint) {
	t.Helper()
	s := newStore(t)
	ctx := context.Background()
	source := executionRequest("source")
	target := executionRequest("target")
	target.NodeID = "target"
	target.Endpoint = "https://target.example"
	target.Token = strings.Repeat("b", 64)
	for _, in := range []ExecutionNodeRequest{source, target} {
		if _, err := s.AcquireExecutionNode(ctx, in); err != nil {
			t.Fatal(err)
		}
	}
	o, token, err := s.ReserveSessionOwner(ctx, ReserveSessionOwner{Realm: "r", OwnerUserID: "alice", ProjectID: "p", NodeID: "node"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ActivateSessionOwner(ctx, "r", o.SessionRef, token); err != nil {
		t.Fatal(err)
	}
	a := ExecutionLeaseRequest{ExecutionNodeRequest: source, WriterHolder: "writer:source"}
	l, err := s.SessionExecutionLease(ctx, o.SessionRef, a, "acquire")
	if err != nil {
		t.Fatal(err)
	}
	a.FencingToken = l.FencingToken
	b := ExecutionLeaseRequest{ExecutionNodeRequest: target, WriterHolder: "writer:target"}
	id := "mig_" + strings.Repeat("c", 48)
	sha := strings.Repeat("d", 64)
	in := SessionMigrationCheckpoint{ID: id, OwnerUserID: "alice", TargetNodeID: "target", SnapshotKey: "session-migration/v1/" + o.SessionRef + "/" + id + "/" + sha, SnapshotSHA256: sha, SnapshotBytes: 100, EventCount: 4, Execution: a}
	return s, o.SessionRef, a, b, in
}

func TestSessionMigrationFreezesSourceAndAtomicallyMovesOwnerAndFence(t *testing.T) {
	s, ref, source, target, in := migrationFixture(t)
	ctx := context.Background()
	m, err := s.CheckpointSessionMigration(ctx, ref, in)
	if err != nil || m.State != "checkpointed" {
		t.Fatalf("checkpoint %+v %v", m, err)
	}
	if replay, err := s.CheckpointSessionMigration(ctx, ref, in); err != nil || replay.ID != m.ID {
		t.Fatalf("checkpoint retry %+v %v", replay, err)
	}
	for _, mode := range []string{"acquire", "renew", "release"} {
		if _, err := New(s.pool).SessionExecutionLease(ctx, ref, source, mode); !errors.Is(err, ErrExecutionFenced) {
			t.Fatalf("frozen source %s: %v", mode, err)
		}
	}
	// A replacement source process must also fail, after the original goes offline.
	if _, err = s.RenewExecutionNode(ctx, source.ExecutionNodeRequest, true); err != nil {
		t.Fatal(err)
	}
	next := source
	next.ProcessID = "source-restarted"
	if _, err = s.AcquireExecutionNode(ctx, next.ExecutionNodeRequest); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SessionExecutionLease(ctx, ref, next, "acquire"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("restarted source escaped freeze: %v", err)
	}
	activation := SessionMigrationActivation{OwnerUserID: "alice", SnapshotSHA256: in.SnapshotSHA256, Execution: target}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := New(s.pool).ActivateSessionMigration(ctx, ref, in.ID, activation)
			if err != nil || out.State != "activated" {
				t.Errorf("activate %+v %v", out, err)
			}
		}()
	}
	wg.Wait()
	o, err := s.SessionOwner(ctx, "r", ref)
	if err != nil || o.NodeID != "target" || o.OwnerUserID != "alice" || o.ProjectID != "p" {
		t.Fatalf("owner %+v %v", o, err)
	}
	lease, err := s.SessionExecutionLease(ctx, ref, target, "acquire")
	if err != nil || lease.FencingToken != source.FencingToken+2 || lease.NodeID != "target" || lease.WriterHolder != "writer:target" {
		t.Fatalf("target %+v %v", lease, err)
	}
	if _, err = s.SessionExecutionLease(ctx, ref, next, "acquire"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("source reacquired after activation: %v", err)
	}
	loaded, err := New(s.pool).SessionMigration(ctx, "r", ref, in.ID)
	if err != nil || loaded.State != "activated" || loaded.ActivatedAt == nil {
		t.Fatalf("durable receipt %+v %v", loaded, err)
	}
	if _, err = s.SessionMigration(ctx, "foreign", ref, in.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross realm receipt: %v", err)
	}
}

func TestSessionMigrationRejectsInvalidAndForgedCheckpointWithoutFreezing(t *testing.T) {
	s, ref, source, _, good := migrationFixture(t)
	ctx := context.Background()
	for _, field := range []string{"owner", "realm", "project", "token", "writer", "fence", "key", "digest", "bytes", "count", "same-node"} {
		t.Run(field, func(t *testing.T) {
			in := good
			switch field {
			case "owner":
				in.OwnerUserID = "bob"
			case "realm":
				in.Execution.Realm = "foreign"
			case "project":
				in.Execution.ProjectID = "foreign"
			case "token":
				in.Execution.Token = strings.Repeat("f", 64)
			case "writer":
				in.Execution.WriterHolder = "forged"
			case "fence":
				in.Execution.FencingToken++
			case "key":
				in.SnapshotKey = "content/" + in.SnapshotSHA256
			case "digest":
				in.SnapshotSHA256 = "bad"
			case "bytes":
				in.SnapshotBytes = 33554433
			case "count":
				in.EventCount = 10001
			case "same-node":
				in.TargetNodeID = source.NodeID
			}
			if _, err := s.CheckpointSessionMigration(ctx, ref, in); err == nil {
				t.Fatal("forged checkpoint accepted")
			}
			if _, err := s.SessionExecutionLease(ctx, ref, source, "renew"); err != nil {
				t.Fatalf("failed request froze source: %v", err)
			}
		})
	}
}

func TestSessionMigrationActivationRemainsFrozenOnMismatchOrOfflineTarget(t *testing.T) {
	s, ref, source, target, in := migrationFixture(t)
	ctx := context.Background()
	if _, err := s.CheckpointSessionMigration(ctx, ref, in); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"owner", "digest", "project", "node", "token"} {
		t.Run(field, func(t *testing.T) {
			activation := SessionMigrationActivation{OwnerUserID: "alice", SnapshotSHA256: in.SnapshotSHA256, Execution: target}
			switch field {
			case "owner":
				activation.OwnerUserID = "bob"
			case "digest":
				activation.SnapshotSHA256 = strings.Repeat("f", 64)
			case "project":
				activation.Execution.ProjectID = "foreign"
			case "node":
				activation.Execution = source
			case "token":
				activation.Execution.Token = strings.Repeat("e", 64)
			}
			if _, err := s.ActivateSessionMigration(ctx, ref, in.ID, activation); err == nil {
				t.Fatal("forged activation accepted")
			}
		})
	}
	if _, err := s.RenewExecutionNode(ctx, target.ExecutionNodeRequest, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ActivateSessionMigration(ctx, ref, in.ID, SessionMigrationActivation{OwnerUserID: "alice", SnapshotSHA256: in.SnapshotSHA256, Execution: target}); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("expired target activated: %v", err)
	}
	o, _ := s.SessionOwner(ctx, "r", ref)
	m, _ := s.SessionMigration(ctx, "r", ref, in.ID)
	if o.NodeID != source.NodeID || m.State != "checkpointed" {
		t.Fatalf("failed activation partially committed: %+v %+v", o, m)
	}
	if _, err := s.SessionExecutionLease(ctx, ref, source, "acquire"); !errors.Is(err, ErrExecutionFenced) {
		t.Fatalf("failed activation revived source: %v", err)
	}
}

func TestSessionMigrationCheckpointRetryRevalidatesFrozenAuthority(t *testing.T) {
	for _, field := range []string{"owner-state", "owner-user", "owner-project", "owner-node", "source-process", "writer", "fence", "activated"} {
		t.Run(field, func(t *testing.T) {
			s, ref, _, target, in := migrationFixture(t)
			ctx := context.Background()
			if _, err := s.CheckpointSessionMigration(ctx, ref, in); err != nil {
				t.Fatal(err)
			}
			var query string
			switch field {
			case "owner-state":
				query = `UPDATE session_owners SET state='failed' WHERE session_ref=$1`
			case "owner-user":
				query = `UPDATE session_owners SET owner_user_id='bob' WHERE session_ref=$1`
			case "owner-project":
				query = `UPDATE session_owners SET project_id='foreign' WHERE session_ref=$1`
			case "owner-node":
				query = `UPDATE session_owners SET node_id='foreign' WHERE session_ref=$1`
			case "source-process":
				in.Execution.ProcessID = "replacement"
			case "writer":
				in.Execution.WriterHolder = "forged"
			case "fence":
				in.Execution.FencingToken++
			case "activated":
				if _, err := s.ActivateSessionMigration(ctx, ref, in.ID, SessionMigrationActivation{OwnerUserID: "alice", SnapshotSHA256: in.SnapshotSHA256, Execution: target}); err != nil {
					t.Fatal(err)
				}
			}
			if query != "" {
				if _, err := s.pool.Exec(ctx, query, ref); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.CheckpointSessionMigration(ctx, ref, in); err == nil {
				t.Fatal("stale checkpoint retry accepted")
			}
		})
	}
}

func TestSessionMigrationActivatedRetryRejectsDeactivatedOwner(t *testing.T) {
	s, ref, _, target, in := migrationFixture(t)
	ctx := context.Background()
	if _, err := s.CheckpointSessionMigration(ctx, ref, in); err != nil {
		t.Fatal(err)
	}
	activation := SessionMigrationActivation{OwnerUserID: "alice", SnapshotSHA256: in.SnapshotSHA256, Execution: target}
	if _, err := s.ActivateSessionMigration(ctx, ref, in.ID, activation); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE session_owners SET state='failed' WHERE session_ref=$1`, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ActivateSessionMigration(ctx, ref, in.ID, activation); !errors.Is(err, ErrOwnerConflict) {
		t.Fatalf("deactivated owner returned successful activation: %v", err)
	}
	m, err := s.SessionMigration(ctx, "r", ref, in.ID)
	if err != nil || m.State != "activated" {
		t.Fatalf("rejected retry changed durable receipt: %+v %v", m, err)
	}
}
