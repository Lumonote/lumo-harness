/** A formal tag must describe the actual desktop and chart product version. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const numeric = '(?:0|[1-9][0-9]*)'
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`, 'u')

function chartField(source, name) {
  const lines = source.split(/\r?\n/u).filter(line => line.startsWith(name + ':'))
  assert.equal(lines.length, 1, `Chart must define exactly one ${name}`)
  const match = new RegExp(`^${name}:\\s*(?:"([^"\\s]+)"|'([^'\\s]+)'|([^'"\\s]+))\\s*(?:#.*)?$`, 'u').exec(lines[0])
  assert.ok(match, `Chart ${name} must be an explicit version scalar`)
  return match[1] ?? match[2] ?? match[3]
}

export function verifyReleaseVersion(ref, { packageVersion, desktopVersion, chart }) {
  assert.ok(typeof ref === 'string' && ref.startsWith('refs/tags/v'), 'Formal release requires a v-prefixed Git tag')
  const version = ref.slice('refs/tags/v'.length)
  assert.ok(semver.test(version), 'Release tag must contain a canonical semantic version')
  for (const [name, actual] of Object.entries({ package: packageVersion, desktop: desktopVersion, chart: chartField(chart, 'version'), appVersion: chartField(chart, 'appVersion') })) {
    assert.equal(actual, version, `${name} version differs from release tag`)
  }
  return { version }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: GITHUB_REF=refs/tags/v<version> node verify-release-version.mjs')
    console.log(JSON.stringify(verifyReleaseVersion(process.env.GITHUB_REF, {
      packageVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
      desktopVersion: JSON.parse(readFileSync(resolve(root, 'desktop/tauri.conf.json'), 'utf8')).version,
      chart: readFileSync(resolve(root, 'deploy/helm/lumo-platform/Chart.yaml'), 'utf8'),
    })))
  } catch (error) { console.error(`Release version verification failed: ${error.message}`); process.exitCode = 1 }
}
