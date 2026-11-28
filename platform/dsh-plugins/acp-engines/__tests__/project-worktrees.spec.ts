import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectWorktrees } from '../src/project-worktrees.ts'

const directories: string[] = []
const command = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-worktrees-')))
  directories.push(path)
  command(path, ['init', '-b', 'main'])
  command(path, ['config', 'user.name', 'Test Developer'])
  command(path, ['config', 'user.email', 'test@example.invalid'])
  command(path, ['config', 'commit.gpgSign', 'false'])
  writeFileSync(join(path, 'README.md'), 'original\n')
  writeFileSync(join(path, '.gitignore'), '*.build\n')
  command(path, ['add', '.']); command(path, ['commit', '-m', 'initial'])
  return { path, manager: new ProjectWorktrees() }
}

describe('project worktrees use real Git evidence and preserve the user checkout', { timeout: 30_000 }, () => {
  it('captures a clean canonical project snapshot and rejects uncommitted work and detached HEAD', async () => {
    const { path, manager } = fixture()
    const repo = await manager.inspect(path)
    expect(repo).toEqual({ root: path, commonDir: join(path, '.git'), branch: 'main', baseCommit: command(path, ['rev-parse', 'HEAD']) })
    writeFileSync(join(path, 'pending.md'), 'unsaved')
    await expect(manager.inspect(path)).rejects.toThrow('未提交')
    rmSync(join(path, 'pending.md'))
    command(path, ['checkout', '--detach'])
    await expect(manager.inspect(path)).rejects.toThrow('detached')
  })

  it('creates and resumes registered independent worktrees without changing the original checkout', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path)
    const [first, second] = await Promise.all([manager.create(repo, 'run-one', 'first'), manager.create(repo, 'run-one', 'second')])
    expect(first.branch).toBe('codex/lumo-run-one-first')
    expect(first.path).not.toBe(second.path)
    expect(await new ProjectWorktrees().create(repo, 'run-one', 'first')).toEqual(first)
    writeFileSync(join(first.path, 'README.md'), 'task change\n')
    expect(readFileSync(join(second.path, 'README.md'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('original\n')
    expect(command(path, ['status', '--porcelain'])).toBe('')
  })

  it('collects committed, staged, unstaged and untracked changes without writing the index', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'evidence', 'task')
    writeFileSync(join(task.path, 'committed.txt'), 'committed result\n')
    command(task.path, ['add', '.']); command(task.path, ['commit', '-m', 'agent commit'])
    writeFileSync(join(task.path, 'staged.txt'), 'staged result\n'); command(task.path, ['add', 'staged.txt'])
    writeFileSync(join(task.path, 'README.md'), 'unstaged result\n')
    writeFileSync(join(task.path, 'new name.txt'), 'untracked result\n')
    writeFileSync(join(task.path, 'ignored.build'), 'excluded build result\n')
    const before = command(task.path, ['status', '--porcelain'])
    const result = await manager.collect(repo, task)
    expect(result.files.sort()).toEqual(['README.md', 'committed.txt', 'new name.txt', 'staged.txt'])
    for (const content of ['committed result', 'staged result', 'unstaged result', 'untracked result']) expect(result.diff).toContain(content)
    expect(result.diff).not.toContain('excluded build result')
    expect(result.commit).toBeUndefined()
    expect(command(task.path, ['status', '--porcelain'])).toBe(before)
  })

  it('commits only task workspace changes and handles no-change or agent-created commits', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'commit', 'task')
    expect((await manager.collect(repo, task, 'No changes')).commit).toBeUndefined()
    writeFileSync(join(task.path, 'new.txt'), 'new code\n')
    const first = await manager.collect(repo, task, 'Implement task')
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/u)
    expect(first.status).toBe('')
    expect((await manager.collect(repo, task, 'Already committed')).commit).toBe(first.commit)
    expect(command(path, ['rev-parse', 'HEAD'])).toBe(repo.baseCommit)
    expect(command(path, ['status', '--porcelain'])).toBe('')
  })

  it('records the actual commit after a project commit hook updates generated content', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'hooks', 'task')
    const hook = join(repo.commonDir, 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nprintf "generated by project hook\\n" > generated.txt\ngit add generated.txt\n'); chmodSync(hook, 0o755)
    writeFileSync(join(task.path, 'new.txt'), 'new code\n')
    const evidence = await manager.collect(repo, task, 'Task with hook')
    expect(evidence.files).toContain('generated.txt')
    expect(evidence.diff).toContain('generated by project hook')
    expect(evidence.status).toBe('')
    expect(command(path, ['rev-parse', 'HEAD'])).toBe(repo.baseCommit)
  })

  it('merges independent results and supplies a merged dependency base before explicit fast-forward', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path)
    const a = await manager.create(repo, 'parallel', 'a'), b = await manager.create(repo, 'parallel', 'b')
    writeFileSync(join(a.path, 'a.txt'), 'A\n'); writeFileSync(join(b.path, 'b.txt'), 'B\n')
    const ca = (await manager.collect(repo, a, 'Task A')).commit!, cb = (await manager.collect(repo, b, 'Task B')).commit!
    const deps = await manager.merge(repo, 'parallel', [ca, cb], 'deps-review')
    expect(deps.state).toBe('ready')
    const review = await manager.create(repo, 'parallel', 'review', deps.commit)
    expect(readFileSync(join(review.path, 'a.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(review.path, 'b.txt'), 'utf8')).toBe('B\n')
    const merged = await manager.merge(repo, 'parallel', [ca, cb])
    expect(merged.state).toBe('ready')
    expect(command(path, ['rev-parse', 'HEAD'])).toBe(repo.baseCommit)
    const result = await manager.integrate(repo, merged.workspace, merged.commit)
    expect(result).toEqual({ commit: merged.commit, branch: 'main' })
    expect(await new ProjectWorktrees().integrate(repo, merged.workspace, merged.commit)).toEqual(result)
    expect(command(path, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('B\n')
  })

  it('preserves merge conflicts in the integration worktree and allows recovery after a real resolution', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path)
    const a = await manager.create(repo, 'conflict', 'a'), b = await manager.create(repo, 'conflict', 'b')
    writeFileSync(join(a.path, 'README.md'), 'version A\n'); writeFileSync(join(b.path, 'README.md'), 'version B\n')
    const ca = (await manager.collect(repo, a, 'Task A')).commit!, cb = (await manager.collect(repo, b, 'Task B')).commit!
    const merged = await manager.merge(repo, 'conflict', [ca, cb])
    expect(merged.state).toBe('conflict'); expect(merged.conflicts).toEqual(['README.md'])
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('original\n')
    await expect(manager.integrate(repo, merged.workspace, merged.commit)).rejects.toThrow('未提交')
    expect((await new ProjectWorktrees().merge(repo, 'conflict', [ca, cb])).state).toBe('conflict')
    writeFileSync(join(merged.workspace.path, 'README.md'), 'resolved A and B\n')
    command(merged.workspace.path, ['add', '.']); command(merged.workspace.path, ['commit', '-m', 'Resolve reviewed conflict'])
    const recovered = await manager.merge(repo, 'conflict', [ca, cb])
    expect(recovered.state).toBe('ready')
    await manager.integrate(repo, recovered.workspace, recovered.commit)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('resolved A and B\n')
  })

  it('refuses integration if the original checkout changed, preserving both sets of edits', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'changed', 'task')
    writeFileSync(join(task.path, 'task.txt'), 'task\n')
    const commit = (await manager.collect(repo, task, 'Task')).commit!
    const merged = await manager.merge(repo, 'changed', [commit])
    writeFileSync(join(path, 'user.txt'), 'user change\n')
    await expect(manager.integrate(repo, merged.workspace, merged.commit)).rejects.toThrow('未提交')
    command(path, ['add', '.']); command(path, ['commit', '-m', 'User changed project'])
    await expect(manager.integrate(repo, merged.workspace, merged.commit)).rejects.toThrow('HEAD 已变化')
    expect(readFileSync(join(path, 'user.txt'), 'utf8')).toBe('user change\n')
    expect(readFileSync(join(task.path, 'task.txt'), 'utf8')).toBe('task\n')
  })

  it('requires revalidation when the approved integration commit changes', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'approved', 'task')
    const approved = command(task.path, ['rev-parse', 'HEAD'])
    writeFileSync(join(task.path, 'later.txt'), 'later\n')
    await manager.collect(repo, task, 'Later unreviewed change')
    await expect(manager.integrate(repo, task, approved)).rejects.toThrow('重新测试和评审')
    expect(command(path, ['rev-parse', 'HEAD'])).toBe(repo.baseCommit)
  })

  it('reconciles pending and already merged results using read-only Git checks', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'reconcile', 'task')
    writeFileSync(join(task.path, 'task.txt'), 'task\n')
    const commit = (await manager.collect(repo, task, 'Task')).commit!
    const before = command(path, ['reflog', '--all', '--format=%H %gs'])
    expect(await manager.integrationStatus(repo, task, commit)).toBe('pending')
    expect(command(path, ['rev-parse', 'HEAD'])).toBe(repo.baseCommit)
    expect(command(path, ['reflog', '--all', '--format=%H %gs'])).toBe(before)
    await manager.integrate(repo, task, commit)
    const mergedBefore = command(path, ['reflog', '--all', '--format=%H %gs'])
    expect(await new ProjectWorktrees().integrationStatus(repo, task, commit)).toBe('merged')
    expect(command(path, ['reflog', '--all', '--format=%H %gs'])).toBe(mergedBefore)
    await expect(manager.integrationStatus(repo, task, repo.baseCommit)).rejects.toThrow('集成结果已变化')
    writeFileSync(join(path, 'user.txt'), 'user change\n')
    await expect(manager.integrationStatus(repo, task, commit)).rejects.toThrow('未提交')
    command(path, ['add', '.']); command(path, ['commit', '-m', 'User work'])
    await expect(manager.integrationStatus(repo, task, commit)).rejects.toThrow('HEAD 已变化')
    command(path, ['checkout', '-b', 'another'])
    await expect(manager.integrationStatus(repo, task, commit)).rejects.toThrow('分支已变化')
  })

  it('rejects forged worktree paths, branch changes, path traversal and linked managed parents', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'identity', 'task')
    await expect(manager.collect(repo, { ...task, path })).rejects.toThrow('路径无效')
    await expect(manager.create(repo, '../escape', 'task')).rejects.toThrow('标识无效')
    command(task.path, ['checkout', '-b', 'different'])
    await expect(manager.collect(repo, task)).rejects.toThrow('分支已切换')
    const external = join(path, 'external'); mkdirSync(external)
    symlinkSync(external, join(repo.commonDir, 'lumo-workflows', 'linked'))
    await expect(manager.create(repo, 'linked', 'task')).rejects.toThrow('符号链接')
  })

  it('verifies durable creation receipts rather than trusting a restored baseline', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'receipt', 'task')
    writeFileSync(join(task.path, 'change.txt'), 'change\n')
    const commit = (await manager.collect(repo, task, 'Task')).commit!
    await expect(new ProjectWorktrees().collect(repo, { ...task, baseCommit: commit })).rejects.toThrow('创建记录不符')
    await expect(manager.create(repo, 'receipt', 'task', commit)).rejects.toThrow('创建记录不符')
    rmSync(join(repo.commonDir, 'lumo-workflows', 'receipt', '.metadata', 'task.json'))
    await expect(manager.create(repo, 'receipt', 'task')).rejects.toThrow('ENOENT')
    expect(readFileSync(join(task.path, 'change.txt'), 'utf8')).toBe('change\n')
  })

  it('reports untracked symlinks as links without reading files outside the worktree', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'links', 'task')
    const external = join(path, '.git', 'outside.txt'); writeFileSync(external, 'must not expose external content\n')
    symlinkSync(external, join(task.path, 'linked.txt'))
    const evidence = await manager.collect(repo, task)
    expect(evidence.files).toEqual(['linked.txt'])
    expect(evidence.diff).not.toContain('must not expose external content')
    expect(evidence.diff).toContain('120000')
  })

  it('marks oversized evidence as truncated while retaining complete file identities', async () => {
    const { path, manager } = fixture(), repo = await manager.inspect(path), task = await manager.create(repo, 'bounded', 'task')
    writeFileSync(join(task.path, 'large.txt'), 'line\n'.repeat(20_000))
    const evidence = await manager.collect(repo, task)
    expect(evidence.truncated).toBe(true)
    expect(evidence.diff.length).toBeLessThanOrEqual(64 * 1024)
    expect(evidence.files).toEqual(['large.txt'])
  })
})
