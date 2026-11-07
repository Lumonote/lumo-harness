package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

const sessionOwnerDDL = `
CREATE TABLE IF NOT EXISTS session_owners (
 session_ref TEXT PRIMARY KEY,
 realm TEXT NOT NULL CHECK (realm <> ''),
 owner_user_id TEXT NOT NULL CHECK (owner_user_id <> ''),
 project_id TEXT NOT NULL CHECK (project_id <> ''),
 node_id TEXT NOT NULL CHECK (node_id <> ''),
 parent_session_ref TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK (state IN ('reserved','active','failed')),
 creation_token_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 activated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS session_owners_owner_idx ON session_owners (realm, owner_user_id, node_id, session_ref) WHERE state = 'active';
`

var ErrOwnerConflict = errors.New("session owner creation conflict")
var ErrOwnerInvalid = errors.New("invalid session owner request")

type SessionOwner struct {
	SessionRef       string     `json:"session_ref"`
	Realm            string     `json:"realm"`
	OwnerUserID      string     `json:"owner_user_id"`
	ProjectID        string     `json:"project_id"`
	NodeID           string     `json:"node_id"`
	ParentSessionRef string     `json:"parent_session_ref"`
	State            string     `json:"state"`
	CreatedAt        time.Time  `json:"created_at"`
	ActivatedAt      *time.Time `json:"activated_at,omitempty"`
}

type ReserveSessionOwner struct {
	Realm            string `json:"realm"`
	OwnerUserID      string `json:"owner_user_id"`
	ProjectID        string `json:"project_id"`
	NodeID           string `json:"node_id"`
	ParentSessionRef string `json:"parent_session_ref,omitempty"`
}

const ownerColumns = `session_ref,realm,owner_user_id,project_id,node_id,parent_session_ref,state,created_at,activated_at`

func scanOwner(row pgx.Row) (SessionOwner, error) {
	var o SessionOwner
	err := row.Scan(&o.SessionRef, &o.Realm, &o.OwnerUserID, &o.ProjectID, &o.NodeID, &o.ParentSessionRef, &o.State, &o.CreatedAt, &o.ActivatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return o, ErrNotFound
	}
	return o, err
}
func randomOwnerToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func ownerTokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// ReserveSessionOwner allocates a fresh identity. There is deliberately no API to claim an existing Session ID.
func (s *Store) ReserveSessionOwner(ctx context.Context, in ReserveSessionOwner) (SessionOwner, string, error) {
	for _, v := range []string{in.Realm, in.OwnerUserID, in.ProjectID, in.NodeID} {
		if strings.TrimSpace(v) == "" || len(v) > 256 {
			return SessionOwner{}, "", ErrOwnerInvalid
		}
	}
	if len(in.ParentSessionRef) > 256 {
		return SessionOwner{}, "", ErrOwnerInvalid
	}
	id, err := randomOwnerToken(16)
	if err != nil {
		return SessionOwner{}, "", err
	}
	token, err := randomOwnerToken(32)
	if err != nil {
		return SessionOwner{}, "", err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SessionOwner{}, "", err
	}
	defer tx.Rollback(ctx)
	if in.ParentSessionRef != "" {
		p, err := scanOwner(tx.QueryRow(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE session_ref=$1 AND realm=$2 FOR SHARE`, in.ParentSessionRef, in.Realm))
		if err != nil {
			return SessionOwner{}, "", err
		}
		if p.State != "active" || p.OwnerUserID != in.OwnerUserID || p.ProjectID != in.ProjectID || p.NodeID != in.NodeID {
			return SessionOwner{}, "", ErrOwnerConflict
		}
	}
	o, err := scanOwner(tx.QueryRow(ctx, `INSERT INTO session_owners(session_ref,realm,owner_user_id,project_id,node_id,parent_session_ref,state,creation_token_hash) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7) RETURNING `+ownerColumns, "session-"+id, in.Realm, in.OwnerUserID, in.ProjectID, in.NodeID, in.ParentSessionRef, ownerTokenHash(token)))
	if err != nil {
		return o, "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return o, "", err
	}
	return o, token, nil
}
func (s *Store) ActivateSessionOwner(ctx context.Context, realm, ref, token string) (SessionOwner, error) {
	if strings.TrimSpace(realm) == "" || ref == "" || len(token) != 64 {
		return SessionOwner{}, ErrOwnerInvalid
	}
	o, err := scanOwner(s.pool.QueryRow(ctx, `UPDATE session_owners SET state='active',activated_at=COALESCE(activated_at,now()) WHERE session_ref=$1 AND realm=$2 AND creation_token_hash=$3 AND state IN ('reserved','active') RETURNING `+ownerColumns, ref, realm, ownerTokenHash(token)))
	if errors.Is(err, ErrNotFound) {
		return o, ErrOwnerConflict
	}
	return o, err
}
func (s *Store) SessionOwner(ctx context.Context, realm, ref string) (SessionOwner, error) {
	if strings.TrimSpace(realm) == "" || ref == "" {
		return SessionOwner{}, ErrOwnerInvalid
	}
	return scanOwner(s.pool.QueryRow(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE realm=$1 AND session_ref=$2`, realm, ref))
}
func (s *Store) SessionOwners(ctx context.Context, realm, user, node, after string, limit int) ([]SessionOwner, error) {
	if strings.TrimSpace(realm) == "" || strings.TrimSpace(user) == "" || strings.TrimSpace(node) == "" || limit < 1 || limit > 100 {
		return nil, ErrOwnerInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT `+ownerColumns+` FROM session_owners WHERE realm=$1 AND owner_user_id=$2 AND node_id=$3 AND state='active' AND session_ref>$4 ORDER BY session_ref LIMIT $5`, realm, user, node, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionOwner{}
	for rows.Next() {
		o, err := scanOwner(rows)
		if err != nil {
			return nil, fmt.Errorf("read owner: %w", err)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
