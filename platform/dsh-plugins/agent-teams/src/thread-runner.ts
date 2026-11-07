import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'
import { parseThreadRow, resolveThreadWorkspacePath, type ThreadRound, type ThreadRow } from './thread.ts'
import type { ThreadRoundRunner } from './threads.ts'

export interface ThreadRoundAuthorization {
  userId: string
  projectId: string
  agentId: string
  presetRevision: number
  provider: string
  model: string
  maxConcurrency: number
  systemPrompt?: string
}

/** The durable control plane must pin this identity for the entire Thread.
 * Its transaction also checks the current authoritative Thread, serializes
 * rounds, and moves its lifecycle state; this node never writes threads. */
export interface ThreadRoundAdmissionRequest {
  thread: ThreadRow
  round: ThreadRound
  runId: string
  requestHash: string
  ownerUserId: string
  agentId: string
  presetRevision: number
  provider: string
  model: string
  maxConcurrency: number
}

export interface ThreadRoundReceipt {
  runId: string
  state: 'completed' | 'failed' | 'cancelled' | 'uncertain'
  summary: string
}

export interface ThreadRoundStore {
  /** Atomically and durably admit once, or return the immutable existing
   * receipt. A still-running admission is uncertain, never a new admission.
   * A changed request hash, owner, preset, or concurrent round must reject.
   * create is only for a Thread with no prior admitted round; later rounds
   * require the same persisted session. Failed/uncertain rounds block reuse. */
  admit(request: ThreadRoundAdmissionRequest): Promise<
    | { kind: 'admitted'; token: string; sessionMode: 'create' | 'resume' }
    | { kind: 'replay'; receipt: ThreadRoundReceipt }
  >
  /** Fence by the exact admission token; persist the receipt and its Thread
   * lifecycle transition together. A failed response may already be committed. */
  finish(request: ThreadRoundAdmissionRequest, token: string, receipt: ThreadRoundReceipt): Promise<void>
}

export interface LocalThreadRunnerOptions {
  ctx: Context
  realm: string
  nodeId: string
  workspaceRoot: string
  /** Materializes only this Thread's node-local workspace. */
  workspace(thread: ThreadRow): Promise<string>
  /** Trusted code, never a prompt/tool payload. Must check current owner and
   * project authorization. Called before admission, again before first input,
   * and during execution; a failure stops the active turn. */
  authorize(input: Parameters<ThreadRoundRunner['start']>[0]): Promise<ThreadRoundAuthorization>
  roundStore: ThreadRoundStore
  persistence: SessionPersistence
  meterScope: SessionMeterScope
  timeoutMs?: number
  authorityPollMs?: number
}

export class ThreadRoundExecutionError extends Error {
  constructor(readonly receipt: ThreadRoundReceipt) {
    super(`Thread ${receipt.runId}: ${receipt.state}: ${receipt.summary}`)
    this.name = 'ThreadRoundExecutionError'
  }
}

/** Run identity belongs to a particular Thread and round, never to a label. */
export function threadRoundRunId(threadId: string, round: ThreadRound, realm: string): string {
  if (!realm?.trim() || !threadId?.trim() || !round.task_id?.trim() || !Number.isSafeInteger(round.attempt) || round.attempt < 1) {
    throw new Error('Thread run identity requires its realm, Thread, task and positive attempt')
  }
  return `thread-${createHash('sha256').update(JSON.stringify([realm, threadId, round.task_id, round.attempt])).digest('hex')}`
}

function assertAuthorization(value: ThreadRoundAuthorization, thread: ThreadRow): ThreadRoundAuthorization {
  if (!value || ['userId', 'projectId', 'agentId', 'provider', 'model'].some(key => {
    const field = value[key as keyof ThreadRoundAuthorization]
    return typeof field !== 'string' || !field.trim()
  }) || !Number.isSafeInteger(value.presetRevision) || value.presetRevision < 1
    || !Number.isSafeInteger(value.maxConcurrency) || value.maxConcurrency < 1
    || value.projectId !== thread.project_id || (value.systemPrompt !== undefined && typeof value.systemPrompt !== 'string')) {
    throw new Error('Thread execution requires complete current trusted owner/project/Agent authorization')
  }
  return structuredClone(value)
}

function identity(value: ThreadRoundAuthorization): string {
  return JSON.stringify([value.userId, value.projectId, value.agentId, value.presetRevision,
    value.provider, value.model, value.maxConcurrency, value.systemPrompt ?? ''])
}

