import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { projectFiles, projectFileBlocks, projectFilePreview, PREVIEW_LIMITS } from '../src/project-files.ts'
import { promptContext } from '../src/prompt-context.ts'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
describe('project file mentions', () => {
  it('browses the current project and rejects traversal and symlinks outside its root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumo-project-files-')); dirs.push(dir)
    const root = join(dir, 'project'); mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'src', 'App.tsx'), 'hello'); writeFileSync(join(dir, 'outside.txt'), 'outside')
    symlinkSync(join(dir, 'outside.txt'), join(root, 'escape.txt'))
    expect(projectFiles(root, '')).toEqual([{ path: 'src', name: 'src', directory: true }])
    expect(projectFiles(root, 'src/App')).toEqual([{ path: 'src/App.tsx', name: 'App.tsx', directory: false }])
    expect(projectFileBlocks(root, ['src/App.tsx'])).toEqual([expect.objectContaining({ type: 'resource_link', name: 'src/App.tsx', uri: expect.stringContaining('/project/src/App.tsx') })])
    for (const file of ['../outside.txt', '/etc/passwd', 'escape.txt', 'src']) expect(() => projectFileBlocks(root, [file])).toThrow()
  })
  it('bounds context counts and rejects forged Skill identifiers', () => {
    expect(promptContext({ skills: ['code-review'], files: ['src/App.tsx'] })).toEqual({ skills: ['code-review'], files: ['src/App.tsx'] })
    expect(() => promptContext({ skills: ['../../private'] })).toThrow()
    expect(() => promptContext({ skills: ['same', 'same'] })).toThrow()
    expect(() => promptContext({ files: ['bad\nfile'] })).toThrow()
    expect(() => promptContext({ files: Array.from({ length: 9 }, (_, n) => String(n)) })).toThrow()
  })
  it('previews bounded UTF-8 and allowlisted images while refusing binary, traversal and external symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumo-previews-')); dirs.push(dir)
    const root = join(dir, 'project'); mkdirSync(root)
    writeFileSync(join(root, 'README.md'), '# Project\n<script>text only</script>')
    writeFileSync(join(root, 'large.txt'), 'a'.repeat(PREVIEW_LIMITS.textBytes + 100))
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 1]))
    writeFileSync(join(root, 'fake.png'), '<svg onload="alert(1)"></svg>')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
    writeFileSync(join(root, 'one.png'), png)
    writeFileSync(join(dir, 'private.txt'), 'secret'); symlinkSync(join(dir, 'private.txt'), join(root, 'outside.txt'))
    expect(projectFilePreview(root, 'README.md')).toMatchObject({ text: '# Project\n<script>text only</script>', mimeType: 'text/plain' })
    expect(projectFilePreview(root, 'large.txt')).toMatchObject({ truncated: true, size: PREVIEW_LIMITS.textBytes + 100 })
    expect(projectFilePreview(root, 'large.txt').text).toHaveLength(PREVIEW_LIMITS.textBytes)
    expect(projectFilePreview(root, 'one.png')).toMatchObject({ mimeType: 'image/png', data: png.toString('base64') })
    for (const path of ['binary.bin', 'fake.png']) expect(projectFilePreview(root, path)).toMatchObject({ unsupported: true, mimeType: 'application/octet-stream' })
    for (const path of ['outside.txt', '../private.txt', '/etc/passwd', '.']) expect(() => projectFilePreview(root, path)).toThrow()
  })
})
