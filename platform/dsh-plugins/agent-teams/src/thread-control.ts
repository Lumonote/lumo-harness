import type { SessionOwnerClient } from '../../../shared/session-owners.ts'
import type { ThreadRoundAdmissionRequest, ThreadRoundAuthorization, ThreadRoundReceipt, ThreadRoundStore } from './thread-runner.ts'
import type { ThreadRoundRunner } from './threads.ts'
import type { ThreadRegistryLike } from './thread-registry.ts'

export interface ThreadExecutionBinding {
  governanceUrl: string
  projectId: string
  agentId: string
  presetRevision: number
  provider: string
  model: string
  /** Also bounded by the current governance preset before each round. */
  timeoutMs?: number
}

export interface ThreadControlOptions {
  baseUrl: string
  token: string
  realm: string
  userId: string
  binding: ThreadExecutionBinding
  registry: ThreadRegistryLike
  /** Trusted host verifies a live parent or an opaque claimed mailbox capability. */
  verifyParent?(input: Parameters<ThreadRoundRunner['start']>[0]): boolean
  owner?: Pick<SessionOwnerClient, 'get'>
  fetch?: typeof globalThis.fetch
}

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Thread control-plane response')
  return value as JsonObject
}

/** Only explicit service configuration can select execution identity. Neither
 * a browser body, a model tool nor a parent Agent can change this binding. */
