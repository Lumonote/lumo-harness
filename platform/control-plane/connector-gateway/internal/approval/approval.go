// Package approval owns the one-time human authorization record for sensitive
// connector writes. The record stores a digest of the requested invocation,
// never its body, headers, or credentials.
package approval

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

const DDL = `
CREATE TABLE IF NOT EXISTS connector_approvals (
  id                TEXT PRIMARY KEY,
  realm             TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  project_id        TEXT,
  connector_id      TEXT NOT NULL,
  connector_version INTEGER NOT NULL,
  operation         TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
  approver_user_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  decided_at        TIMESTAMPTZ,
  consumed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_connector_approvals_realm_status
  ON connector_approvals (realm, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connector_approvals_requester
  ON connector_approvals (realm, requester_user_id, created_at DESC);
`

var (
	ErrNotApprovable = errors.New("connector approval is not pending or has expired")
	ErrNotUsable     = errors.New("connector approval is invalid, expired, already used, or does not match this request")
)

// Request is the audit-safe projection of a manual approval. RequestHash never
// leaves this package, because it is an implementation binding rather than a
// UI identifier.
type Request struct {
	ID               string    `json:"id"`
	Realm            string    `json:"realm"`
	RequesterUserID  string    `json:"requester_user_id"`
	ProjectID        string    `json:"project_id,omitempty"`
	ConnectorID      string    `json:"connector_id"`
	ConnectorVersion int       `json:"connector_version"`
	Operation        string    `json:"operation"`
	Status           string    `json:"status"`
	ApproverUserID   string    `json:"approver_user_id,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	RequestHash      string    `json:"-"`
}

type Store struct{ pool *pgxpool.Pool }

func NewPg(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Init(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, DDL)
	return err
}

// InvocationHash binds approval to every caller-controlled value that can
// change the target request, as well as to the manifest version resolved when
// the requester asked for approval. CorrelationID is audit-only and is
// intentionally excluded so a one-shot retry can receive a fresh trace ID.
func InvocationHash(inv domain.Invocation, connectorVersion int) (string, error) {
	canonical := struct {
		ConnectorID      string            `json:"connectorId"`
		ConnectorVersion int               `json:"connectorVersion"`
		Operation        string            `json:"operation"`
		PathParams       map[string]string `json:"pathParams,omitempty"`
		Query            map[string]string `json:"query,omitempty"`
		Headers          map[string]string `json:"headers,omitempty"`
		Body             json.RawMessage   `json:"body,omitempty"`
	}{
		ConnectorID: inv.ConnectorID, ConnectorVersion: connectorVersion, Operation: inv.Operation,
		PathParams: inv.PathParams, Query: inv.Query, Headers: inv.Headers, Body: inv.Body,
	}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("connector approval: canonicalize invocation: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func (s *Store) Create(ctx context.Context, caller domain.Caller, inv domain.Invocation, connectorVersion int, ttl time.Duration) (Request, error) {
	if ttl <= 0 {
		return Request{}, errors.New("connector approval: ttl must be positive")
	}
	hash, err := InvocationHash(inv, connectorVersion)
	if err != nil {
		return Request{}, err
	}
	id, err := newID()
	if err != nil {
		return Request{}, err
	}
	request := Request{
		ID: id, Realm: string(caller.Realm), RequesterUserID: caller.UserID, ProjectID: caller.ProjectID,
		ConnectorID: inv.ConnectorID, ConnectorVersion: connectorVersion, Operation: inv.Operation,
		RequestHash: hash, Status: "pending", ExpiresAt: time.Now().UTC().Add(ttl),
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO connector_approvals
		  (id, realm, requester_user_id, project_id, connector_id, connector_version, operation, request_hash, status, expires_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10)
		RETURNING created_at`,
		request.ID, request.Realm, request.RequesterUserID, request.ProjectID, request.ConnectorID,
		request.ConnectorVersion, request.Operation, request.RequestHash, request.Status, request.ExpiresAt,
	)
	if err := row.Scan(&request.CreatedAt); err != nil {
		return Request{}, fmt.Errorf("connector approval: create: %w", err)
	}
	return request, nil
}

