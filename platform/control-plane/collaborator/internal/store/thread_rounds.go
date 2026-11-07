package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

var (
	ErrThreadRoundNotFound = errors.New("thread round not found")
	ErrThreadRoundConflict = errors.New("thread round conflicts with its durable execution")
	threadRoundHash        = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ThreadRoundIdentity is frozen when the first round is admitted. A stable
// session must never be resumed under another owner's identity or model route.
type ThreadRoundIdentity struct {
	OwnerUserID    string `json:"owner_user_id"`
	AgentID        string `json:"agent_id"`
	PresetRevision int    `json:"preset_revision"`
	MaxConcurrency int    `json:"max_concurrency"`
	Provider       string `json:"provider"`
	Model          string `json:"model"`
}

// ThreadRoundReceipt is safe to expose through a read or replay response.
// Token is returned only to the caller whose admission committed; it must be
// added explicitly to that response, never serialized by a generic JSON writer.
type ThreadRoundReceipt struct {
	ThreadRoundIdentity
	Realm                 string     `json:"realm"`
	ThreadID              string     `json:"thread_id"`
	NodeID                string     `json:"node_id"`
	CoordinatorSessionRef string     `json:"coordinator_session_ref"`
	TaskID                string     `json:"task_id"`
	Attempt               int        `json:"attempt"`
	RequestHash           string     `json:"request_hash"`
	RunID                 string     `json:"run_id"`
	SessionMode           string     `json:"session_mode"`
	State                 string     `json:"state"`
	Summary               string     `json:"summary"`
	CreatedAt             time.Time  `json:"created_at"`
	FinishedAt            *time.Time `json:"finished_at,omitempty"`
	Token                 string     `json:"-"`
}

const threadRoundColumns = `realm, thread_id, node_id, coordinator_session_ref, task_id,
	attempt, request_hash, run_id, owner_user_id, agent_id, preset_revision, max_concurrency, provider, model,
	session_mode, state, summary, created_at, finished_at`

func scanThreadRound(row pgx.Row) (ThreadRoundReceipt, error) {
	var r ThreadRoundReceipt
	err := row.Scan(&r.Realm, &r.ThreadID, &r.NodeID, &r.CoordinatorSessionRef, &r.TaskID,
		&r.Attempt, &r.RequestHash, &r.RunID, &r.OwnerUserID, &r.AgentID, &r.PresetRevision, &r.MaxConcurrency,
		&r.Provider, &r.Model, &r.SessionMode, &r.State, &r.Summary, &r.CreatedAt, &r.FinishedAt)
	return r, err
}

func validateThreadRoundIdentity(identity ThreadRoundIdentity) error {
	for field, value := range map[string]string{"owner_user_id": identity.OwnerUserID, "agent_id": identity.AgentID} {
		if err := validateRoundRef(field, value); err != nil {
			return err
		}
	}
	if identity.PresetRevision < 1 || identity.PresetRevision > 2147483647 ||
		identity.MaxConcurrency < 1 || identity.MaxConcurrency > 2147483647 ||
		strings.TrimSpace(identity.Provider) == "" || len(identity.Provider) > 200 || !validRoundText(identity.Provider) ||
		strings.TrimSpace(identity.Model) == "" || len(identity.Model) > 200 || !validRoundText(identity.Model) {
		return fmt.Errorf("%w: invalid thread round execution identity", domain.ErrInvalidThread)
	}
	return nil
}

func validRoundText(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, '\x00')
}

func validateRoundRef(field, value string) error {
	if !validRoundText(value) {
		return fmt.Errorf("%w: %s is not valid PostgreSQL text", domain.ErrInvalidThread, field)
	}
	return domain.ValidateThreadRef(field, value)
}