export function assertThreadExecutionBinding(value: ThreadExecutionBinding): void {
  if (!value || [value.projectId, value.agentId, value.provider, value.model].some(item => typeof item !== 'string' || !item.trim())
    || !Number.isSafeInteger(value.presetRevision) || value.presetRevision < 1
    || !Number.isSafeInteger(value.timeoutMs ?? 600_000) || (value.timeoutMs ?? 600_000) < 1 || (value.timeoutMs ?? 600_000) > 1_800_000) {
    throw new Error('Thread execution requires a fixed project, Agent, preset revision, model and timeout')
  }
  const url = new URL(value.governanceUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Thread governance URL')
}

export function createThreadControl(options: ThreadControlOptions): {
  store: ThreadRoundStore
  authorize(input: Parameters<ThreadRoundRunner['start']>[0]): Promise<ThreadRoundAuthorization>
} {
  assertThreadExecutionBinding(options.binding)
  if (![options.token, options.realm, options.userId].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('Thread control plane requires service credentials and a fixed owner')
  }
  const fetcher = options.fetch ?? globalThis.fetch
  const binding = structuredClone(options.binding)
  const collaborator = new URL(options.baseUrl)
  if (!['http:', 'https:'].includes(collaborator.protocol) || collaborator.username || collaborator.password || collaborator.search || collaborator.hash) throw new Error('Invalid Thread collaborator URL')
  const call = async (base: string, path: string, body: unknown): Promise<{ status: number; body: JsonObject }> => {
    const response = await fetcher(`${base.replace(/\/+$/u, '')}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${options.token}`, 'x-lumo-realm': options.realm, 'x-lumo-user': options.userId, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Thread control plane refused ${path}: HTTP ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Thread control plane returned an empty response')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 128 * 1024) throw new Error('Thread control-plane response exceeds its bound')
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return { status: response.status, body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
  }
  const roundPath = (request: ThreadRoundAdmissionRequest) => `/threads/${encodeURIComponent(request.thread.id)}/rounds`
  function receipt(raw: unknown, request: ThreadRoundAdmissionRequest): ThreadRoundReceipt {
    const value = object(raw)
    for (const [key, expected] of Object.entries({ realm: options.realm, thread_id: request.thread.id,
      task_id: request.round.task_id, node_id: request.thread.node_id, coordinator_session_ref: request.thread.coordinator_session_ref,
      attempt: request.round.attempt, request_hash: request.requestHash, run_id: request.runId, owner_user_id: options.userId,
      agent_id: binding.agentId, preset_revision: binding.presetRevision, max_concurrency: request.maxConcurrency,
      provider: binding.provider, model: binding.model })) {
      if (value[key] !== expected) throw new Error(`Thread round receipt has a mismatched ${key}`)
    }
    if (!['running', 'completed', 'failed', 'cancelled'].includes(String(value.state)) || typeof value.summary !== 'string'
      || !['create', 'resume'].includes(String(value.session_mode)) || [...value.summary].length > 16_000) throw new Error('Invalid Thread round receipt')
    return { runId: request.runId, state: value.state === 'running' ? 'uncertain' : value.state as ThreadRoundReceipt['state'], summary: value.summary }
  }
  const store: ThreadRoundStore = {
    async admit(request) {
      if (request.ownerUserId !== options.userId || request.agentId !== binding.agentId || request.presetRevision !== binding.presetRevision
        || request.provider !== binding.provider || request.model !== binding.model
        || request.thread.realm !== options.realm || request.thread.project_id !== binding.projectId) throw new Error('Thread admission differs from the fixed node identity')
      const response = await call(options.baseUrl, roundPath(request), {
        node_id: request.thread.node_id, coordinator_session_ref: request.thread.coordinator_session_ref, task_id: request.round.task_id,
        attempt: request.round.attempt, request_hash: request.requestHash, run_id: request.runId,
        owner_user_id: options.userId, agent_id: binding.agentId, preset_revision: binding.presetRevision,
        max_concurrency: request.maxConcurrency, provider: binding.provider, model: binding.model,
      })
      const result = receipt(response.body.receipt, request)
      if (response.status === 201 && response.body.admitted === true && result.state === 'uncertain'
        && typeof response.body.token === 'string' && /^[0-9a-f]{64}$/u.test(response.body.token)) {
        return { kind: 'admitted', token: response.body.token, sessionMode: object(response.body.receipt).session_mode as 'create' | 'resume' }
      }
      if (response.status !== 200 || response.body.admitted !== false || response.body.token !== undefined) throw new Error('Invalid Thread round admission response')
      return { kind: 'replay', receipt: result }
    },
    async finish(request, token, result) {
      // Failed teardown is deliberately left as an uncertain running receipt.
      // Converting it to a terminal failure would authorize a replacement
      // while its model stream or durable writer might still be active.
      if (result.state === 'uncertain') return
      const response = await call(options.baseUrl, `${roundPath(request)}/${encodeURIComponent(request.runId)}/finish`, {
        token, state: result.state, summary: result.summary,
      })
      const saved = receipt(response.body, request)
      if (response.status !== 200 || saved.state !== result.state || saved.summary !== result.summary) throw new Error('Thread finish receipt differs from the submitted outcome')
    },
  }
  return {
    store,
    async authorize(input) {
      const thread = await options.registry.get(input.thread.id)
      const parent = input.parent as { id?: unknown } | undefined
      if (!thread || !(options.verifyParent ? options.verifyParent(input) : parent?.id === thread.coordinator_session_ref)) throw new Error('Thread requires its current coordinating Agent session')
      for (const key of ['id', 'realm', 'project_id', 'task_id', 'node_id', 'session_ref', 'workspace', 'coordinator_session_ref'] as const) {
        if (thread[key] !== input.thread[key]) throw new Error('Thread execution differs from the authoritative registry')
      }
      if (options.owner) {
        const own = await options.owner.get(options.realm, thread.session_ref)
        const coordinator = await options.owner.get(options.realm, thread.coordinator_session_ref)
        if (own.state !== 'active' || coordinator.state !== 'active' || own.owner_user_id !== options.userId || coordinator.owner_user_id !== options.userId || own.project_id !== binding.projectId || coordinator.project_id !== binding.projectId || own.node_id !== thread.node_id) throw new Error('Thread session owner authority mismatch')
      }
      if (['done', 'stopped', 'failed'].includes(thread.state)) throw new Error('Thread is terminal')
      const response = await call(binding.governanceUrl, `/v1/runtime/tasks/${encodeURIComponent(thread.task_id)}/thread-authorization`, {
        owner_user_id: options.userId, project_id: binding.projectId, agent_id: binding.agentId,
        preset_revision: binding.presetRevision, provider: binding.provider, model: binding.model,
      })
      const value = response.body
      const preset = object(value.preset)
      if (response.status !== 200 || value.realm !== options.realm || value.user_id !== options.userId || value.project_id !== thread.project_id
        || value.task_id !== thread.task_id || preset.id !== binding.agentId || preset.realm !== options.realm
        || preset.owner_user_id !== options.userId || preset.project_id !== binding.projectId || preset.revision !== binding.presetRevision
        || preset.provider !== binding.provider || preset.model_ref !== binding.model || preset.status !== 'active'
        || !Array.isArray(preset.connector_ids) || preset.connector_ids.length || !Array.isArray(preset.knowledge_space_ids) || preset.knowledge_space_ids.length
        || (preset.system_prompt_ref !== undefined && preset.system_prompt_ref !== '') || preset.max_budget_cents !== 0
        || !Number.isSafeInteger(preset.max_concurrency) || Number(preset.max_concurrency) < 1 || Number(preset.max_concurrency) > 2_147_483_647
        || !Number.isSafeInteger(preset.timeout_seconds) || Number(preset.timeout_seconds) * 1000 < (binding.timeoutMs ?? 600_000)) {
        throw new Error('Thread preset is outside the supported fixed text execution profile')
      }
      return { userId: options.userId, projectId: binding.projectId, agentId: binding.agentId,
        presetRevision: binding.presetRevision, maxConcurrency: Number(preset.max_concurrency), provider: binding.provider, model: binding.model }
    },
  }
}
