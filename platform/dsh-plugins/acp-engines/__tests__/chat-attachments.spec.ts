import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/attachment-store.ts'
import { ATTACHMENT_LIMITS, attachmentRefs } from '../src/chat-attachments.ts'
import { handleAcpRoute } from '../src/routes.ts'
import type { EngineHost } from '../src/engine-host.ts'
import type { SessionAskBroker } from '../src/permission-asks.ts'

const scope = { realm: 'local', userId: 'me', projectId: 'project' }
const directories: string[] = []
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'lumo-files-test-')); directories.push(dir); return { dir, store: new AttachmentStore(dir) } }
const payload = (name = 'notes.md', mimeType = 'text/markdown', text = 'hello attachment') => ({ name, mimeType, data: Buffer.from(text).toString('base64') })
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })

describe('scoped chat attachments', () => {
  it('stores private bytes, survives restart and reuses the same upload id', () => {
    const { dir, store } = fixture(), input = payload(), ref = store.upload(input, scope)
    expect(store.upload(input, scope)).toEqual(ref)
    const saved = new AttachmentStore(dir).get(ref.id, scope)
    expect(saved.bytes.toString()).toBe('hello attachment')
    expect(statSync(saved.path).mode & 0o777).toBe(0o600)
    expect(store.resolve([ref], scope)).toEqual([ref])
    for (const foreign of [{ ...scope, userId: 'other' }, { ...scope, realm: 'other' }, { ...scope, projectId: 'other' }]) {
      expect(() => store.get(ref.id, foreign)).toThrow('不可访问')
      expect(() => store.resolve([ref], foreign)).toThrow('当前用户')
    }
    expect(() => store.resolve([{ ...ref, name: 'forged.md' }], scope)).toThrow('附件')
    expect(() => store.get('../../outside', scope)).toThrow('标识')
  })
  it('rejects malformed, oversized and duplicate inputs; accepts the full 8 MB boundary', () => {
    const { store } = fixture()
    for (const input of [{ ...payload(), data: 'invalid!' }, { ...payload(), data: 'AB==' }, payload('../escape'), payload('bad\nname'), payload('file', 'text/plain; charset=utf8')]) expect(() => store.upload(input, scope)).toThrow()
    expect(() => store.upload({ ...payload(), data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1).toString('base64') }, scope)).toThrow()
    const large = store.upload({ ...payload('binary.bin', 'application/octet-stream'), data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes).toString('base64') }, scope)
    expect(large.size).toBe(ATTACHMENT_LIMITS.fileBytes)
    expect(() => attachmentRefs([large, large])).toThrow('重复')
    expect(() => attachmentRefs(Array.from({ length: 5 }, () => large))).toThrow('4')
  })
  it('embeds text and supported images; exposes other real files through a readable resource link', () => {
    const { store } = fixture(), text = store.upload(payload(), scope), img = store.upload(payload('diagram.png', 'image/png', 'image bytes'), scope), pdf = store.upload(payload('document.pdf', 'application/pdf', '%PDF-test'), scope)
    const blocks = store.prompt('review', [text, img, pdf], scope, { promptCapabilities: { image: true } }) as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'text', text: 'review' })
    expect(blocks.some(b => String(b.text).includes('hello attachment'))).toBe(true)
    expect(blocks).toContainEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64') })
    const link = blocks.find(b => b.type === 'resource_link')!
    expect(readFileSync(fileURLToPath(String(link.uri)), 'utf8')).toBe('%PDF-test')
    const fallback = store.prompt('', [img], scope) as Array<Record<string, unknown>>
    expect(fallback.some(b => b.type === 'image')).toBe(false)
    expect(fallback.some(b => b.type === 'resource_link')).toBe(true)
  })
  it('uploads and prompts through trusted route scope, bounds the body and serves files with safe headers', async () => {
    const { store } = fixture(), prompt = vi.fn(() => ({ ok: true })), id = '12345678-1234-1234-1234-123456789abc'
    const host = { get: () => ({ id, state: 'idle', cwd: '/tmp', capabilities: { promptCapabilities: { image: true } } }), preparePrompt: () => ({ signal: new AbortController().signal, cancel: () => {}, release: () => {} }), prompt } as unknown as EngineHost
    const readBody = vi.fn(), call = async (path: string, input: unknown, identity = scope, method = 'POST') => {
      readBody.mockResolvedValueOnce(Buffer.from(JSON.stringify(input)))
      const req = Object.assign(new EventEmitter(), { method, headers: {}, url: `/lumo/api/acp${path}` })
      const res = Object.assign(new EventEmitter(), { status: 0, headers: {} as Record<string, unknown>, data: '', writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers }, end(data: string | Buffer) { this.data = data.toString() } })
      await handleAcpRoute(req as IncomingMessage, res as unknown as ServerResponse, req.url, { host, asks: {} as SessionAskBroker, attachments: store, identity, readBody })
      return res
    }
    const upload = await call('/attachments', { ...payload(), userId: 'spoofed' })
    expect(upload.status).toBe(201); expect(readBody.mock.calls[0]?.[1]).toBe(ATTACHMENT_LIMITS.bodyBytes)
    const file = JSON.parse(upload.data).attachment
    expect((await call(`/sessions/${id}/prompt`, { text: '', attachments: [file] })).status).toBe(202)
    expect(prompt).toHaveBeenCalledWith(id, scope, expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('hello attachment') })]), { text: '', attachments: [file] }, expect.objectContaining({ workspaceOwner: `session:${id}` }))
    expect((await call(`/sessions/${id}/prompt`, { text: '', attachments: [file] }, { ...scope, userId: 'other' })).status).toBe(400)
    expect(prompt).toHaveBeenCalledTimes(1)
    const download = await call(`/attachments/${file.id}`, {}, scope, 'GET')
    expect(download.data).toBe('hello attachment'); expect(download.headers['content-disposition']).toContain('attachment;')
    expect(download.headers['x-content-type-options']).toBe('nosniff')
    expect((await call(`/attachments/${file.id}`, {}, { ...scope, projectId: 'other' }, 'GET')).status).toBe(404)
  })
})
