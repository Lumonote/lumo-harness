/** Service-authenticated owner registry. New IDs are allocated by the authority;
 * no runtime can claim an arbitrary existing session through this contract. */
import { boundedJSON } from './session-execution.ts'

export interface SessionOwner {
  session_ref: string
  realm: string
  owner_user_id: string
  project_id: string
  node_id: string
  parent_session_ref: string
  state: 'reserved' | 'active' | 'failed'
  created_at: string
  activated_at?: string
}
export interface SessionOwnerReservation { owner: SessionOwner; creation_token: string }
export class SessionOwnerClient {
  private readonly base: string
  constructor(baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch = globalThis.fetch) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !token.trim()) throw new Error('Invalid session owner authority configuration')
    this.base = baseUrl.replace(/\/+$/u, '')
  }
  private async call(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.base}/v1/session-owners${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Session owner authority refused: HTTP ${response.status}`)
    }
    return boundedJSON(response)
  }
  async reserve(input: Omit<SessionOwner, 'session_ref' | 'state' | 'created_at' | 'activated_at'>): Promise<SessionOwnerReservation> {
    const value = await this.call('', input)
    const owner = parseSessionOwner(value.owner)
    if (owner.state !== 'reserved' || typeof value.creation_token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.creation_token)) throw new Error('Invalid owner reservation')
    for (const [key, expected] of Object.entries(input)) if (owner[key as keyof SessionOwner] !== expected) throw new Error('Owner reservation scope mismatch')
    return { owner, creation_token: value.creation_token }
  }
  async activate(realm: string, sessionRef: string, creationToken: string): Promise<SessionOwner> {
    const value = parseSessionOwner((await this.call(`/${encodeURIComponent(sessionRef)}/activate`, { realm, creation_token: creationToken })).owner)
    if (value.realm !== realm || value.session_ref !== sessionRef || value.state !== 'active') throw new Error('Owner activation scope mismatch')
    return value
  }
  async get(realm: string, sessionRef: string): Promise<SessionOwner> {
    const value = parseSessionOwner((await this.call(`/${encodeURIComponent(sessionRef)}?realm=${encodeURIComponent(realm)}`)).owner)
    if (value.realm !== realm || value.session_ref !== sessionRef) throw new Error('Owner identity mismatch')
    return value
  }
  async list(realm: string, userId: string, nodeId: string, after = ''): Promise<{ owners: SessionOwner[]; next_cursor: string }> {
    const q = new URLSearchParams({ realm, owner_user_id: userId, node_id: nodeId, after, limit: '100' })
    const value = await this.call(`?${q}`)
    if (!Array.isArray(value.owners) || value.owners.length > 100 || typeof value.next_cursor !== 'string') throw new Error('Invalid owner list')
    const owners = value.owners.map(parseSessionOwner)
    for (const owner of owners) if (owner.realm !== realm || owner.owner_user_id !== userId || owner.node_id !== nodeId || owner.state !== 'active') throw new Error('Owner list scope mismatch')
    return { owners, next_cursor: value.next_cursor }
  }
  async listProject(realm: string,userId: string,projectId: string,after = ''): Promise<{ owners: SessionOwner[]; next_cursor: string }> {
    const value=await this.call(`?${new URLSearchParams({realm,owner_user_id:userId,project_id:projectId,after,limit:'100'})}`)
    if(!Array.isArray(value.owners)||value.owners.length>100||typeof value.next_cursor!=='string') throw new Error('Invalid owner project list')
    const owners=value.owners.map(parseSessionOwner)
    for(const owner of owners) if(owner.realm!==realm||owner.owner_user_id!==userId||owner.project_id!==projectId||owner.state!=='active') throw new Error('Owner project list scope mismatch')
    return {owners,next_cursor:value.next_cursor}
  }
}
export function parseSessionOwner(value: unknown): SessionOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owner fact')
  const o = value as Record<string, unknown>
  for (const key of ['session_ref', 'realm', 'owner_user_id', 'project_id', 'node_id', 'created_at']) if (typeof o[key] !== 'string' || !o[key].trim()) throw new Error(`Invalid owner ${key}`)
  if (typeof o.parent_session_ref !== 'string' || !['reserved', 'active', 'failed'].includes(String(o.state))) throw new Error('Invalid owner state')
  return o as unknown as SessionOwner
}
