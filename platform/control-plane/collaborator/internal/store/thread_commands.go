package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// Commands are an asynchronous durable mailbox, never a synchronous node RPC.
// Claims have no automatic expiry: an uncertain host must never execute twice.
const threadCommandsDDL = `
CREATE TABLE IF NOT EXISTS thread_commands (
 realm TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id),
 owner_user_id TEXT NOT NULL, node_id TEXT NOT NULL, coordinator_session_ref TEXT NOT NULL,
 task_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0), prompt TEXT NOT NULL,
 request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('waiting','pending','claimed','completed','failed','expired')),
 wake_key TEXT NOT NULL DEFAULT '', wake_deadline TIMESTAMPTZ, event_id TEXT NOT NULL DEFAULT '',
 claim_hash TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 PRIMARY KEY(realm,id), UNIQUE(realm,thread_id,attempt)
);
CREATE INDEX IF NOT EXISTS thread_commands_pending ON thread_commands(realm,node_id,owner_user_id,created_at,id) WHERE state='pending';
CREATE UNIQUE INDEX IF NOT EXISTS thread_commands_active ON thread_commands(realm,thread_id) WHERE state IN ('waiting','pending','claimed');`

type ThreadCommand struct {
	ID                    string     `json:"id"`
	Realm                 string     `json:"realm"`
	ThreadID              string     `json:"thread_id"`
	OwnerUserID           string     `json:"owner_user_id"`
	NodeID                string     `json:"node_id"`
	CoordinatorSessionRef string     `json:"coordinator_session_ref"`
	TaskID                string     `json:"task_id"`
	Attempt               int        `json:"attempt"`
	Prompt                string     `json:"prompt"`
	State                 string     `json:"state"`
	WakeKey               string     `json:"wake_key"`
	WakeDeadline          *time.Time `json:"wake_deadline,omitempty"`
	EventID               string     `json:"event_id"`
	RunID                 string     `json:"run_id"`
	Summary               string     `json:"summary"`
	ClaimToken            string     `json:"claim_token,omitempty"`
}

const commandColumns = `id,realm,thread_id,owner_user_id,node_id,coordinator_session_ref,task_id,attempt,prompt,state,wake_key,wake_deadline,event_id,run_id,summary`

