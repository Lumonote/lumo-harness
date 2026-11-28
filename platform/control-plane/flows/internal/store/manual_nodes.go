package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// All receipts and finalization take the same parent lock. Expiry can never
// race a late receipt into reviving a finished run or changing unknown to success.
func lockManualRun(ctx context.Context, tx pgx.Tx, id int64) error {
	var found int64
	err := tx.QueryRow(ctx, `SELECT r.id FROM flow_runs r
  WHERE r.id=$1 AND r.status='running' AND r.automation_id='manual'
  AND r.claimed_at>(EXTRACT(EPOCH FROM now())*1000)::bigint-$2
  AND EXISTS(SELECT 1 FROM flow_manual_requests m WHERE m.trigger_id=r.trigger_id)
  FOR UPDATE OF r`, id, RunExpiry.Milliseconds()).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRunFinalized
	}
	return err
}

func (s *Store) StartManualNode(ctx context.Context, runID int64, nodeID, operator string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockManualRun(ctx, tx, runID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO flow_manual_node_attempts(run_id,node_id,operator,status)
  VALUES($1,$2,$3,'running')`, runID, nodeID, operator); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// A successful node and its partial run output commit atomically. Failed or
// uncertain nodes retain their own receipt without pretending their output is
// suitable input for a dependant.
func (s *Store) FinishManualNode(ctx context.Context, runID int64, nodeID, status string, output json.RawMessage, nodeErr error) error {
	if status != "succeeded" && status != "failed" && status != "unknown" {
		return fmt.Errorf("invalid manual node status %q", status)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockManualRun(ctx, tx, runID); err != nil {
		return err
	}
	var errText *string
	if nodeErr != nil {
		value := nodeErr.Error()
		errText = &value
	}
	tag, err := tx.Exec(ctx, `UPDATE flow_manual_node_attempts SET status=$3,output=$4,error=$5,finished_at=now()
  WHERE run_id=$1 AND node_id=$2 AND attempt=1 AND status='running'`, runID, nodeID, status, output, errText)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrRunFinalized
	}
	if status == "succeeded" {
		if _, err := tx.Exec(ctx, `UPDATE flow_runs SET output=jsonb_build_object(
   'outputs',COALESCE(output->'outputs','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),
   'order',COALESCE(output->'order','[]'::jsonb)||jsonb_build_array($2::text)) WHERE id=$1`, runID, nodeID, output); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Never replace the incremental output with an in-memory aggregate: a crash or
// a failed receipt can leave only the previously committed nodes trustworthy.
func (s *Store) FinishManualRun(ctx context.Context, id int64, runErr error) (ManualRun, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManualRun{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockManualRun(ctx, tx, id); err != nil {
		return ManualRun{}, err
	}
	status := "succeeded"
	var errText *string
	if runErr != nil {
		status = "failed"
		value := runErr.Error()
		errText = &value
	}
	tag, err := tx.Exec(ctx, `UPDATE flow_manual_node_attempts SET status='unknown',finished_at=now(),
  error='node outcome could not be durably confirmed; inspect effects before retry'
  WHERE run_id=$1 AND status='running'`, id)
	if err != nil {
		return ManualRun{}, err
	}
	if tag.RowsAffected() > 0 && runErr == nil {
		status = "failed"
		value := "node outcome could not be durably confirmed; inspect effects before retry"
		errText = &value
	}
	if _, err := tx.Exec(ctx, `UPDATE flow_runs SET status=$2,error=$3,finished_at=now() WHERE id=$1`, id, status, errText); err != nil {
		return ManualRun{}, err
	}
	run, err := scanManualRun(tx.QueryRow(ctx, `SELECT `+manualRunColumns+` FROM flow_runs r WHERE r.id=$1`, id))
	if err != nil {
		return ManualRun{}, err
	}
	return run, tx.Commit(ctx)
}
