/**
 * Upstream dsh source identity.
 *
 * Release / CI / acceptance use the immutable commit pinned in platform/dsh-pin.json
 * (see docs/dsh-compat.md). `master` is only followed by the nightly compatibility job.
 *
 *   node resolve-upstream-ref.mjs                  print pinned SHA (also writes sha= to $GITHUB_OUTPUT)
 *   node resolve-upstream-ref.mjs --latest         resolve upstream master once (old behaviour)
 *   node resolve-upstream-ref.mjs --validate <ref> accept only master or a full 40-hex SHA
 *   node resolve-upstream-ref.mjs --select [ref]   empty → pinned SHA, otherwise validate; writes ref=
 *   node resolve-upstream-ref.mjs --bump <sha> [tag]  rewrite the pin (upgrade entry point)
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const pinFile = fileURLToPath(new URL('../dsh-pin.json', import.meta.url))

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

export function pinnedUpstream(text = readFileSync(pinFile, 'utf8')) {
  const pin = JSON.parse(text)
  assert.match(pin.sha ?? '', /^[a-f0-9]{40}$/u, 'dsh-pin.json sha must be a full immutable Git SHA')
  return pin
}

export function selectUpstreamRef(value, pin = pinnedUpstream()) {
  return value ? validateUpstreamRef(value) : pin.sha
}

const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`) }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, ...rest] = process.argv.slice(2)
    if (mode === '--validate') {
      assert.equal(rest.length, 1, 'Expected one upstream ref')
      console.log(validateUpstreamRef(rest[0]))
    } else if (mode === '--select') {
      const ref = selectUpstreamRef(rest[0] ?? '')
      output('ref', ref)
      console.log(ref)
    } else if (mode === '--latest') {
      const sha = upstreamCommit(execFileSync('git', ['ls-remote', '--exit-code', 'https://github.com/deepseek-ai/deepseek-harness.git', 'refs/heads/master'], { encoding: 'utf8', timeout: 60000 }))
      output('sha', sha)
      console.log(sha)
    } else if (mode === '--bump') {
      assert.ok(rest.length >= 1 && rest.length <= 2, 'Usage: --bump <sha> [tag]')
      assert.match(rest[0], /^[a-f0-9]{40}$/u, 'Bump target must be a full Git SHA')
      const pin = pinnedUpstream()
      const next = { ...pin, sha: rest[0], tag: rest[1] ?? null, pinnedAt: new Date().toISOString().slice(0, 10) }
      writeFileSync(pinFile, `${JSON.stringify(next, null, 2)}\n`)
      console.log(`dsh pin: ${pin.sha} -> ${next.sha}. Now run check-compatibility + tests and add a row to docs/dsh-compat.md.`)
    } else {
      assert.equal(mode, undefined, 'Usage: node resolve-upstream-ref.mjs [--latest | --validate <ref> | --select [ref] | --bump <sha> [tag]]')
      const sha = pinnedUpstream().sha
      output('sha', sha)
      console.log(sha)
    }
  } catch (error) { console.error(`Upstream resolution failed: ${error.message}`); process.exitCode = 1 }
}
