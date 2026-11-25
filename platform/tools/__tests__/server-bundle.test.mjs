// 服务端安装包打包脚本单测：命名、VERSION/manifest、文件清单、SHA256SUMS；pack() 用一棵假运行树端到端跑一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { BUNDLE_RE, bundleName, buildManifest, fileSums, normalizeArch, pack, readPin, sumsFor, treeDshHead, versionFile } from '../remote/pack-server.mjs'

const pin = readPin()

test('bundle naming', () => {
  assert.equal(bundleName('1.2.3', 'linux', 'x86_64'), 'lumo-server-1.2.3-linux-x64')
  assert.equal(bundleName('1.2.3', 'linux', 'aarch64'), 'lumo-server-1.2.3-linux-arm64')
  assert.throws(() => bundleName('1.2.3', 'windows', 'x64'))
  assert.throws(() => bundleName('1.2.3;rm', 'linux', 'x64'))
  assert.throws(() => normalizeArch('mips'))
  assert.ok(BUNDLE_RE.test('lumo-server-1.2.3-linux-arm64.tar.gz'))
})

test('pin is the single source for dsh', () => {
  assert.match(pin.dsh.sha, /^[0-9a-f]{40}$/u)
  const v = versionFile({ version: pin.version, os: 'linux', arch: 'x64', dsh: pin.dsh })
  assert.ok(v.includes(`dsh_sha=${pin.dsh.sha}\n`) && v.includes('os=linux\n') && v.includes('arch=x64\n'))
  const m = buildManifest({ version: '1.2.3', os: 'linux', arch: 'x64', dsh: pin.dsh, engines: pin.engines, fileCount: 1, filesSha256: 'x', createdAt: 't' })
  assert.equal(m.schema, 1); assert.equal(m.entry, 'bin/lumo-node'); assert.equal(m.dsh.sha, pin.dsh.sha)
})

function fakeTree(head = pin.dsh.sha) {
  const t = mkdtempSync(join(tmpdir(), 'lumo-tree-'))
  mkdirSync(join(t, 'deepseek-harness', '.git'), { recursive: true })
  writeFileSync(join(t, 'deepseek-harness', '.git', 'HEAD'), `${head}\n`)
  writeFileSync(join(t, 'deepseek-harness', 'package.json'), '{}')
  mkdirSync(join(t, 'platform', 'data-plane', 'dsh-node', 'src'), { recursive: true })
  mkdirSync(join(t, 'platform', 'data-plane', 'dsh-node', 'node_modules', 'tsx', 'dist'), { recursive: true })
  writeFileSync(join(t, 'platform', 'data-plane', 'dsh-node', 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(t, 'platform', 'data-plane', 'dsh-node', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '\n')
  return t
}

test('treeDshHead reads detached and ref HEAD', () => {
  const t = fakeTree()
  assert.equal(treeDshHead(t), pin.dsh.sha)
  writeFileSync(join(t, 'deepseek-harness', '.git', 'HEAD'), 'ref: refs/heads/master\n')
  writeFileSync(join(t, 'deepseek-harness', '.git', 'packed-refs'), `${pin.dsh.sha} refs/heads/master\n`)
  assert.equal(treeDshHead(t), pin.dsh.sha)
  rmSync(t, { recursive: true, force: true })
})

test('pack refuses a tree that is not on the dsh pin', () => {
  const t = fakeTree('0'.repeat(40)), out = mkdtempSync(join(tmpdir(), 'lumo-out-'))
  assert.throws(() => pack({ tree: t, os: 'linux', arch: 'x64', out }), /pin/u)
  assert.throws(() => pack({ tree: fakeTree(), os: 'linux', arch: 'x64', out, dshSha: '1'.repeat(40) }), /pin/u)
})

const gnuTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar')
test('pack produces tarball, sidecar sha256, manifest and SHA256SUMS', { skip: !gnuTar && 'needs GNU tar' }, () => {
  const t = fakeTree(), out = mkdtempSync(join(tmpdir(), 'lumo-out-'))
  const r = pack({ tree: t, os: 'linux', arch: 'x64', out, now: '2026-11-24T00:00:00Z' })
  const name = bundleName(pin.version, 'linux', 'x64')
  assert.ok(existsSync(join(out, `${name}.tar.gz`)))
  assert.equal(readFileSync(join(out, `${name}.tar.gz.sha256`), 'utf8'), `${r.sha256}  ${name}.tar.gz\n`)
  const list = spawnSync('tar', ['-tzf', r.tarball], { encoding: 'utf8' }).stdout.split('\n')
  for (const f of ['VERSION', 'manifest.json', 'files.sha256', 'bin/lumo-node', 'app/platform/data-plane/dsh-node/src/index.ts']) assert.ok(list.includes(`${name}/${f}`), f)
  assert.ok(!list.some(f => f.includes('/.git/')), '.git must not be shipped')
  assert.equal(r.manifest.dsh.sha, pin.dsh.sha)
  assert.equal(sumsFor(out), `${r.sha256}  ${name}.tar.gz\n`)
})

test('fileSums lists every regular file except itself and manifest', () => {
  const t = mkdtempSync(join(tmpdir(), 'lumo-sums-'))
  writeFileSync(join(t, 'a'), 'a'); writeFileSync(join(t, 'manifest.json'), '{}'); writeFileSync(join(t, 'files.sha256'), '')
  assert.equal(fileSums(t), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a\n')
})
