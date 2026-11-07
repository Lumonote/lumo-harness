// Package owned persists exact one-use owner consent before external writes.
// It never stores login credentials, resolved connector credentials or headers.
package owned

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

const DDL = `
CREATE TABLE IF NOT EXISTS owned_connector_receipts (
 id TEXT PRIMARY KEY,realm TEXT NOT NULL,owner_user_id TEXT NOT NULL,
 project_id TEXT NOT NULL,session_ref TEXT NOT NULL,connector_id TEXT NOT NULL,
 operation TEXT NOT NULL,connector_version INTEGER NOT NULL,payload TEXT NOT NULL,
 digest TEXT NOT NULL,revision BIGINT NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','consumed','succeeded','failed','unknown')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 expires_at TIMESTAMPTZ NOT NULL,decided_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS owned_connector_receipts_session_idx ON owned_connector_receipts(realm,owner_user_id,project_id,session_ref,created_at DESC);
CREATE INDEX IF NOT EXISTS owned_connector_receipts_expiry_idx ON owned_connector_receipts(expires_at) WHERE payload<>'null';
`

var ErrDenied = errors.New("owned connector authority unavailable or denied")
var ErrChanged = errors.New("owned connector receipt changed, expired or already used")

type Scope struct {
	Realm        string `json:"realm"`
	UserID       string `json:"user_id"`
	ProjectID    string `json:"project_id"`
	SessionRef   string `json:"session_ref"`
	NodeID       string `json:"node_id"`
	ProcessID    string `json:"process_id"`
	NodeFence    int64  `json:"node_fence"`
	WriterHolder string `json:"writer_holder"`
	FencingToken int64  `json:"fencing_token"`
}
type Receipt struct {
	ID               string          `json:"id"`
	ConnectorID      string          `json:"connector_id"`
	Operation        string          `json:"operation"`
	ConnectorVersion int             `json:"connector_version"`
	Payload          json.RawMessage `json:"payload"`
	Digest           string          `json:"digest"`
	Revision         int64           `json:"revision"`
	Status           string          `json:"status"`
	ExpiresAt        time.Time       `json:"expires_at"`
}
type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }
func (s *Store) Init(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, DDL)
	if err != nil {
		return err
	}
	return s.Expire(ctx)
}

// Clear business payloads after their five-minute consent window. Consumed
// calls with no durable completion remain unknown and can never be replayed.
func (s *Store) Expire(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `UPDATE owned_connector_receipts SET payload='null',status=CASE WHEN status='consumed' THEN 'unknown' WHEN status IN ('pending','approved') THEN 'rejected' ELSE status END,revision=revision+1 WHERE expires_at<=clock_timestamp() AND payload<>'null'`)
	return err
}

