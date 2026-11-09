import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { verifyReleaseVersion } from '../verify-release-version.mjs'

const metadata = { packageVersion: '1.2.3', desktopVersion: '1.2.3', chart: 'version: 1.2.3\nappVersion: "1.2.3"\n' }
test('a formal release tag binds all four product versions', () => {
  assert.deepEqual(verifyReleaseVersion('refs/tags/v1.2.3', metadata), { version: '1.2.3' })
  for (const change of [{ packageVersion: '1.2.2' }, { desktopVersion: '1.2.2' }, { chart: 'version: 1.2.2\nappVersion: "1.2.3"\n' }, { chart: 'version: 1.2.3\nappVersion: "1.2.2"\n' }]) {
    assert.throws(() => verifyReleaseVersion('refs/tags/v1.2.3', { ...metadata, ...change }), /differs/u)
  }
})
test('malformed, duplicate, missing and arbitrary release versions fail closed', () => {
  for (const ref of ['refs/heads/main', 'refs/tags/v9.0.0', 'refs/tags/v01.2.3', 'refs/tags/v1.2', 'refs/tags/v1.2.3-01', 'refs/tags/v1.2.3\n']) {
    assert.throws(() => verifyReleaseVersion(ref, metadata))
  }
  for (const chart of ['version: 1.2.3\n', metadata.chart + 'version: 1.2.3\n', 'version: !!str 1.2.3\nappVersion: "1.2.3"\n']) {
    assert.throws(() => verifyReleaseVersion('refs/tags/v1.2.3', { ...metadata, chart }))
  }
  const version = '1.2.3-rc.1+build.123'
  assert.deepEqual(verifyReleaseVersion('refs/tags/v' + version, { packageVersion: version, desktopVersion: version, chart: `version: ${version}\nappVersion: "${version}"\n` }), { version })
})
test('release checks the product tag before resolving and building sources', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const start = workflow.indexOf('  source-identity:')
  const end = workflow.indexOf('\n  basic-validation:', start)
  const source = workflow.slice(start, end)
  assert.match(source, /if: startsWith\(github.ref, 'refs\/tags\/v'\)/u)
  assert(source.indexOf('verify-release-version.mjs') < source.indexOf('resolve-upstream-ref.mjs'))
})
