import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/** The original checkout is only changed by an explicit integrate call. */
export interface ProjectRepository { root: string; commonDir: string; branch: string; baseCommit: string }
export interface ProjectWorktree { runId: string; taskId: string; path: string; branch: string; baseCommit: string }
export interface ProjectChanges { head: string; status: string; stat: string; diff: string; files: string[]; commit?: string; truncated: boolean }
export interface ProjectMergeResult { workspace: ProjectWorktree; state: 'ready' | 'conflict'; commit: string; conflicts: string[]; error?: string }

const execute = promisify(execFile)
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const EVIDENCE_LIMIT = 64 * 1024
const queues = new Map<string, Promise<unknown>>()
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
const lines = (text: string) => text.split('\0').filter(Boolean)

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  // The host may itself run inside another Git command. Never inherit its target or index.
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)(?:_|$)/u.test(key)) delete env[key]
  return env
}
async function git(cwd: string, args: string[], allowed = [0]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execute('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: environment(), encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    })
    return { ...result, code: 0 }
  } catch (error) {
    const e = error as Error & { code?: number | string; stdout?: string; stderr?: string }
    if (typeof e.code === 'number' && allowed.includes(e.code)) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code }
    throw new Error(`Git 操作失败：${(e.stderr?.trim() || e.message).slice(0, 2000)}`)
  }
}
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(fn)
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}
const head = async (cwd: string) => (await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
const branch = async (cwd: string) => {
  const value = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])
  if (value.code) throw new Error('项目需要位于已有分支，不能使用 detached HEAD')
  return value.stdout.trim()
}
const status = async (cwd: string) => (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
async function assertClean(cwd: string): Promise<void> {
  if (await status(cwd)) throw new Error('工作区存在未提交改动，请先提交或自行保存后再继续项目流程')
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).stdout.trim()
  for (const file of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { await lstat(join(gitDir, file)); throw new Error('工作区仍有未完成的 Git 合并或变基') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
async function topology(cwd: string): Promise<{ root: string; commonDir: string }> {
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim())
  const commonDir = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
  return { root, commonDir }
}
async function checkRepository(repo: ProjectRepository): Promise<void> {
  if (!repo || !isAbsolute(repo.root) || !isAbsolute(repo.commonDir) || !SHA.test(repo.baseCommit) || !repo.branch || /[\x00-\x1f]/u.test(repo.branch)) throw new Error('项目仓库快照无效')
  const current = await topology(repo.root)
  if (current.root !== repo.root || current.commonDir !== repo.commonDir) throw new Error('项目仓库位置已变化，不能恢复此流程')
  await git(repo.root, ['cat-file', '-e', `${repo.baseCommit}^{commit}`])
}
function identity(repo: ProjectRepository, runId: string, taskId: string) {
  if (!ID.test(runId) || !ID.test(taskId)) throw new Error('工作流或任务标识无效')
  return { path: join(repo.commonDir, 'lumo-workflows', runId, taskId), branch: `codex/lumo-${runId}-${taskId}` }
}
const receiptPath = (repo: ProjectRepository, workspace: ProjectWorktree) => join(repo.commonDir, 'lumo-workflows', workspace.runId, '.metadata', `${workspace.taskId}.json`)
async function verifyReceipt(repo: ProjectRepository, workspace: ProjectWorktree): Promise<void> {
  const file = receiptPath(repo, workspace)
  await noSymlinkParents(repo.commonDir, file)
  const value = JSON.parse(await readFile(file, 'utf8')) as { repository?: ProjectRepository; workspace?: ProjectWorktree }
  const sameRepo = value.repository && (['root', 'commonDir', 'branch', 'baseCommit'] as const).every(key => value.repository![key] === repo[key])
  const sameWorkspace = value.workspace && (['runId', 'taskId', 'path', 'branch', 'baseCommit'] as const).every(key => value.workspace![key] === workspace[key])
  if (!sameRepo || !sameWorkspace) throw new Error('协作工作区基线或所属流程与创建记录不符')
}
async function noSymlinkParents(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error('协作工作区路径越界')
  const parts = relative(root, path).split(sep).filter(Boolean)
  let cursor = root
  for (const part of parts) {
    cursor = join(cursor, part)
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('协作工作区路径不能使用符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

export class ProjectWorktrees {
  async inspect(cwd: string): Promise<ProjectRepository> {
    const repo = await topology(cwd)
    await assertClean(repo.root)
    const snapshot = { ...repo, branch: await branch(repo.root), baseCommit: await head(repo.root) }
    // Catch a checkout change while the initial snapshot was being assembled.
    await this.assertOriginal(snapshot)
    return snapshot
  }

  private async assertOriginal(repo: ProjectRepository): Promise<void> {
    await checkRepository(repo)
    if (await branch(repo.root) !== repo.branch || await head(repo.root) !== repo.baseCommit) throw new Error('原项目分支或 HEAD 已变化；已保留隔离工作区，请重新核对集成目标')
    await assertClean(repo.root)
  }

  /** Recovery validates Git's registry as well as the persisted identity, not just a stored path. */
  async verify(repo: ProjectRepository, workspace: ProjectWorktree): Promise<void> {
    await checkRepository(repo)
    const expected = identity(repo, workspace.runId, workspace.taskId)
    if (workspace.path !== expected.path || workspace.branch !== expected.branch || !SHA.test(workspace.baseCommit)) throw new Error('协作工作区标识或路径无效')
    await verifyReceipt(repo, workspace)
    await noSymlinkParents(repo.commonDir, workspace.path)
    const current = await topology(workspace.path)
    if (current.root !== workspace.path || current.commonDir !== repo.commonDir || await branch(workspace.path) !== workspace.branch) throw new Error('协作工作区不属于当前项目或分支已切换')
    const records = (await git(repo.root, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0')
    if (!records.some(record => {
      const fields = record.split('\0')
      return fields.includes(`worktree ${workspace.path}`) && fields.includes(`branch refs/heads/${workspace.branch}`)
    })) throw new Error('协作工作区已不在 Git 登记中')
    const ancestor = await git(workspace.path, ['merge-base', '--is-ancestor', workspace.baseCommit, 'HEAD'], [0, 1])
    if (ancestor.code) throw new Error('协作工作区历史已被改写，无法核对基线')
  }

  async create(repo: ProjectRepository, runId: string, taskId: string, baseCommit = repo.baseCommit): Promise<ProjectWorktree> {
    return serial(`${repo.commonDir}:create:${runId}:${taskId}`, async () => {
      await checkRepository(repo)
      if (!SHA.test(baseCommit)) throw new Error('任务基线提交无效')
      if ((await git(repo.root, ['merge-base', '--is-ancestor', repo.baseCommit, baseCommit], [0, 1])).code) throw new Error('任务基线不包含项目初始提交')
      const target = identity(repo, runId, taskId), workspace = { runId, taskId, ...target, baseCommit }
      await noSymlinkParents(repo.commonDir, target.path)
      const exists = await lstat(target.path).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return false
      })
      if (exists) {
        await this.verify(repo, workspace)
        return workspace
      }
      await mkdir(join(repo.commonDir, 'lumo-workflows', runId), { recursive: true, mode: 0o700 })
      await noSymlinkParents(repo.commonDir, target.path)
      const metadata = join(repo.commonDir, 'lumo-workflows', runId, '.metadata')
      await noSymlinkParents(repo.commonDir, metadata)
      await mkdir(metadata, { recursive: true, mode: 0o700 })
      const receipt = receiptPath(repo, workspace)
      try { await writeFile(receipt, JSON.stringify({ repository: repo, workspace }), { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await verifyReceipt(repo, workspace)
      }
      await git(repo.root, ['worktree', 'add', '-b', target.branch, '--', target.path, baseCommit])
      await this.verify(repo, workspace)
      return workspace
    })
  }

  async collect(repo: ProjectRepository, workspace: ProjectWorktree, commitMessage?: string): Promise<ProjectChanges> {
    return serial(workspace.path, async () => {
      await this.verify(repo, workspace)
      if (commitMessage !== undefined && (!commitMessage.trim() || commitMessage.length > 2000 || commitMessage.includes('\0'))) throw new Error('任务提交说明无效')
      if ((await git(workspace.path, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout) throw new Error('协作工作区仍有未解决的合并冲突')
      const initialStatus = await status(workspace.path)
      let commit: string | undefined
      if (commitMessage !== undefined && initialStatus) {
        const untracked = lines((await git(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout)
        if (untracked.length > 1000) throw new Error('未跟踪文件超过 1000 个，请先排除构建产物后再收集')
        await git(workspace.path, ['add', '--all', '--', '.'])
        await git(workspace.path, ['-c', 'user.name=Lumo Workflow', '-c', 'user.email=lumo-workflow@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', commitMessage])
        await assertClean(workspace.path)
        commit = await head(workspace.path)
      }
      // Capture after hooks and the commit have finished, so evidence describes the actual result.
      const trackedFiles = lines((await git(workspace.path, ['diff', '--name-only', '-z', workspace.baseCommit, '--'])).stdout)
      const untracked = lines((await git(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout)
      if (untracked.length > 1000) throw new Error('未跟踪文件超过 1000 个，请先排除构建产物后再收集')
      let diff = (await git(workspace.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv', workspace.baseCommit, '--'])).stdout
      let stat = (await git(workspace.path, ['diff', '--stat', '--no-ext-diff', '--no-textconv', workspace.baseCommit, '--'])).stdout
      for (const file of untracked) {
        const path = resolve(workspace.path, file)
        if (!inside(workspace.path, path)) throw new Error('未跟踪文件路径越界')
        const result = await git(workspace.path, ['diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file], [0, 1])
        diff += result.stdout
        stat += `${file} (new file)\n`
      }
      const finalHead = await head(workspace.path)
      if (commitMessage !== undefined && finalHead !== workspace.baseCommit) commit = finalHead
      return { head: finalHead, status: commitMessage !== undefined ? await status(workspace.path) : initialStatus,
        stat: stat.slice(0, EVIDENCE_LIMIT), diff: diff.slice(0, EVIDENCE_LIMIT), files: [...new Set([...trackedFiles, ...untracked])],
        ...(commit ? { commit } : {}), truncated: stat.length > EVIDENCE_LIMIT || diff.length > EVIDENCE_LIMIT }
    })
  }

  async merge(repo: ProjectRepository, runId: string, commits: string[], taskId = 'integration'): Promise<ProjectMergeResult> {
    if (!commits.every(value => SHA.test(value))) throw new Error('待合并提交无效')
    const workspace = await this.create(repo, runId, taskId)
    return serial(workspace.path, async () => {
      await this.verify(repo, workspace)
      const pending = lines((await git(workspace.path, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout)
      if (pending.length) return { workspace, state: 'conflict', commit: await head(workspace.path), conflicts: pending, error: '合并冲突已保留，请在隔离工作区解决并提交后重试' }
      await assertClean(workspace.path)
      for (const commit of [...new Set(commits)]) {
        if ((await git(repo.root, ['merge-base', '--is-ancestor', repo.baseCommit, commit], [0, 1])).code) throw new Error('待合并提交不属于此项目基线')
        if (!(await git(workspace.path, ['merge-base', '--is-ancestor', commit, 'HEAD'], [0, 1])).code) continue
        const result = await git(workspace.path, ['-c', 'user.name=Lumo Workflow', '-c', 'user.email=lumo-workflow@localhost', '-c', 'commit.gpgSign=false', 'merge', '--no-edit', '--no-ff', commit], [0, 1])
        if (result.code) {
          const conflicts = lines((await git(workspace.path, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout)
          return { workspace, state: 'conflict', commit: await head(workspace.path), conflicts, error: (result.stderr || result.stdout).trim().slice(0, 2000) }
        }
      }
      await assertClean(workspace.path)
      return { workspace, state: 'ready', commit: await head(workspace.path), conflicts: [] }
    })
  }

  /** Reconcile an interrupted persistence receipt without running merge or updating any Git ref. */
  async integrationStatus(repo: ProjectRepository, workspace: ProjectWorktree, expectedCommit: string): Promise<'merged' | 'pending'> {
    return serial(`${repo.commonDir}:integrate`, () => serial(workspace.path, async () => {
      if (!SHA.test(expectedCommit)) throw new Error('待核对集成提交无效')
      await this.verify(repo, workspace)
      await assertClean(workspace.path)
      if (await head(workspace.path) !== expectedCommit) throw new Error('集成结果已变化，请重新测试和评审后再合入')
      await assertClean(repo.root)
      if (await branch(repo.root) !== repo.branch) throw new Error('原项目分支已变化，不能核对集成结果')
      const current = await head(repo.root)
      if (current === expectedCommit) return 'merged'
      if (current === repo.baseCommit) return 'pending'
      throw new Error('原项目 HEAD 已变化，不能核对集成结果；已保留隔离工作区')
    }))
  }

  async integrate(repo: ProjectRepository, workspace: ProjectWorktree, expectedCommit?: string): Promise<{ commit: string; branch: string }> {
    return serial(`${repo.commonDir}:integrate`, () => serial(workspace.path, async () => {
      await this.verify(repo, workspace)
      await assertClean(workspace.path)
      const target = await head(workspace.path)
      if (expectedCommit !== undefined && target !== expectedCommit) throw new Error('集成结果已变化，请重新测试和评审后再合入')
      await assertClean(repo.root)
      // A process may restart after Git succeeds but before its workflow receipt is saved.
      if (await branch(repo.root) === repo.branch && await head(repo.root) === target) return { commit: target, branch: repo.branch }
      await this.assertOriginal(repo)
      // Git performs a checked ref update and refuses local modifications; no reset, force or stash.
      await git(repo.root, ['merge', '--ff-only', '--no-edit', target])
      if (await head(repo.root) !== target || await branch(repo.root) !== repo.branch) throw new Error('合入后的项目状态与预期不符，请核对 Git 状态')
      await assertClean(repo.root)
      return { commit: target, branch: repo.branch }
    }))
  }
}
