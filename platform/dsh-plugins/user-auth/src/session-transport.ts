/** Authenticated first-party Session transport. Never forwards a browser as the
 * shared carrier owner. The supported execution profile is text-only. */
import { mkdir, lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { buildForkSeed, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access/types'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionOwnerClient, type SessionOwner } from '../../../shared/session-owners.ts'
import { SessionExecutionClient, SessionExecutionRuntime, type ExecutionNode } from '../../../shared/session-execution.ts'
import type { SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'
import type { SessionModelBilling } from '../../../shared/seam-contracts/model-billing.ts'
import { SessionModelPolicy, SessionTurnModelGuard, modelSelection, type SessionModelChoice } from './session-model-policy.ts'
import type { Principal } from './client.ts'
import { installSessionKnowledge, USER_SESSION_KNOWLEDGE_TOOL, validateSessionKnowledge, type SessionKnowledgeConfig } from './session-knowledge.ts'

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
  /** Explicit server-approved route + pricing bindings. Omitted keeps the
   * existing single-model profile and does not expose model mutation. */
  modelChoices?: SessionModelChoice[]
  knowledge?: SessionKnowledgeConfig
  routing?: { routes: Record<string, string>; transportSecurity: 'tls' | 'mesh-mtls' | 'development'; nodeIdFromEnvironment?: boolean }
}
export type SessionAuthority = (() => Promise<Principal | void>) & { credential?: string }
export interface AuthenticatedSessionTransport {
  execute(principal: Principal, action: string, request: Record<string, unknown>, signal: AbortSignal, authority?: SessionAuthority): Promise<unknown>
  stream(principal: Principal, action: string, request: Record<string, unknown>, signal: AbortSignal, authority?: SessionAuthority): Promise<AsyncIterable<unknown>>
  /** Internal ingress is never permitted to recurse through a routing wrapper. */
  internal?: { transport: AuthenticatedSessionTransport; destination(node: ExecutionNode): Promise<void> }
  runtime?: SessionExecutionRuntime
}
export class PendingSessionInputError extends Error {
  readonly code = 'session_pending_input'
  constructor() { super('Session has durable pending input; automatic replay is disabled until its history is reviewed') }
}
export class SessionForkUnavailableError extends Error {
  readonly code = 'session_fork_unavailable'
  constructor() { super('Session has no completed turn to fork') }
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
function textOnly(content: unknown): void {
  if (!Array.isArray(content) || content.some(part => !part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string')) throw new Error('Authenticated Session accepts only text message parts')
}
function completedPrefix(events: readonly SessionEvent[]): SessionEvent['seq'] {
  const last = events.findLast(event => event.type === 'turn/end')
  if (!last) throw new SessionForkUnavailableError()
  let boundary = last.seq
  for (const event of events.slice(boundary + 1)) {
    if (event.type === 'turn/start' || event.type === 'agent/inbox/spliced' || event.type === 'user/message' && event.surfaceOp === 'append') break
    boundary = event.seq
  }
  if (events[boundary]?.seq !== boundary) throw new Error('Session fork boundary is invalid')
  return boundary
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
export function createSessionTransport(ctx: Context, config: SessionTransportConfig, token: string, authorizeProject: (principal: Principal) => Promise<void>, fetcher?: typeof fetch, execution?: { realm: string; writerHolder: string; endpoint: string }): AuthenticatedSessionTransport {
  if (![config.nodeId, config.projectId, config.provider, config.model].every(v => typeof v === 'string' && v.trim()) || !isAbsolute(config.workspaceRoot)) throw new Error('Dynamic Session transport requires a fixed node, project, workspace and model')
  const connection = ctx.get('connection') as unknown as Connection | undefined
  const gateway = ctx.get('typertGateway') as unknown as TypertGateway | undefined
  const access = ctx.get('remoteAccess') as unknown as Access | undefined
  const meters = ctx.get('meteringScope') as SessionMeterScope | undefined
  const models = new SessionModelPolicy(config)
  const billing = ctx.get('sessionModelBilling') as SessionModelBilling | undefined
  if (models.dynamic && !billing) throw new Error('Dynamic model selection requires exact model billing admission')
  const persistence = ctx.get('sessionPersistence')
  validateSessionKnowledge(config.knowledge)
  const knowledge = config.knowledge === undefined ? undefined : ctx.get('knowledgeAuthenticatedQuery')
  if (config.knowledge && !knowledge) throw new Error('Dynamic Session knowledge requires a current-user authenticated knowledge query capability')
  if (!connection || !gateway || !access || !meters || !persistence || !ctx.get('sessionQuery') || !ctx.get('agents')) throw new Error('Dynamic Session transport requires connection, Gateway, access, agents, persistence, query and metering')
  const owners = new SessionOwnerClient(config.authorityUrl, token, fetcher)
  const grants = new Map<string, readonly RemoteAccessBinding[]>()
  const known = new Map<string, SessionOwner>()
  const pendingInputs = new Set<string>()
  const prepared = new WeakSet<Agent>()
  const authorities = new Map<string, SessionAuthority>()
  const polls = new Map<string, ReturnType<typeof setInterval>>()
  const handles = new Set<AgentHandle>()
  const resuming = new Map<string, Promise<void>>()
  const runtime = execution ? new SessionExecutionRuntime(new SessionExecutionClient(config.authorityUrl, token, fetcher), execution.realm, config.nodeId, config.projectId, execution.endpoint, execution.writerHolder, () => {
    for (const agent of ctx.agents.list()) if (prepared.has(agent)) agent.cancel({ kind: 'parent' })
    // Disposal closes public write handles. The PG replication backend also
    // checks this generation atomically, including writes queued before expiry.
    void Promise.allSettled([...handles].map(handle => handle.dispose()))
  }) : undefined
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
    agent.ctx.tools.guard(exec => config.knowledge && exec.name === USER_SESSION_KNOWLEDGE_TOOL ? undefined : 'Authenticated Session execution does not grant this tool access')
    if (config.knowledge && knowledge) installSessionKnowledge(agent, knowledge, config.knowledge, config.projectId, async () => {
      const authority = authorities.get(owner.session_ref)
      if (!authority) throw new Error('Knowledge query requires current login authority')
      const principal = await authority()
      if (!principal || principal.user_id !== owner.owner_user_id || principal.realm !== owner.realm) throw new Error('Knowledge query requires the current authenticated Session owner')
      await authorizeProject(principal)
      await own(principal, owner.session_ref)
      return principal
    })
    // Preserve native durable choices on resume/fork; a removed choice never
    // silently becomes another provider. Fixed deployments retain their route.
    if (models.dynamic) models.require(agent.model.current())
    else agent.model.select(modelSelection(models.fallback))
    const turnModels = new SessionTurnModelGuard(models)
    agent.ctx.on('agent/pre-step', async ({ turn, modelSelection: selection }, next) => {
      const authority = authorities.get(owner.session_ref)
      if (!authority) return { kind: 'reject' }
      try { turnModels.check(turn, selection); await runtime?.ensure(owner.session_ref); await authority(); return next() } catch { agent.cancel({ kind: 'parent' }); return { kind: 'reject' } }
    })
    const release = meters.bind(owner.session_ref, { context: { userId: owner.owner_user_id, projectId: owner.project_id,
      agentId: 'lumo-user-session', componentId: 'user-auth', feature: 'session:text' }, traceId: `session:${owner.session_ref}`,
      ...(models.dynamic ? { modelRoutes: models.billingRoutes() } : {}) })
    agent.ctx.effect(() => release, 'lumo-user: meter attribution')
    prepared.add(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    const owner = known.get(agent.id)
    if (owner) prepare(agent, owner)
    return undefined
  })
  ctx.effect(() => async () => { releasePolicy(); grants.clear(); known.clear(); pendingInputs.clear(); authorities.clear(); for (const timer of polls.values()) clearInterval(timer); polls.clear(); await Promise.allSettled([...handles].map(h => h.dispose())); await runtime?.dispose() }, 'lumo-user: Session transport')
  async function own(principal: Principal, ref: string): Promise<SessionOwner> {
    const owner = await owners.get(principal.realm, ref)
    if (owner.state !== 'active' || owner.owner_user_id !== principal.user_id || owner.project_id !== config.projectId || owner.node_id !== config.nodeId) throw new Error('Session ownership does not authorize this user, project and node')
    await runtime?.ensure(ref)
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
  async function create(principal: Principal, signal: AbortSignal, authority?: SessionAuthority, parent = '', seed?: SessionEvent[], inheritedEventCount?: SessionLogOffset): Promise<unknown> {
    if (handles.size >= 64) throw new Error('Authenticated Session active capacity reached')
    if (!authority) throw new Error('Authenticated creation requires a current login authority')
    await authority()
    const reserved = await owners.reserve({ realm: principal.realm, owner_user_id: principal.user_id, project_id: config.projectId, node_id: config.nodeId, parent_session_ref: parent })
    const owner = reserved.owner
    await runtime?.ensure(owner.session_ref)
    const id = SessionId(owner.session_ref)
    if (ctx.sessions.get(id) || await persistence!.stat(id)) throw new Error('Reserved Session already exists; refusing legacy adoption')
    const cwd = await workspace(config.workspaceRoot, owner.session_ref)
    remember(owner.session_ref, owner)
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd, ...(seed === undefined ? {} : { isSeeded: true }) },
      ...(seed === undefined ? {} : { seed }), ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
      signal, agentOptions: { provider: config.provider, model: config.model }, setup: (_scope, agent) => { prepare(agent, owner) } })
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
  async function activeAgent(ref: string, signal: AbortSignal): Promise<Agent> {
    let agent = ctx.agents.get(SessionId(ref))
    if (!agent) {
      let pending = resuming.get(ref)
      if (!pending) {
        const owner = known.get(ref)!
        pending = ctx.agents.resume({ resumeSessionId: SessionId(ref), signal: runtime ? AbortSignal.any([signal, runtime.signal]) : signal,
          agentOptions: { provider: config.provider, model: config.model }, setup: (_scope, current) => prepare(current, owner) })
          .then(handle => { handles.add(handle) }).finally(() => { resuming.delete(ref) })
        resuming.set(ref, pending)
      }
      await pending; agent = ctx.agents.get(SessionId(ref))
    }
    if (!agent || !prepared.has(agent)) throw new Error('Authenticated Session Agent is unavailable')
    return agent
  }
  return {
    ...(runtime ? { runtime } : {}),
    async execute(principal, action, request, signal, authority) {
      if (execution && principal.realm !== execution.realm) throw new Error('Session Realm does not match this execution node')
      await authorizeProject(principal)
      await runtime?.check()
      signal.throwIfAborted()
      if (action === 'create') {
        if (Object.keys(request).length) throw new Error('Session create does not accept a caller identity, path, model or parent')
        return create(principal, signal, authority)
      }
      if (action === 'fork') {
        if (Object.keys(request).some(key => key !== 'sessionId')) throw new Error('Session fork accepts only its source Session identity')
        const ref = target(request)
        if (!authority) throw new Error('Authenticated fork requires a current login authority')
        await authority()
        await own(principal, ref)
        using source = await ctx.sessionQuery.observeSession(SessionId(ref))
        const boundary = completedPrefix(source.events)
        // Public fork seed construction closes the copied history. The child gets
        // a fresh authority ID and workspace; browser-supplied metadata is never inherited.
        return await create(principal, signal, authority, ref, buildForkSeed(source.events, boundary), SessionLogOffset(boundary + 1))
      }
      if (action === 'list') {
        if (Object.keys(request).some(k => k !== 'after') || (request.after !== undefined && typeof request.after !== 'string')) throw new Error('Invalid Session list cursor')
        const page = await owners.list(principal.realm, principal.user_id, config.nodeId, request.after as string | undefined)
        return { ...page, owners: page.owners.filter(owner => owner.project_id === config.projectId) }
      }
      if (!unary.has(action) && action !== 'models' && action !== 'selectModel') throw new Error('Session action is not available in the authenticated text profile')
      const ref = target(request)
      await own(principal, ref)
      if (action === 'models' || action === 'selectModel') {
        if (!authority) throw new Error('Authenticated model selection requires current login authority')
        await authority()
        if (action === 'models' && Object.keys(request).some(key => key !== 'sessionId')) throw new Error('Model catalog accepts only its owned Session identity')
        const agent = await activeAgent(ref, signal)
        if (action === 'models') return models.view(agent)
        return models.select(agent, request, {
          authorize: async () => { signal.throwIfAborted(); await authority(); await authorizeProject(principal); await own(principal, ref) },
          admit: route => billing!.quote(route), resolve: selection => ctx.llm.resolveCallConfig(selection, signal), flush: () => persistence!.flush(),
        })
      }
      if (action === 'prompt') textOnly(request.content)
      if (action === 'updateQueue') {
        const update = object(request.action)
        if (update.kind === 'edit') textOnly(update.content)
      }
      if (action === 'prompt') {
        if (!authority) throw new Error('Authenticated prompt requires a current login authority')
        await authority()
        authorities.set(ref, authority)
        if (runtime) await activeAgent(ref, signal)
        if (!polls.has(ref)) {
          const timer = setInterval(() => {
            const agent = ctx.agents.get(SessionId(ref))
            if (!agent || agent.status !== 'running') { clearInterval(timer); polls.delete(ref); authorities.delete(ref); return }
            void authorities.get(ref)?.().catch(() => { agent.cancel({ kind: 'parent' }); authorities.delete(ref) })
          }, 1000)
          timer.unref(); polls.set(ref, timer)
        }
      }
      signal = runtime ? AbortSignal.any([signal,runtime.signal]) : signal
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
    async stream(principal, action, request, signal, authority) {
      await authorizeProject(principal)
      if (!streams.has(action)) throw new Error('Session stream is not available')
      const ref = target(request)
      await own(principal, ref)
      if (authority) await authority()
      signal = runtime ? AbortSignal.any([signal, runtime.signal]) : signal
      const call = await peerFor(principal, [ref], signal)
      try {
        const source = await gateway!.stream({ namespace: 'session', method: action, args: { request }, peer: call.peer, signal })
        return (async function* () { try { for await (const item of source) { signal.throwIfAborted(); await runtime?.ensure(ref); if (authority) await authority(); yield item } } finally { await call.close() } })()
      } catch (error) { await call.close(); throw error }
    },
  }
}
