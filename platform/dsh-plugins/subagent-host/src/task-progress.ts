import type { Context } from '@deepseek-ai/cordis'
import type { GovernedExecution } from './governed-dispatch.ts'
import type { RuntimeReportConfig } from './runtime-report.ts'

export const TASK_PROGRESS_TOOL = 'report_task_progress'
export interface ProgressCheckpoint {
  status: 'on_track' | 'at_risk' | 'blocked'
  percent: number
  summary: string
  next_step: string
  blocked_reason?: string
  due_at?: string | null
}
interface ProgressView {
  current_run_id: string
  revision: number
  can_update: boolean
  progress: ({ source: string; updated_by: string } & ProgressCheckpoint) | null
}

function validateCheckpoint(value: unknown): asserts value is ProgressCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Progress requires an object')
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['status', 'percent', 'summary', 'next_step', 'blocked_reason', 'due_at'].includes(key))
    || !['on_track', 'at_risk', 'blocked'].includes(String(p.status)) || !Number.isInteger(p.percent) || Number(p.percent) < 0 || Number(p.percent) > 100
    || typeof p.summary !== 'string' || !p.summary.trim() || [...p.summary].length > 4000
    || typeof p.next_step !== 'string' || !p.next_step.trim() || [...p.next_step].length > 2000
    || p.blocked_reason !== undefined && (typeof p.blocked_reason !== 'string' || [...p.blocked_reason].length > 2000)
    || (p.status === 'blocked') !== Boolean(typeof p.blocked_reason === 'string' && p.blocked_reason.trim())
    || p.due_at !== undefined && p.due_at !== null && (typeof p.due_at !== 'string' || !Number.isFinite(Date.parse(p.due_at)))) {
    throw new Error('Progress requires a valid percentage, summary, next step and a reason exactly when blocked')
  }
}

async function responseJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing progress response')
  let size = 0
  const parts: Uint8Array[] = []
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 128 * 1024) throw new Error('Progress response exceeds limit')
      parts.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

/** The model never chooses task, Run, realm, node, session, actor or revision.
 * An optimistic conflict is surfaced; it must not overwrite a concurrent human
 * update merely because the transport can retry. Progress is not acceptance. */
export class GovernedProgressReporter {
  private readonly base: string
  private inFlight = false
  private automaticRevision: number | undefined
  private explicitCheckpoint = false
  constructor(private readonly config: RuntimeReportConfig, private readonly execution: GovernedExecution,
    private readonly fetcher: typeof fetch = fetch) {
    this.base = `${config.governanceUrl.replace(/\/+$/u, '')}/v1/runtime/task-runs/${encodeURIComponent(execution.runId)}/progress`
  }

  private async request(url: string, signal: AbortSignal, checkpoint?: ProgressCheckpoint, revision?: number): Promise<unknown> {
    signal.throwIfAborted()
    const response = await this.fetcher(url, {
      method: checkpoint ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: { authorization: `Bearer ${this.config.token}`, 'x-lumo-realm': this.config.realm, 'content-type': 'application/json' },
      ...(checkpoint ? { body: JSON.stringify({ ...checkpoint, run_id: this.execution.runId, expected_revision: revision,
        node_id: this.config.nodeId, session_ref: this.execution.sessionRef }) } : {}),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(response.status === 409 ? 'Progress changed or this Run is no longer active; inspect the task before reporting again' : `Progress report refused: HTTP ${response.status}`)
    }
    return responseJSON(response)
  }

  async report(checkpoint: ProgressCheckpoint, signal: AbortSignal, automatic = false): Promise<{ revision: number; recorded: boolean }> {
    validateCheckpoint(checkpoint)
    if (this.inFlight) throw new Error('Another progress checkpoint is being recorded')
    this.inFlight = true
    try {
      const query = new URLSearchParams({ node_id: this.config.nodeId, session_ref: this.execution.sessionRef })
      const view = await this.request(`${this.base}?${query}`, signal) as ProgressView
      if (view.current_run_id !== this.execution.runId || !Number.isSafeInteger(view.revision) || view.revision < 0 || !view.can_update) throw new Error('Progress Run identity or revision is invalid')
      // An automatic phase may replace only its own preceding automatic phase.
      // Preserve every explicit model/human checkpoint, including on_track work
      // that is still incomplete, and any persisted report this instance did not
      // create. A final text reply does not prove a blocker was resolved.
      if (automatic && (this.explicitCheckpoint || view.progress && (
        view.progress.source !== 'runtime' || view.progress.status !== 'on_track' || view.revision !== this.automaticRevision
      ))) return { revision: view.revision, recorded: false }
      const value = await this.request(this.base, signal, checkpoint, view.revision) as { run_id: string; task_id: string; revision: number; source: string }
      if (value.run_id !== this.execution.runId || value.task_id !== this.execution.task.id || value.revision !== view.revision + 1 || value.source !== 'runtime') throw new Error('Progress receipt does not match this execution')
      if (automatic) this.automaticRevision = value.revision
      else this.explicitCheckpoint = true
      // Only a bounded receipt is returned. Existing human text and credentials
      // are never introduced into the Agent's prompt through this tool.
      return { revision: value.revision, recorded: true }
    } finally { this.inFlight = false }
  }

  install(ctx: Context, signal: AbortSignal): void {
    ctx.tools.register({
      name: TASK_PROGRESS_TOOL,
      description: 'Record an attributed progress checkpoint for this task: percent, concise completed work, next action, and a blocker when blocked. Does not complete or approve the task. Use when a meaningful milestone or blocker changes; do not invent progress.',
      parameters: { type: 'object', additionalProperties: false, required: ['status', 'percent', 'summary', 'next_step'], properties: {
        status: { type: 'string', enum: ['on_track', 'at_risk', 'blocked'] }, percent: { type: 'integer', minimum: 0, maximum: 100 },
        summary: { type: 'string', minLength: 1, maxLength: 4000 }, next_step: { type: 'string', minLength: 1, maxLength: 2000 },
        blocked_reason: { type: 'string', maxLength: 2000 }, due_at: { type: 'string', format: 'date-time' },
      } },
      output: { schema: { type: 'object', properties: { revision: { type: 'integer' }, recorded: { type: 'boolean' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => {
        exec.signal.throwIfAborted()
        if (!exec.agent || String(exec.agent.session.id) !== this.execution.sessionRef) throw new Error('Progress tool requires its exact execution Session')
        validateCheckpoint(args)
        return this.report(args, AbortSignal.any([signal, exec.signal]))
      },
    })
  }
}