// AdmitThreadRound commits an exclusive execution before the host starts it.
// A replay never grants execution authority, even when a process lost its
// response. Running rounds deliberately have no expiry or automatic takeover:
// an uncertain previous execution must not produce another model turn.
func (s *Store) AdmitThreadRound(ctx context.Context, realm, threadID, nodeID, coordinatorSessionRef, taskID string,
	attempt int, requestHash, runID string, identity ThreadRoundIdentity) (ThreadRoundReceipt, bool, error) {
	if err := domain.ValidateThreadID(threadID); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	for field, value := range map[string]string{"node_id": nodeID, "coordinator_session_ref": coordinatorSessionRef, "task_id": taskID, "run_id": runID} {
		if err := validateRoundRef(field, value); err != nil {
			return ThreadRoundReceipt{}, false, err
		}
	}
	requestHash = strings.ToLower(requestHash)
	if strings.TrimSpace(realm) == "" || !validRoundText(realm) || attempt < 1 || attempt > 2147483647 || !threadRoundHash.MatchString(requestHash) {
		return ThreadRoundReceipt{}, false, fmt.Errorf("%w: invalid thread round attempt or request hash", domain.ErrInvalidThread)
	}
	if err := validateThreadRoundIdentity(identity); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	// Slot counting must take a fresh statement snapshot after waiting for the
	// Agent lock, even when a deployment changed its session isolation default.
	tx, err := s.pg.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	thread, err := scanThread(tx.QueryRow(ctx, `SELECT `+threadColumns+` FROM threads WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, threadID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ThreadRoundReceipt{}, false, ErrThreadNotFound
	}
	if err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	if thread.NodeID != nodeID || thread.CoordinatorSessionRef != coordinatorSessionRef || thread.TaskID != taskID {
		return ThreadRoundReceipt{}, false, fmt.Errorf("%w: thread ownership does not match", ErrThreadRoundConflict)
	}
	existing, err := scanThreadRound(tx.QueryRow(ctx, `SELECT `+threadRoundColumns+` FROM thread_rounds WHERE realm=$1 AND thread_id=$2 AND attempt=$3`, realm, threadID, attempt))
	if err == nil {
		if existing.NodeID != nodeID || existing.CoordinatorSessionRef != coordinatorSessionRef || existing.TaskID != taskID ||
			existing.RunID != runID || existing.RequestHash != requestHash || existing.ThreadRoundIdentity != identity {
			return ThreadRoundReceipt{}, false, ErrThreadRoundConflict
		}
		return existing, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ThreadRoundReceipt{}, false, err
	}
	if thread.State != domain.ThreadStateIdle {
		return ThreadRoundReceipt{}, false, fmt.Errorf("%w: a new round requires an idle thread", ErrThreadRoundConflict)
	}
	sessionMode := "create"
	previous, err := scanThreadRound(tx.QueryRow(ctx, `SELECT `+threadRoundColumns+` FROM thread_rounds WHERE realm=$1 AND thread_id=$2 ORDER BY attempt DESC LIMIT 1`, realm, threadID))
	if err == nil {
		if previous.State != "completed" || attempt != previous.Attempt+1 || previous.ThreadRoundIdentity != identity {
			return ThreadRoundReceipt{}, false, fmt.Errorf("%w: continuation requires the next attempt and the same execution identity", ErrThreadRoundConflict)
		}
		sessionMode = "resume"
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ThreadRoundReceipt{}, false, err
	}
	// Lock one Agent after locking this Thread. No path takes another Thread
	// lock while holding this advisory lock. Across service replicas, the count
	// and insert therefore consume one shared preset slot atomically. A replay
	// has already returned above and never needs or consumes another slot.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(
		jsonb_build_array('collaborator.thread-round-agent',$1::text,$2::text)::text,0))`, realm, identity.AgentID); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	var active int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM thread_rounds WHERE realm=$1 AND agent_id=$2 AND state='running'`, realm, identity.AgentID).Scan(&active); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	if active >= identity.MaxConcurrency {
		return ThreadRoundReceipt{}, false, fmt.Errorf("%w: Agent Thread concurrency limit reached", ErrThreadRoundConflict)
	}
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	token := hex.EncodeToString(tokenBytes[:])
	tokenHash := sha256.Sum256([]byte(token))
	receipt, err := scanThreadRound(tx.QueryRow(ctx, `INSERT INTO thread_rounds
		(realm,thread_id,node_id,coordinator_session_ref,task_id,attempt,request_hash,run_id,
		 owner_user_id,agent_id,preset_revision,max_concurrency,provider,model,session_mode,token_hash,state)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'running') RETURNING `+threadRoundColumns,
		realm, threadID, nodeID, coordinatorSessionRef, taskID, attempt, requestHash, runID,
		identity.OwnerUserID, identity.AgentID, identity.PresetRevision, identity.MaxConcurrency, identity.Provider, identity.Model, sessionMode, hex.EncodeToString(tokenHash[:])))
	if threadUniqueViolation(err) != "" {
		return ThreadRoundReceipt{}, false, ErrThreadRoundConflict
	}
	if err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE threads SET state='running',updated_at=now() WHERE realm=$1 AND id=$2`, realm, threadID); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ThreadRoundReceipt{}, false, err
	}
	receipt.Token = token
	return receipt, true, nil
}

