package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const manualDDL = `CREATE TABLE IF NOT EXISTS flow_manual_requests (
 realm TEXT NOT NULL,user_id TEXT NOT NULL,flow_id TEXT NOT NULL,request_key TEXT NOT NULL,
 trigger_id BIGINT NOT NULL UNIQUE REFERENCES flow_trigger_outbox(id) ON DELETE CASCADE,
 PRIMARY KEY(realm,user_id,flow_id,request_key)
);
CREATE TABLE IF NOT EXISTS flow_manual_node_attempts (
 run_id BIGINT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL,attempt INT NOT NULL DEFAULT 1 CHECK(attempt=1),operator TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown')),
 output JSONB,error TEXT,started_at TIMESTAMPTZ NOT NULL DEFAULT now(),finished_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,node_id,attempt)
);`

var ErrManualInputConflict = errors.New("idempotency key already used with different input")

type ManualRun struct {
	ID          int64               `json:"id"`
	TriggerID   uint64              `json:"-"`
	FlowVersion int                 `json:"flowVersion"`
	Status      string              `json:"status"`
	Output      json.RawMessage     `json:"output,omitempty"`
	Error       string              `json:"error,omitempty"`
	Nodes       []ManualNodeAttempt `json:"nodes"`
}

type ManualNodeAttempt struct {
	NodeID     string          `json:"nodeId"`
	Attempt    int             `json:"attempt"`
	Operator   string          `json:"operator"`
	Status     string          `json:"status"`
	Output     json.RawMessage `json:"output,omitempty"`
	Error      string          `json:"error,omitempty"`
	StartedAt  time.Time       `json:"startedAt"`
	FinishedAt *time.Time      `json:"finishedAt,omitempty"`
}

// One statement provides a consistent snapshot of the run and its node receipts.
const manualRunColumns = `r.id,r.trigger_id,r.flow_version,r.status,r.output,COALESCE(r.error,''),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('nodeId',n.node_id,'attempt',n.attempt,'operator',n.operator,
  'status',n.status,'output',n.output,'error',COALESCE(n.error,''),'startedAt',n.started_at,'finishedAt',n.finished_at)
  ORDER BY n.started_at,n.node_id) FROM flow_manual_node_attempts n WHERE n.run_id=r.id),'[]'::jsonb)`

func scanManualRun(row pgx.Row) (ManualRun, error) {
	var run ManualRun
	var nodes []byte
	err := row.Scan(&run.ID, &run.TriggerID, &run.FlowVersion, &run.Status, &run.Output, &run.Error, &nodes)
	if err == nil {
		err = json.Unmarshal(nodes, &run.Nodes)
	}
	return run, err
}

// StartManualRun persists a delivered trigger and a run atomically before effects.
// Manual requests never enter the automation worker or inherit the flow author's grants.
func (s *Store) StartManualRun(ctx context.Context, realm, user, flow, key string, version int, input json.RawMessage) (ManualRun, bool, error) {
	if err := s.expireManualRuns(ctx, flow); err != nil {
		return ManualRun{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManualRun{}, false, err
	}
	defer tx.Rollback(ctx)
	scope, _ := json.Marshal([]string{realm, user, flow, key})
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, string(scope)); err != nil {
		return ManualRun{}, false, err
	}
	run, err := scanManualRun(tx.QueryRow(ctx, `SELECT `+manualRunColumns+` FROM flow_manual_requests m
  JOIN flow_runs r ON r.trigger_id=m.trigger_id WHERE m.realm=$1 AND m.user_id=$2 AND m.flow_id=$3 AND m.request_key=$4`, realm, user, flow, key))
	if err == nil {
		var same bool
		if err := tx.QueryRow(ctx, `SELECT payload=$2::jsonb FROM flow_trigger_outbox WHERE id=$1`, run.TriggerID, input).Scan(&same); err != nil {
			return run, false, err
		}
		if !same {
			return run, false, ErrManualInputConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return run, false, err
		}
		return run, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return run, false, err
	}
	// Lock current authority while recording the attempt; published versions remain immutable.
	var live bool
	err = tx.QueryRow(ctx, `SELECT true FROM flows f JOIN projects p ON p.id=f.project_id AND p.realm=f.realm
  JOIN project_members m ON m.project_id=p.id AND m.user_id=$2 AND m.role IN ('owner','editor')
  JOIN flow_versions v ON v.flow_id=f.id AND v.version=$4
  WHERE f.realm=$1 AND f.id=$3 AND f.status IN ('published','targeted') AND p.status='active'
  FOR SHARE OF f,p,m`, realm, user, flow, version).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) {
		return run, false, ErrManagementForbidden
	}
	if err != nil {
		return run, false, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO flow_trigger_outbox(realm,event_name,payload,delivered_at,bindings_prepared)
  VALUES($1,'lumo.manual',$2,(EXTRACT(EPOCH FROM now())*1000)::bigint,true) RETURNING id`, realm, input).Scan(&run.TriggerID)
	if err != nil {
		return run, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO flow_manual_requests(realm,user_id,flow_id,request_key,trigger_id) VALUES($1,$2,$3,$4,$5)`, realm, user, flow, key, run.TriggerID); err != nil {
		return run, false, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO flow_runs(trigger_id,automation_id,flow_id,flow_version,status,claimed_at,output)
  VALUES($1,'manual',$2,$3,'running',(EXTRACT(EPOCH FROM now())*1000)::bigint,'{"outputs":{},"order":[]}') RETURNING id,flow_version,status`, run.TriggerID, flow, version).Scan(&run.ID, &run.FlowVersion, &run.Status)
	if err != nil {
		return run, false, err
	}
	return run, true, tx.Commit(ctx)
}

// A crashed manual process is never automatically retried: effects may already exist.
func (s *Store) expireManualRuns(ctx context.Context, flow string) error {
	_, err := s.pool.Exec(ctx, `WITH expired AS (UPDATE flow_runs r SET status='failed',finished_at=now(),
  error='manual execution interrupted; outcome may be unknown; inspect effects before retry'
  FROM flow_manual_requests m WHERE m.trigger_id=r.trigger_id AND r.flow_id=$1 AND r.status='running'
  AND r.claimed_at<=(EXTRACT(EPOCH FROM now())*1000)::bigint-$2 RETURNING r.id)
  UPDATE flow_manual_node_attempts SET status='unknown',finished_at=now(),
  error='execution interrupted before a durable node receipt; inspect effects before retry'
  WHERE run_id IN (SELECT id FROM expired) AND status='running'`, flow, RunExpiry.Milliseconds())
	return err
}

func (s *Store) ManualRunResult(ctx context.Context, realm, user, flow string, id int64) (ManualRun, error) {
	if err := s.expireManualRuns(ctx, flow); err != nil {
		return ManualRun{}, err
	}
	run, err := scanManualRun(s.pool.QueryRow(ctx, `SELECT `+manualRunColumns+` FROM flow_runs r JOIN flow_manual_requests m ON m.trigger_id=r.trigger_id
  WHERE m.realm=$1 AND m.user_id=$2 AND m.flow_id=$3 AND r.id=$4`, realm, user, flow, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return run, ErrNotFound
	}
	if err != nil {
		return run, fmt.Errorf("read manual run: %w", err)
	}
	return run, nil
}
