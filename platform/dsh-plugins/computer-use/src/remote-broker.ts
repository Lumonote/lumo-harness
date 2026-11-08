/** Local approval converts a remote request into one bounded existing Agent turn. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-tools'
import type { RemoteComputerEnvelope, RemoteComputerPlan, RemoteComputerLease, RemoteComputerLeaseInput, RemoteComputerLocalRequest } from '../../../shared/seam-contracts/remote-computer.ts'
import './index.ts'

export type { RemoteComputerEnvelope, RemoteComputerPlan, RemoteComputerLease, RemoteComputerLeaseInput, RemoteComputerLocalRequest } from '../../../shared/seam-contracts/remote-computer.ts'
const ref = (v: unknown): v is string => typeof v === 'string' && /^[^\s\u0000-\u001f\u007f]{1,256}$/u.test(v)
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const idPattern = /^[A-Za-z0-9_-]{43}$/u
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const observe = new Set(['getCapabilities', 'listApps', 'findApps', 'getApp', 'listWindows', 'getState', 'screenshot'])
const interact = new Set([...observe, 'hover', 'click', 'setValue', 'selectText', 'performSecondaryAction', 'typeText', 'paste', 'pressKey', 'scroll', 'drag'])
const windowsObserve = new Set(['check_permissions', 'list_apps', 'list_windows', 'get_window_state'])
const windowsInteract = new Set([...windowsObserve, 'click', 'type_text', 'press_key', 'scroll', 'drag', 'move_cursor'])
/** AgentLoop's RuntimeContextProjection.project() appends this precise owned
 * shape after pre-step's claimed inbox batch. It is never admitted from inbox.
 * Source: @deepseek-ai/dsh-agent-loop/src/runtime-context.ts (public loop).
 */
function loopContext(value: unknown): boolean {
 if (!record(value) || value.role !== 'user' || typeof value.id !== 'string' || !Array.isArray(value.content) || value.content.length !== 1 || !record(value.content[0]) || value.content[0].type !== 'text' || typeof value.content[0].text !== 'string' || !record(value.source) || value.source.kind !== 'runtime-context') return false
 const source = value.source
 if (Object.keys(source).length === 1) return value.content[0].text === 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
 return Object.keys(source).sort().join(',') === 'form,kind,sections' && source.form === 'snapshot' && Array.isArray(source.sections) && source.sections.every(section => record(section) && Object.keys(section).sort().join(',') === 'name,text' && typeof section.name === 'string' && typeof section.text === 'string')
}
export interface RemoteComputerBrokerOptions {
 ctx: Context
 enabled?: boolean
 realm: string
 nodeId: string
 ownerUserId: string
 ledgerDir: string
 authorize(id: string, input: RemoteComputerLeaseInput): Promise<RemoteComputerLease>
}
interface Active { request: RemoteComputerLocalRequest; agent: Agent; message: UserMessage; turn?: number; abort: AbortController; running: Promise<void>; serial: Promise<void>; successes: number; failed: boolean; ended: string | undefined }
interface Approval { request: RemoteComputerLocalRequest; cancelled: boolean; done: Promise<void>; complete(): void }
async function durable(path: string, value: unknown): Promise<void> {
 const temp = `${path}.${randomUUID()}.tmp`
 try {
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
  await rename(temp, path)
  const directory = await open(join(path, '..'), 'r').catch(() => undefined)
  if (directory) try { await directory.sync().catch(error => { if (process.platform !== 'win32') throw error }) } finally { await directory.close() }
 } catch (error) { await rm(temp, { force: true }); throw error }
}
export function parseRemoteComputerEnvelope(raw: unknown): { envelope: RemoteComputerEnvelope; plan: RemoteComputerPlan } {
 if (!record(raw) || Object.keys(raw).sort().join(',') !== 'digest,plan_json,request_id,version' || raw.version !== 1 || typeof raw.request_id !== 'string' || !idPattern.test(raw.request_id)
  || typeof raw.digest !== 'string' || !digestPattern.test(raw.digest) || typeof raw.plan_json !== 'string' || Buffer.byteLength(raw.plan_json) > 24 * 1024
  || `sha256:${createHash('sha256').update(raw.plan_json).digest('hex')}` !== raw.digest) throw Error('REMOTE_COMPUTER_INVALID_REQUEST')
 const plan: unknown = JSON.parse(raw.plan_json)
 if (!record(plan) || Object.keys(plan).sort().join(',') !== 'agent_id,capability,channel,expires_at,intent,node_id,owner_user_id,project_id,realm,sender_user_id,session_ref,subject,team_id'
  || !['realm', 'node_id', 'owner_user_id', 'project_id', 'session_ref', 'channel', 'subject', 'sender_user_id', 'team_id', 'agent_id'].every(key => ref(plan[key]))
  || !['computer.observe', 'computer.interact'].includes(String(plan.capability)) || typeof plan.intent !== 'string' || !plan.intent.trim() || [...plan.intent].length > 4000
  || typeof plan.expires_at !== 'string' || !Number.isFinite(Date.parse(plan.expires_at))) throw Error('REMOTE_COMPUTER_INVALID_PLAN')
 return { envelope: structuredClone(raw) as unknown as RemoteComputerEnvelope, plan: plan as unknown as RemoteComputerPlan }
}
/** Explicit lists; a provider's matching name prefix never grants remote authority. */
export function remoteComputerToolAllowed(capability: RemoteComputerPlan['capability'], name: string, args: unknown): boolean {
 if (!record(args)) return false
 if (name === 'cua') return typeof args.method === 'string' && (capability === 'computer.observe' ? observe : interact).has(args.method)
 const prefix = 'lumo_cua_windows__'
 if (!name.startsWith(prefix)) return false
 const tool = name.slice(prefix.length)
 if (!(capability === 'computer.observe' ? windowsObserve : windowsInteract).has(tool)) return false
 return tool !== 'check_permissions' || args.prompt === false
}

