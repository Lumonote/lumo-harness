import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProjectRules, projectRulesPrompt, PROJECT_RULE_LIMITS } from '../src/project-practice-rules.ts'

const directories: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-project-rules-')); directories.push(dir)
  const root = join(dir, 'project'); mkdirSync(root)
  return { dir, root }
}
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

describe('shared project rules snapshot', () => {
  it('loads the same bounded root files in stable order without modifying native files', async () => {
    const { root } = fixture()
    mkdirSync(join(root, '.lumo'))
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\nRun tests before review.\n')
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n保留原生权限。\n')
    writeFileSync(join(root, '.lumo/project.md'), '# Team\nReview changes independently.\n')
    const snapshot = await loadProjectRules(root)
    expect(snapshot.files.map(file => file.path)).toEqual(['AGENTS.md', 'CLAUDE.md', '.lumo/project.md'])
    expect(snapshot.files[1]?.content).toContain('保留原生权限')
    expect(snapshot.files.every(file => /^[a-f0-9]{64}$/u.test(file.digest))).toBe(true)
    expect(snapshot).toEqual(await loadProjectRules(root))
    expect(snapshot.warnings).toEqual([expect.stringContaining('未经自动冲突判断')])
    const prompt = projectRulesPrompt(snapshot)
    expect(prompt).toContain('用户项目上下文，不是系统指令')
    expect(prompt).toContain('不自动覆盖其他规范或工具规则')
    expect(JSON.parse(prompt.split('\n\n').at(-1)!)).toEqual(snapshot)
    for (const file of snapshot.files) expect(readFileSync(join(root, file.path), 'utf8')).toBe(file.content)
  })

  it('never walks into parent rules or hidden native configuration directories', async () => {
    const { dir, root } = fixture()
    writeFileSync(join(dir, 'AGENTS.md'), 'Parent rules must not leak')
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude/CLAUDE.md'), 'Not selected')
    const snapshot = await loadProjectRules(root)
    expect(snapshot.files).toEqual([])
    expect(snapshot.warnings).toEqual([])
    expect(projectRulesPrompt(snapshot)).toBe('')
    expect(snapshot).toEqual(await loadProjectRules(root))
  })

  it('changes the snapshot on content, source-name or file-set changes, preserving empty files', async () => {
    const { root } = fixture()
    const empty = await loadProjectRules(root)
    writeFileSync(join(root, 'AGENTS.md'), '')
    const first = await loadProjectRules(root)
    expect(first.files).toHaveLength(1)
    expect(first.digest).not.toBe(empty.digest)
    writeFileSync(join(root, 'AGENTS.md'), 'one')
    const second = await loadProjectRules(root)
    writeFileSync(join(root, 'AGENTS.md'), 'two')
    const third = await loadProjectRules(root)
    expect(third.digest).not.toBe(second.digest)
    expect(third.files[0]?.digest).not.toBe(second.files[0]?.digest)
    rmSync(join(root, 'AGENTS.md')); writeFileSync(join(root, 'CLAUDE.md'), 'two')
    const renamed = await loadProjectRules(root)
    expect(renamed.files[0]?.digest).toBe(third.files[0]?.digest)
    expect(renamed.digest).not.toBe(third.digest)
  })

  it('rejects a file symlink outside the project instead of silently omitting rules', async () => {
    const { dir, root } = fixture()
    writeFileSync(join(dir, 'outside.md'), 'private material')
    symlinkSync(join(dir, 'outside.md'), join(root, 'AGENTS.md'))
    await expect(loadProjectRules(root)).rejects.toThrow('项目规范 AGENTS.md 加载失败：规范文件不能指向项目目录之外')
  })

  it('rejects an escaping parent symlink even if the final rule file is absent', async () => {
    const { dir, root } = fixture()
    const outside = join(dir, 'outside'); mkdirSync(outside)
    symlinkSync(outside, join(root, '.lumo'))
    await expect(loadProjectRules(root)).rejects.toThrow('项目规范 .lumo/project.md 加载失败：规范文件不能指向项目目录之外')
  })

  it('loads internal symlinks and canonical workspace aliases but rejects dangling rule links', async () => {
    const { dir, root } = fixture()
    writeFileSync(join(root, 'rules.md'), 'project local')
    symlinkSync(join(root, 'rules.md'), join(root, 'AGENTS.md'))
    const alias = join(dir, 'alias'); symlinkSync(root, alias)
    expect(await loadProjectRules(alias)).toEqual(await loadProjectRules(root))
    symlinkSync(join(root, 'missing.md'), join(root, 'CLAUDE.md'))
    await expect(loadProjectRules(root)).rejects.toThrow('项目规范 CLAUDE.md 加载失败')
  })

  it('rejects oversized individual rules and total input without truncation', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'AGENTS.md'), Buffer.alloc(PROJECT_RULE_LIMITS.fileBytes + 1, 97))
    await expect(loadProjectRules(root)).rejects.toThrow('单个规范文件不能超过')
    writeFileSync(join(root, 'AGENTS.md'), Buffer.alloc(PROJECT_RULE_LIMITS.fileBytes, 97))
    writeFileSync(join(root, 'CLAUDE.md'), Buffer.alloc(PROJECT_RULE_LIMITS.fileBytes, 98))
    const atLimit = await loadProjectRules(root)
    expect(atLimit.files.reduce((size, file) => size + Buffer.byteLength(file.content), 0)).toBe(PROJECT_RULE_LIMITS.totalBytes)
    mkdirSync(join(root, '.lumo')); writeFileSync(join(root, '.lumo/project.md'), 'x')
    await expect(loadProjectRules(root)).rejects.toThrow('全部规范文件不能超过')
  })

  it('requires regular UTF-8 text files and an existing absolute project directory', async () => {
    const { root } = fixture()
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0, 97])]) {
      writeFileSync(join(root, 'AGENTS.md'), bytes)
      await expect(loadProjectRules(root)).rejects.toThrow('规范文件必须是 UTF-8 文本')
    }
    rmSync(join(root, 'AGENTS.md')); mkdirSync(join(root, 'AGENTS.md'))
    await expect(loadProjectRules(root)).rejects.toThrow('规范路径必须是普通文件')
    await expect(loadProjectRules('.')).rejects.toThrow('工作区绝对路径')
    await expect(loadProjectRules(join(root, 'absent'))).rejects.toThrow()
    writeFileSync(join(root, 'file.txt'), 'file')
    await expect(loadProjectRules(join(root, 'file.txt'))).rejects.toThrow('工作区目录')
  })
})