func scanCommand(row pgx.Row) (ThreadCommand, error) {
	var c ThreadCommand
	err := row.Scan(&c.ID, &c.Realm, &c.ThreadID, &c.OwnerUserID, &c.NodeID, &c.CoordinatorSessionRef, &c.TaskID, &c.Attempt, &c.Prompt, &c.State, &c.WakeKey, &c.WakeDeadline, &c.EventID, &c.RunID, &c.Summary)
	return c, err
}
func commandDigest(c ThreadCommand) string {
	b, _ := json.Marshal([]any{c.Realm, c.ID, c.ThreadID, c.OwnerUserID, c.NodeID, c.CoordinatorSessionRef, c.TaskID, c.Attempt, c.Prompt, c.WakeKey, c.WakeDeadline})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func commandTokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (s *Store) EnqueueThreadCommand(ctx context.Context, c ThreadCommand) (ThreadCommand, bool, error) {
	if err := validateRoundRef("command_id", c.ID); err != nil {
		return c, false, err
	}
	if err := validateThreadRoundIdentity(ThreadRoundIdentity{OwnerUserID: c.OwnerUserID, AgentID: "command", PresetRevision: 1, MaxConcurrency: 1, Provider: "command", Model: "command"}); err != nil {
		return c, false, err
	}
	if c.Attempt < 1 || c.Attempt > 2147483647 || strings.TrimSpace(c.Prompt) == "" || len(c.Prompt) > 256000 || !validRoundText(c.Prompt) {
		return c, false, fmt.Errorf("%w: invalid command", domain.ErrInvalidThread)
	}
	if (c.WakeKey == "") != (c.WakeDeadline == nil) || len(c.WakeKey) > 128 {
		return c, false, fmt.Errorf("%w: invalid wake registration", domain.ErrInvalidThread)
	}
	tx, err := s.pg.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return c, false, err
	}
	defer tx.Rollback(ctx)
	thread, err := scanThread(tx.QueryRow(ctx, `SELECT `+threadColumns+` FROM threads WHERE realm=$1 AND id=$2 FOR UPDATE`, c.Realm, c.ThreadID))
	if errors.Is(err, pgx.ErrNoRows) {
		return c, false, ErrThreadNotFound
	}
	if err != nil {
		return c, false, err
	}
	if thread.NodeID != c.NodeID || thread.TaskID != c.TaskID || thread.CoordinatorSessionRef != c.CoordinatorSessionRef {
		return c, false, ErrThreadRoundConflict
	}
	old, err := scanCommand(tx.QueryRow(ctx, `SELECT `+commandColumns+` FROM thread_commands WHERE realm=$1 AND id=$2`, c.Realm, c.ID))
	if err == nil {
		var hash string
		err = tx.QueryRow(ctx, `SELECT request_hash FROM thread_commands WHERE realm=$1 AND id=$2`, c.Realm, c.ID).Scan(&hash)
		if err != nil {
			return c, false, err
		}
		if hash != commandDigest(c) {
			return c, false, ErrThreadRoundConflict
		}
		return old, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return c, false, err
	}
	if thread.State != domain.ThreadStateIdle {
		return c, false, ErrThreadRoundConflict
	}
	var prev int
	var state string
	err = tx.QueryRow(ctx, `SELECT attempt,state FROM thread_rounds WHERE realm=$1 AND thread_id=$2 ORDER BY attempt DESC LIMIT 1`, c.Realm, c.ThreadID).Scan(&prev, &state)
	if err == nil && (state != "completed" || c.Attempt != prev+1) {
		return c, false, ErrThreadRoundConflict
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return c, false, err
	}
	c.State = "pending"
	if c.WakeKey != "" {
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '24 hours'`, c.WakeDeadline).Scan(&valid); err != nil {
			return c, false, err
		}
		if !valid {
			return c, false, ErrThreadRoundConflict
		}
		c.State = "waiting"
	}
	_, err = tx.Exec(ctx, `INSERT INTO thread_commands(realm,id,thread_id,owner_user_id,node_id,coordinator_session_ref,task_id,attempt,prompt,request_hash,state,wake_key,wake_deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, c.Realm, c.ID, c.ThreadID, c.OwnerUserID, c.NodeID, c.CoordinatorSessionRef, c.TaskID, c.Attempt, c.Prompt, commandDigest(c), c.State, c.WakeKey, c.WakeDeadline)
	if threadUniqueViolation(err) != "" {
		return c, false, ErrThreadRoundConflict
	}
	if err != nil {
		return c, false, err
	}
	if c.State == "waiting" {
		_, err = tx.Exec(ctx, `UPDATE threads SET state='awaiting',updated_at=now() WHERE realm=$1 AND id=$2`, c.Realm, c.ThreadID)
		if err != nil {
			return c, false, err
		}
	}
	return c, true, tx.Commit(ctx)
}
func (s *Store) GetThreadCommand(ctx context.Context, realm, id, owner string) (ThreadCommand, error) {
	c, err := scanCommand(s.pg.QueryRow(ctx, `SELECT `+commandColumns+` FROM thread_commands WHERE realm=$1 AND id=$2 AND owner_user_id=$3`, realm, id, owner))
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrThreadRoundNotFound
	}
	if err == nil && c.State == "waiting" {
		if err := s.ExpireThreadCommands(ctx, realm, c.NodeID, owner); err != nil {
			return c, err
		}
		c, err = scanCommand(s.pg.QueryRow(ctx, `SELECT `+commandColumns+` FROM thread_commands WHERE realm=$1 AND id=$2 AND owner_user_id=$3`, realm, id, owner))
	}
	return c, err
}

