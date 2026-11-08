import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fetchPinnedCommit } from '../source-plugin-fetch.mjs'

interface GitResult { status: number | null; signal?: string | null; error?: Error; stdout: string; stderr: string }
const commit = '6337fc823ce20251c8de8085948165c81aaa701e'
const checkout = '/temporary source (&)/checkout'
const success = (): GitResult => ({ status: 0, signal: null, stdout: '', stderr: '' })
const failure = (stderr: string, status = 128): GitResult => ({ status, signal: null, stdout: '', stderr })
const dns = "fatal: unable to access 'https://github.com/deepseek-ai/dsh-superagent-prototype.git/': Could not resolve host: github.com\n"

function harness(results: GitResult[]) {
  const pending = [...results]
  const execute = vi.fn((_command: string, _args: string[], _options: unknown) => {
    const result = pending.shift()
    if (result === undefined) throw new Error('Unexpected extra git invocation')
    return result
  })
  const wait = vi.fn((_milliseconds: number) => {})
  const log = vi.fn((_message: string) => {})
  return { execute, wait, log, fetch: () => fetchPinnedCommit(checkout, commit, { execute, wait, log }) }
}

function expectPinnedArguments(calls: Array<[string, string[], unknown]>) {
  for (const [command, args] of calls) {
    expect(command).toBe('git')
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', 'http.version=HTTP/1.1'])
    expect(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2)).toEqual(['-C', checkout])
    expect(args.slice(args.indexOf('fetch'))).toEqual(['fetch', '--depth', '1', 'origin', commit])
  }
}

describe('pinned source plugin fetch', () => {
  it('fetches the full commit with HTTP/1.1 once when Git succeeds', () => {
    const f = harness([success()])
    expect(f.fetch).not.toThrow()
    expectPinnedArguments(f.execute.mock.calls)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.wait).not.toHaveBeenCalled()
    expect(f.log).not.toHaveBeenCalled()
  })

  it('recovers from the reported DNS failure without changing the source pin', () => {
    const f = harness([failure(dns), success()])
    expect(f.fetch).not.toThrow()
    expectPinnedArguments(f.execute.mock.calls)
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.wait.mock.calls).toEqual([[5_000]])
    expect(f.log).toHaveBeenCalledTimes(1)
  })

  it('keeps the DNS retry classification when Git emits terminal colors', () => {
    const f = harness([failure(`\u001b[31m${dns}\u001b[0m`), success()])
    expect(f.fetch).not.toThrow()
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.wait.mock.calls).toEqual([[5_000]])
  })

  it.each(['main', commit.slice(0, 7)])('rejects a floating or abbreviated ref before starting Git: %s', ref => {
    const execute = vi.fn()
    expect(() => fetchPinnedCommit(checkout, ref, { execute })).toThrow(/40-character commit/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses bounded backoff and succeeds on the last permitted attempt', () => {
    const f = harness([failure(dns), failure('fatal: Connection timed out'), success()])
    expect(f.fetch).not.toThrow()
    expectPinnedArguments(f.execute.mock.calls)
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(f.wait.mock.calls).toEqual([[5_000], [15_000]])
  })

  it('fails after three attempts and preserves the final Git exit status', () => {
    const f = harness([failure(dns), failure(dns), failure(dns, 23)])
    expect(f.fetch).toThrow(/23/)
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(f.wait.mock.calls).toEqual([[5_000], [15_000]])
  })

  it.each([408, 429, 500, 502, 503, 504])('retries Git HTTP %i failures', status => {
    const f = harness([failure(`fatal: unable to access 'https://github.com/example/repository.git/': The requested URL returned error: ${status}`), success()])
    expect(f.fetch).not.toThrow()
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.wait.mock.calls).toEqual([[5_000]])
  })

  it.each([
    'fatal: unable to access repository: Failed to connect to github.com port 443: Connection timed out',
    'fatal: unable to access repository: Recv failure: Connection reset by peer',
  ])('retries a transient connection failure: %s', stderr => {
    const f = harness([failure(stderr), success()])
    expect(f.fetch).not.toThrow()
    expect(f.execute).toHaveBeenCalledTimes(2)
  })

  it.each([
    'fatal: Authentication failed for repository',
    'fatal: unable to access repository: The requested URL returned error: 403',
    'fatal: unable to access repository: The requested URL returned error: 404',
    'fatal: repository not found',
    'fatal: remote error: upload-pack: not our ref 6337fc823ce20251c8de8085948165c81aaa701e',
    'fatal: fetch-pack: invalid index-pack output',
    'fatal: SHA1 hash mismatch',
    'fatal: unable to access repository: SSL certificate problem: certificate has expired',
  ])('does not retry a deterministic Git failure: %s', stderr => {
    const f = harness([failure(stderr)])
    expect(f.fetch).toThrow(/128/)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.wait).not.toHaveBeenCalled()
  })

  it.each(['SIGINT', 'SIGTERM'])('does not retry a fetch interrupted by %s', signal => {
    const f = harness([{ ...failure(dns), status: null, signal }])
    expect(f.fetch).toThrow(new RegExp(signal))
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.wait).not.toHaveBeenCalled()
  })

  it('propagates a missing Git executable without retrying', () => {
    const error = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' })
    const f = harness([{ ...failure(dns), status: null, error }])
    expect(f.fetch).toThrow(error)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.wait).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('captures real Git stderr from a PATH with spaces and retries the same exact commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo pinned fetch (&) '))
    const bin = join(root, 'fake git tools (&)')
    const source = join(root, 'source (&)')
    const logPath = join(root, 'calls.jsonl')
    const original = { PATH: process.env.PATH, LUMO_GIT_FETCH_TEST_LOG: process.env.LUMO_GIT_FETCH_TEST_LOG }
    mkdirSync(bin); mkdirSync(source)
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const path = process.env.LUMO_GIT_FETCH_TEST_LOG;
const previous = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean) : [];
fs.appendFileSync(path, JSON.stringify(process.argv.slice(2)) + '\\n');
if (previous.length === 0) {
  process.stderr.write(${JSON.stringify(dns)}, () => process.exit(128));
}
`, { mode: 0o755 })
    try {
      process.env.PATH = `${bin}:${original.PATH ?? ''}`
      process.env.LUMO_GIT_FETCH_TEST_LOG = logPath
      const wait = vi.fn((_milliseconds: number) => {})
      const log = vi.fn((_message: string) => {})
      expect(() => fetchPinnedCommit(source, commit, { wait, log })).not.toThrow()
      const calls = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual(calls[0])
      expect(calls[0]?.slice(calls[0].indexOf('-C'), calls[0].indexOf('-C') + 2)).toEqual(['-C', source])
      expect(calls[0]?.slice(calls[0].indexOf('fetch'))).toEqual(['fetch', '--depth', '1', 'origin', commit])
      expect(wait.mock.calls).toEqual([[5_000]])
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
