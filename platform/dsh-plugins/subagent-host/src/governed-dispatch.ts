import { createHash } from 'node:crypto'
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
  task: GovernedTask
  preset: ExecutionPreset
}
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
// needs explicit recovery; it must never silently execute the same Run twice.
export const GOVERNED_EXECUTION_DDL = `
CREATE TABLE IF NOT EXISTS lumo_governed_executions (
  run_id TEXT PRIMARY KEY, realm TEXT NOT NULL, node_id TEXT NOT NULL,
  worker_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  attempt INTEGER NOT NULL, execution JSONB NOT NULL, result JSONB,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_delivery_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
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
      const selected = await client.query<{
        run_id: string; attempt: number; deadline_ms: string; task: GovernedTask; preset: ExecutionPreset
      }>(`SELECT r.id AS run_id,s.attempt,s.deadline_ms,row_to_json(t) AS task,row_to_json(p) AS preset
        FROM governance_delegation_tasks t
        JOIN governance_task_runs r ON r.realm=t.realm AND r.task_id=t.id AND r.id=t.scheduler_task_id
        JOIN scheduler_tasks s ON s.task_id=r.id AND s.realm=r.realm AND s.worker_id=r.worker_id AND s.project_id=t.project_id
        JOIN scheduler_dispatch_outbox o ON o.task_id=s.task_id AND o.attempt=s.attempt AND o.node_id=s.node_id
        JOIN governance_agent_presets p ON p.realm=r.realm AND 'agent:'||p.id=r.worker_id
        JOIN governance_users u ON u.realm=p.realm AND u.id=p.owner_user_id
        JOIN governance_worker_heartbeats h ON h.realm=r.realm AND h.worker_id=r.worker_id AND h.node_id=s.node_id
        WHERE r.realm=$1 AND s.node_id=$2 AND r.worker_id=$3 AND t.project_id=$4
          AND t.state IN ('QUEUED','ASSIGNED') AND r.state IN ('QUEUED','ASSIGNED') AND s.state='PLACED'
          AND r.scheduler_task_id=r.id AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=r.realm AND task_id=t.id)
          AND (r.assigned_node_id='' OR r.assigned_node_id=s.node_id) AND r.session_ref=''
          AND t.business_state='ASSIGNED' AND o.delivered_at IS NULL AND o.claimed_by IS NULL
          AND p.status='active' AND u.status='active' AND p.owner_user_id=$5 AND p.revision=$6
          AND (p.project_id='' OR p.project_id=t.project_id)
          AND h.status='active' AND h.preset_revision=p.revision AND h.instance_id=$7
          AND h.updated_at >= now()-interval '30 seconds'
          AND NOT EXISTS (SELECT 1 FROM lumo_governed_executions e WHERE e.run_id=r.id)
        ORDER BY o.id LIMIT 1 FOR UPDATE OF t,r,s,o SKIP LOCKED FOR SHARE OF p,u,h`,
      [realm, nodeId, `agent:${binding.agentId}`, binding.projectId, binding.userId, binding.presetRevision, this.instanceId])
      const row = selected.rows[0]
      if (!row) { await client.query('COMMIT'); return }
      assertExecutionPreset(binding, realm, row.preset)
      const depth = row.task.intent_contract?.depth ?? 0
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > row.preset.max_delegation_depth) {
        throw new Error('task delegation depth exceeds the installed preset')
      }
      const execution: GovernedExecution = { runId: row.run_id, attempt: row.attempt,
        deadlineMS: Number(row.deadline_ms), task: row.task, preset: row.preset,
        sessionRef: `gov-${createHash('sha256').update(JSON.stringify([realm, row.run_id])).digest('hex')}` }
      const inserted = await client.query(`INSERT INTO lumo_governed_executions
        (run_id,realm,node_id,worker_id,project_id,instance_id,attempt,execution)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id) DO NOTHING RETURNING run_id`,
      [row.run_id, realm, nodeId, `agent:${binding.agentId}`, binding.projectId, this.instanceId, row.attempt, JSON.stringify(execution)])
      if (!inserted.rowCount) { await client.query('ROLLBACK'); return }
      await client.query(`UPDATE governance_task_runs SET state='RUNNING',assigned_node_id=$3,session_ref=$4,started_at=COALESCE(started_at,now())
        WHERE realm=$1 AND id=$2`, [realm, row.run_id, nodeId, execution.sessionRef])
      await client.query(`UPDATE governance_delegation_tasks SET state='RUNNING',business_state='EXECUTING',assigned_node_id=$3,updated_at=now()
        WHERE realm=$1 AND id=$2`, [realm, row.task.id, nodeId])
      await client.query(`UPDATE scheduler_tasks SET state='RUNNING',updated_at=${nowMS} WHERE task_id=$1`, [row.run_id])
      await client.query(`UPDATE scheduler_task_attempts SET state='RUNNING',updated_at=${nowMS} WHERE task_id=$1 AND attempt=$2`, [row.run_id, row.attempt])
      await client.query(`UPDATE scheduler_dispatch_outbox SET delivered_at=${nowMS},claimed_by=NULL WHERE task_id=$1 AND attempt=$2`, [row.run_id, row.attempt])
      await client.query('COMMIT')
      return execution
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async shouldStop(execution: GovernedExecution): Promise<boolean> {
    const rows = await this.pool.query<{ state: string }>(`SELECT state FROM scheduler_tasks
      WHERE task_id=$1 AND realm=$2 AND node_id=$3 AND attempt=$4`,
    [execution.runId, this.config.realm, this.config.nodeId, execution.attempt])
    return rows.rows[0]?.state !== 'RUNNING'
  }

  async save(execution: GovernedExecution, result: GovernedResult): Promise<void> {
    if (result.run_id !== execution.runId || result.task_id !== execution.task.id ||
        result.session_ref !== execution.sessionRef || result.node_id !== this.config.nodeId) throw new Error('execution result identity mismatch')
    const saved = await this.pool.query(`UPDATE lumo_governed_executions SET result=$4::jsonb
      WHERE realm=$1 AND run_id=$2 AND instance_id=$3 AND (result IS NULL OR result=$4::jsonb) RETURNING run_id`,
    [this.config.realm, execution.runId, this.instanceId, JSON.stringify(result)])
    if (!saved.rowCount) throw new Error('execution result is immutable or belongs to another runtime instance')
  }

  async deliver(): Promise<void> {
    // Identical replays are accepted by Governance and Scheduler. No execution
    // identity refresh is needed to deliver already persisted receipts.
    const rows = await this.pool.query<{ result: GovernedResult; attempt: number }>(`SELECT result,attempt FROM lumo_governed_executions
      WHERE realm=$1 AND node_id=$2 AND result IS NOT NULL AND delivered_at IS NULL AND next_delivery_at<=now()
      ORDER BY accepted_at LIMIT 16`, [this.config.realm, this.config.nodeId])
    for (const row of rows.rows) {
      const result = row.result
      try {
        const response = await fetch(`${this.config.governanceUrl.replace(/\/+$/, '')}/v1/runtime/task-runs/${encodeURIComponent(result.run_id)}/result`, {
          method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5_000),
          headers: { authorization: `Bearer ${this.config.token}`, 'x-lumo-realm': this.config.realm, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        })
        if (!response.ok) throw new Error(`governed result delivery: HTTP ${response.status}`)
        // Governance committed the receipt and parent notification. Finish the
        // scheduler attempt and release its slot in a fenced transaction.
        await this.settle(result, row.attempt)
      } catch (error) {
        await this.pool.query(`UPDATE lumo_governed_executions SET delivery_attempts=delivery_attempts+1,last_error=$3,
          next_delivery_at=now()+LEAST(300,POWER(2,LEAST(delivery_attempts+1,8))) * interval '1 second'
          WHERE realm=$1 AND run_id=$2 AND delivered_at IS NULL`,
        [this.config.realm, result.run_id, error instanceof Error ? error.message : 'result delivery failed'])
      }
    }
  }

  private async settle(result: GovernedResult, attempt: number): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const state = result.state === 'CANCELLED' ? 'ABORTED' : result.state
      const current = await client.query<{ state: string }>(`SELECT state FROM scheduler_tasks
        WHERE task_id=$1 AND realm=$2 AND node_id=$3 AND attempt=$4 FOR UPDATE`,
      [result.run_id, this.config.realm, this.config.nodeId, attempt])
      const prior = current.rows[0]?.state
      if (!prior || (!['RUNNING', 'CANCELLING'].includes(prior) && prior !== state)) throw new Error('scheduler attempt changed before result settlement')
      await client.query(`UPDATE scheduler_tasks SET state=$2,updated_at=${nowMS} WHERE task_id=$1`, [result.run_id, state])
      await client.query(`UPDATE scheduler_task_attempts SET state=$3,updated_at=${nowMS} WHERE task_id=$1 AND attempt=$2`, [result.run_id, attempt, state])
      await client.query(`UPDATE lumo_governed_executions SET delivered_at=now(),last_error='' WHERE realm=$1 AND run_id=$2`, [this.config.realm, result.run_id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
