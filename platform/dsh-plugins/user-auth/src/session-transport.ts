/** Authenticated first-party Session transport. Never forwards a browser as the
 * shared carrier owner. The supported execution profile is text-only. */
import { mkdir, lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access/types'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionOwnerClient, type SessionOwner } from '../../../shared/session-owners.ts'
import type { SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'
import type { Principal } from './client.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'lumo-user': { readonly kind: 'lumo-user'; readonly realm: string; readonly userId: string; readonly requestId: string } }
}
interface Connection { createPeer(options: { principal: { kind: 'lumo-user'; realm: string; userId: string; requestId: string }; interactions: 'none' }): PeerScope }
interface Access { registerPolicy(kind: 'lumo-user', policy: { bindings(principal: { requestId: string }): readonly RemoteAccessBinding[] }): () => void }
export interface SessionTransportConfig {
  authorityUrl: string
  nodeId: string
  projectId: string
  workspaceRoot: string
  provider: string
  model: string
}
export interface AuthenticatedSessionTransport {
  execute(principal: Principal, action: string, request: Record<string, unknown>, signal: AbortSignal, authority?: () => Promise<void>): Promise<unknown>
  stream(principal: Principal, action: string, request: Record<string, unknown>, signal: AbortSignal): Promise<AsyncIterable<unknown>>
}
export class PendingSessionInputError extends Error {
  readonly code = 'session_pending_input'
  constructor() { super('Session has durable pending input; automatic replay is disabled until its history is reviewed') }
}
const unary = new Set(['state', 'wait', 'events', 'page', 'projections', 'rename', 'prompt', 'cancel', 'updateQueue'])
const streams = new Set(['follow', 'observeState', 'observeEvent', 'observeProjections'])
const actions = [...unary, ...streams].map(name => `session/${name}` as const)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session request must be an object')
  return value as Record<string, unknown>
}
function target(request: Record<string, unknown>): string {
  const address = request.address === undefined ? undefined : object(request.address)
  if (address && (address.kind !== 'session' || request.sessionId !== undefined)) throw new Error('Only an owned ordinary Session address is accepted')
  const ref = address?.sessionId ?? request.sessionId
  if (typeof ref !== 'string' || !/^session-[a-f0-9]{32}$/u.test(ref)) throw new Error('A managed Session identity is required')
  return ref
}
async function workspace(root: string, id: string): Promise<string> {
  const absolute = resolve(root)
  if (!isAbsolute(root) || absolute === '/') throw new Error('A dedicated absolute Session workspace root is required')
  let path = '/'
  for (const part of [...absolute.split('/').filter(Boolean), id]) {
    path = join(path, part)
    try { await mkdir(path) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Session workspace contains a symlink or non-directory')
  }
  return path
}
export function createSessionTransport(ctx: Context, config: SessionTransportConfig, token: string, authorizeProject: (principal: Principal) => Promise<void>, fetcher?: typeof fetch): AuthenticatedSessionTransport {
  if (![config.nodeId, config.projectId, config.provider, config.model].every(v => typeof v === 'string' && v.trim()) || !isAbsolute(config.workspaceRoot)) throw new Error('Dynamic Session transport requires a fixed node, project, workspace and model')
  const connection = ctx.get('connection') as unknown as Connection | undefined
  const gateway = ctx.get('typertGateway') as unknown as TypertGateway | undefined
  const access = ctx.get('remoteAccess') as unknown as Access | undefined
  const meters = ctx.get('meteringScope') as SessionMeterScope | undefined
  const persistence = ctx.get('sessionPersistence')
  if (!connection || !gateway || !access || !meters || !persistence || !ctx.get('sessionQuery') || !ctx.get('agents')) throw new Error('Dynamic Session transport requires connection, Gateway, access, agents, persistence, query and metering')
  const owners = new SessionOwnerClient(config.authorityUrl, token, fetcher)
  const grants = new Map<string, readonly RemoteAccessBinding[]>()
  const known = new Map<string, SessionOwner>()
  const pendingInputs = new Set<string>()
  const prepared = new WeakSet<Agent>()
  const authorities = new Map<string, () => Promise<void>>()
  const polls = new Map<string, ReturnType<typeof setInterval>>()
  const handles = new Set<AgentHandle>()
  const releasePolicy = access.registerPolicy('lumo-user', { bindings: p => grants.get(p.requestId) ?? [] })
  const remember = (ref: string, owner: SessionOwner): void => {
    if (!known.has(ref) && known.size >= 512) throw new Error('Authenticated Session identity capacity reached')
    known.set(ref, owner)
  }
  const prepare = (agent: Agent, owner: SessionOwner): void => {
    if (prepared.has(agent)) return
    // The public creation announcement runs before queued durable work wakes.
    // A crash must not silently charge for another execution of old input.
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      pendingInputs.add(owner.session_ref)
      throw new PendingSessionInputError()
    }
    pendingInputs.delete(owner.session_ref)
    if (ctx.agents.list().filter(current => prepared.has(current)).length >= 64) throw new Error('Authenticated Session active capacity reached')
    agent.ctx.tools.restrict({ allow: [] })
    agent.ctx.tools.guard(() => 'Authenticated Session text execution does not grant tool access')
    agent.model.select({ provider: config.provider, model: config.model })
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const authority = authorities.get(owner.session_ref)
      if (!authority) return { kind: 'reject' }
      try { await authority(); return next() } catch { agent.cancel({ kind: 'parent' }); return { kind: 'reject' } }
    })
    const release = meters.bind(owner.session_ref, { context: { userId: owner.owner_user_id, projectId: owner.project_id,
      agentId: 'lumo-user-session', componentId: 'user-auth', feature: 'session:text' }, traceId: `session:${owner.session_ref}` })
    agent.ctx.effect(() => release, 'lumo-user: meter attribution')
    prepared.add(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    const owner = known.get(agent.id)
    if (owner) prepare(agent, owner)
    return undefined
  })
  ctx.effect(() => async () => { releasePolicy(); grants.clear(); known.clear(); pendingInputs.clear(); authorities.clear(); for (const timer of polls.values()) clearInterval(timer); polls.clear(); await Promise.allSettled([...handles].map(h => h.dispose())) }, 'lumo-user: Session transport')
  async function own(principal: Principal, ref: string): Promise<SessionOwner> {
    const owner = await owners.get(principal.realm, ref)
    if (owner.state !== 'active' || owner.owner_user_id !== principal.user_id || owner.project_id !== config.projectId || owner.node_id !== config.nodeId) throw new Error('Session ownership does not authorize this user, project and node')
    const live = ctx.agents.get(SessionId(ref))
    if (live && !prepared.has(live)) throw new Error('Session Agent predates its authenticated execution scope')
    remember(ref, owner)
    return owner
  }
  async function peerFor(principal: Principal, refs: string[], signal: AbortSignal): Promise<{ peer: PeerScope; close(): Promise<void> }> {
    signal.throwIfAborted()
    const requestId = randomUUID()
    const peer = connection!.createPeer({ principal: { kind: 'lumo-user', realm: principal.realm, userId: principal.user_id, requestId }, interactions: 'none' })
    grants.set(requestId, refs.map(id => ({ role: { name: 'lumo:user-session', resource: 'session', actions }, resource: { kind: 'session', id: SessionId(id) } })))
    const abort = () => { void peer.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    return { peer, close: async () => { grants.delete(requestId); signal.removeEventListener('abort', abort); await peer.dispose() } }
  }
  async function create(principal: Principal, request: Record<string, unknown>, signal: AbortSignal, authority?: () => Promise<void>): Promise<unknown> {
    if (handles.size >= 64) throw new Error('Authenticated Session active capacity reached')
    if (!authority) throw new Error('Authenticated creation requires a current login authority')
    await authority()
    if (Object.keys(request).length) throw new Error('Session create does not accept a caller identity, path, model or parent')
    const reserved = await owners.reserve({ realm: principal.realm, owner_user_id: principal.user_id, project_id: config.projectId, node_id: config.nodeId, parent_session_ref: '' })
    const owner = reserved.owner
    const id = SessionId(owner.session_ref)
    if (ctx.sessions.get(id) || await persistence!.stat(id)) throw new Error('Reserved Session already exists; refusing legacy adoption')
    const cwd = await workspace(config.workspaceRoot, owner.session_ref)
    remember(owner.session_ref, owner)
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, signal, agentOptions: { provider: config.provider, model: config.model }, setup: (_scope, agent) => { prepare(agent, owner) } })
    handles.add(handle)
    try {
      await persistence!.flush()
      signal.throwIfAborted()
      await authority()
      await owners.activate(owner.realm, owner.session_ref, reserved.creation_token)
      return { sessionId: owner.session_ref }
    } catch (error) {
      await handle.dispose().catch(() => {})
      handles.delete(handle)
      throw error
    }
  }
  return {
    async execute(principal, action, request, signal, authority) {
      await authorizeProject(principal)
      signal.throwIfAborted()
      if (action === 'create') return create(principal, request, signal, authority)
      if (action === 'list') {
        if (Object.keys(request).some(k => k !== 'after') || (request.after !== undefined && typeof request.after !== 'string')) throw new Error('Invalid Session list cursor')
        const page = await owners.list(principal.realm, principal.user_id, config.nodeId, request.after as string | undefined)
        return { ...page, owners: page.owners.filter(owner => owner.project_id === config.projectId) }
      }
      if (!unary.has(action)) throw new Error('Session action is not available in the authenticated text profile')
      const ref = target(request)
      await own(principal, ref)
      if (action === 'prompt') {
        if (!authority) throw new Error('Authenticated prompt requires a current login authority')
        await authority()
        authorities.set(ref, authority)
        if (!polls.has(ref)) {
          const timer = setInterval(() => {
            const agent = ctx.agents.get(SessionId(ref))
            if (!agent || agent.status !== 'running') { clearInterval(timer); polls.delete(ref); authorities.delete(ref); return }
            void authorities.get(ref)?.().catch(() => { agent.cancel({ kind: 'parent' }); authorities.delete(ref) })
          }, 1000)
          timer.unref(); polls.set(ref, timer)
        }
      }
      const call = await peerFor(principal, [ref], signal)
      try { return await gateway!.invoke({ namespace: 'session', method: action, args: { request }, peer: call.peer, signal }) }
      catch (error) {
        // The public controller wraps Agent initialization errors. Preserve the
        // local admission failure without parsing its remote error message.
        if (pendingInputs.has(ref)) throw new PendingSessionInputError()
        throw error
      }
      finally { await call.close() }
    },
    async stream(principal, action, request, signal) {
      await authorizeProject(principal)
      if (!streams.has(action)) throw new Error('Session stream is not available')
      const ref = target(request)
      await own(principal, ref)
      const call = await peerFor(principal, [ref], signal)
      try {
        const source = await gateway!.stream({ namespace: 'session', method: action, args: { request }, peer: call.peer, signal })
        return (async function* () { try { for await (const item of source) { signal.throwIfAborted(); yield item } } finally { await call.close() } })()
      } catch (error) { await call.close(); throw error }
    },
  }
}