func (s *Store) GetThreadRound(ctx context.Context, realm, threadID, runID string) (ThreadRoundReceipt, error) {
	receipt, err := scanThreadRound(s.pg.QueryRow(ctx, `SELECT `+threadRoundColumns+` FROM thread_rounds WHERE realm=$1 AND thread_id=$2 AND run_id=$3`, realm, threadID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ThreadRoundReceipt{}, ErrThreadRoundNotFound
	}
	return receipt, err
}

// FinishThreadRound accepts only the original execution capability and an
// immutable terminal outcome. The thread lock also fences node-loss handling,
// so a late success can never resurrect a failed thread.
func (s *Store) FinishThreadRound(ctx context.Context, realm, threadID, runID, token, state, summary string) (ThreadRoundReceipt, error) {
	if (state != "completed" && state != "failed" && state != "cancelled") ||
		!validRoundText(summary) || utf8.RuneCountInString(summary) > 16000 || !threadRoundHash.MatchString(token) {
		return ThreadRoundReceipt{}, fmt.Errorf("%w: invalid round outcome, summary or token", domain.ErrInvalidThread)
	}
	if err := domain.ValidateThreadID(threadID); err != nil {
		return ThreadRoundReceipt{}, err
	}
	if err := validateRoundRef("run_id", runID); err != nil {
		return ThreadRoundReceipt{}, err
	}
	if strings.TrimSpace(realm) == "" || !validRoundText(realm) {
		return ThreadRoundReceipt{}, fmt.Errorf("%w: invalid realm", domain.ErrInvalidThread)
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return ThreadRoundReceipt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	thread, err := scanThread(tx.QueryRow(ctx, `SELECT `+threadColumns+` FROM threads WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, threadID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ThreadRoundReceipt{}, ErrThreadNotFound
	}
	if err != nil {
		return ThreadRoundReceipt{}, err
	}
	receipt, err := scanThreadRound(tx.QueryRow(ctx, `SELECT `+threadRoundColumns+` FROM thread_rounds WHERE realm=$1 AND thread_id=$2 AND run_id=$3`, realm, threadID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ThreadRoundReceipt{}, ErrThreadRoundNotFound
	}
	if err != nil {
		return ThreadRoundReceipt{}, err
	}
	var storedHash string
	if err := tx.QueryRow(ctx, `SELECT token_hash FROM thread_rounds WHERE realm=$1 AND thread_id=$2 AND run_id=$3`, realm, threadID, runID).Scan(&storedHash); err != nil {
		return ThreadRoundReceipt{}, err
	}
	tokenHash := sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(hex.EncodeToString(tokenHash[:]))) != 1 {
		return ThreadRoundReceipt{}, fmt.Errorf("%w: execution token does not match", ErrThreadRoundConflict)
	}
	if receipt.State != "running" {
		if receipt.State != state || receipt.Summary != summary {
			return ThreadRoundReceipt{}, fmt.Errorf("%w: round outcome is immutable", ErrThreadRoundConflict)
		}
		return receipt, tx.Commit(ctx)
	}
	if state == "completed" && thread.State != domain.ThreadStateRunning {
		return ThreadRoundReceipt{}, fmt.Errorf("%w: success cannot complete a terminated thread", ErrThreadRoundConflict)
	}
	receipt, err = scanThreadRound(tx.QueryRow(ctx, `UPDATE thread_rounds SET state=$4,summary=$5,finished_at=now()
		WHERE realm=$1 AND thread_id=$2 AND run_id=$3 RETURNING `+threadRoundColumns, realm, threadID, runID, state, summary))
	if err != nil {
		return ThreadRoundReceipt{}, err
	}
	if !domain.ThreadStateTerminal(thread.State) {
		next := "failed"
		if state == "completed" {
			next = "idle"
		}
		if _, err := tx.Exec(ctx, `UPDATE threads SET state=$3,updated_at=now() WHERE realm=$1 AND id=$2`, realm, threadID, next); err != nil {
			return ThreadRoundReceipt{}, err
		}
	}
	return receipt, tx.Commit(ctx)
}

func threadHasRunningRound(ctx context.Context, tx pgx.Tx, realm, threadID string) (bool, error) {
	var running bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_rounds WHERE realm=$1 AND thread_id=$2 AND state='running')`, realm, threadID).Scan(&running)
	return running, err
}
