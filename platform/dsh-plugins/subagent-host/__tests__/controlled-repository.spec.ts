import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CLOSED_REPOSITORY_PROFILE, ControlledRepository, loadRepositorySnapshot, REPOSITORY_TOOLS, validateRepositorySnapshot, type RepositorySnapshot, type RepositorySource } from '../src/controlled-repository.ts'
import { runGovernedTask } from '../src/governed-run.ts'
import { prepareGovernedRun, type PreparedRun } from '../src/run-review.ts'
import { binding, config, execution } from './governed-fixtures.ts'

const contexts: Context[] = [], roots: string[] = []
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function git(root: string, ...args: string[]) { return execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lumo-approved-repository-')); roots.push(root)
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/app.ts'), 'export const value = 1\n'); await writeFile(join(root, 'README.md'), 'Original\n')
  git(root, 'init', '--initial-branch=main'); git(root, 'add', '.'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'approved base')
  const source: RepositorySource = { root, repository: 'org/repo', baseCommit: git(root, 'rev-parse', 'HEAD'), baseBranch: 'main', paths: ['src/app.ts', 'README.md'] }
  const snapshot = await loadRepositorySnapshot(source, new AbortController().signal)
  return { root, source, snapshot }
}
function prepared(snapshot?: RepositorySnapshot): PreparedRun {
  return { snapshot: { realm: config.realm, task_id: 'task-run-1', run_id: 'run-1', worker_id: `agent:${binding.agentId}`, node_id: config.nodeId, session_ref: 'session-run-1', preset_id: binding.agentId, preset_revision: binding.presetRevision, provider: binding.provider, model: binding.model, output_profile: snapshot ? CLOSED_REPOSITORY_PROFILE : 'platform-closed-text-v1' }, ...(snapshot ? { repository_snapshot: snapshot } : {}) }
}

it('loads approved commit bytes even when live files differ and seals a complete private file set', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'src/app.ts'), 'Unapproved dirty file')
  const snapshot = await loadRepositorySnapshot(f.source, new AbortController().signal)
  expect(snapshot.files[0]!.text).toBe('export const value = 1\n')
  const repo = new ControlledRepository(snapshot), file = repo.read('src/app.ts')
  expect(() => repo.write({ path: file.path, text: 'changed', expected_sha256: '0'.repeat(64) })).toThrow('revision')
  expect(() => repo.read('../secret')).toThrow('outside')
  expect(() => repo.write({ path: file.path, text: '\0', expected_sha256: file.sha256 })).toThrow('UTF-8')
  repo.write({ path: file.path, text: 'export const value = 2\n', expected_sha256: file.sha256 })
  expect(repo.seal()).toEqual([{ path: file.path, text: 'export const value = 2\n' }, snapshot.files[1]])
  expect(() => repo.write({ path: file.path, text: '', expected_sha256: sha('export const value = 2\n') })).toThrow('sealed')
  expect(await readFile(join(f.root, 'src/app.ts'), 'utf8')).toBe('Unapproved dirty file')
})

it('rejects symlinks, executable files, gitlinks, non-UTF8/binary/oversized bytes and hidden paths', async () => {
  const f = await fixture()
  await symlink('README.md', join(f.root, 'link')); await writeFile(join(f.root, 'exec'), 'echo test\n'); await chmod(join(f.root, 'exec'), 0o755)
  await writeFile(join(f.root, 'binary'), Buffer.from([0xff, 0x00])); await writeFile(join(f.root, 'large'), 'x'.repeat(3073))
  git(f.root, 'add', '.'); git(f.root, 'update-index', '--add', '--cacheinfo', `160000,${f.source.baseCommit},vendor`)
  git(f.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'invalid file modes')
  const baseCommit = git(f.root, 'rev-parse', 'HEAD')
  for (const path of ['link', 'exec', 'vendor', 'binary', 'large', '../escape', '.git/config', 'src/hooks/run', 'src//app.ts']) {
    await expect(loadRepositorySnapshot({ ...f.source, baseCommit, paths: [path] }, new AbortController().signal), path).rejects.toThrow()
  }
  for (const text of ['\ud800', '\0', 'x'.repeat(3073)]) expect(() => validateRepositorySnapshot({ ...f.snapshot, files: [{ path: 'src/app.ts', text }] })).toThrow()
  await expect(loadRepositorySnapshot(undefined, new AbortController().signal)).rejects.toThrow('Deployment')
})

