package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

const delegationReceiptsDDL = `CREATE TABLE IF NOT EXISTS governance_delegation_receipts (
 realm TEXT NOT NULL,
 requester_user_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id),
 run_id TEXT NOT NULL REFERENCES governance_task_runs(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(realm,requester_user_id,request_key)
);`

// DelegationReceipt describes the original caller request, before matching or
// intent enrichment. Its scope is always the authenticated requester and realm.
type DelegationReceipt struct{ Key, Hash string }

var receiptKey = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,200}$`)
var receiptHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (r DelegationReceipt) Validate() error {
	if !receiptKey.MatchString(r.Key) || !receiptHash.MatchString(r.Hash) {
		return fmt.Errorf("%w: invalid delegation idempotency key or digest", ErrBadRequest)
	}
	return nil
}

type receiptQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func lookupDelegationReceipt(ctx context.Context, q receiptQuerier, realm, user string, receipt DelegationReceipt) (domain.DelegatedTask, domain.TaskRun, error) {
	var task domain.DelegatedTask
	var run domain.TaskRun
	if err := receipt.Validate(); err != nil {
		return task, run, err
	}
	var hash, taskID, runID string
	err := q.QueryRow(ctx, `SELECT request_hash,task_id,run_id FROM governance_delegation_receipts
 WHERE realm=$1 AND requester_user_id=$2 AND request_key=$3`, realm, user, receipt.Key).Scan(&hash, &taskID, &runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return task, run, ErrNotFound
	}
	if err != nil {
		return task, run, err
	}
	if hash != receipt.Hash {
		return task, run, fmt.Errorf("%w: idempotency key reused with a different request", ErrConflict)
	}
	if err := scanDelegatedTask(q.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 AND t.requester_user_id=$3`, realm, taskID, user), &task); err != nil {
		return task, run, err
	}
	err = scanTaskRun(q.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND id=$2 AND task_id=$3`, realm, runID, taskID), &run)
	return task, run, err
}

func (s *Store) LookupDelegationReceipt(ctx context.Context, realm, user string, receipt DelegationReceipt) (domain.DelegatedTask, domain.TaskRun, error) {
	return lookupDelegationReceipt(ctx, s.pool, realm, user, receipt)
}

func lockDelegationReceipt(ctx context.Context, tx pgx.Tx, realm, user string, receipt DelegationReceipt) error {
	if err := receipt.Validate(); err != nil {
		return err
	}
	key, _ := json.Marshal([]string{"delegation-receipt", realm, user, receipt.Key})
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, string(key))
	return err
}
