import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/attachment-store.ts'
import { ATTACHMENT_GRACE_MS } from '../src/attachment-lifecycle.ts'

const scope = { realm: 'local', userId: 'user', projectId: 'project' }, dirs: string[] = []
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-attachment-life-')); dirs.push(dir)
  const store = new AttachmentStore(dir), upload = (name = 'notes.txt') => store.upload({ name, mimeType: 'text/plain', data: Buffer.from('retained evidence').toString('base64') }, scope)
  return { dir, store, upload, index: () => join(dir, readdirSync(dir)[0]!, '.references.json') }
}
describe('conservative attachment lifecycle', () => {
  it('measures quota, keeps shared references across restarts, and collects abandoned files after their grace period', () => {
    vi.useFakeTimers(); const f = fixture(), used = f.upload(), abandoned = f.upload('abandoned.txt')
    f.store.retain('session:one', [used], scope); f.store.retain('room:two', [used], scope)
    expect(f.store.stats(scope)).toMatchObject({ usedBytes: used.size + abandoned.size, referencedBytes: used.size, reclaimableBytes: abandoned.size, files: 2 })
    expect(f.store.collect(scope).removedFiles).toBe(0)
    vi.setSystemTime(Date.now() + ATTACHMENT_GRACE_MS + 1)
    const restored = new AttachmentStore(f.dir)
    expect(restored.collect(scope)).toMatchObject({ removedFiles: 1, freedBytes: abandoned.size })
    restored.releaseOwner('session:one', scope)
    expect(restored.collect(scope, { graceMs: 0 }).removedFiles).toBe(0)
    restored.releaseOwner('room:two', scope)
    expect(restored.collect(scope, { graceMs: 0 })).toMatchObject({ removedFiles: 1, usedBytes: 0 })
    expect(restored.stats({ ...scope, userId: 'other' }).files).toBe(0)
  })
  it('refreshes a reselected upload grace period and isolates scopes', () => {
    vi.useFakeTimers(); const f = fixture(), file = f.upload()
    vi.setSystemTime(Date.now() + ATTACHMENT_GRACE_MS + 1); expect(f.upload()).toEqual(file)
    expect(f.store.collect(scope).removedFiles).toBe(0)
    expect(() => f.store.retain('session:other', [file], { ...scope, projectId: 'other' })).toThrow()
    expect(f.store.stats(scope).referencedBytes).toBe(0)
  })
  it('never collects legacy files with unknown references, even after a new conversation releases its reference', () => {
    const f = fixture(), file = f.upload(); rmSync(f.index())
    f.store.retain('session:new', [file], scope); f.store.releaseOwner('session:new', scope)
    expect(f.store.collect(scope, { graceMs: 0 })).toMatchObject({ removedFiles: 0, referencedBytes: file.size })
    expect(f.store.get(file.id, scope).bytes.toString()).toBe('retained evidence')
  })
  it('fails closed on corrupted reference data without overwriting it or deleting attachment bytes', () => {
    const f = fixture(), file = f.upload(), bad = '{broken index'; writeFileSync(f.index(), bad)
    expect(() => f.store.collect(scope, { graceMs: 0 })).toThrow('已停止清理')
    expect(() => f.store.retain('session:new', [file], scope)).toThrow('已停止清理')
    expect(readFileSync(f.index(), 'utf8')).toBe(bad); expect(f.store.get(file.id, scope).file).toEqual(file)
  })
})
