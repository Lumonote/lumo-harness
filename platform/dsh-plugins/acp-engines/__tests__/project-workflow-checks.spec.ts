import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProjectCheck, PROJECT_CHECK_LIMITS } from '../src/project-workflow-checks.ts'

const roots: string[] = [], groups: number[] = []
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'lumo-checks-')); roots.push(dir); return dir }
const check = (code: string, timeoutMs = 3000) => ({ id: 'test', command: process.execPath, args: ['-e', code], timeoutMs })
const ready = async (path: string) => { const deadline = Date.now() + 3000; while (!existsSync(path) && Date.now() < deadline) await delay(10); expect(existsSync(path)).toBe(true) }
afterEach(() => {
  vi.unstubAllEnvs()
  for (const pid of groups.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* Already stopped. */ } }
  roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

describe('project workflow command evidence', () => {
  it('runs argument arrays without a shell and records the actual commit, output and timestamps', async () => {
    const cwd = fixture(), arg = 'literal; echo $(not-a-shell)'
    const result = await runProjectCheck({ ...check('process.stdout.write(process.argv[1]); process.stderr.write("|stderr");'), args: ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("|stderr");', arg] }, cwd, 'commit-123', new AbortController().signal)
    expect(result).toMatchObject({ state: 'passed', exitCode: 0, commit: 'commit-123', truncated: false })
    expect(result.output).toContain(arg); expect(result.output).toContain('|stderr')
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt))
  })

  it('marks nonzero exits and launch failures as failed', async () => {
    const cwd = fixture()
    const failed = await runProjectCheck(check('process.stderr.write("test failed"); process.exit(7)'), cwd, 'sha', new AbortController().signal)
    expect(failed).toMatchObject({ state: 'failed', exitCode: 7 })
    expect(failed.output).toContain('test failed')
    const missing = await runProjectCheck({ id: 'missing', command: join(cwd, 'no-executable'), args: [] }, cwd, 'sha', new AbortController().signal)
    expect(missing).toMatchObject({ state: 'failed', exitCode: null })
    expect(missing.output).toContain('命令启动或运行失败')
  })

  it('caps merged stdout and stderr at 16 KiB without splitting UTF-8', async () => {
    const result = await runProjectCheck(check('process.stdout.write("好".repeat(30000)); process.stderr.write("error".repeat(10000))'), fixture(), 'sha', new AbortController().signal)
    expect(result).toMatchObject({ state: 'passed', exitCode: 0, truncated: true })
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(PROJECT_CHECK_LIMITS.outputBytes)
    expect(result.output).not.toContain('\uFFFD')
    const binary = await runProjectCheck(check('process.stdout.write(Buffer.alloc(17000,255))'), fixture(), 'sha', new AbortController().signal)
    expect(binary).toMatchObject({ state: 'passed', truncated: true })
    expect(Buffer.byteLength(binary.output)).toBeLessThanOrEqual(PROJECT_CHECK_LIMITS.outputBytes)
  })

  it('reuses the engine environment filter for platform service credentials', async () => {
    vi.stubEnv('LUMO_PG_DSN', 'synthetic-test-credential'); vi.stubEnv('LUMO_DESKTOP_HANDOFF_FILE', 'synthetic-handoff')
    const result = await runProjectCheck(check('if ("LUMO_PG_DSN" in process.env || "LUMO_DESKTOP_HANDOFF_FILE" in process.env) process.exit(5); process.stdout.write("ENV_CLEAN")'), fixture(), 'sha', new AbortController().signal)
    expect(result).toMatchObject({ state: 'passed', output: 'ENV_CLEAN' })
  })

  it('times out and waits for a SIGTERM-resistant process to stop before resolving', async () => {
    const result = await runProjectCheck(check('process.on("SIGTERM",()=>{}); setInterval(()=>{},100)', 150), fixture(), 'sha', new AbortController().signal)
    expect(result.state).toBe('failed'); expect(result.exitCode).toBeNull()
    expect(result.output).toContain('超过 150 毫秒')
  })

  it('does not spawn when the signal was already aborted', async () => {
    const cwd = fixture(), marker = join(cwd, 'started'), controller = new AbortController(); controller.abort()
    const result = await runProjectCheck(check(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`), cwd, 'sha', controller.signal)
    expect(result).toMatchObject({ state: 'cancelled', exitCode: null })
    expect(result.output).toContain('命令未启动'); expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('cancels the whole group even when the parent exits before its resistant child', async () => {
    const cwd = fixture(), marker = join(cwd, 'writes'), pidFile = join(cwd, 'pid'), controller = new AbortController()
    const descendant = `process.on('SIGTERM',()=>{}); setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'.'),20)`
    const parent = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},100)`
    const pending = runProjectCheck(check(parent), cwd, 'sha', controller.signal)
    await ready(pidFile); groups.push(Number(readFileSync(pidFile, 'utf8')))
    await ready(marker); controller.abort()
    const result = await pending
    expect(result.state).toBe('cancelled')
    const size = statSync(marker).size; await delay(150)
    expect(statSync(marker).size).toBe(size)
    expect(() => process.kill(-groups.at(-1)!, 0)).toThrow()
  })

  it('rejects invalid timeout values before execution', async () => {
    await expect(runProjectCheck(check('process.exit(0)', 30 * 60_000 + 1), fixture(), 'sha', new AbortController().signal)).rejects.toThrow('超时配置无效')
  })

  it.skipIf(process.platform === 'win32')('fails and cleans up commands that leave a background child after exiting successfully', async () => {
    const cwd = fixture(), marker = join(cwd, 'writes'), pidFile = join(cwd, 'pid')
    const descendant = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'.'),20)`
    const parent = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});child.unref();setTimeout(()=>process.exit(0),80)`
    const pending = runProjectCheck(check(parent), cwd, 'sha', new AbortController().signal)
    await ready(pidFile); groups.push(Number(readFileSync(pidFile, 'utf8')))
    const result = await pending
    expect(result).toMatchObject({ state: 'failed', exitCode: 0 })
    expect(result.output).toContain('后台子进程')
    expect(() => process.kill(-groups.at(-1)!, 0)).toThrow()
  })
})
