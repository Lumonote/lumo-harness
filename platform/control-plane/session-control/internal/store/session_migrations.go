package store

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

const sessionMigrationDDL = `
CREATE TABLE IF NOT EXISTS session_migrations (
 id TEXT PRIMARY KEY,session_ref TEXT NOT NULL REFERENCES session_owners(session_ref),
 realm TEXT NOT NULL,owner_user_id TEXT NOT NULL,project_id TEXT NOT NULL,
 source_node_id TEXT NOT NULL,target_node_id TEXT NOT NULL,
 source_process_id TEXT NOT NULL,source_node_fence BIGINT NOT NULL,source_fencing_token BIGINT NOT NULL,
 snapshot_key TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,snapshot_bytes BIGINT NOT NULL CHECK(snapshot_bytes>0 AND snapshot_bytes<=33554432),
 event_count INTEGER NOT NULL CHECK(event_count>=0 AND event_count<=10000),
 state TEXT NOT NULL CHECK(state IN ('checkpointed','activated')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),activated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS session_migrations_pending_idx ON session_migrations(session_ref) WHERE state='checkpointed';
CREATE INDEX IF NOT EXISTS session_migrations_session_idx ON session_migrations(realm,session_ref,created_at DESC);
`

type SessionMigration struct {
	ID                 string     `json:"id"`
	SessionRef         string     `json:"session_ref"`
	Realm              string     `json:"realm"`
	OwnerUserID        string     `json:"owner_user_id"`
	ProjectID          string     `json:"project_id"`
	SourceNodeID       string     `json:"source_node_id"`
	TargetNodeID       string     `json:"target_node_id"`
	SourceProcessID    string     `json:"source_process_id"`
	SourceNodeFence    int64      `json:"source_node_fence"`
	SourceFencingToken int64      `json:"source_fencing_token"`
	SnapshotKey        string     `json:"snapshot_key"`
	SnapshotSHA256     string     `json:"snapshot_sha256"`
	SnapshotBytes      int64      `json:"snapshot_bytes"`
	EventCount         int        `json:"event_count"`
	State              string     `json:"state"`
	CreatedAt          time.Time  `json:"created_at"`
	ActivatedAt        *time.Time `json:"activated_at,omitempty"`
}

type SessionMigrationCheckpoint struct {
	ID             string                `json:"id"`
	OwnerUserID    string                `json:"owner_user_id"`
	TargetNodeID   string                `json:"target_node_id"`
	SnapshotKey    string                `json:"snapshot_key"`
	SnapshotSHA256 string                `json:"snapshot_sha256"`
	SnapshotBytes  int64                 `json:"snapshot_bytes"`
	EventCount     int                   `json:"event_count"`
	Execution      ExecutionLeaseRequest `json:"execution"`
}

type SessionMigrationActivation struct {
	OwnerUserID    string                `json:"owner_user_id"`
	SnapshotSHA256 string                `json:"snapshot_sha256"`
	Execution      ExecutionLeaseRequest `json:"execution"`
}

var migrationID = regexp.MustCompile(`^mig_[a-f0-9]{48}$`)
var migrationSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)
var migrationRef = regexp.MustCompile(`^session-[a-f0-9]{32}$`)

const migrationColumns = `id,session_ref,realm,owner_user_id,project_id,source_node_id,target_node_id,source_process_id,source_node_fence,source_fencing_token,snapshot_key,snapshot_sha256,snapshot_bytes,event_count,state,created_at,activated_at`

