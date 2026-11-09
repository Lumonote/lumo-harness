/** Release resolves master once; consumers accept only that immutable commit. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function upstreamCommit(output) {
  const rows = output.trim().split(/\r?\n/u)
  assert.equal(rows.length, 1, 'Expected exactly one upstream master reference')
  const match = /^([a-f0-9]{40})\s+refs\/heads\/master$/u.exec(rows[0])
  assert.ok(match, 'Upstream master did not resolve to a full Git SHA')
  return match[1]
}

export function validateUpstreamRef(value) {
  assert.ok(value === 'master' || /^[a-f0-9]{40}$/u.test(value), 'Upstream ref must be master or a full immutable Git SHA')
  return value
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === '--validate') {
      assert.equal(process.argv.length, 4, 'Expected one upstream ref')
      console.log(validateUpstreamRef(process.argv[3]))
    } else {
      assert.equal(process.argv.length, 2, 'Usage: node resolve-upstream-ref.mjs [--validate <ref>]')
      const sha = upstreamCommit(execFileSync('git', ['ls-remote', '--exit-code', 'https://github.com/deepseek-ai/deepseek-harness.git', 'refs/heads/master'], { encoding: 'utf8', timeout: 60000 }))
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`)
      console.log(sha)
    }
  } catch (error) { console.error(`Upstream resolution failed: ${error.message}`); process.exitCode = 1 }
}
