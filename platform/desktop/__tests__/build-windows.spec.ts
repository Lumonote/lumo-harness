import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { buildWindows, finalizeWindowsBundle } from '../build-windows.mjs'

interface CommandResult { code: number | null; signal?: string | null; output: string }

const buildArgs = ['tauri', 'build', '--no-bundle']
const bundleArgs = ['tauri', 'bundle', '--bundles', 'nsis']
const success = (): CommandResult => ({ code: 0, signal: null, output: '' })
const download = 'Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip\n'
const httpFailure = (status: number, code = 1): CommandResult => ({
  code, signal: null,
  output: `${download}Error failed to bundle project: \`http status: ${status}\`\n`,
})

function harness(results: Array<CommandResult | Error>) {
  const pending = [...results]
  const run = vi.fn(async (_args: string[]) => {
    const result = pending.shift()
    if (result === undefined) throw new Error('Unexpected extra cargo invocation')
    if (result instanceof Error) throw result
    return result
  })
  const wait = vi.fn(async (_milliseconds: number) => {})
  const log = vi.fn((_message: string) => {})
  return { run, wait, log, build: () => buildWindows({ run, wait, log }) }
}

describe('Windows desktop build and NSIS download recovery', () => {
  it('always records a unique unsigned installer without Windows signing tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo unsigned NSIS '))
    const run = vi.fn(() => { throw Error('Signing tools must not run') })
    try {
      writeFileSync(join(root, 'App.exe'), 'NSIS payload')
      const result = finalizeWindowsBundle({ directory: root, env: { LUMO_RELEASE_SIGNING_REQUIRED: '0' }, run,
        runtimeReport: { target: 'win-x64', version: '1.2.1', total: { contentBytes: 123, fileCount: 4 }, sourceRevision: 'a'.repeat(40), upstreamRevision: 'b'.repeat(40) } })
      expect(result.artifact).toBe('App-unsigned.exe')
      expect(existsSync(join(root, 'App.exe'))).toBe(false)
      expect(JSON.parse(readFileSync(join(root, 'App-unsigned.exe.release.json'), 'utf8')).receipt.status).toBe('unsigned')
      expect(run).not.toHaveBeenCalled()
      writeFileSync(join(root, 'another.exe'), 'stale payload')
      expect(() => finalizeWindowsBundle({ directory: root, env: {} })).toThrow(/唯一/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps the signed Windows bundle path strict and leaves its installer name intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo signed NSIS '))
    const run = vi.fn(() => ({ status: 0, stdout: '' }))
    const report = { target: 'win-x64', version: '1.2.1', total: { contentBytes: 123, fileCount: 4 }, sourceRevision: 'a'.repeat(40), upstreamRevision: 'b'.repeat(40) }
    try {
      writeFileSync(join(root, 'App.exe'), 'NSIS payload')
      expect(() => finalizeWindowsBundle({ directory: root, env: { LUMO_RELEASE_SIGNING_REQUIRED: '1' }, run, runtimeReport: report })).toThrow(/LUMO_WINDOWS_CERT_THUMBPRINT/)
      expect(run).not.toHaveBeenCalled()
      const result = finalizeWindowsBundle({ directory: root, env: { LUMO_RELEASE_SIGNING_REQUIRED: '1', LUMO_WINDOWS_CERT_THUMBPRINT: 'a'.repeat(40), LUMO_WINDOWS_TIMESTAMP_URL: 'https://timestamp.example.test' }, run, runtimeReport: report })
      expect(result.artifact).toBe('App.exe')
      expect(result.receipt.status).toBe('signed')
      expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['verify', '-NoProfile', 'sign', 'verify'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('builds once and bundles once when the download succeeds', async () => {
    const bundled = success()
    const f = harness([success(), bundled])
    expect(await f.build()).toBe(bundled)
    expect(f.run.mock.calls).toEqual([[buildArgs], [bundleArgs]])
    expect(f.wait).not.toHaveBeenCalled()
    expect(f.log).not.toHaveBeenCalled()
  })

  it.each([408, 429, 500, 502, 503, 504])('recovers a transient HTTP %i without rebuilding the runtime or Rust executable', async status => {
    const bundled = success()
    const f = harness([success(), httpFailure(status), bundled])
    expect(await f.build()).toBe(bundled)
    expect(f.run.mock.calls).toEqual([[buildArgs], [bundleArgs], [bundleArgs]])
    expect(f.wait.mock.calls).toEqual([[5_000]])
    expect(f.log).toHaveBeenCalledTimes(1)
  })

  it('uses bounded backoff for two failed downloads, then succeeds on the third bundle attempt', async () => {
    const bundled = success()
    const f = harness([success(), httpFailure(504), httpFailure(502), bundled])
    expect(await f.build()).toBe(bundled)
    expect(f.run.mock.calls).toEqual([[buildArgs], [bundleArgs], [bundleArgs], [bundleArgs]])
    expect(f.wait.mock.calls).toEqual([[5_000], [15_000]])
  })

  it('returns the last original exit code after all three download attempts fail', async () => {
    const exhausted = httpFailure(504, 23)
    const f = harness([success(), httpFailure(504), httpFailure(503), exhausted])
    expect(await f.build()).toBe(exhausted)
    expect(f.run).toHaveBeenCalledTimes(4)
    expect(f.wait.mock.calls).toEqual([[5_000], [15_000]])
  })

  it('recognizes the same Tauri download failure with terminal colors', async () => {
    const failure = httpFailure(504)
    failure.output = `\u001b[32m${download}\u001b[0m\u001b[31mError\u001b[0m failed to bundle project: \`http status: 504\`\n`
    const f = harness([success(), failure, success()])
    expect((await f.build()).code).toBe(0)
    expect(f.run).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['HTTP 403', httpFailure(403).output],
    ['HTTP 404', httpFailure(404).output],
    ['checksum mismatch', `${download}Info validating hash\nError failed to bundle project: \`hash doesn't match\`\n`],
    ['NSIS resource failure', 'File: failed opening file "runtime/missing.js"\nError failed to bundle project: `Failed to bundle app with makensis`\n'],
    ['unrelated HTTP text', `${download}resource http status: 504\nError failed to bundle project: \`Failed to bundle app with makensis\`\n`],
    ['HTTP failure without a download', 'Error failed to bundle project: `http status: 504`\n'],
  ])('does not retry a deterministic failure: %s', async (_name, output) => {
    const failed: CommandResult = { code: 17, signal: null, output }
    const f = harness([success(), failed])
    expect(await f.build()).toBe(failed)
    expect(f.run.mock.calls).toEqual([[buildArgs], [bundleArgs]])
    expect(f.wait).not.toHaveBeenCalled()
  })

  it('returns a failed compilation without trying to bundle', async () => {
    const failed: CommandResult = { code: 101, signal: null, output: 'error: could not compile lumo-desktop' }
    const f = harness([failed])
    expect(await f.build()).toBe(failed)
    expect(f.run.mock.calls).toEqual([[buildArgs]])
    expect(f.wait).not.toHaveBeenCalled()
  })

  it.each(['SIGINT', 'SIGTERM'])('does not retry an interrupted bundle (%s)', async signal => {
    const interrupted: CommandResult = { ...httpFailure(504), code: null, signal }
    const f = harness([success(), interrupted])
    expect(await f.build()).toBe(interrupted)
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.wait).not.toHaveBeenCalled()
  })

  it.each(['build', 'bundle'])('propagates a spawn error from %s without retrying', async stage => {
    const error = Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' })
    const f = harness(stage === 'build' ? [error] : [success(), error])
    await expect(f.build()).rejects.toBe(error)
    expect(f.run).toHaveBeenCalledTimes(stage === 'build' ? 1 : 2)
    expect(f.wait).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('runs cargo directly with exact argv, desktop cwd and target, and combines both output streams for recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo windows build (&) '))
    const bin = join(root, 'fake tools (&)')
    const callsPath = join(root, 'calls.jsonl')
    const original = { PATH: process.env.PATH, LUMO_DESKTOP_TARGET: process.env.LUMO_DESKTOP_TARGET,
      LUMO_WINDOWS_BUILD_TEST_LOG: process.env.LUMO_WINDOWS_BUILD_TEST_LOG }
    const wait = vi.fn(async (_milliseconds: number) => {})
    const log = vi.fn((_message: string) => {})
    mkdirSync(bin)
    writeFileSync(join(bin, 'cargo'), `#!${process.execPath}
const fs = require('node:fs');
const path = process.env.LUMO_WINDOWS_BUILD_TEST_LOG;
const previous = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const args = process.argv.slice(2);
fs.appendFileSync(path, JSON.stringify({ args, cwd: process.cwd(), target: process.env.LUMO_DESKTOP_TARGET }) + '\\n');
if (args[1] === 'build') process.exit(0);
if (args[1] !== 'bundle') process.exit(99);
if (!previous.some(call => call.args[1] === 'bundle')) {
  process.stdout.write(${JSON.stringify(download)}, () => {
    process.stderr.write('Error failed to bundle project: \\x60http status: 504\\x60\\n', () => process.exit(1));
  });
} else {
  process.stdout.write('NSIS fixture completed\\n');
}
`, { mode: 0o755 })
    try {
      process.env.PATH = `${bin}:${original.PATH ?? ''}`
      process.env.LUMO_DESKTOP_TARGET = 'parent-target-must-stay'
      process.env.LUMO_WINDOWS_BUILD_TEST_LOG = callsPath
      const result = await buildWindows({ wait, log })
      expect(result).toMatchObject({ code: 0, signal: null, output: 'NSIS fixture completed\n' })
      const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; cwd: string; target: string })
      // The executable is found through a PATH entry containing shell syntax;
      // argv remains an array of distinct arguments at the real process boundary.
      expect(calls.map(call => call.args)).toEqual([buildArgs, bundleArgs, bundleArgs])
      expect(calls.map(call => realpathSync(call.cwd))).toEqual(Array(3).fill(realpathSync(fileURLToPath(new URL('..', import.meta.url)))))
      expect(calls.map(call => call.target)).toEqual(Array(3).fill('win-x64'))
      expect(process.env.LUMO_DESKTOP_TARGET).toBe('parent-target-must-stay')
      expect(wait.mock.calls).toEqual([[5_000]])
      expect(log).toHaveBeenCalledTimes(1)
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
