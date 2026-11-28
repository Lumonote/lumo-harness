import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentId } from './chat-attachments.ts'

export const ATTACHMENT_STORAGE_BYTES = 256 * 1024 * 1024
export const ATTACHMENT_GRACE_MS = 24 * 60 * 60_000
interface References { version: 1; uploads: Record<string, number>; owners: Record<string, string[]> }
export interface AttachmentUsage { usedBytes: number; limitBytes: number; referencedBytes: number; reclaimableBytes: number; files: number }
const empty = (): References => ({ version: 1, uploads: {}, owners: {} })

/** Files without a lifecycle entry predate reference tracking and are never collected. */
export class AttachmentLifecycle {
  constructor(private readonly dir: string) {}
  private read(): References {
    try {
      const path = join(this.dir, '.references.json')
      if (statSync(path).size > 8 * 1024 * 1024) throw new Error('附件引用索引过大')
      const value = JSON.parse(readFileSync(path, 'utf8')) as References
      if (value.version !== 1 || !value.uploads || !value.owners || typeof value.uploads !== 'object' || typeof value.owners !== 'object' || Array.isArray(value.uploads) || Array.isArray(value.owners)
        || Object.entries(value.uploads).some(([id, time]) => !attachmentId.test(id) || !Number.isFinite(time) || time < 0)
        || Object.entries(value.owners).some(([owner, ids]) => !owner || owner.length > 256 || !Array.isArray(ids) || ids.some(id => !attachmentId.test(id)))) throw new Error('附件引用索引无效')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw new Error('附件引用索引不可读取，已停止清理以保留历史附件', { cause: error })
    }
  }
  private write(value: References): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const target = join(this.dir, '.references.json'), temp = `${target}.${randomUUID()}.tmp`
    try { writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temp, target) }
    finally { rmSync(temp, { force: true }) }
  }
  upload(id: string): void {
    const refs = this.read(); refs.uploads[id] = Date.now(); this.write(refs)
  }
  touch(id: string): void { const refs = this.read(); if (Object.hasOwn(refs.uploads, id)) { refs.uploads[id] = Date.now(); this.write(refs) } }
  retain(owner: string, ids: string[]): void {
    if (!owner || owner.length > 256 || /[\x00-\x1f]/u.test(owner)) throw new Error('附件引用者无效')
    const refs = this.read()
    Object.defineProperty(refs.owners, owner, { value: [...new Set([...(Object.hasOwn(refs.owners, owner) ? refs.owners[owner]! : []), ...ids])], enumerable: true, writable: true, configurable: true })
    this.write(refs)
  }
  releaseOwner(owner: string): void {
    const refs = this.read()
    if (!Object.hasOwn(refs.owners, owner)) return
    const ids = refs.owners[owner]!
    delete refs.owners[owner]
    // Restart the grace period when history is explicitly removed.
    for (const id of ids) if (Object.hasOwn(refs.uploads, id)) refs.uploads[id] = Date.now()
    this.write(refs)
  }
  private files(): { id: string; size: number }[] {
    try { return readdirSync(this.dir).filter(id => attachmentId.test(id)).map(id => ({ id, size: statSync(join(this.dir, id)).size })) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  stats(): AttachmentUsage {
    const refs = this.read(), owned = new Set(Object.values(refs.owners).flat()), files = this.files()
    return { files: files.length, limitBytes: ATTACHMENT_STORAGE_BYTES,
      usedBytes: files.reduce((n, f) => n + f.size, 0),
      referencedBytes: files.reduce((n, f) => n + (owned.has(f.id) || !Object.hasOwn(refs.uploads, f.id) ? f.size : 0), 0),
      reclaimableBytes: files.reduce((n, f) => n + (!owned.has(f.id) && Object.hasOwn(refs.uploads, f.id) ? f.size : 0), 0) }
  }
  collect(graceMs = ATTACHMENT_GRACE_MS): AttachmentUsage & { removedFiles: number; freedBytes: number } {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('附件保留时间无效')
    const refs = this.read(), owned = new Set(Object.values(refs.owners).flat())
    let removedFiles = 0, freedBytes = 0
    for (const file of this.files()) {
      if (owned.has(file.id) || !Object.hasOwn(refs.uploads, file.id) || Date.now() - refs.uploads[file.id]! < graceMs) continue
      rmSync(join(this.dir, file.id), { force: true }); rmSync(join(this.dir, `${file.id}.json`), { force: true })
      delete refs.uploads[file.id]; removedFiles++; freedBytes += file.size
    }
    if (removedFiles) this.write(refs)
    return { ...this.stats(), removedFiles, freedBytes }
  }
}
