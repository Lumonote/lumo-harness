/** Durable local-owner receipts, fenced before Session creation and prompt admission. */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DesktopPetReceipt, DesktopPetReceiptClaim, DesktopPetReceiptUpdate, DesktopPetUploadReceipt } from './desktop-pet-receipt-types.ts'

interface KvUnit {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  close(): Promise<void>
}
interface StorageBackend { kv?: { open(descriptor: { name: string; version: number; tables: readonly string[]; hasGlobal: boolean; layout: 'per-record' }): Promise<KvUnit> } }
interface ServiceContext { get(name: string): unknown }
interface BrowserConnection { browserPeer: object; admit(req: IncomingMessage): { peer: object } | { rejection: number } }
const PREFIX = '/lumo/api/desktop-pet/receipts'
const LEASE_MS = 120_000
const CAPACITY = 10_000
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const phases = new Set(['preparing', 'creating', 'submitting', 'accepted'])
const failures = new Set(['preparation-failed', 'admission-rejected', 'cancelled'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function uploads(value: unknown): value is DesktopPetUploadReceipt[] {
  return Array.isArray(value) && value.length <= 4 && value.every(item => object(item) && Object.keys(item).every(key => key === 'receiptId' || key === 'file')
    && bounded(item['receiptId'], 256) && (item['file'] === undefined || (object(item['file'])
      && Object.keys(item['file']).every(key => ['attachmentId', 'name', 'bytes'].includes(key))
      && bounded(item['file']['attachmentId'], 256) && bounded(item['file']['name'], 255) && integer(item['file']['bytes']) && item['file']['bytes'] <= 8 * 1024 * 1024)))
}
function validClaim(value: unknown): value is DesktopPetReceiptClaim {
  return object(value) && Object.keys(value).length === 4 && typeof value['id'] === 'string' && idPattern.test(value['id'])
    && typeof value['digest'] === 'string' && digestPattern.test(value['digest']) && bounded(value['owner'], 128) && bounded(value['workspaceId'], 4096)
}
function validUpdate(value: unknown): value is DesktopPetReceiptUpdate {
  return object(value) && Object.keys(value).every(key => ['id', 'digest', 'owner', 'revision', 'phase', 'sessionId', 'hostRequestId', 'uploads', 'failure'].includes(key))
    && typeof value['id'] === 'string' && idPattern.test(value['id']) && typeof value['digest'] === 'string' && digestPattern.test(value['digest'])
    && bounded(value['owner'], 128) && integer(value['revision']) && phases.has(value['phase'] as string)
    && (value['sessionId'] === undefined || bounded(value['sessionId'], 256)) && (value['hostRequestId'] === undefined || bounded(value['hostRequestId'], 256))
    && (value['uploads'] === undefined || uploads(value['uploads'])) && (value['failure'] === undefined || failures.has(value['failure'] as string))
}
function validRecord(value: unknown): value is DesktopPetReceipt {
  if (!object(value)) return false
  const { workspaceId, epoch, leaseUntil, updatedAt, ...update } = value
  return validUpdate(update) && bounded(workspaceId, 4096) && bounded(epoch, 128) && integer(leaseUntil) && integer(updatedAt) && uploads(value['uploads'])
    && (value['phase'] === 'preparing' || value['phase'] === 'creating' || bounded(value['sessionId'], 256))
    && (value['phase'] !== 'submitting' || bounded(value['hostRequestId'], 256))
}
export class DesktopPetReceiptError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}

/** One serialized writer owns the SQLite unit; no browser or peer ID is trusted as an account scope. */
export class DesktopPetReceiptStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly unit: KvUnit, private readonly epoch = randomUUID(), private readonly now = Date.now,
    private readonly lockFile = join(homedir(), '.lumo', 'desktop-pet', 'receipts')) {}
  private async load(): Promise<Map<string, { scope: string; receipt: DesktopPetReceipt }>> {
      const snapshot = await this.unit.loadAll()
      const records = new Map<string, { scope: string; receipt: DesktopPetReceipt }>()
      for (const [key, value] of Object.entries(snapshot.tables['requests'] ?? {})) {
        if (!object(value) || Object.keys(value).length !== 2 || typeof value['scope'] !== 'string' || !digestPattern.test(value['scope']) || !validRecord(value['receipt'])
          || key !== this.key(value['scope'], value['receipt'].id)) throw new DesktopPetReceiptError('receipt_storage_invalid', 503)
        records.set(key, value as unknown as { scope: string; receipt: DesktopPetReceipt })
      }
      return records
  }
  private key(scope: string, id: string): string { return createHash('sha256').update(`${scope}\0${id}`).digest('hex') }
  private serial<T>(action: (records: Map<string, { scope: string; receipt: DesktopPetReceipt }>) => Promise<T>): Promise<T> {
    // KV upserts are atomic, but a read/CAS/write is not. All participating
    // local Hosts lock and reread the medium, including after another process
    // or window has changed it. A live PID is never displaced by lock age.
    const result = this.queue.then(async () => {
      await mkdir(dirname(this.lockFile), { recursive: true, mode: 0o700 })
      return withFileLock(this.lockFile, async () => action(await this.load()), { waitMs: 2000 })
    })
    this.queue = result.catch(() => {})
    return result
  }
  private async save(records: Map<string, { scope: string; receipt: DesktopPetReceipt }>, scope: string, record: DesktopPetReceipt): Promise<DesktopPetReceipt> {
    const key = this.key(scope, record.id)
    // Update the readable state only after durability; a failed write can never grant a send lease.
    await this.unit.putRecord('requests', key, { scope, receipt: record })
    records.set(key, { scope, receipt: record })
    return structuredClone(record)
  }
  claim(scope: string, input: DesktopPetReceiptClaim): Promise<{ record: DesktopPetReceipt; acquired: boolean }> {
    return this.serial(async records => {
      const before = records.get(this.key(scope, input.id))?.receipt
      if (before !== undefined) {
        if (before.digest !== input.digest) throw new DesktopPetReceiptError('receipt_payload_conflict')
        if (before.phase !== 'preparing') return { record: structuredClone(before), acquired: before.owner === input.owner && before.epoch === this.epoch }
        if (before.owner !== input.owner && before.epoch === this.epoch && before.leaseUntil > this.now()) return { record: structuredClone(before), acquired: false }
      } else if ([...records.values()].filter(item => item.scope === scope).length >= CAPACITY) {
        // Never evict a send tombstone: removing it would make an old native request replayable.
        throw new DesktopPetReceiptError('receipt_storage_full', 503)
      }
      const transferred = before !== undefined && (before.owner !== input.owner || before.epoch !== this.epoch)
      const record: DesktopPetReceipt = { ...(before ?? input), phase: 'preparing', revision: (before?.revision ?? 0) + 1,
        owner: input.owner, epoch: this.epoch, leaseUntil: this.now() + LEASE_MS, updatedAt: this.now(), uploads: transferred ? [] : before?.uploads ?? [] }
      return { record: await this.save(records, scope, record), acquired: true }
    })
  }
  update(scope: string, input: DesktopPetReceiptUpdate): Promise<DesktopPetReceipt> {
    return this.serial(async records => {
      const before = records.get(this.key(scope, input.id))?.receipt
      if (!before || before.digest !== input.digest || before.owner !== input.owner || before.revision !== input.revision || before.epoch !== this.epoch) throw new DesktopPetReceiptError('receipt_lease_conflict')
      const allowed = before.phase === 'preparing' ? ['preparing', 'creating', 'submitting', 'accepted']
        : before.phase === 'creating' ? ['preparing'] : before.phase === 'submitting' ? ['accepted', ...(input.failure === 'admission-rejected' ? ['preparing'] : [])] : []
      const record = { ...before, ...input, revision: before.revision + 1, leaseUntil: this.now() + LEASE_MS, updatedAt: this.now() }
      if (input.failure === undefined) delete record.failure
      if (!allowed.includes(input.phase) || (before.sessionId && input.sessionId && before.sessionId !== input.sessionId)
        || (before.phase === 'creating' && !record.sessionId) || !validRecord(record)) throw new DesktopPetReceiptError('receipt_transition_invalid')
      return this.save(records, scope, record)
    })
  }
  async close(): Promise<void> { await this.queue; await this.unit.close() }
}

