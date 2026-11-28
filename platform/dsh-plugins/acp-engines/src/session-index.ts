import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { validModelId } from './session-models.ts'
import type { SessionScope } from './session-scope.ts'

export interface RecoveryEntry extends SessionScope {
  id: string; engineId: string; engineSessionId: string; cwd: string; createdAt: string; updatedAt?: string; title?: string; modelId?: string | undefined
}
const MAX_ENTRIES = 128
const MAX_BYTES = 1024 * 1024
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
function metadata(value: unknown): RecoveryEntry {
  if (!value || typeof value !== 'object') throw new Error('ACP 恢复索引记录无效')
  const v = value as Record<string, unknown>
  if (!text(v.id, 36) || !/^[0-9a-f-]{36}$/u.test(v.id) || !text(v.engineId, 64) || !/^[a-z0-9][a-z0-9._-]*$/u.test(v.engineId)
    || !text(v.engineSessionId, 1024) || !text(v.cwd, 4096) || !isAbsolute(v.cwd) || !text(v.realm, 256) || !text(v.userId, 256)
    || (v.title !== undefined && !text(v.title, 200)) || (v.modelId !== undefined && !validModelId(v.modelId))
    || (v.updatedAt !== undefined && (!text(v.updatedAt, 64) || !Number.isFinite(Date.parse(v.updatedAt))))
    || (v.projectId !== undefined && !text(v.projectId, 256)) || !text(v.createdAt, 64) || !Number.isFinite(Date.parse(v.createdAt))) throw new Error('ACP 恢复索引记录无效')
  // 白名单复制：即使调用方传入完整会话，也绝不写入提示词、审批、MCP 配置或凭据。
  return { id: v.id, engineId: v.engineId, engineSessionId: v.engineSessionId, cwd: v.cwd, realm: v.realm, userId: v.userId,
    ...(v.projectId !== undefined ? { projectId: v.projectId } : {}), createdAt: v.createdAt, ...(v.updatedAt ? { updatedAt: v.updatedAt as string } : {}), ...(v.title ? { title: v.title as string } : {}), ...(v.modelId ? { modelId: v.modelId as string } : {}) }
}

/** 同步原子替换让内存与磁盘提交保持一个顺序；失败时保留原记录，调用方可重试关闭。 */
export class SessionIndex {
  private entries = new Map<string, RecoveryEntry>()
  constructor(private readonly path?: string) {
    if (!path) return
    try {
      if (statSync(path).size > MAX_BYTES) throw new Error('ACP 恢复索引过大')
      const body = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; sessions?: unknown }
      if (body.version !== 1 || !Array.isArray(body.sessions) || body.sessions.length > MAX_ENTRIES) throw new Error('ACP 恢复索引格式无效')
      const entries = body.sessions.map(metadata)
      if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('ACP 恢复索引会话重复')
      this.entries = new Map(entries.map(e => [e.id, e]))
      chmodSync(path, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  list(): RecoveryEntry[] { return [...this.entries.values()].map(e => ({ ...e })) }
  get(id: string): RecoveryEntry | undefined { const value = this.entries.get(id); return value ? { ...value } : undefined }
  put(entry: RecoveryEntry): void {
    const next = new Map(this.entries)
    next.delete(entry.id); next.set(entry.id, metadata(entry))
    while (next.size > MAX_ENTRIES) next.delete(next.keys().next().value!)
    this.commit(next)
  }
  remove(id: string): void {
    if (!this.entries.has(id)) return
    const next = new Map(this.entries); next.delete(id); this.commit(next)
  }
  private commit(next: Map<string, RecoveryEntry>): void {
    if (this.path) {
      const body = JSON.stringify({ version: 1, sessions: [...next.values()] })
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('ACP 恢复索引过大')
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      try { writeFileSync(temp, body, { mode: 0o600, flag: 'wx' }); renameSync(temp, this.path) }
      finally { rmSync(temp, { force: true }) }
    }
    this.entries = next
  }
}
