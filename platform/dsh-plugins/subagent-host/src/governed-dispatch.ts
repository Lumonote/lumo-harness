import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { assertExecutionPreset, type ExecutionPreset } from './worker-binding.ts'
import type { RuntimeReportConfig } from './runtime-report.ts'

export interface GovernedTask {
  id: string
  realm: string
  project_id: string
  title: string
  intent: string
  intent_contract?: { objective: string; root_objective: string; constraints: string[]; acceptance_criteria: string[]; depth: number; parent_task_id?: string }
}
export interface GovernedExecution {
  runId: string
  attempt: number
  sessionRef: string
  deadlineMS: number
  cancelled?: boolean
  task: GovernedTask
  preset: ExecutionPreset
}

/** Retrying this write cannot repair an immutable receipt or a lost owner. */
export class ExecutionConflictError extends Error {}
export interface GovernedResult {
  task_id: string
  run_id: string
  session_ref: string
  node_id: string
  state: 'COMPLETED' | 'FAILED' | 'CANCELLED'
  summary: string
  output?: unknown
}

// This consumer deliberately shares the cluster PostgreSQL database with
// Scheduler and Governance. Acceptance, the stable session id and both RUNNING
// projections commit together before Agent creation. A crash after acceptance
// is settled by its replacement with an explicit failure receipt; it must
// never silently execute the same Run twice.
export const GOVERNED_EXECUTION_DDL = `
CREATE TABLE IF NOT EXISTS lumo_governed_executions (
  run_id TEXT PRIMARY KEY, realm TEXT NOT NULL, node_id TEXT NOT NULL,
  worker_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  attempt INTEGER NOT NULL, execution JSONB NOT NULL, result JSONB,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_delivery_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
ALTER TABLE lumo_governed_executions ADD COLUMN IF NOT EXISTS delivery_token TEXT;
CREATE INDEX IF NOT EXISTS lumo_governed_result_pending
  ON lumo_governed_executions(realm,node_id,next_delivery_at) WHERE result IS NOT NULL AND delivered_at IS NULL;`

const nowMS = `(EXTRACT(EPOCH FROM now()) * 1000)::bigint`

export class PgGovernedDispatch {
  constructor(private readonly pool: pg.Pool, readonly config: RuntimeReportConfig, private readonly instanceId: string) {}

  async init(): Promise<void> { await this.pool.query(GOVERNED_EXECUTION_DDL) }