func (s *Store) WakeThreadCommand(ctx context.Context, realm, id, owner, key, event string) (ThreadCommand, error) {
	if strings.TrimSpace(event) == "" || len(event) > 128 {
		return ThreadCommand{}, domain.ErrInvalidThread
	}
	tx, err := s.pg.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ThreadCommand{}, err
	}
	defer tx.Rollback(ctx)
	// Consistent lock ordering: Thread, then its mailbox command.
	var threadID string
	err = tx.QueryRow(ctx, `SELECT thread_id FROM thread_commands WHERE realm=$1 AND id=$2 AND owner_user_id=$3`, realm, id, owner).Scan(&threadID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ThreadCommand{}, ErrThreadRoundNotFound
	}
	if err != nil {
		return ThreadCommand{}, err
	}
	thread, err := scanThread(tx.QueryRow(ctx, `SELECT `+threadColumns+` FROM threads WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, threadID))
	if err != nil {
		return ThreadCommand{}, err
	}
	c, err := scanCommand(tx.QueryRow(ctx, `SELECT `+commandColumns+` FROM thread_commands WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, id))
	if err != nil {
		return c, err
	}
	if c.WakeKey != key || key == "" {
		return c, ErrThreadRoundConflict
	}
	if c.EventID != "" {
		if c.EventID != event {
			return c, ErrThreadRoundConflict
		}
		return c, tx.Commit(ctx)
	}
	if c.State != "waiting" || thread.State != domain.ThreadStateAwaiting {
		return c, ErrThreadRoundConflict
	}
	var expired bool
	if err = tx.QueryRow(ctx, `SELECT wake_deadline<=clock_timestamp() FROM thread_commands WHERE realm=$1 AND id=$2`, realm, id).Scan(&expired); err != nil {
		return c, err
	}
	if expired {
		_, err = tx.Exec(ctx, `UPDATE thread_commands SET state='expired',finished_at=now() WHERE realm=$1 AND id=$2`, realm, id)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE threads SET state='idle',updated_at=now() WHERE realm=$1 AND id=$2`, realm, c.ThreadID)
		}
		if err != nil {
			return c, err
		}
		if err = tx.Commit(ctx); err != nil {
			return c, err
		}
		return c, ErrThreadRoundConflict
	}
	c.State = "pending"
	c.EventID = event
	_, err = tx.Exec(ctx, `UPDATE thread_commands SET state='pending',event_id=$3 WHERE realm=$1 AND id=$2`, realm, id, event)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE threads SET state='idle',updated_at=now() WHERE realm=$1 AND id=$2`, realm, c.ThreadID)
	}
	if err != nil {
		return c, err
	}
	return c, tx.Commit(ctx)
}

// Expire only still-waiting commands under the same Thread-first lock order
// as wake. This is bounded and runs even when no sender retries an old event.
func (s *Store) ExpireThreadCommands(ctx context.Context, realm, node, owner string) error {
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT t.id FROM threads t WHERE t.realm=$1 AND t.node_id=$2 AND EXISTS(SELECT 1 FROM thread_commands c WHERE c.realm=t.realm AND c.thread_id=t.id AND c.owner_user_id=$3 AND c.state='waiting' AND c.wake_deadline<=clock_timestamp()) ORDER BY t.id FOR UPDATE OF t SKIP LOCKED LIMIT 32`, realm, node, owner)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, id := range ids {
		tag, err := tx.Exec(ctx, `UPDATE thread_commands SET state='expired',finished_at=now() WHERE realm=$1 AND thread_id=$2 AND state='waiting' AND wake_deadline<=clock_timestamp()`, realm, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			if _, err = tx.Exec(ctx, `UPDATE threads SET state='idle',updated_at=now() WHERE realm=$1 AND id=$2 AND state='awaiting'`, realm, id); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ClaimThreadCommand(ctx context.Context, realm, node, owner string) (*ThreadCommand, error) {
	if err := s.ExpireThreadCommands(ctx, realm, node, owner); err != nil {
		return nil, err
	}
	// A single UPDATE locks and claims once, across all replica processes. No
	// claim lease/reclaim path exists, so a lost response remains uncertain.
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(tokenBytes[:])
	c, err := scanCommand(s.pg.QueryRow(ctx, `UPDATE thread_commands SET state='claimed',claim_hash=$4 WHERE (realm,id)=(SELECT realm,id FROM thread_commands WHERE realm=$1 AND node_id=$2 AND owner_user_id=$3 AND state='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING `+commandColumns, realm, node, owner, commandTokenHash(token)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.ClaimToken = token
	return &c, nil
}
func (s *Store) FinishThreadCommand(ctx context.Context, realm, id, node, owner, token, state, runID, summary string) (ThreadCommand, error) {
	if (state != "completed" && state != "failed") || !threadRoundHash.MatchString(token) || !utf8.ValidString(summary) || strings.ContainsRune(summary, '\x00') || utf8.RuneCountInString(summary) > 16000 {
		return ThreadCommand{}, domain.ErrInvalidThread
	}
	c, err := scanCommand(s.pg.QueryRow(ctx, `UPDATE thread_commands SET state=$6,run_id=$7,summary=$8,finished_at=now() WHERE realm=$1 AND id=$2 AND node_id=$3 AND owner_user_id=$4 AND claim_hash=$5 AND (state='claimed' OR(state=$6 AND run_id=$7 AND summary=$8)) RETURNING `+commandColumns, realm, id, node, owner, commandTokenHash(token), state, runID, summary))
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrThreadRoundConflict
	}
	return c, err
}
