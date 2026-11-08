import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'
import { boundedJSON, type SessionExecutionRuntime } from '../../../shared/session-execution.ts'
import { SessionOwnerClient } from '../../../shared/session-owners.ts'
import type { Principal } from './client.ts'
import type { SessionAuthority, SessionTransportConfig } from './session-transport.ts'
import { captureWorkspace, migrationDirectory, MIGRATION_SNAPSHOT_MAX_BYTES, parseMigrationSnapshot, restoreMigrationSnapshot, snapshotHash, type MigrationSnapshot } from './session-migration-snapshot.ts'

export class SessionMigrationError extends Error {
  constructor(readonly code: 'session_migration_busy' | 'session_migration_frozen' | 'session_migration_unavailable' | 'session_migration_invalid' | 'session_migration_unknown') { super(code) }
}
export interface MigrationReceipt {
  id: string; session_ref: string; realm: string; owner_user_id: string; project_id: string
  source_node_id: string; target_node_id: string; source_process_id: string; source_node_fence: number; source_fencing_token: number
  snapshot_key: string; snapshot_sha256: string; snapshot_bytes: number; event_count: number; state: 'checkpointed' | 'activated'; created_at: string; activated_at?: string
}
export const migrationActions = new Set(['checkpoint', 'recover', 'migrationStatus'])
export class SessionMigrationClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetcher: typeof fetch = globalThis.fetch) {}
  async call(ref: string, suffix: string, body?: unknown, signal?: AbortSignal): Promise<MigrationReceipt | undefined> {
    const active = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    let res: Response
    try { res = await this.fetcher(`${this.base.replace(/\/+$/u, '')}/v1/session-migrations/${encodeURIComponent(ref)}${suffix}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: active, headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) } catch { throw new SessionMigrationError(body === undefined ? 'session_migration_unavailable' : 'session_migration_unknown') }
    if (res.status === 404 && body === undefined) { void res.body?.cancel(); return }
    if (!res.ok) { void res.body?.cancel(); throw new SessionMigrationError(res.status === 409 ? 'session_migration_frozen' : res.status < 500 ? 'session_migration_invalid' : body === undefined ? 'session_migration_unavailable' : 'session_migration_unknown') }
    let value: MigrationReceipt
    try { value = (await boundedJSON(res, 8192, active)).migration as MigrationReceipt } catch { throw new SessionMigrationError(body === undefined ? 'session_migration_unavailable' : 'session_migration_unknown') }
    if (!value || !/^mig_[a-f0-9]{48}$/u.test(value.id) || value.session_ref !== ref || !value.realm || !value.owner_user_id || !value.project_id || !value.source_node_id || !value.target_node_id || !/^[a-f0-9]{64}$/u.test(value.snapshot_sha256) || value.snapshot_key !== `session-migration/v1/${ref}/${value.id}/${value.snapshot_sha256}` || !Number.isSafeInteger(value.snapshot_bytes) || value.snapshot_bytes < 1 || value.snapshot_bytes > MIGRATION_SNAPSHOT_MAX_BYTES || !Number.isSafeInteger(value.event_count) || value.event_count < 0 || value.event_count > 10000 || !['checkpointed', 'activated'].includes(value.state)) {
      // A successful mutation with an invalid receipt may already have
      // committed. Keep the UI frozen until a separate authoritative read
      // resolves the result; malformed JSON and malformed facts are equally
      // unable to prove whether the owner moved.
      throw new SessionMigrationError(body === undefined ? 'session_migration_unavailable' : 'session_migration_unknown')
    }
    // Internal responses are untrusted data. Construct the public fact instead
    // of returning arbitrary fields, which could accidentally include a proof.
    return { id: value.id, session_ref: value.session_ref, realm: value.realm, owner_user_id: value.owner_user_id, project_id: value.project_id,
      source_node_id: value.source_node_id, target_node_id: value.target_node_id, source_process_id: value.source_process_id,
      source_node_fence: value.source_node_fence, source_fencing_token: value.source_fencing_token,
      snapshot_key: value.snapshot_key, snapshot_sha256: value.snapshot_sha256, snapshot_bytes: value.snapshot_bytes, event_count: value.event_count,
      state: value.state, created_at: value.created_at, ...(value.activated_at ? { activated_at: value.activated_at } : {}) }
  }
  get(realm: string, ref: string, id?: string, signal?: AbortSignal) { return this.call(ref, '?' + new URLSearchParams({ realm, ...(id ? { id } : {}) }), undefined, signal) }
}
interface MigrationHost {
  quiesce<T>(ref: string, signal: AbortSignal, run: () => Promise<T>): Promise<T>
  close(ref: string): Promise<void>
  resume(principal: Principal, ref: string, signal: AbortSignal): Promise<void>
}
/** Explicit opt-in; idle text/knowledge/attachment Sessions only. Connector
 * effects need a separate complete receipt set and are deliberately refused. */
export class OwnedSessionMigration {
  readonly client: SessionMigrationClient
  private readonly owners: SessionOwnerClient
  private readonly blocked = new Set<string>()
  private readonly active = new Map<string, number>()
  private readonly restoring = new Set<string>()
  private readonly policySHA: string
  private readonly objectStore: ObjectStoreSeam
  constructor(private readonly ctx: Context, private readonly config: SessionTransportConfig, token: string, private readonly runtime: SessionExecutionRuntime, private readonly persistence: SessionPersistence, private readonly host: MigrationHost, private readonly authorizeProject: (principal: Principal) => Promise<void>, fetcher?: typeof fetch) {
    if (!config.migration || config.migration.enabled !== true || Object.keys(config.migration).some(key => key !== 'enabled') || config.connectors || !config.routing || Object.keys(config.routing.routes).length < 2 || process.platform === 'win32') throw new Error('Session migration requires explicit enablement, trusted node routes, portable absolute workspaces and a read-only Session tool profile')
    const store = ctx.get('objectStore') as ObjectStoreSeam | undefined
    if (!store || !ctx.get('sessionLog') || !ctx.get('sessionLogReplication') || !ctx.get('recovery')) throw new Error('Session migration requires shared object storage, durable replicated log and recovery journal')
    this.objectStore = store; this.client = new SessionMigrationClient(config.authorityUrl, token, fetcher); this.owners = new SessionOwnerClient(config.authorityUrl, token, fetcher)
    this.policySHA = snapshotHash(JSON.stringify({ provider: config.provider, model: config.model, choices: config.modelChoices ?? [] }))
  }
  assert(ref: string): void { if (this.blocked.has(ref)) throw new SessionMigrationError('session_migration_frozen') }
  enter(ref: string): () => void { this.assert(ref); this.active.set(ref, (this.active.get(ref) ?? 0) + 1); return () => { const count = (this.active.get(ref) ?? 1) - 1; if (count) this.active.set(ref, count); else this.active.delete(ref) } }
  private async authorize(principal: Principal, ref: string, authority?: SessionAuthority) {
    if (!authority) throw new SessionMigrationError('session_migration_invalid')
    const current = await authority()
    if (current && (current.realm !== principal.realm || current.user_id !== principal.user_id)) throw new SessionMigrationError('session_migration_invalid')
    await this.authorizeProject(principal)
    const owner = await this.owners.get(principal.realm, ref)
    if (owner.state !== 'active' || owner.owner_user_id !== principal.user_id || owner.project_id !== this.config.projectId) throw new SessionMigrationError('session_migration_invalid')
    return owner
  }
  private matches(receipt: MigrationReceipt, principal: Principal) { if (receipt.realm !== principal.realm || receipt.owner_user_id !== principal.user_id || receipt.project_id !== this.config.projectId) throw new SessionMigrationError('session_migration_invalid'); return receipt }
  private async readBlob(receipt: MigrationReceipt, signal: AbortSignal): Promise<Buffer> {
    const stat = await this.objectStore.stat(receipt.realm, receipt.snapshot_key)
    if (stat?.bytes !== receipt.snapshot_bytes) throw new SessionMigrationError('session_migration_invalid')
    let data: Buffer
    if (this.objectStore.getStream) {
      const stream = await this.objectStore.getStream(receipt.realm, receipt.snapshot_key, signal)
      if (!stream || stream.bytes !== receipt.snapshot_bytes) throw new SessionMigrationError('session_migration_invalid')
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of stream.body) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > receipt.snapshot_bytes) throw new SessionMigrationError('session_migration_invalid'); chunks.push(Buffer.from(chunk)) }
      data = Buffer.concat(chunks)
    } else { const stored = await this.objectStore.get(receipt.realm, receipt.snapshot_key); if (!stored) throw new SessionMigrationError('session_migration_invalid'); data = stored.body }
    signal.throwIfAborted(); if (data.length !== receipt.snapshot_bytes || snapshotHash(data) !== receipt.snapshot_sha256) throw new SessionMigrationError('session_migration_invalid'); return data
  }
  async execute(principal: Principal, action: string, request: Record<string, unknown>, signal: AbortSignal, authority?: SessionAuthority): Promise<unknown> {
    await this.runtime.check()
    signal = AbortSignal.any([signal, this.runtime.signal])
    signal.throwIfAborted()
    const ref = request.sessionId
    if (typeof ref !== 'string' || !/^session-[a-f0-9]{32}$/u.test(ref) || Object.keys(request).some(key => !['sessionId', ...(action === 'checkpoint' ? ['targetNodeId'] : action === 'recover' ? ['migrationId'] : [])].includes(key))) throw new SessionMigrationError('session_migration_invalid')
    const owner = await this.authorize(principal, ref, authority)
    if (action === 'migrationStatus') { const receipt = await this.client.get(principal.realm, ref, undefined, signal); return { migration: receipt ? this.matches(receipt, principal) : null, targets: Object.keys(this.config.routing!.routes).filter(id => id !== owner.node_id) } }
    if (action === 'recover') {
      if (typeof request.migrationId !== 'string' || !/^mig_[a-f0-9]{48}$/u.test(request.migrationId) || this.restoring.has(ref)) throw new SessionMigrationError('session_migration_busy')
      this.restoring.add(ref)
      try {
        const receipt = await this.client.get(principal.realm, ref, request.migrationId, signal)
        if (!receipt || this.matches(receipt, principal).target_node_id !== this.config.nodeId) throw new SessionMigrationError('session_migration_invalid')
        if (receipt.state === 'checkpointed') {
          const data = await this.readBlob(receipt, signal)
          let snapshot: MigrationSnapshot
          try { snapshot = parseMigrationSnapshot(data, { realm: principal.realm, ownerUserID: principal.user_id, projectID: this.config.projectId, sessionRef: ref, cwd: join(this.config.workspaceRoot, ref), eventCount: receipt.event_count, modelPolicySHA: this.policySHA }) } catch { throw new SessionMigrationError('session_migration_invalid') }
          try { await restoreMigrationSnapshot(this.persistence, this.config.workspaceRoot, receipt.id, receipt.snapshot_sha256, snapshot, signal) }
          catch (error) {
            signal.throwIfAborted()
            if (error instanceof SessionAlreadyOwnedError || error instanceof Error && error.message.startsWith('atomic-write: timed out waiting for the writer lock')) throw new SessionMigrationError('session_migration_busy')
            if (error instanceof Error && error.message === 'Session migration snapshot failed bounded integrity validation') throw new SessionMigrationError('session_migration_invalid')
            throw new SessionMigrationError('session_migration_unavailable')
          }
          await this.authorize(principal, ref, authority); signal.throwIfAborted()
          await this.client.call(ref, `/${receipt.id}/activate`, { owner_user_id: principal.user_id, snapshot_sha256: receipt.snapshot_sha256, execution: await this.runtime.nodeProof() }, signal)
        }
        await this.authorize(principal, ref, authority)
        await this.host.resume(principal, ref, signal)
        const current = await this.client.get(principal.realm, ref, receipt.id, signal)
        if (!current || current.state !== 'activated') throw new SessionMigrationError('session_migration_unknown')
        return { migration: this.matches(current, principal), ready: true }
      } catch (error) {
        if (error instanceof SessionMigrationError) throw error
        signal.throwIfAborted()
        throw new SessionMigrationError('session_migration_unavailable')
      } finally { this.restoring.delete(ref) }
    }
    if (action !== 'checkpoint' || owner.node_id !== this.config.nodeId || typeof request.targetNodeId !== 'string' || request.targetNodeId === this.config.nodeId || !Object.hasOwn(this.config.routing!.routes, request.targetNodeId)) throw new SessionMigrationError('session_migration_invalid')
    const previous = await this.client.get(principal.realm, ref, undefined, signal)
    if (previous?.state === 'checkpointed') { if (this.matches(previous, principal).target_node_id !== request.targetNodeId) throw new SessionMigrationError('session_migration_frozen'); this.blocked.add(ref); await this.runtime.retire(ref); await this.host.close(ref); return { migration: previous } }
    // A restarted source must acquire its current generation before native
    // resume/flush opens a replicated writer during checkpoint capture.
    await this.runtime.ensure(ref)
    if (this.blocked.has(ref) || (this.active.get(ref) ?? 0) > 0) throw new SessionMigrationError('session_migration_busy')
    this.blocked.add(ref)
    let freezing = false
    try {
      const receipt = await this.host.quiesce(ref, signal, async () => {
        const journal = this.ctx.get('recovery') as { orphans(ref: string): Promise<unknown[]> }
        if ((await journal.orphans(ref)).length) throw new SessionMigrationError('session_migration_busy')
        await this.persistence.flush(); await (this.ctx.get('sessionLogReplication') as { flush(): Promise<void> }).flush()
        const handle = await this.persistence.open(SessionId(ref), 'read', { signal })
        let snapshot: MigrationSnapshot
        try {
          const events = [...(await handle.read(0, 10001, { signal })).events]
          if (events.length > 10000) throw new SessionMigrationError('session_migration_invalid')
          const records = await (this.ctx.get('sessionLog') as { read(ref: string): Promise<Array<{ seq: number; payload: unknown }>> }).read(ref)
          if (events.length > 10000 || !isDeepStrictEqual(records.map(row => row.payload), events) || records.some((row, index) => row.seq !== index)) throw new SessionMigrationError('session_migration_invalid')
          const directory = await migrationDirectory(this.config.workspaceRoot, ref)
          if (handle.header.cwd !== directory) throw new SessionMigrationError('session_migration_invalid')
          snapshot = { version: 1, realm: principal.realm, ownerUserID: principal.user_id, projectID: this.config.projectId, sessionRef: ref, modelPolicySHA: this.policySHA, header: handle.header, inheritedEventCount: handle.inheritedEventCount, events, workspace: await captureWorkspace(directory, signal) }
        } finally { await handle.close() }
        const data = Buffer.from(JSON.stringify(snapshot))
        parseMigrationSnapshot(data, { realm: principal.realm, ownerUserID: principal.user_id, projectID: this.config.projectId, sessionRef: ref, cwd: snapshot.header.cwd!, eventCount: snapshot.events.length, modelPolicySHA: this.policySHA })
        const id = 'mig_' + randomBytes(24).toString('hex'), digest = snapshotHash(data), key = `session-migration/v1/${ref}/${id}/${digest}`
        await this.objectStore.put(principal.realm, key, data, 'application/json')
        const provisional = { realm: principal.realm, snapshot_key: key, snapshot_bytes: data.length, snapshot_sha256: digest } as MigrationReceipt
        await this.readBlob(provisional, signal); await this.authorize(principal, ref, authority)
        const execution = await this.runtime.proof(ref)
        // Retire before submitting the freeze. An unknown authority response
        // leaves this process closed; query the receipt instead of replaying.
        freezing = true; await this.runtime.retire(ref)
        const value = await this.client.call(ref, '/checkpoint', { id, owner_user_id: principal.user_id, target_node_id: request.targetNodeId, snapshot_key: key, snapshot_sha256: digest, snapshot_bytes: data.length, event_count: snapshot.events.length, execution }, signal)
        if (!value) throw new SessionMigrationError('session_migration_unknown')
        return this.matches(value, principal)
      })
      await this.host.close(ref)
      return { migration: receipt }
    } catch (error) {
      if (!freezing) this.blocked.delete(ref)
      if (error instanceof SessionMigrationError) throw error
      signal.throwIfAborted()
      if (freezing) throw new SessionMigrationError('session_migration_unknown')
      if (error instanceof Error && error.message === 'Session migration snapshot failed bounded integrity validation') throw new SessionMigrationError('session_migration_invalid')
      throw new SessionMigrationError('session_migration_unavailable')
    }
  }
}