  async take(): Promise<GovernedExecution | undefined> {
    const { realm, nodeId, binding } = this.config
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize admission for this replica even if callers race. The
      // process-local active map is not the authority for its capacity.
      await client.query(`SELECT node_id FROM governance_worker_heartbeats
        WHERE realm=$1 AND worker_id=$2 AND node_id=$3 FOR UPDATE`,
      [realm, `agent:${binding.agentId}`, nodeId])
      const selected = await client.query<{
        run_id: string; attempt: number; deadline_ms: string; cancelled: boolean; task: GovernedTask; preset: ExecutionPreset
      }>(`SELECT r.id AS run_id,s.attempt,s.deadline_ms,row_to_json(t) AS task,row_to_json(p) AS preset,
        (s.state='CANCELLING' OR r.state='CANCELLING' OR t.state='CANCELLING' OR EXISTS (
          SELECT 1 FROM scheduler_control_commands c WHERE c.task_id=s.task_id AND c.attempt=s.attempt
            AND c.node_id=s.node_id AND c.command IN ('CANCEL','PREEMPT'))) AS cancelled
        FROM governance_delegation_tasks t
        JOIN governance_task_runs r ON r.realm=t.realm AND r.task_id=t.id AND r.id=t.scheduler_task_id
        JOIN scheduler_tasks s ON s.task_id=r.id AND s.realm=r.realm AND s.worker_id=r.worker_id AND s.project_id=t.project_id
        JOIN scheduler_dispatch_outbox o ON o.task_id=s.task_id AND o.attempt=s.attempt AND o.node_id=s.node_id
        JOIN governance_agent_presets p ON p.realm=r.realm AND 'agent:'||p.id=r.worker_id
        JOIN governance_users u ON u.realm=p.realm AND u.id=p.owner_user_id
        JOIN governance_worker_heartbeats h ON h.realm=r.realm AND h.worker_id=r.worker_id AND h.node_id=s.node_id
        WHERE r.realm=$1 AND s.node_id=$2 AND r.worker_id=$3 AND t.project_id=$4
          AND t.state IN ('QUEUED','ASSIGNED','CANCELLING') AND r.state IN ('QUEUED','ASSIGNED','CANCELLING')
          AND s.state IN ('PLACED','CANCELLING')
          AND r.scheduler_task_id=r.id AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=r.realm AND task_id=t.id)
          AND (r.assigned_node_id='' OR r.assigned_node_id=s.node_id) AND r.session_ref=''
          AND t.business_state='ASSIGNED' AND o.delivered_at IS NULL AND o.claimed_by IS NULL
          AND p.status='active' AND u.status='active' AND p.owner_user_id=$5 AND p.revision=$6
          AND (p.project_id='' OR p.project_id=t.project_id)
          AND h.status='active' AND h.preset_revision=p.revision AND h.instance_id=$7
          AND h.updated_at >= now()-interval '30 seconds'
          AND (SELECT count(*) FROM lumo_governed_executions e WHERE e.realm=r.realm
            AND e.worker_id=r.worker_id AND e.node_id=s.node_id AND e.result IS NULL)
            < LEAST($8,h.max_concurrency,p.max_concurrency)
          AND NOT EXISTS (SELECT 1 FROM lumo_governed_executions e WHERE e.run_id=r.id)
        ORDER BY o.id LIMIT 1 FOR UPDATE OF t,r,s,o SKIP LOCKED FOR SHARE OF p,u,h`,
      [realm, nodeId, `agent:${binding.agentId}`, binding.projectId, binding.userId, binding.presetRevision, this.instanceId, this.config.capacity])
      const row = selected.rows[0]
      if (!row) { await client.query('COMMIT'); return }
      assertExecutionPreset(binding, realm, row.preset)
      // Task-level validation happens after durable admission, before Agent
      // creation. A bad task gets a failure receipt instead of blocking FIFO.
      const execution: GovernedExecution = { runId: row.run_id, attempt: row.attempt,
        deadlineMS: Number(row.deadline_ms), cancelled: row.cancelled, task: row.task, preset: row.preset,
        sessionRef: `gov-${createHash('sha256').update(JSON.stringify([realm, row.run_id])).digest('hex')}` }
      const inserted = await client.query(`INSERT INTO lumo_governed_executions
        (run_id,realm,node_id,worker_id,project_id,instance_id,attempt,execution)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id) DO NOTHING RETURNING run_id`,
      [row.run_id, realm, nodeId, `agent:${binding.agentId}`, binding.projectId, this.instanceId, row.attempt, JSON.stringify(execution)])
      if (!inserted.rowCount) { await client.query('ROLLBACK'); return }
      const state = row.cancelled ? 'CANCELLING' : 'RUNNING'
      await client.query(`UPDATE governance_task_runs SET state=$5,assigned_node_id=$3,session_ref=$4,
        started_at=CASE WHEN $5='RUNNING' THEN COALESCE(started_at,now()) ELSE started_at END
        WHERE realm=$1 AND id=$2`, [realm, row.run_id, nodeId, execution.sessionRef, state])
      await client.query(`UPDATE governance_delegation_tasks SET state=$4,
        business_state=CASE WHEN $4='RUNNING' THEN 'EXECUTING' ELSE business_state END,assigned_node_id=$3,updated_at=now()
        WHERE realm=$1 AND id=$2`, [realm, row.task.id, nodeId, state])
      await client.query(`UPDATE scheduler_tasks SET state=$2,updated_at=${nowMS} WHERE task_id=$1`, [row.run_id, state])
      await client.query(`UPDATE scheduler_task_attempts SET state=$3,updated_at=${nowMS} WHERE task_id=$1 AND attempt=$2`, [row.run_id, row.attempt, state])
      await client.query(`UPDATE scheduler_dispatch_outbox SET delivered_at=${nowMS},claimed_by=NULL WHERE task_id=$1 AND attempt=$2`, [row.run_id, row.attempt])
      await client.query('COMMIT')
      return execution
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async shouldStop(execution: GovernedExecution): Promise<boolean> {
    const rows = await this.pool.query(`SELECT s.task_id FROM scheduler_tasks s
      JOIN lumo_governed_executions e ON e.realm=s.realm AND e.run_id=s.task_id AND e.attempt=s.attempt
      JOIN governance_worker_heartbeats h ON h.realm=e.realm AND h.worker_id=e.worker_id AND h.node_id=e.node_id
      JOIN governance_agent_presets p ON p.realm=e.realm AND 'agent:'||p.id=e.worker_id
      JOIN governance_users u ON u.realm=p.realm AND u.id=p.owner_user_id
      JOIN governance_task_runs r ON r.realm=e.realm AND r.id=e.run_id
      JOIN governance_delegation_tasks t ON t.realm=r.realm AND t.id=r.task_id
      WHERE s.task_id=$1 AND s.realm=$2 AND s.node_id=$3 AND s.attempt=$4 AND s.state='RUNNING'
        AND r.state='RUNNING' AND t.state='RUNNING' AND t.scheduler_task_id=r.id
        AND e.instance_id=$5 AND e.result IS NULL AND h.instance_id=e.instance_id
        AND h.status IN ('active','draining') AND h.updated_at>=now()-interval '30 seconds'
        AND p.status='active' AND u.status='active' AND p.revision=h.preset_revision
        AND p.revision=$6 AND p.owner_user_id=$7 AND (p.project_id='' OR p.project_id=e.project_id)
        AND NOT EXISTS (SELECT 1 FROM scheduler_control_commands c WHERE c.task_id=s.task_id
          AND c.attempt=s.attempt AND c.node_id=s.node_id AND c.command IN ('CANCEL','PREEMPT'))`,
    [execution.runId, this.config.realm, this.config.nodeId, execution.attempt, this.instanceId,
      this.config.binding.presetRevision, this.config.binding.userId])
    return rows.rows.length === 0
  }

  /** Only the currently admitted replacement of this exact Worker/node can
   * settle its predecessor. An expired heartbeat alone never proves that an
   * arbitrary replica may take over. Saved results remain untouched. */
  async recover(): Promise<number> {
    const { realm, nodeId, binding } = this.config
    const recovered = await this.pool.query(`WITH lost AS (
      SELECT e.run_id,s.state FROM lumo_governed_executions e
      JOIN governance_worker_heartbeats h ON h.realm=e.realm AND h.worker_id=e.worker_id AND h.node_id=e.node_id
      JOIN scheduler_tasks s ON s.task_id=e.run_id AND s.realm=e.realm AND s.node_id=e.node_id AND s.attempt=e.attempt
      WHERE e.realm=$1 AND e.node_id=$2 AND e.worker_id=$3 AND e.project_id=$4
        AND e.instance_id<>$5 AND h.instance_id=$5 AND h.status='active'
        AND h.updated_at>=now()-interval '30 seconds' AND e.result IS NULL
        AND s.state IN ('RUNNING','CANCELLING')
      ORDER BY e.accepted_at LIMIT 16 FOR UPDATE OF e SKIP LOCKED FOR SHARE OF h
    ) UPDATE lumo_governed_executions e SET result=jsonb_build_object(
      'task_id',e.execution->'task'->>'id','run_id',e.run_id,
      'session_ref',e.execution->>'sessionRef','node_id',e.node_id,
      'state',CASE WHEN lost.state='CANCELLING' THEN 'CANCELLED' ELSE 'FAILED' END,
      'summary','Runtime restarted before its result was persisted. Execution outcome is uncertain; review the session log before retrying.'),
      next_delivery_at=now(),last_error='runtime_restarted'
      FROM lost WHERE e.run_id=lost.run_id AND e.result IS NULL RETURNING e.run_id`,
    [realm, nodeId, `agent:${binding.agentId}`, binding.projectId, this.instanceId])
    return recovered.rowCount ?? 0
  }

  async save(execution: GovernedExecution, result: GovernedResult): Promise<void> {
    if (result.run_id !== execution.runId || result.task_id !== execution.task.id ||
        result.session_ref !== execution.sessionRef || result.node_id !== this.config.nodeId) throw new ExecutionConflictError('execution result identity mismatch')
    const saved = await this.pool.query(`UPDATE lumo_governed_executions SET result=$4::jsonb
      WHERE realm=$1 AND run_id=$2 AND instance_id=$3 AND (result IS NULL OR result=$4::jsonb) RETURNING run_id`,
    [this.config.realm, execution.runId, this.instanceId, JSON.stringify(result)])
    if (!saved.rowCount) throw new ExecutionConflictError('execution result is immutable or belongs to another runtime instance')
  }

  async deliver(): Promise<void> {
    // Identical replays are accepted by Governance and Scheduler. No execution
    // identity refresh is needed to deliver already persisted receipts.
    const token = randomUUID()
    // Bound each delivery tick and fence acknowledgments after a claim expires.
    const rows = await this.pool.query<{ result: GovernedResult; attempt: number }>(`WITH picked AS (
      SELECT run_id FROM lumo_governed_executions
      WHERE realm=$1 AND node_id=$2 AND result IS NOT NULL AND delivered_at IS NULL AND next_delivery_at<=now()
      ORDER BY next_delivery_at,accepted_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE lumo_governed_executions e SET delivery_token=$3,next_delivery_at=now()+interval '15 seconds',
      delivery_attempts=delivery_attempts+1 FROM picked WHERE e.run_id=picked.run_id RETURNING e.result,e.attempt`,
    [this.config.realm, this.config.nodeId, token])
    for (const row of rows.rows) {
      const result = row.result
      try {
        const response = await fetch(`${this.config.governanceUrl.replace(/\/+$/, '')}/v1/runtime/task-runs/${encodeURIComponent(result.run_id)}/result`, {
          method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5_000),
          headers: { authorization: `Bearer ${this.config.token}`, 'x-lumo-realm': this.config.realm, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        })
        await response.body?.cancel()
        if (!response.ok) throw new Error(`governed result delivery: HTTP ${response.status}`)
        // Governance committed the receipt and parent notification. Finish the
        // scheduler attempt and release its slot in a fenced transaction.
        await this.settle(result, row.attempt, token)
      } catch (error) {
        await this.pool.query(`UPDATE lumo_governed_executions SET last_error=$3,delivery_token=NULL,
          next_delivery_at=now()+LEAST(300,POWER(2,LEAST(delivery_attempts,9))) * interval '1 second'
          WHERE realm=$1 AND run_id=$2 AND delivered_at IS NULL AND delivery_token=$4`,
        [this.config.realm, result.run_id, error instanceof Error ? error.message : 'result delivery failed', token])
      }
    }
  }

  private async settle(result: GovernedResult, attempt: number, token: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const state = result.state === 'CANCELLED' ? 'ABORTED' : result.state
      const claim = await client.query(`SELECT run_id FROM lumo_governed_executions
        WHERE realm=$1 AND run_id=$2 AND delivered_at IS NULL AND delivery_token=$3 FOR UPDATE`,
      [this.config.realm, result.run_id, token])
      if (!claim.rowCount) { await client.query('COMMIT'); return }
      const current = await client.query<{ state: string }>(`SELECT state FROM scheduler_tasks
        WHERE task_id=$1 AND realm=$2 AND node_id=$3 AND attempt=$4 FOR UPDATE`,
      [result.run_id, this.config.realm, this.config.nodeId, attempt])
      const prior = current.rows[0]?.state
      if (!prior || (!['RUNNING', 'CANCELLING'].includes(prior) && prior !== state)) throw new Error('scheduler attempt changed before result settlement')
      await client.query(`UPDATE scheduler_tasks SET state=$2,updated_at=${nowMS} WHERE task_id=$1`, [result.run_id, state])
      await client.query(`UPDATE scheduler_task_attempts SET state=$3,updated_at=${nowMS} WHERE task_id=$1 AND attempt=$2`, [result.run_id, attempt, state])
      await client.query(`UPDATE lumo_governed_executions SET delivered_at=now(),last_error='',delivery_token=NULL WHERE realm=$1 AND run_id=$2`, [this.config.realm, result.run_id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