async function checkedWorkspace(options: LocalThreadRunnerOptions, thread: ThreadRow): Promise<string> {
  if (!isAbsolute(options.workspaceRoot)) throw new Error('Thread workspace root must be absolute')
  const canonicalRoot = await realpath(options.workspaceRoot)
  const supplied = await options.workspace(thread)
  if (!isAbsolute(supplied)) throw new Error('Thread workspace must be absolute')
  const expected = resolveThreadWorkspacePath(canonicalRoot, thread.workspace)
  // Inspect every node-local descendant, including the shared thread/ parent;
  // checking only the final directory would miss an ancestor symlink escape.
  const suffix = relative(canonicalRoot, expected)
  if (!suffix || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Thread workspace escapes its node root')
  let current = canonicalRoot
  for (const segment of suffix.split(sep)) {
    current = join(current, segment)
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Thread workspace ancestry must contain only directories without symlinks')
  }
  if (await realpath(supplied) !== expected || resolve(supplied) !== resolveThreadWorkspacePath(resolve(options.workspaceRoot), thread.workspace)) {
    throw new Error('Thread workspace does not belong to this Thread on this node')
  }
  return expected
}

function replay(receipt: ThreadRoundReceipt, runId: string): { runId: string; summary: string } {
  if (receipt.runId !== runId || !['completed', 'failed', 'cancelled', 'uncertain'].includes(receipt.state)
    || typeof receipt.summary !== 'string') throw new Error('Invalid durable Thread round receipt')
  if (receipt.state !== 'completed') throw new ThreadRoundExecutionError(receipt)
  return { runId, summary: receipt.summary }
}

/** A node-local stable-session executor. Worker one-shot providers are not
 * involved. Each round owns and disposes one public AgentHandle, then the next
 * round resumes the exact same persisted session with fresh scoped policy.
 * Tools are deliberately denied until per-tool authorization is implemented. */
export function createLocalThreadRunner(options: LocalThreadRunnerOptions): ThreadRoundRunner & { canStart(nodeId: string): boolean } {
  if (!options.nodeId?.trim() || !options.realm?.trim() || !options.persistence || !options.meterScope
    || !options.roundStore || typeof options.authorize !== 'function' || typeof options.workspace !== 'function') {
    throw new Error('Thread execution requires node/realm identity, persistence, durable admission, workspace, authorization and metering')
  }
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const authorityPollMs = options.authorityPollMs ?? 1_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000
    || !Number.isSafeInteger(authorityPollMs) || authorityPollMs < 10 || authorityPollMs > 30_000) {
    throw new Error('Thread execution timeout or authority polling interval is invalid')
  }
  return {
    canStart: nodeId => nodeId === options.nodeId,
    async start(requestInput) {
      const thread = parseThreadRow(requestInput.thread, requestInput.thread.id)
      // An async admission must authorize and execute the exact same prompt
      // and round even if a caller later reuses its mutable request object.
      const input = { ...requestInput, thread, round: { ...requestInput.round } }
      if (thread.realm !== options.realm || thread.node_id !== options.nodeId) throw new Error('Thread execution is restricted to its registered realm and this exact node')
      if (input.round.task_id !== thread.task_id
        || !Number.isSafeInteger(input.round.attempt) || input.round.attempt < 1
        || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt, 'utf8') > 256_000) {
        throw new Error('Thread round identity, lifecycle or prompt is invalid')
      }
      input.signal.throwIfAborted()
      const mountedPersistence = options.ctx.get('sessionPersistence')
      if (!mountedPersistence || mountedPersistence.identity !== options.persistence.identity) {
        throw new Error('Thread runner persistence must be the durable backend mounted on its Agent runtime')
      }
      const authorization = assertAuthorization(await options.authorize(input), thread)
      const runId = threadRoundRunId(thread.id, input.round, thread.realm)
      const request: ThreadRoundAdmissionRequest = {
        thread, round: structuredClone(input.round), runId,
        requestHash: createHash('sha256').update(JSON.stringify([
          thread.id, thread.realm, thread.project_id, thread.task_id, thread.session_ref, thread.node_id,
          thread.workspace, thread.coordinator_session_ref, input.round.attempt, input.prompt, identity(authorization),
        ])).digest('hex'),
        ownerUserId: authorization.userId, agentId: authorization.agentId, presetRevision: authorization.presetRevision,
        provider: authorization.provider, model: authorization.model,
        maxConcurrency: authorization.maxConcurrency,
      }
      // No model input is sent before the durable control-plane response.
      // Immutable receipt replay does not require opening a live workspace.
      const admitted = await options.roundStore.admit(request)
      if (admitted.kind === 'replay') return replay(admitted.receipt, runId)
      if (!admitted.token?.trim() || !['create', 'resume'].includes(admitted.sessionMode)) throw new Error('Invalid durable Thread admission')
      let handle: AgentHandle | undefined
      let releaseMeter: (() => void) | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      let checking: Promise<void> | undefined
      let detach: (() => void) | undefined
      const stop = new AbortController()
      const signal = AbortSignal.any([input.signal, stop.signal, AbortSignal.timeout(timeoutMs)])
      let receipt: ThreadRoundReceipt = { runId, state: 'failed', summary: 'Thread execution failed before producing a deliverable' }
      const checkAuthority = async () => {
        signal.throwIfAborted()
        const current = assertAuthorization(await options.authorize(input), thread)
        if (identity(current) !== identity(authorization)) throw new Error('Thread authorization changed after admission')
        signal.throwIfAborted()
      }
      try {
        if (['stopped', 'done', 'failed'].includes(thread.state)) throw new Error('Thread is terminal; a new round requires a new Thread')
        await checkAuthority()
        const workspace = await checkedWorkspace(options, thread)
        const stored = await options.persistence.stat(SessionId(thread.session_ref), { signal })
        if ((admitted.sessionMode === 'create' && stored !== undefined)
          || (admitted.sessionMode === 'resume' && stored === undefined)) {
          throw new Error('Thread persisted session presence differs from its durable round history; operator review required')
        }
        if (stored && (stored.header.id !== thread.session_ref || stored.header.cwd !== workspace)) {
          throw new Error('Thread persisted session workspace or identity does not match its registered node')
        }
        releaseMeter = options.meterScope.bind(thread.session_ref, {
          context: { userId: authorization.userId, projectId: authorization.projectId, agentId: authorization.agentId,
            componentId: 'agent-teams', feature: `thread:${thread.id}` }, traceId: `run:${runId}`,
        })
        const setup = (childCtx: Context, agent: AgentHandle['agent']) => {
          if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('Thread has unaccounted durable pending input; refusing to replay side effects')
          childCtx.tools.restrict({ allow: [] })
          // Restrictions hide global tools. A guard also denies tools that
          // unrelated lifecycle listeners register in the fresh Agent scope.
          childCtx.tools.guard(() => 'Thread execution does not grant tool access')
          childCtx.systemPrompt.context({ name: 'lumo:thread-identity', order: 120,
            text: `Thread execution identity: ${JSON.stringify({ realm: thread.realm, thread: thread.id,
              task: thread.task_id, run: runId, attempt: input.round.attempt, owner: authorization.userId,
              project: authorization.projectId, agent: authorization.agentId, presetRevision: authorization.presetRevision })}` })
          if (authorization.systemPrompt) childCtx.systemPrompt.context({ name: 'lumo:thread-policy', order: 110, text: authorization.systemPrompt })
        }
        const agentOptions = { provider: authorization.provider, model: authorization.model }
        handle = admitted.sessionMode === 'create'
          ? await options.ctx.agents.create({ sessionId: SessionId(thread.session_ref), meta: { cwd: workspace }, signal, agentOptions, setup })
          : await options.ctx.agents.resume({ resumeSessionId: SessionId(thread.session_ref), signal, agentOptions, setup })
        const agent = handle.agent
        const cancel = () => agent.cancel({ kind: 'parent' })
        signal.addEventListener('abort', cancel, { once: true })
        detach = () => signal.removeEventListener('abort', cancel)
        await checkAuthority()
        // Persisted route selection overrides create/resume fallback options.
        agent.model.select(agentOptions)
        const boundary = agent.session.snapshotEvents().length
        poll = setInterval(() => {
          if (checking || signal.aborted) return
          checking = checkAuthority().catch(error => { stop.abort(error) }).finally(() => { checking = undefined })
        }, authorityPollMs)
        poll.unref()
        signal.throwIfAborted()
        agent.followup(createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } }))
        await agent.whenIdle()
        clearInterval(poll)
        await checking
        await checkAuthority()
        signal.throwIfAborted()
        const events = agent.session.snapshotEvents().slice(boundary)
        const reason = foldConsumedWork(events).end?.data.reason.kind
        const output = finalAssistantOutput(events)
        const summary = (output ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        receipt = { runId, state: reason === 'completed' && summary.trim() ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed',
          summary: summary.trim() ? [...summary].slice(0, 16_000).join('') : `Thread round stopped without a text deliverable (${reason ?? 'no completed work'})` }
      } catch (error) {
        receipt = { runId, state: signal.aborted ? 'cancelled' : 'failed',
          summary: signal.aborted ? 'Thread execution cancelled, timed out, or lost its current authorization' : 'Thread execution failed; inspect the stable session log before retrying' }
        options.ctx.logger.warn('Thread %s round %s stopped: %s', thread.id, input.round.attempt, error)
      } finally {
        clearInterval(poll)
        await checking
        detach?.()
        // Only dispose() owns the public loop + scope + durable writer teardown.
        // Keep attribution while any late stream commits are still draining.
        try {
          await handle?.dispose()
          releaseMeter?.()
        } catch (error) {
          receipt = { runId, state: 'uncertain', summary: 'Thread Agent teardown or durable session flush failed; execution was not replayed' }
          options.ctx.logger.warn('Thread %s disposal failed: %s', thread.id, error)
        }
      }
      // Do not retry execution or manufacture a result if this response is
      // lost. The durable admission stays running/uncertain until reconciled.
      await options.roundStore.finish(request, admitted.token, receipt)
      return replay(receipt, runId)
    },
  }
}