// Decide transitions a pending request once. An approver cannot approve or
// reject their own request, preventing a role-bearing requester from bypassing
// the human separation-of-duties gate.
func (s *Store) Decide(ctx context.Context, id, realm, approver, decision string) (Request, error) {
	if decision != "approved" && decision != "rejected" {
		return Request{}, errors.New("connector approval: invalid decision")
	}
	row := s.pool.QueryRow(ctx, `
		UPDATE connector_approvals
		SET status = $1, approver_user_id = $2, decided_at = now()
		WHERE id = $3 AND realm = $4 AND status = 'pending' AND expires_at > now()
		  AND requester_user_id <> $2
		RETURNING id, realm, requester_user_id, COALESCE(project_id,''), connector_id, connector_version,
		          operation, status, COALESCE(approver_user_id,''), created_at, expires_at, request_hash`,
		decision, approver, id, realm,
	)
	request, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotApprovable
	}
	if err != nil {
		return Request{}, fmt.Errorf("connector approval: decide: %w", err)
	}
	return request, nil
}

// Consume atomically turns an approved request into a one-shot execution
// permit. The actual connector invocation happens afterwards; a transport
// failure therefore requires a new explicit approval rather than widening a
// previously reviewed authorization into an unbounded retry token.
func (s *Store) Consume(ctx context.Context, id string, caller domain.Caller, inv domain.Invocation, connectorVersion int) (Request, error) {
	hash, err := InvocationHash(inv, connectorVersion)
	if err != nil {
		return Request{}, err
	}
	row := s.pool.QueryRow(ctx, `
		UPDATE connector_approvals
		SET status = 'consumed', consumed_at = now()
		WHERE id = $1 AND realm = $2 AND requester_user_id = $3 AND request_hash = $4
		  AND status = 'approved' AND expires_at > now()
		RETURNING id, realm, requester_user_id, COALESCE(project_id,''), connector_id, connector_version,
		          operation, status, COALESCE(approver_user_id,''), created_at, expires_at, request_hash`,
		id, string(caller.Realm), caller.UserID, hash,
	)
	request, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotUsable
	}
	if err != nil {
		return Request{}, fmt.Errorf("connector approval: consume: %w", err)
	}
	return request, nil
}

// List returns a recent audit-safe queue. Admin callers receive the realm queue;
// all other callers only receive their own records.
func (s *Store) List(ctx context.Context, realm, requester string, all bool) ([]Request, error) {
	query := `
		SELECT id, realm, requester_user_id, COALESCE(project_id,''), connector_id, connector_version,
		       operation, status, COALESCE(approver_user_id,''), created_at, expires_at, request_hash
		FROM connector_approvals WHERE realm = $1`
	args := []any{realm}
	if !all {
		query += ` AND requester_user_id = $2`
		args = append(args, requester)
	}
	query += ` ORDER BY created_at DESC LIMIT 100`
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("connector approval: list: %w", err)
	}
	defer rows.Close()
	requests := make([]Request, 0)
	now := time.Now()
	for rows.Next() {
		request, err := scan(rows)
		if err != nil {
			return nil, err
		}
		// Keep expiration as an effective read-model state instead of mutating the
		// audit record on a mere list request. Decide and Consume enforce the same
		// expiry predicate in SQL, so a stale UI can never act on this projection.
		request.Status = effectiveStatus(request.Status, request.ExpiresAt, now)
		requests = append(requests, request)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("connector approval: list rows: %w", err)
	}
	return requests, nil
}

func effectiveStatus(status string, expiresAt, now time.Time) string {
	if (status == "pending" || status == "approved") && !expiresAt.After(now) {
		return "expired"
	}
	return status
}

type rowScanner interface{ Scan(...any) error }

func scan(row rowScanner) (Request, error) {
	var request Request
	err := row.Scan(
		&request.ID, &request.Realm, &request.RequesterUserID, &request.ProjectID,
		&request.ConnectorID, &request.ConnectorVersion, &request.Operation, &request.Status,
		&request.ApproverUserID, &request.CreatedAt, &request.ExpiresAt, &request.RequestHash,
	)
	return request, err
}

func newID() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("connector approval: random id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
