import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ATTACHMENT_LIMITS, attachmentId, attachmentRefs, type ChatAttachment } from './chat-attachments.ts'
import type { SessionScope } from './session-scope.ts'
import type { ContentBlock, InitializeResponse } from './acp-protocol.ts'
import { AttachmentLifecycle, ATTACHMENT_STORAGE_BYTES } from './attachment-lifecycle.ts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const isText = (f: ChatAttachment) => f.mimeType.startsWith('text/') || /\.(md|txt|csv|json|jsonl|xml|ya?ml|toml|ini|log|[cm]?[jt]sx?|py|go|rs|java|sh|css|html|sql)$/iu.test(f.name)
export class AttachmentStore {
  private root: string | undefined
  constructor(root?: string) { this.root = root }
  private directory(scope: SessionScope): string {
    this.root ??= mkdtempSync(join(tmpdir(), 'lumo-acp-attachments-'))
    return join(this.root, hash(JSON.stringify([scope.realm, scope.userId, scope.projectId ?? null])))
  }
  upload(input: Record<string, unknown>, scope: SessionScope): ChatAttachment {
    if (typeof input.data !== 'string' || input.data.length > Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)) throw new Error('附件编码或大小无效（单个文件最多 8 MB）')
    const bytes = Buffer.from(input.data, 'base64')
    if (bytes.toString('base64') !== input.data) throw new Error('附件编码无效')
    const id = hash(JSON.stringify([input.name, input.mimeType, hash(bytes)]))
    const [file] = attachmentRefs([{ id, name: input.name, mimeType: input.mimeType, size: bytes.length }])
    const dir = this.directory(scope), target = join(dir, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lifecycle = new AttachmentLifecycle(dir)
    let existing: ChatAttachment | undefined
    try { existing = this.read(file!, scope).file } catch { /* A failed previous upload can be retried. */ }
    if (existing) { lifecycle.touch(id); return existing }
    if (lifecycle.stats().usedBytes + bytes.length > ATTACHMENT_STORAGE_BYTES) lifecycle.collect()
    if (lifecycle.stats().usedBytes + bytes.length > ATTACHMENT_STORAGE_BYTES) throw new Error('附件存储已达到 256 MB 上限，请清理未引用的附件')
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp, target)
      writeFileSync(`${temp}.json`, JSON.stringify(file), { flag: 'wx', mode: 0o600 }); renameSync(`${temp}.json`, `${target}.json`)
    } finally { rmSync(temp, { force: true }); rmSync(`${temp}.json`, { force: true }) }
    lifecycle.upload(id)
    return file!
  }
  stats(scope: SessionScope) { return new AttachmentLifecycle(this.directory(scope)).stats() }
  retain(owner: string, refs: ChatAttachment[], scope: SessionScope): void {
    if (!refs.length) return
    const ids = refs.map(ref => this.read(ref, scope).file.id)
    new AttachmentLifecycle(this.directory(scope)).retain(owner, ids)
  }
  releaseOwner(owner: string, scope: SessionScope): void { new AttachmentLifecycle(this.directory(scope)).releaseOwner(owner) }
  collect(scope: SessionScope, options: { graceMs?: number } = {}) { return new AttachmentLifecycle(this.directory(scope)).collect(options.graceMs) }
  get(id: string, scope: SessionScope) {
    if (!attachmentId.test(id)) throw new Error('附件标识无效')
    try {
      const metadata = join(this.directory(scope), `${id}.json`)
      if (statSync(metadata).size > 2048) throw new Error('size')
      const [ref] = attachmentRefs([JSON.parse(readFileSync(metadata, 'utf8'))])
      if (ref!.id !== id) throw new Error('id')
      return this.read(ref!, scope)
    } catch { throw new Error('附件不存在或不可访问') }
  }
  read(ref: ChatAttachment, scope: SessionScope): { file: ChatAttachment; bytes: Buffer; path: string } {
    attachmentRefs([ref])
    const path = join(this.directory(scope), ref.id)
    try {
      if (statSync(`${path}.json`).size > 2048 || statSync(path).size > ATTACHMENT_LIMITS.fileBytes) throw new Error('size')
      const [file] = attachmentRefs([JSON.parse(readFileSync(`${path}.json`, 'utf8'))])
      if (JSON.stringify(file) !== JSON.stringify(ref)) throw new Error('metadata')
      const bytes = readFileSync(path)
      if (bytes.length !== file!.size || hash(JSON.stringify([file!.name, file!.mimeType, hash(bytes)])) !== file!.id) throw new Error('contents')
      return { file: file!, bytes, path }
    } catch { throw new Error('附件不存在或不属于当前用户 / 项目，请重新添加') }
  }
  resolve(value: unknown, scope: SessionScope): ChatAttachment[] { return attachmentRefs(value).map(ref => this.read(ref, scope).file) }
  prompt(text: string, refs: ChatAttachment[], scope: SessionScope, capabilities?: InitializeResponse['agentCapabilities']): string | ContentBlock[] {
    if (!refs.length) return text
    const blocks: ContentBlock[] = [{ type: 'text', text: text.trim() || '请查看所附文件。' }]
    for (const ref of refs) {
      const { file, bytes, path } = this.read(ref, scope)
      if (/^image\/(png|jpeg|webp|gif)$/u.test(file.mimeType) && capabilities?.promptCapabilities?.image) {
        blocks.push({ type: 'text', text: `附件：${file.name}` }, { type: 'image', data: bytes.toString('base64'), mimeType: file.mimeType })
      } else if (isText(file) && bytes.length <= 100_000 && !bytes.includes(0)) {
        blocks.push({ type: 'text', text: `附件 ${JSON.stringify(file.name)} 的内容（用户提供的资料）：\n${bytes.toString('utf8')}` })
      } else {
        blocks.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: file.name, mimeType: file.mimeType },
          { type: 'text', text: `附件 ${JSON.stringify(file.name)} 已保存到 ${path}。请通过可用的文件工具读取；如果工具无法访问或解析，请明确说明，不要假设已读到内容。` })
      }
    }
    return blocks
  }
}