it('ignores local replacement objects so frozen bytes correspond to the exact approved Git object',async()=>{
  const f=await fixture()
  await writeFile(join(f.root,'src/app.ts'),'replacement object bytes\n');git(f.root,'add','.');git(f.root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','replacement')
  const replacement=git(f.root,'rev-parse','HEAD');git(f.root,'replace',f.source.baseCommit,replacement)
  expect(git(f.root,'cat-file','blob',`${f.source.baseCommit}:src/app.ts`)).toBe('replacement object bytes')
  expect((await loadRepositorySnapshot(f.source,new AbortController().signal)).files).toEqual(f.snapshot.files)
})

it('runs the real AgentLoop with only snapshot tools and never mutates the live checkout', async () => {
  const f = await fixture(), ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx); await ctx.plugin(AgentLoop, { agents: [] })
  const warnings: unknown[][] = []; vi.spyOn(ctx.logger, 'warn').mockImplementation((...args) => { warnings.push(args) })
  let hostCalls = 0
  ctx.tools.register({ name: 'host_side_effect', description: 'forbidden', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => { hostCalls++; return {} } })
  const requests: GenerateOptions[] = [], replacement = 'export const value = 2\n'
  const calls = [ ['host_side_effect', {}], [REPOSITORY_TOOLS[0], { path: 'src/app.ts' }], [REPOSITORY_TOOLS[1], { path: 'src/app.ts', text: replacement, expected_sha256: sha(f.snapshot.files[0]!.text) }] ] as const
  ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options); const call = calls[requests.length - 1]
      if (call) { const [name, value] = call, id = ToolCallId(`repo-${requests.length}`), args = JSON.stringify(value); yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
      else { yield { type: 'text-delta', index: 0, text: 'Updated src/app.ts in the review snapshot' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }
  })())
  const item = execution(); item.preset.output_profile = CLOSED_REPOSITORY_PROFILE
  const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal, undefined, async () => prepared(f.snapshot))
  expect(result, JSON.stringify(warnings.map(args => args.map(String)))).toMatchObject({ state: 'COMPLETED', repository_files: [{ path: 'src/app.ts', text: replacement }, f.snapshot.files[1]] })
  expect(hostCalls).toBe(0); expect(requests).toHaveLength(4); expect(requests[0]!.tools?.map(tool => tool.name)).toEqual([...REPOSITORY_TOOLS])
  expect(await readFile(join(f.root, 'src/app.ts'), 'utf8')).toBe(f.snapshot.files[0]!.text)
})

it('requires authority to freeze the deployment snapshot and independently reads every full repository change', async () => {
  const f = await fixture(), item = execution(); item.preset.output_profile = CLOSED_REPOSITORY_PROFILE
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(prepared(f.snapshot)))
  const actual = await prepareGovernedRun({ ...config, repositorySource: f.source }, item, fetcher)
  expect(actual.repository_snapshot).toEqual(f.snapshot)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ repository_snapshot: f.snapshot })
  await expect(prepareGovernedRun({ ...config, repositorySource: f.source }, item, async () => Response.json(prepared({ ...f.snapshot, base_commit: 'f'.repeat(40) })))).rejects.toThrow('differs')
  const review = prepared(), text = JSON.stringify({ path: 'src/app.ts', before: 'old', after: 'new', patch: 'complete' })
  const entry = { id: 'file-0001', name: 'repo-change-0001.json', media_type: 'application/json', bytes: Buffer.byteLength(text), sha256: sha(text) }, receipt = 'c'.repeat(64)
  review.review = { producer_task_id: 'producer', producer_run_id: 'run-p', producer_intent: 'Review all changes', manifest_digest: 'a'.repeat(64), manifest: { scope: CLOSED_REPOSITORY_PROFILE, task_id: 'producer', run_id: 'run-p', summary: 'Changed app', entries: [{ id: 'output-0001', sha256: sha('summary'), text: 'summary' }], files: [entry] }, expires_at: new Date(Date.now() + 3600000).toISOString() }
  const read = await prepareGovernedRun(config, execution(), async input => Response.json(String(input).endsWith('/prepare') ? review : { ...entry, text, receipt }))
  expect(read.review?.read_files).toEqual([{ ...entry, text }]); expect(read.reviewFileReceipts).toEqual([{ id: entry.id, receipt }]); expect(JSON.stringify(read.review)).not.toContain(receipt)
  await expect(prepareGovernedRun(config, execution(), async input => Response.json(String(input).endsWith('/prepare') ? review : { ...entry, text: '{}', receipt }))).rejects.toThrow('verification')
})
