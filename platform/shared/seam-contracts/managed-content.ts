import { createHash } from 'node:crypto'
import { joinRealmKey } from './object-store.ts'

export const MANAGED_CONTENT_PREFIX = 'managed-content/v1/'
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const relativePattern = new RegExp(`^${MANAGED_CONTENT_PREFIX}(${uuid})/([a-f0-9]{64})$`, 'u')
export function managedContentKey(realm: string, objectId: string, sha256: string): string {
  const relative = `${MANAGED_CONTENT_PREFIX}${objectId}/${sha256}`
  if (!relativePattern.test(relative)) throw new TypeError('Invalid managed content identity')
  return joinRealmKey(realm, relative)
}
export function parseManagedContentKey(realm: string, key: string): { objectId: string; sha256: string; relativeKey: string } | undefined {
  const prefix = `${realm}/`
  if (!key.startsWith(prefix)) return undefined
  const relativeKey = key.slice(prefix.length)
  const match = relativePattern.exec(relativeKey)
  if (!match || joinRealmKey(realm, relativeKey) !== key) return undefined
  return { objectId: match[1]!, sha256: match[2]!, relativeKey }
}
export function isManagedContentKey(key: string): boolean {
  return key.startsWith('managed-content/') || key.includes('/managed-content/')
}
export function contentDigest(body: Buffer | string): string { return createHash('sha256').update(body).digest('hex') }
export interface ManagedContentReference { realm: string; kind: 'knowledge-file'; referenceId: string }
export interface ManagedContentReceipt extends ManagedContentReference { objectId: string; objectKey: string; sha256: string; byteSize: number }
export interface ManagedContentCandidate {
  objectId: string; objectKey: string; state: 'ready' | 'deleting'; revision: number
  byteSize: number; unreferencedAt: string; collectAfter: string
}
export interface ManagedContentCollection { deletionEnabled: boolean; candidates: number; deleted: number; failed: number }
/** Host-only managed namespace. Pending uploads never expire automatically;
 * producers pin/release in the same PG transaction as their authoritative row. */
export interface ManagedContentSeam {
  put(reference: ManagedContentReference, body: Buffer | string, contentType?: string): Promise<ManagedContentReceipt>
  /** Explicit upload failure compensation. Never releases a committed pin. */
  abandon(reference: ManagedContentReference): Promise<boolean>
  candidates(realm: string, limit?: number): Promise<ManagedContentCandidate[]>
  /** Dry-run unless deletion is explicitly configured on this Provider. */
  collect(realm: string, limit?: number): Promise<ManagedContentCollection>
}