/** BrowserAuth persists this grant per Harness home. Its domain-separated HMAC identifies the actual local owner; it is never sent to the browser. */
export async function desktopPetOwnerScope(ctx: ServiceContext): Promise<string> {
  const credentials = ctx.get('credentials') as { readRecord(key: string): Promise<unknown> } | undefined
  const record = await credentials?.readRecord('client-connection/browser-session')
  const payload = object(record) && record['kind'] === 'grant' && object(record['payload']) ? record['payload'] : undefined
  if (payload?.['version'] !== 1 || typeof payload['secret'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(payload['secret'])) throw new DesktopPetReceiptError('receipt_owner_unavailable', 503)
  const secret = Buffer.from(payload['secret'], 'base64url')
  if (secret.length !== 32 || secret.toString('base64url') !== payload['secret']) throw new DesktopPetReceiptError('receipt_owner_unavailable', 503)
  return createHmac('sha256', secret).update('lumo-desktop-pet-receipts/local-owner/v1').digest('hex')
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff')
  res.writeHead(status); res.end(JSON.stringify(value))
}
export function desktopPetReceiptsHandler(ctx: ServiceContext, local: boolean, store: () => DesktopPetReceiptStore | undefined) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!local) { json(res, 404, { error: 'desktop_pet_local_only' }); return }
    const connection = ctx.get('connection') as BrowserConnection | undefined
    if (!connection) { json(res, 503, { error: 'browser_auth_unavailable' }); return }
    const admission = connection.admit(req)
    if ('rejection' in admission || admission.peer !== connection.browserPeer) { json(res, 'rejection' in admission ? admission.rejection : 403, { error: 'browser_auth_required' }); return }
    const path = new URL(req.url ?? '/', 'http://local.invalid').pathname
    const action = path === `${PREFIX}/claim` ? 'claim' : path === `${PREFIX}/update` ? 'update' : undefined
    if (!action) { json(res, 404, { error: 'unknown_receipt_endpoint' }); return }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); json(res, 405, { error: 'method_not_allowed' }); return }
    const protocol = (ctx.get('webServer') as { protocol?: string } | undefined)?.protocol
    let origin: string | undefined
    try { if (protocol === 'http:' || protocol === 'https:') origin = new URL(`${protocol}//${req.headers.host ?? ''}`).origin } catch { /* fail closed */ }
    if (!origin || req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'same_origin_required' }); return }
    if (!/^application\/json(?:\s*;|\s*$)/iu.test(req.headers['content-type'] ?? '')) { json(res, 415, { error: 'json_required' }); return }
    try {
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of req) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 16_384) throw new DesktopPetReceiptError('body_too_large', 413); chunks.push(data) }
      let input: unknown
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DesktopPetReceiptError('invalid_json', 400) }
      if (!(action === 'claim' ? validClaim(input) : validUpdate(input))) throw new DesktopPetReceiptError('invalid_receipt_metadata', 400)
      const active = store()
      if (!active) throw new DesktopPetReceiptError('receipt_storage_unavailable', 503)
      const scope = await desktopPetOwnerScope(ctx)
      const result = action === 'claim' ? await active.claim(scope, input as DesktopPetReceiptClaim) : await active.update(scope, input as DesktopPetReceiptUpdate)
      json(res, 200, result)
    } catch (error) { json(res, error instanceof DesktopPetReceiptError ? error.status : 503, { error: error instanceof DesktopPetReceiptError ? error.code : 'receipt_storage_unavailable' }) }
  }
}
export function registerDesktopPetReceiptRoutes(ctx: Context, local: boolean): void {
  let store: DesktopPetReceiptStore | undefined
  if (local) ctx.inject(['storage', 'storage.backend.sqlite', 'credentials', 'connection'], storageCtx => {
    const backend = (storageCtx.get('storage') as { backend: { get(name: string): StorageBackend | undefined } } | undefined)?.backend.get('sqlite')
    if (!backend?.kv) return
    let disposed = false
    const opening = backend.kv.open({ name: 'lumo_desktop_pet_receipts', version: 1, tables: ['requests'], hasGlobal: false, layout: 'per-record' }).then(unit => {
      const opened = new DesktopPetReceiptStore(unit)
      if (disposed) return opened.close()
      store = opened
    }).catch(() => { /* API remains unavailable; never substitute memory for durability. */ })
    storageCtx.effect(() => async () => { disposed = true; await opening; const opened = store; store = undefined; await opened?.close() }, 'lumo-ui: desktop receipt storage')
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: desktopPetReceiptsHandler(ctx, local, () => store) }), 'lumo-ui: authenticated desktop receipts')
}
