package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const sessionExecutionDDL = `
CREATE TABLE IF NOT EXISTS session_execution_nodes (
 realm TEXT NOT NULL,node_id TEXT NOT NULL,project_id TEXT NOT NULL,
 process_id TEXT NOT NULL,endpoint TEXT NOT NULL,token_hash TEXT NOT NULL,
 fence BIGINT NOT NULL CHECK(fence>0),expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(realm,node_id)
);
CREATE TABLE IF NOT EXISTS session_execution_leases (
 session_ref TEXT PRIMARY KEY REFERENCES session_owners(session_ref),
 realm TEXT NOT NULL,node_id TEXT NOT NULL,project_id TEXT NOT NULL,
 process_id TEXT NOT NULL,node_fence BIGINT NOT NULL,
 fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
 writer_holder TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS session_owners_project_idx ON session_owners(realm,owner_user_id,project_id,session_ref) WHERE state='active';
`

var ErrExecutionFenced = errors.New("session execution lease unavailable or fenced")

// Every expiration comparison uses the database clock. An expired process can
// never revive its old credentials, including before another process takes over.
type ExecutionNode struct {
	Realm     string    `json:"realm"`
	NodeID    string    `json:"node_id"`
	ProjectID string    `json:"project_id"`
	ProcessID string    `json:"process_id"`
	Endpoint  string    `json:"endpoint"`
	Fence     int64     `json:"fence"`
	ExpiresAt time.Time `json:"expires_at"`
}
type ExecutionNodeRequest struct {
	Realm     string `json:"realm"`
	NodeID    string `json:"node_id"`
	ProjectID string `json:"project_id"`
	ProcessID string `json:"process_id"`
	Endpoint  string `json:"endpoint"`
	Token     string `json:"token"`
}
type ExecutionLease struct {
	SessionRef   string    `json:"session_ref"`
	Realm        string    `json:"realm"`
	NodeID       string    `json:"node_id"`
	ProjectID    string    `json:"project_id"`
	ProcessID    string    `json:"process_id"`
	NodeFence    int64     `json:"node_fence"`
	FencingToken int64     `json:"fencing_token"`
	WriterHolder string    `json:"writer_holder"`
	ExpiresAt    time.Time `json:"expires_at"`
}
type ExecutionLeaseRequest struct {
	ExecutionNodeRequest
	WriterHolder string `json:"writer_holder"`
	FencingToken int64  `json:"fencing_token"`
}

const executionNodeColumns = `realm,node_id,project_id,process_id,endpoint,fence,expires_at`
const executionLeaseColumns = `session_ref,realm,node_id,project_id,process_id,node_fence,fencing_token,writer_holder,expires_at`