export class RemoteComputerBroker {
 private readonly requests = new Map<string, RemoteComputerLocalRequest>()
 private active?: Active
 private approving?: Approval
 private disposed = false
 private releaseLock?: () => void
 private holdingLock?: Promise<void>
 private readonly disposers: Array<() => unknown> = []
 private constructor(private readonly options: RemoteComputerBrokerOptions) {}
 static async create(options: RemoteComputerBrokerOptions): Promise<RemoteComputerBroker> {
  if (options.enabled !== true || ![options.realm, options.nodeId, options.ownerUserId].every(ref) || !isAbsolute(options.ledgerDir)) throw Error('REMOTE_COMPUTER_DISABLED')
  const broker = new RemoteComputerBroker(options)
  await mkdir(options.ledgerDir, { recursive: true, mode: 0o700 })
  let entered!: () => void; let failed!: (error: unknown) => void
  const enteredLock = new Promise<void>((done, reject) => { entered = done; failed = reject })
  const ended = new Promise<void>(done => { broker.releaseLock = done })
  broker.holdingLock = withFileLock(join(options.ledgerDir, 'broker'), async () => { entered(); await ended }, { waitMs: 250 }).catch(error => { failed(error); throw error })
  void broker.holdingLock.catch(() => {})
  await enteredLock
  try {
  const files = (await readdir(options.ledgerDir)).filter(v => /^[A-Za-z0-9_-]{43}\.json$/u.test(v))
  if (files.length > 200) throw Error('REMOTE_COMPUTER_LEDGER_LIMIT')
  for (const file of files) {
   const value: unknown = JSON.parse(await readFile(join(options.ledgerDir, file), 'utf8'))
   if (!record(value)) throw Error('REMOTE_COMPUTER_LEDGER_INVALID')
   const parsed = parseRemoteComputerEnvelope(value.envelope)
   broker.verifyTarget(parsed.plan)
   if (!['pending', 'running', 'completed', 'failed', 'denied', 'cancelled', 'unknown'].includes(String(value.state)) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.summary !== 'string') throw Error('REMOTE_COMPUTER_LEDGER_INVALID')
   const row = { ...parsed, state: value.state, revision: value.revision, summary: value.summary } as RemoteComputerLocalRequest
   // Startup never retries a previously attempted approval or execution.
   if (row.state === 'running') { row.state = 'unknown'; row.summary = 'Host restarted before a confirmed execution receipt'; await broker.persist(row) }
   broker.requests.set(parsed.envelope.request_id, row)
  }
  const ctx = options.ctx
  broker.disposers.push(ctx.tools.guard(execution => {
   const active = broker.active
   if (!active || execution.agent !== active.agent) return undefined
   return active.abort.signal.aborted || !remoteComputerToolAllowed(active.request.plan.capability, execution.name, execution.arguments) ? 'REMOTE_COMPUTER_CAPABILITY_DENIED' : undefined
  }))
  broker.disposers.push(ctx.on('tools/execute', async (execution, next) => {
   const active = broker.active
   if (!active || execution.agent !== active.agent) return next()
   if (!remoteComputerToolAllowed(active.request.plan.capability, execution.name, execution.arguments)) throw Error('REMOTE_COMPUTER_CAPABILITY_DENIED')
   await broker.check(active)
   active.abort.signal.throwIfAborted()
   const result = await next()
   if (result.isError) active.failed = true; else active.successes++
   return result
  }, { prepend: true }))
  const stop = (active: Active) => { active.abort.abort(); active.agent.cancel({ kind: 'user' }); ctx.lumoComputerUse.stop() }
  broker.disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
   const active = broker.active
   if (active?.agent === agent && !isDeepStrictEqual(message, active.message)) stop(active)
  }))
  broker.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
   const active = broker.active
   if (active?.agent !== agent) return
   if (!isDeepStrictEqual(message, active.message) || (active.turn !== undefined && active.turn !== turn) || active.ended !== undefined) stop(active)
   else active.turn = turn
  }))
  broker.disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
   const active = broker.active
   if (active?.agent !== payload.agent) return next()
   if (active.abort.signal.aborted || active.ended !== undefined || active.turn !== payload.turn || payload.messages.some(message => !isDeepStrictEqual(message, active.message))) { stop(active); return { kind: 'reject' } }
   const decision = await next()
   if (active.abort.signal.aborted || active.ended !== undefined || (decision.kind === 'enter' && decision.messages.some(message => !isDeepStrictEqual(message, active.message) && !loopContext(message)))) { stop(active); return { kind: 'reject' } }
   return decision
  }, { prepend: true }))
  broker.disposers.push(ctx.on('session/event', (session, event) => { if (session === broker.active?.agent.session && event.type === 'turn/end') broker.active.ended = event.data.reason.kind }))
  return broker
  } catch (error) { await broker.dispose(); throw error }
 }
 private verifyTarget(plan: RemoteComputerPlan): void {
  if (plan.realm !== this.options.realm || plan.node_id !== this.options.nodeId || plan.owner_user_id !== this.options.ownerUserId) throw Error('REMOTE_COMPUTER_TARGET_MISMATCH')
 }
 private path(id: string): string { return join(this.options.ledgerDir, `${id}.json`) }
 private async persist(row: RemoteComputerLocalRequest): Promise<void> { await durable(this.path(row.envelope.request_id), row) }
 list(): RemoteComputerLocalRequest[] { return [...this.requests.values()].map(row => structuredClone(row)) }
 async ingest(raw: unknown): Promise<RemoteComputerLocalRequest> {
  if (this.disposed) throw Error('REMOTE_COMPUTER_DISPOSED')
  const { envelope, plan } = parseRemoteComputerEnvelope(raw); this.verifyTarget(plan)
  if (Date.parse(plan.expires_at) <= Date.now() || Date.parse(plan.expires_at) > Date.now() + 125_000) throw Error('REMOTE_COMPUTER_REQUEST_EXPIRED')
  return await withFileLock(this.path(envelope.request_id), async () => {
   const existing = this.requests.get(envelope.request_id)
   if (existing) { if (existing.envelope.digest !== envelope.digest || existing.envelope.plan_json !== envelope.plan_json) throw Error('REMOTE_COMPUTER_REQUEST_CONFLICT'); return structuredClone(existing) }
   if (this.requests.size >= 200) throw Error('REMOTE_COMPUTER_LEDGER_LIMIT')
   const row: RemoteComputerLocalRequest = { envelope, plan, state: 'pending', revision: 1, summary: '' }
   await this.persist(row); this.requests.set(envelope.request_id, row); return structuredClone(row)
  })
 }
 private async lease(row: RemoteComputerLocalRequest, phase: RemoteComputerLeaseInput['phase'], extra: Partial<RemoteComputerLeaseInput> = {}): Promise<void> {
  const result = await this.options.authorize(row.envelope.request_id, { ...extra, digest: row.envelope.digest, expected_revision: row.revision, phase })
  if (result.request_id !== row.envelope.request_id || result.digest !== row.envelope.digest || result.revision !== row.revision + 1 || Date.parse(result.expires_at) !== Date.parse(row.plan.expires_at)
   || ((phase === 'approve' || phase === 'check') && result.state !== 'running') || (phase === 'deny' && result.state !== 'denied')
   || (phase === 'cancel' && result.state !== 'cancelled') || (phase === 'finish' && result.state !== extra.state)) throw Error('REMOTE_COMPUTER_INVALID_LEASE')
  row.revision = result.revision; row.state = result.state
  await this.persist(row)
 }
 async decide(id: string, decision: { digest: string; approve: boolean }): Promise<RemoteComputerLocalRequest> {
  if (!idPattern.test(id) || this.disposed) throw Error('REMOTE_COMPUTER_INVALID_REQUEST')
  return await withFileLock(this.path(id), async () => {
   const row = this.requests.get(id)
   if (!row || row.envelope.digest !== decision.digest || row.state !== 'pending' || Date.parse(row.plan.expires_at) <= Date.now()) throw Error('REMOTE_COMPUTER_REQUEST_CONFLICT')
   if (!decision.approve) { await this.lease(row, 'deny'); return structuredClone(row) }
   if (this.active || this.approving) throw Error('REMOTE_COMPUTER_BUSY')
   const agent = this.options.ctx.agents.get(SessionId(row.plan.session_ref))
   if (!agent || agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0 || this.options.ctx.lumoComputerUse.snapshot().phase !== 'disabled') throw Error('REMOTE_COMPUTER_SESSION_NOT_READY')
   const provider = this.options.ctx.get('computerUse') as { providerName?: string } | undefined
   if (provider?.providerName !== 'dsh-cua' && !(provider?.providerName === 'lumo-cua-windows' && (this.options.ctx.get('lumoWindowsComputerUse') as { available?: boolean } | undefined)?.available)) throw Error('REMOTE_COMPUTER_PROVIDER_UNAVAILABLE')
   const controlRevision = this.options.ctx.lumoComputerUse.controlRevision
   // Reserve this broker before the first persistence/authority await. Per-row
   // locks cannot exclude approvals for different requests or Sessions.
   let complete!: () => void
   const approval: Approval = { request: row, cancelled: false, done: new Promise<void>(done => { complete = done }), complete: () => complete() }
   this.approving = approval
   try {
    // Persist an attempted approval before the remote CAS. A lost reply is unknown,
    // never an invitation to approve again or execute another copy.
    row.state = 'running'; row.summary = 'Approval attempted; awaiting a confirmed device lease'; await this.persist(row)
    try { await this.lease(row, 'approve') } catch (error) { row.state = 'unknown'; row.summary = 'Approval outcome unknown; execution was not started'; await this.persist(row); throw error }
    if (this.disposed || approval.cancelled || Date.parse(row.plan.expires_at) <= Date.now() || agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0 || this.options.ctx.lumoComputerUse.controlRevision !== controlRevision || this.options.ctx.lumoComputerUse.snapshot().phase !== 'disabled') {
     row.summary = 'Approval cancelled before execution; no Agent input was submitted'
     try { await this.lease(row, 'cancel') } catch { row.state = 'unknown'; row.summary = 'Approval cancellation outcome unknown; execution was not started'; await this.persist(row) }
     throw Error('REMOTE_COMPUTER_SESSION_NOT_READY')
    }
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Locally approved remote computer task. Scope: ${row.plan.capability}. Do only this task on this device before ${row.plan.expires_at}. Other tools and authority changes are forbidden.\n\n${row.plan.intent}` }] })
    const active: Active = { request: row, agent, message, abort: new AbortController(), running: Promise.resolve(), serial: Promise.resolve(), successes: 0, failed: false, ended: undefined }
    this.active = active
    active.running = this.run(active)
    void active.running.catch(() => {})
    return structuredClone(row)
   } finally {
    if (this.approving === approval) delete this.approving
    approval.complete()
   }
  })
 }
 private async check(active: Active): Promise<void> {
  const work = active.serial.then(async () => { active.abort.signal.throwIfAborted(); if (Date.parse(active.request.plan.expires_at) <= Date.now()) throw Error('REMOTE_COMPUTER_EXPIRED'); await this.lease(active.request, 'check') })
  active.serial = work.catch(() => {})
  try { await work } catch (error) { active.abort.abort(); active.agent.cancel({ kind: 'user' }); this.options.ctx.lumoComputerUse.stop(); throw error }
 }
 private async run(active: Active): Promise<void> {
  const row = active.request; const control = this.options.ctx.lumoComputerUse
  const deadline = setTimeout(() => { active.abort.abort(); active.agent.cancel({ kind: 'user' }); control.stop() }, Math.max(0, Date.parse(row.plan.expires_at) - Date.now()))
  const heartbeat = setInterval(() => { void this.check(active).catch(() => {}) }, 1000); heartbeat.unref(); deadline.unref()
  let state: 'completed' | 'failed' | 'cancelled' | 'unknown' = 'unknown'
  try {
   control.enable(row.plan.session_ref)
   active.agent.followup(active.message)
   await active.agent.whenIdle()
   state = active.abort.signal.aborted ? 'cancelled' : active.ended === 'completed' && active.successes > 0 && !active.failed ? 'completed' : 'failed'
  } catch { state = active.abort.signal.aborted ? 'cancelled' : 'unknown' }
  finally {
   clearTimeout(deadline); clearInterval(heartbeat); control.stop()
   // Agent idle may precede native teardown. Never send a terminal receipt or
   // withdraw capability guards until the desktop lease has actually drained.
   await control.coordinator.releaseOwner(active.agent)
   await active.serial
   row.summary = state === 'completed' ? `Completed ${active.successes} approved desktop operations` : 'Remote desktop task ended; inspect the local Session before a new request'
   try { await this.lease(row, 'finish', { state, summary: row.summary }) }
   catch { row.state = 'unknown'; row.summary = 'Final outcome was not confirmed; this request will never replay'; await this.persist(row) }
   if (this.active === active) delete this.active
  }
 }
 async revoke(id: string, digest: string): Promise<void> {
  const row = this.requests.get(id); if (!row || row.envelope.digest !== digest) throw Error('REMOTE_COMPUTER_REQUEST_CONFLICT')
  if (this.approving?.request === row) { const approval = this.approving; approval.cancelled = true; await approval.done }
  if (this.active?.request === row) { const active = this.active; active.abort.abort(); active.agent.cancel({ kind: 'user' }); this.options.ctx.lumoComputerUse.stop(); await active.running }
  else if (row.state === 'pending') { row.state = 'cancelled'; row.summary = 'Revoked before local approval'; await this.persist(row) }
 }
 async dispose(): Promise<void> {
  this.disposed = true
  if (this.approving) { const approval = this.approving; approval.cancelled = true; await approval.done }
  if (this.active) await this.revoke(this.active.request.envelope.request_id, this.active.request.envelope.digest)
  for (const dispose of this.disposers.reverse()) await dispose()
  this.disposers.length = 0
  this.releaseLock?.(); delete this.releaseLock; await this.holdingLock
 }
}