func scanMigration(row pgx.Row) (SessionMigration, error) {
	var m SessionMigration
	err := row.Scan(&m.ID, &m.SessionRef, &m.Realm, &m.OwnerUserID, &m.ProjectID, &m.SourceNodeID, &m.TargetNodeID, &m.SourceProcessID, &m.SourceNodeFence, &m.SourceFencingToken, &m.SnapshotKey, &m.SnapshotSHA256, &m.SnapshotBytes, &m.EventCount, &m.State, &m.CreatedAt, &m.ActivatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

func (s *Store) SessionMigration(ctx context.Context, realm, ref, id string) (SessionMigration, error) {
	if realm == "" || !migrationRef.MatchString(ref) || (id != "" && !migrationID.MatchString(id)) {
		return SessionMigration{}, ErrOwnerInvalid
	}
	if id == "" {
		return scanMigration(s.pool.QueryRow(ctx, `SELECT `+migrationColumns+` FROM session_migrations WHERE realm=$1 AND session_ref=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, realm, ref))
	}
	return scanMigration(s.pool.QueryRow(ctx, `SELECT `+migrationColumns+` FROM session_migrations WHERE realm=$1 AND session_ref=$2 AND id=$3`, realm, ref, id))
}

// A checkpoint is accepted only from the exact live original writer. It is a
// one-way freeze, never a replay instruction. The immutable blob was uploaded
// and independently read/hashed before this authority transaction is requested.
func (s *Store) CheckpointSessionMigration(ctx context.Context, ref string, in SessionMigrationCheckpoint) (SessionMigration, error) {
	e := in.Execution
	if !migrationRef.MatchString(ref) || !migrationID.MatchString(in.ID) || !migrationSHA.MatchString(in.SnapshotSHA256) || in.SnapshotBytes < 1 || in.SnapshotBytes > 33554432 || in.EventCount < 0 || in.EventCount > 10000 || in.OwnerUserID == "" || in.TargetNodeID == "" || in.TargetNodeID == e.NodeID || !validExecutionNode(e.ExecutionNodeRequest) || e.WriterHolder == "" || e.FencingToken < 1 || in.SnapshotKey != "session-migration/v1/"+ref+"/"+in.ID+"/"+in.SnapshotSHA256 {
		return SessionMigration{}, ErrOwnerInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionMigration{}, err
	}
	defer tx.Rollback(ctx)
	// node -> execution -> owner -> migration, consistently with normal writers.
	n, err := scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND process_id=$4 AND endpoint=$5 AND token_hash=$6 AND expires_at>clock_timestamp() FOR SHARE`, e.Realm, e.NodeID, e.ProjectID, e.ProcessID, e.Endpoint, ownerTokenHash(e.Token)))
	if err != nil {
		return SessionMigration{}, err
	}
	l, err := scanExecutionLease(tx.QueryRow(ctx, `SELECT `+executionLeaseColumns+` FROM session_execution_leases WHERE session_ref=$1 FOR UPDATE`, ref))
	if err != nil {
		return SessionMigration{}, err
	}
	o, err := scanOwner(tx.QueryRow(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE session_ref=$1 FOR UPDATE`, ref))
	if err != nil {
		return SessionMigration{}, err
	}
	prior, err := scanMigration(tx.QueryRow(ctx, `SELECT `+migrationColumns+` FROM session_migrations WHERE id=$1`, in.ID))
	if err == nil {
		if prior.SessionRef != ref || prior.Realm != e.Realm || prior.OwnerUserID != in.OwnerUserID || prior.SourceNodeID != e.NodeID || prior.TargetNodeID != in.TargetNodeID || prior.SnapshotKey != in.SnapshotKey || prior.SnapshotSHA256 != in.SnapshotSHA256 || prior.SnapshotBytes != in.SnapshotBytes || prior.EventCount != in.EventCount {
			return SessionMigration{}, ErrOwnerConflict
		}
		// A receipt is not authority to resurrect a changed/deactivated owner or
		// let a replacement source process impersonate the original checkpoint.
		if prior.State != "checkpointed" || prior.ProjectID != e.ProjectID || prior.SourceProcessID != e.ProcessID || prior.SourceNodeFence != n.Fence || prior.SourceFencingToken != e.FencingToken || o.State != "active" || o.Realm != prior.Realm || o.OwnerUserID != prior.OwnerUserID || o.ProjectID != prior.ProjectID || o.NodeID != prior.SourceNodeID || l.Realm != prior.Realm || l.NodeID != prior.SourceNodeID || l.ProjectID != prior.ProjectID || l.ProcessID != prior.SourceProcessID || l.NodeFence != prior.SourceNodeFence || l.FencingToken != prior.SourceFencingToken+1 || l.WriterHolder != e.WriterHolder {
			return SessionMigration{}, ErrOwnerConflict
		}
		if _, err = scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND process_id=$3 AND fence=$4 AND expires_at>clock_timestamp()`, e.Realm, e.NodeID, e.ProcessID, n.Fence)); err != nil {
			return SessionMigration{}, err
		}
		return prior, tx.Commit(ctx)
	}
	if !errors.Is(err, ErrNotFound) {
		return SessionMigration{}, err
	}
	var live, target, pending bool
	err = tx.QueryRow(ctx, `SELECT $1::timestamptz>clock_timestamp(),EXISTS(SELECT 1 FROM session_execution_nodes WHERE realm=$2 AND node_id=$3 AND project_id=$4 AND expires_at>clock_timestamp())`, l.ExpiresAt, e.Realm, in.TargetNodeID, e.ProjectID).Scan(&live, &target)
	if err != nil {
		return SessionMigration{}, err
	}
	if !live || !target || o.State != "active" || o.Realm != e.Realm || o.OwnerUserID != in.OwnerUserID || o.ProjectID != e.ProjectID || o.NodeID != e.NodeID || l.Realm != e.Realm || l.NodeID != e.NodeID || l.ProjectID != e.ProjectID || l.ProcessID != e.ProcessID || l.NodeFence != n.Fence || l.FencingToken != e.FencingToken || l.WriterHolder != e.WriterHolder {
		return SessionMigration{}, ErrExecutionFenced
	}
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_migrations WHERE session_ref=$1 AND state='checkpointed')`, ref).Scan(&pending); err != nil {
		return SessionMigration{}, err
	}
	if pending {
		return SessionMigration{}, ErrOwnerConflict
	}
	m, err := scanMigration(tx.QueryRow(ctx, `INSERT INTO session_migrations(id,session_ref,realm,owner_user_id,project_id,source_node_id,target_node_id,source_process_id,source_node_fence,source_fencing_token,snapshot_key,snapshot_sha256,snapshot_bytes,event_count,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'checkpointed') RETURNING `+migrationColumns, in.ID, ref, e.Realm, in.OwnerUserID, e.ProjectID, e.NodeID, in.TargetNodeID, e.ProcessID, n.Fence, e.FencingToken, in.SnapshotKey, in.SnapshotSHA256, in.SnapshotBytes, in.EventCount))
	if err != nil {
		return SessionMigration{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp(),fencing_token=fencing_token+1 WHERE session_ref=$1`, ref); err != nil {
		return SessionMigration{}, err
	}
	// Revalidate after waiting for all locks. Expired node credentials never
	// gain authority merely because they were live at statement start.
	if _, err = scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND process_id=$3 AND fence=$4 AND expires_at>clock_timestamp()`, e.Realm, e.NodeID, e.ProcessID, n.Fence)); err != nil {
		return SessionMigration{}, err
	}
	return m, tx.Commit(ctx)
}

// Activate requires a target process proof after exact durable import. Owner
// and execution generation move together; old credentials cannot reacquire or
// revive their fencing high-water mark. No source input is ever replayed here.
func (s *Store) ActivateSessionMigration(ctx context.Context, ref, id string, in SessionMigrationActivation) (SessionMigration, error) {
	e := in.Execution
	if !migrationRef.MatchString(ref) || !migrationID.MatchString(id) || !migrationSHA.MatchString(in.SnapshotSHA256) || in.OwnerUserID == "" || !validExecutionNode(e.ExecutionNodeRequest) || e.WriterHolder == "" {
		return SessionMigration{}, ErrOwnerInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionMigration{}, err
	}
	defer tx.Rollback(ctx)
	n, err := scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND process_id=$4 AND endpoint=$5 AND token_hash=$6 AND expires_at>clock_timestamp() FOR SHARE`, e.Realm, e.NodeID, e.ProjectID, e.ProcessID, e.Endpoint, ownerTokenHash(e.Token)))
	if err != nil {
		return SessionMigration{}, err
	}
	l, err := scanExecutionLease(tx.QueryRow(ctx, `SELECT `+executionLeaseColumns+` FROM session_execution_leases WHERE session_ref=$1 FOR UPDATE`, ref))
	if err != nil {
		return SessionMigration{}, err
	}
	o, err := scanOwner(tx.QueryRow(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE session_ref=$1 FOR UPDATE`, ref))
	if err != nil {
		return SessionMigration{}, err
	}
	m, err := scanMigration(tx.QueryRow(ctx, `SELECT `+migrationColumns+` FROM session_migrations WHERE id=$1 AND session_ref=$2 FOR UPDATE`, id, ref))
	if err != nil {
		return m, err
	}
	if m.Realm != e.Realm || m.OwnerUserID != in.OwnerUserID || m.ProjectID != e.ProjectID || m.TargetNodeID != e.NodeID || m.SnapshotSHA256 != in.SnapshotSHA256 || o.State != "active" || o.Realm != m.Realm || o.OwnerUserID != m.OwnerUserID || o.ProjectID != m.ProjectID {
		return m, ErrOwnerConflict
	}
	if m.State == "activated" {
		if o.NodeID != m.TargetNodeID {
			return m, ErrOwnerConflict
		}
		if _, err = scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND process_id=$3 AND fence=$4 AND expires_at>clock_timestamp()`, e.Realm, e.NodeID, e.ProcessID, n.Fence)); err != nil {
			return m, err
		}
		return m, tx.Commit(ctx)
	}
	if o.NodeID != m.SourceNodeID || o.State != "active" || l.NodeID != m.SourceNodeID || l.ProcessID != m.SourceProcessID || l.NodeFence != m.SourceNodeFence || l.FencingToken != m.SourceFencingToken+1 {
		return m, ErrOwnerConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE session_owners SET node_id=$2 WHERE session_ref=$1`, ref, m.TargetNodeID); err != nil {
		return m, err
	}
	if _, err = tx.Exec(ctx, `UPDATE session_execution_leases SET node_id=$2,process_id=$3,node_fence=$4,fencing_token=fencing_token+1,writer_holder=$5,expires_at=clock_timestamp()+interval '10 seconds' WHERE session_ref=$1`, ref, e.NodeID, e.ProcessID, n.Fence, e.WriterHolder); err != nil {
		return m, err
	}
	m, err = scanMigration(tx.QueryRow(ctx, `UPDATE session_migrations SET state='activated',activated_at=clock_timestamp() WHERE id=$1 RETURNING `+migrationColumns, id))
	if err != nil {
		return m, err
	}
	if _, err = scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND process_id=$3 AND fence=$4 AND expires_at>clock_timestamp()`, e.Realm, e.NodeID, e.ProcessID, n.Fence)); err != nil {
		return m, err
	}
	return m, tx.Commit(ctx)
}
