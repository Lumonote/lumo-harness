import { spawnSync } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

const retryDelays = [5_000, 15_000]
const sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)

function isTransientFetchError(output) {
  const text = stripVTControlCharacters(output)
  // Retry transport failures, never authentication, a missing ref or repository,
  // or a local checkout/build error. Git's exit 128 alone is not a retry reason.
  return /could not resolve (?:host|proxy)|failed to connect|connection (?:timed out|reset)|operation timed out|remote end hung up unexpectedly|early EOF/i.test(text)
    || /(?:requested URL returned error:|HTTP\/[12](?:\.\d)?(?:\s+stream \d+)?(?:\s+was not closed cleanly:)?\s+)\s*(?:408|429|500|502|503|504)\b/i.test(text)
    || /RPC failed;\s*curl (?:18|28|52|55|56|92)\b/i.test(text)
}

/** Fetch one immutable commit into a disposable checkout; never choose a branch. */
export function fetchPinnedCommit(checkout, commit, { execute = spawnSync, wait = sleep, log = console.warn } = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Source plugin fetch requires a full 40-character commit')
  for (let attempt = 0; ; attempt++) {
    const result = execute('git', ['-c', 'http.version=HTTP/1.1', '-C', checkout,
      'fetch', '--depth', '1', 'origin', commit], {
      cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024, timeout: 120_000, windowsHide: true,
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status === 0 && !result.signal) return
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.signal || attempt >= retryDelays.length || !isTransientFetchError(diagnostic)) {
      throw new Error(`source plugin: git fetch failed (${result.status ?? result.signal}) after ${attempt + 1} attempt(s)`)
    }
    const milliseconds = retryDelays[attempt]
    log(`源码插件下载暂时失败，${milliseconds / 1000} 秒后重试（${attempt + 2}/${retryDelays.length + 1}），保留固定提交 ${commit}。`)
    wait(milliseconds)
  }
}