// Every scope check reads the same persistent owner and current execution
// generation used by Session-control. These are host facts, never browser IDs.
func (s *Store) Authorize(ctx context.Context, in Scope) error {
	return authorize(ctx, s.pool, in)
}

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func authorize(ctx context.Context, q queryer, in Scope) error {
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_owners o
 JOIN session_execution_nodes n ON n.realm=o.realm AND n.node_id=o.node_id
 JOIN session_execution_leases l ON l.session_ref=o.session_ref
 WHERE o.session_ref=$1 AND o.realm=$2 AND o.owner_user_id=$3 AND o.project_id=$4 AND o.node_id=$5 AND o.state='active'
 AND n.project_id=o.project_id AND n.process_id=$6 AND n.fence=$7 AND n.expires_at>clock_timestamp()
 AND l.realm=o.realm AND l.project_id=o.project_id AND l.node_id=o.node_id AND l.process_id=n.process_id AND l.node_fence=n.fence
 AND l.writer_holder=$8 AND l.fencing_token=$9 AND l.expires_at>clock_timestamp())`, in.SessionRef, in.Realm, in.UserID, in.ProjectID, in.NodeID, in.ProcessID, in.NodeFence, in.WriterHolder, in.FencingToken).Scan(&ok)
	if err != nil || !ok {
		return ErrDenied
	}
	return nil
}

const columns = `id,connector_id,operation,connector_version,payload,digest,revision,status,expires_at`

func scan(row pgx.Row) (Receipt, error) {
	var r Receipt
	var payload string
	err := row.Scan(&r.ID, &r.ConnectorID, &r.Operation, &r.ConnectorVersion, &payload, &r.Digest, &r.Revision, &r.Status, &r.ExpiresAt)
	r.Payload = json.RawMessage(payload)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrChanged
	}
	return r, err
}
func (s *Store) Create(ctx context.Context, in Scope, inv domain.Invocation, version int) (Receipt, error) {
	if err := s.Authorize(ctx, in); err != nil {
		return Receipt{}, err
	}
	if len(inv.Headers) > 0 || len(inv.Body) > 64*1024 {
		return Receipt{}, ErrDenied
	}
	raw, err := json.Marshal(inv)
	if err != nil || len(raw) > 64*1024 {
		return Receipt{}, ErrDenied
	}
	digest, err := approval.InvocationHash(inv, version)
	if err != nil {
		return Receipt{}, err
	}
	var random [24]byte
	if _, err = rand.Read(random[:]); err != nil {
		return Receipt{}, err
	}
	id := hex.EncodeToString(random[:])
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Receipt{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize receipt admission for one immutable owner, including independent
	// gateway replicas. Parallel tool calls cannot accumulate unbounded approvals.
	var locked string
	if err = tx.QueryRow(ctx, `SELECT session_ref FROM session_owners WHERE session_ref=$1 AND realm=$2 AND owner_user_id=$3 AND project_id=$4 FOR UPDATE`, in.SessionRef, in.Realm, in.UserID, in.ProjectID).Scan(&locked); err != nil {
		return Receipt{}, ErrDenied
	}
	if err = authorize(ctx, tx, in); err != nil {
		return Receipt{}, err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM owned_connector_receipts WHERE realm=$1 AND owner_user_id=$2 AND project_id=$3 AND session_ref=$4 AND status IN ('pending','approved') AND expires_at>clock_timestamp()`, in.Realm, in.UserID, in.ProjectID, in.SessionRef).Scan(&count); err != nil {
		return Receipt{}, err
	}
	if count >= 8 {
		return Receipt{}, ErrDenied
	}
	r, err := scan(tx.QueryRow(ctx, `INSERT INTO owned_connector_receipts(id,realm,owner_user_id,project_id,session_ref,connector_id,operation,connector_version,payload,digest,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '5 minutes') RETURNING `+columns, id, in.Realm, in.UserID, in.ProjectID, in.SessionRef, inv.ConnectorID, inv.Operation, version, string(raw), digest))
	if err != nil {
		return Receipt{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Receipt{}, err
	}
	return r, nil
}
func (s *Store) Get(ctx context.Context, in Scope, id string) (Receipt, error) {
	return scan(s.pool.QueryRow(ctx, `SELECT `+columns+` FROM owned_connector_receipts WHERE id=$1 AND realm=$2 AND owner_user_id=$3 AND project_id=$4 AND session_ref=$5`, id, in.Realm, in.UserID, in.ProjectID, in.SessionRef))
}
func (s *Store) mutate(ctx context.Context, in Scope, id, query string, args ...any) (Receipt, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Receipt{}, err
	}
	defer tx.Rollback(ctx)
	// Lock before evaluating the fresh database deadline. A transaction waiting
	// on this row must not resume an approval whose clock expired during its wait.
	var found string
	if err = tx.QueryRow(ctx, `SELECT id FROM owned_connector_receipts WHERE id=$1 AND realm=$2 AND owner_user_id=$3 AND project_id=$4 AND session_ref=$5 FOR UPDATE`, id, in.Realm, in.UserID, in.ProjectID, in.SessionRef).Scan(&found); err != nil {
		return Receipt{}, ErrChanged
	}
	// Ownership or execution may have changed while this row was locked by a
	// concurrent answer. Revalidate the live generation after the lock wait.
	if err = authorize(ctx, tx, in); err != nil {
		return Receipt{}, err
	}
	result, err := scan(tx.QueryRow(ctx, query, args...))
	if err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Receipt{}, err
	}
	return result, nil
}
func (s *Store) Decide(ctx context.Context, in Scope, id, digest string, revision int64, approve bool) (Receipt, error) {
	status := "rejected"
	if approve {
		status = "approved"
	}
	return s.mutate(ctx, in, id, `UPDATE owned_connector_receipts SET status=$1,payload=CASE WHEN $1='rejected' THEN 'null' ELSE payload END,revision=revision+1,decided_at=clock_timestamp()
 WHERE id=$2 AND realm=$3 AND owner_user_id=$4 AND project_id=$5 AND session_ref=$6 AND digest=$7 AND revision=$8 AND status='pending' AND expires_at>clock_timestamp() RETURNING `+columns, status, id, in.Realm, in.UserID, in.ProjectID, in.SessionRef, digest, revision)
}

// Consume seals the exact reviewed payload before the first external dispatch.
// Unknown outcomes are never made available for replay under the same receipt.
func (s *Store) Consume(ctx context.Context, in Scope, id, digest string, revision int64) (Receipt, error) {
	return s.mutate(ctx, in, id, `UPDATE owned_connector_receipts SET status='consumed',revision=revision+1,consumed_at=clock_timestamp()
 WHERE id=$1 AND realm=$2 AND owner_user_id=$3 AND project_id=$4 AND session_ref=$5 AND digest=$6 AND revision=$7 AND status='approved' AND expires_at>clock_timestamp() RETURNING `+columns, id, in.Realm, in.UserID, in.ProjectID, in.SessionRef, digest, revision)
}
func (s *Store) Complete(ctx context.Context, id, status string) error {
	if status != "succeeded" && status != "failed" && status != "unknown" {
		return ErrDenied
	}
	result, err := s.pool.Exec(ctx, `UPDATE owned_connector_receipts SET status=$2,payload='null',revision=revision+1,completed_at=clock_timestamp() WHERE id=$1 AND status='consumed'`, id, status)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrChanged
	}
	return nil
}