func scanExecutionNode(row pgx.Row) (ExecutionNode, error) {
	var n ExecutionNode
	err := row.Scan(&n.Realm, &n.NodeID, &n.ProjectID, &n.ProcessID, &n.Endpoint, &n.Fence, &n.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return n, ErrExecutionFenced
	}
	return n, err
}
func scanExecutionLease(row pgx.Row) (ExecutionLease, error) {
	var l ExecutionLease
	err := row.Scan(&l.SessionRef, &l.Realm, &l.NodeID, &l.ProjectID, &l.ProcessID, &l.NodeFence, &l.FencingToken, &l.WriterHolder, &l.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return l, ErrExecutionFenced
	}
	return l, err
}
func validExecutionNode(n ExecutionNodeRequest) bool {
	for _, v := range []string{n.Realm, n.NodeID, n.ProjectID, n.ProcessID} {
		if v == "" || strings.TrimSpace(v) != v || len(v) > 256 || strings.ContainsAny(v, "\x00\r\n") {
			return false
		}
	}
	if len(n.Token) != 64 {
		return false
	}
	for _, c := range n.Token {
		if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
			return false
		}
	}
	return len(n.Endpoint) <= 2048 && !strings.ContainsAny(n.Endpoint, "\x00\r\n")
}
func (s *Store) AcquireExecutionNode(ctx context.Context, in ExecutionNodeRequest) (ExecutionNode, error) {
	if !validExecutionNode(in) {
		return ExecutionNode{}, ErrOwnerInvalid
	}
	return scanExecutionNode(s.pool.QueryRow(ctx, `INSERT INTO session_execution_nodes(realm,node_id,project_id,process_id,endpoint,token_hash,fence,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp()+interval '15 seconds')
 ON CONFLICT(realm,node_id) DO UPDATE SET project_id=EXCLUDED.project_id,process_id=EXCLUDED.process_id,endpoint=EXCLUDED.endpoint,token_hash=EXCLUDED.token_hash,
 fence=CASE WHEN session_execution_nodes.process_id=EXCLUDED.process_id THEN session_execution_nodes.fence ELSE session_execution_nodes.fence+1 END,
 expires_at=clock_timestamp()+interval '15 seconds'
 WHERE (session_execution_nodes.process_id=EXCLUDED.process_id AND session_execution_nodes.token_hash=EXCLUDED.token_hash AND session_execution_nodes.project_id=EXCLUDED.project_id AND session_execution_nodes.endpoint=EXCLUDED.endpoint AND session_execution_nodes.expires_at>clock_timestamp())
 OR (session_execution_nodes.process_id<>EXCLUDED.process_id AND session_execution_nodes.expires_at<=clock_timestamp())
 RETURNING `+executionNodeColumns, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, in.Endpoint, ownerTokenHash(in.Token)))
}
func (s *Store) RenewExecutionNode(ctx context.Context, in ExecutionNodeRequest, release bool) (ExecutionNode, error) {
	if !validExecutionNode(in) {
		return ExecutionNode{}, ErrOwnerInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExecutionNode{}, err
	}
	defer tx.Rollback(ctx)
	// A WHERE expiry test evaluated before waiting for a row lock can become
	// stale without a concurrent UPDATE. Lock first, then test in a fresh query.
	if _, err = scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 FOR UPDATE`, in.Realm, in.NodeID)); err != nil {
		return ExecutionNode{}, err
	}
	n, err := scanExecutionNode(tx.QueryRow(ctx, `UPDATE session_execution_nodes SET expires_at=CASE WHEN $7 THEN clock_timestamp() ELSE clock_timestamp()+interval '15 seconds' END
 WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND process_id=$4 AND endpoint=$5 AND token_hash=$6 AND expires_at>clock_timestamp() RETURNING `+executionNodeColumns, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, in.Endpoint, ownerTokenHash(in.Token), release))
	if err != nil {
		return n, err
	}
	return n, tx.Commit(ctx)
}
func (s *Store) ExecutionNode(ctx context.Context, realm, node, project string) (ExecutionNode, error) {
	return scanExecutionNode(s.pool.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND expires_at>clock_timestamp()`, realm, node, project))
}
func (s *Store) SessionExecutionLease(ctx context.Context, ref string, in ExecutionLeaseRequest, mode string) (ExecutionLease, error) {
	if !validExecutionNode(in.ExecutionNodeRequest) || in.WriterHolder == "" || len(in.WriterHolder) > 512 || in.FencingToken < 0 || (mode != "acquire" && mode != "renew" && mode != "release") {
		return ExecutionLease{}, ErrOwnerInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExecutionLease{}, err
	}
	defer tx.Rollback(ctx)
	// The node lock precedes the Session lock everywhere, including log writes.
	n, err := scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND process_id=$4 AND endpoint=$5 AND token_hash=$6 AND expires_at>clock_timestamp() FOR SHARE`, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, in.Endpoint, ownerTokenHash(in.Token)))
	if err != nil {
		return ExecutionLease{}, err
	}
	var ownerOK bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_owners WHERE session_ref=$1 AND realm=$2 AND node_id=$3 AND project_id=$4 AND state IN ('reserved','active') AND NOT EXISTS(SELECT 1 FROM session_migrations WHERE session_ref=$1 AND state='checkpointed'))`, ref, in.Realm, in.NodeID, in.ProjectID).Scan(&ownerOK)
	if err != nil {
		return ExecutionLease{}, err
	}
	if !ownerOK {
		return ExecutionLease{}, ErrExecutionFenced
	}
	var l ExecutionLease
	if mode == "acquire" {
		l, err = scanExecutionLease(tx.QueryRow(ctx, `INSERT INTO session_execution_leases(session_ref,realm,node_id,project_id,process_id,node_fence,fencing_token,writer_holder,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,1,$7,clock_timestamp()+interval '10 seconds')
 ON CONFLICT(session_ref) DO UPDATE SET process_id=EXCLUDED.process_id,node_fence=EXCLUDED.node_fence,
 fencing_token=CASE WHEN session_execution_leases.process_id=EXCLUDED.process_id THEN session_execution_leases.fencing_token ELSE session_execution_leases.fencing_token+1 END,
 writer_holder=EXCLUDED.writer_holder,expires_at=clock_timestamp()+interval '10 seconds'
 WHERE session_execution_leases.realm=EXCLUDED.realm AND session_execution_leases.node_id=EXCLUDED.node_id AND session_execution_leases.project_id=EXCLUDED.project_id AND (
 (session_execution_leases.process_id=EXCLUDED.process_id AND session_execution_leases.node_fence=EXCLUDED.node_fence AND session_execution_leases.writer_holder=EXCLUDED.writer_holder AND session_execution_leases.expires_at>clock_timestamp())
		 OR (session_execution_leases.process_id<>EXCLUDED.process_id AND (session_execution_leases.expires_at<=clock_timestamp() OR session_execution_leases.node_fence<EXCLUDED.node_fence))) RETURNING `+executionLeaseColumns, ref, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, n.Fence, in.WriterHolder))
	} else {
		if _, err = scanExecutionLease(tx.QueryRow(ctx, `SELECT `+executionLeaseColumns+` FROM session_execution_leases WHERE session_ref=$1 FOR UPDATE`, ref)); err != nil {
			return ExecutionLease{}, err
		}
		l, err = scanExecutionLease(tx.QueryRow(ctx, `UPDATE session_execution_leases SET expires_at=CASE WHEN $9 THEN clock_timestamp() ELSE clock_timestamp()+interval '10 seconds' END
 WHERE session_ref=$1 AND realm=$2 AND node_id=$3 AND project_id=$4 AND process_id=$5 AND node_fence=$6 AND writer_holder=$7 AND fencing_token=$8 AND expires_at>clock_timestamp() RETURNING `+executionLeaseColumns, ref, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, n.Fence, in.WriterHolder, in.FencingToken, mode == "release"))
	}
	if err != nil {
		return l, err
	}
	// The Session row may have been locked by an in-flight writer while the
	// node's clock deadline passed. Revalidate after every lock is held.
	if _, err = scanExecutionNode(tx.QueryRow(ctx, `SELECT `+executionNodeColumns+` FROM session_execution_nodes WHERE realm=$1 AND node_id=$2 AND project_id=$3 AND process_id=$4 AND endpoint=$5 AND token_hash=$6 AND fence=$7 AND expires_at>clock_timestamp()`, in.Realm, in.NodeID, in.ProjectID, in.ProcessID, in.Endpoint, ownerTokenHash(in.Token), n.Fence)); err != nil {
		return ExecutionLease{}, err
	}
	return l, tx.Commit(ctx)
}
