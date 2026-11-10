import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const signingKeys = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_PROVIDER_SHORT_NAME',
  'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH',
  'LUMO_CUA_SIGNING_KEYCHAIN', 'LUMO_MACOS_SIGNING_KEYCHAIN', 'LUMO_MACOS_SIGNING_IDENTITY', 'LUMO_MACOS_NOTARY_PROFILE']

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumo-build-signing-'))
  const platform = join(root, 'platform'), bin = join(root, 'bin'), evidence = join(root, 'build-env.jsonl')
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode: 0o755 }) }
  mkdirSync(platform); mkdirSync(bin)
  copyFileSync(new URL('../../build.sh', import.meta.url), join(platform, 'build.sh'))
  write(join(platform, 'package.json'), '{\n  "version": "1.2.1"\n}\n')
  const capture = join(root, 'capture.mjs')
  write(capture, `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const keys = ${JSON.stringify([...signingKeys, 'APPLE_SIGNING_IDENTITY', 'LUMO_CUA_SIGNING_IDENTITY', 'LUMO_RELEASE_SIGNING_REQUIRED'])};
appendFileSync(process.env.LUMO_SIGNING_TEST_EVIDENCE, JSON.stringify({ stage: process.argv[2], env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])) }) + '\\n');
const node = join(process.env.LUMO_SIGNING_TEST_ROOT, 'platform/desktop/target/release/bundle/macos/DeepSeek Harness.app/Contents/Resources/runtime/node');
mkdirSync(dirname(node), { recursive: true }); writeFileSync(node, 'fixture');
if (process.argv[2] === 'dmg') {
 const dmg = join(process.env.LUMO_SIGNING_TEST_ROOT, 'platform/desktop/target/release/bundle/dmg/DeepSeek-Harness_1.2.1_aarch64.dmg');
 mkdirSync(dirname(dmg), { recursive: true }); writeFileSync(dmg, 'fixture');
}
`)
  const invoke = stage => `"$LUMO_SIGNING_TEST_NODE" "$LUMO_SIGNING_TEST_CAPTURE" ${stage}`
  write(join(platform, 'deploy/lib/dsh-source.sh'), `ensure_dsh_source() { ${invoke('source')}; }\n`)
  write(join(platform, 'upstream/install-components.sh'), `#!/usr/bin/env bash\n${invoke('components')}\n`)
  write(join(platform, 'desktop/make-dmg.sh'), `#!/usr/bin/env bash\n${invoke('dmg')}\n`)
  write(join(bin, 'cargo'), `#!/usr/bin/env bash\n${invoke('cargo')}\n`)
  write(join(bin, 'lipo'), '#!/usr/bin/env bash\necho arm64\n')
  const credentials = Object.fromEntries(signingKeys.map(key => [key, `fixture-${key}`]))
  const env = { ...process.env, ...credentials, APPLE_SIGNING_IDENTITY: 'fixture-Apple-identity', LUMO_CUA_SIGNING_IDENTITY: 'fixture-CUA-identity',
    PATH: `${bin}:${process.env.PATH}`, LUMO_BUILD_HOST_OS: 'Darwin', LUMO_BUILD_HOST_ARCH: 'arm64',
    LUMO_SIGNING_TEST_NODE: process.execPath, LUMO_SIGNING_TEST_CAPTURE: capture,
    LUMO_SIGNING_TEST_EVIDENCE: evidence, LUMO_SIGNING_TEST_ROOT: root }
  delete env.LUMO_RELEASE_SIGNING_MODE; delete env.LUMO_RELEASE_SIGNING_REQUIRED
  return { root, evidence, credentials, env,
    run(overrides = {}, args = ['--targets', 'darwin-arm64']) {
      return spawnSync('bash', [join(platform, 'build.sh'), ...args], { env: { ...env, ...overrides }, encoding: 'utf8' })
    },
    records: () => readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('explicit unsigned builds isolate inherited credentials before source preparation and Tauri', () => {
  const f = fixture()
  try {
    const result = f.run({ LUMO_RELEASE_SIGNING_MODE: 'unsigned' })
    assert.equal(result.status, 0, result.stderr)
    const records = f.records()
    assert.deepEqual(records.map(record => record.stage), ['source', 'components', 'cargo', 'dmg'])
    for (const { env } of records) {
      for (const key of signingKeys) assert.equal(env[key], null, key)
      assert.equal(env.APPLE_SIGNING_IDENTITY, '-')
      assert.equal(env.LUMO_CUA_SIGNING_IDENTITY, '-')
      assert.equal(env.LUMO_RELEASE_SIGNING_REQUIRED, '0')
    }
  } finally { f.cleanup() }
})

test('unsigned and mandatory certificate signing conflict before preparing any dependencies', () => {
  const f = fixture()
  try {
    const result = f.run({ LUMO_RELEASE_SIGNING_MODE: 'unsigned', LUMO_RELEASE_SIGNING_REQUIRED: '1' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unsigned.*LUMO_RELEASE_SIGNING_REQUIRED=1/u)
    assert.equal(existsSync(f.evidence), false)
  } finally { f.cleanup() }
})

test('legacy local mandatory signing retains its inherited identities and credentials', () => {
  const f = fixture()
  try {
    const result = f.run({ LUMO_RELEASE_SIGNING_REQUIRED: '1' })
    assert.equal(result.status, 0, result.stderr)
    for (const { env } of f.records()) {
      for (const key of signingKeys) assert.equal(env[key], f.credentials[key], key)
      assert.equal(env.APPLE_SIGNING_IDENTITY, 'fixture-Apple-identity')
      assert.equal(env.LUMO_CUA_SIGNING_IDENTITY, 'fixture-CUA-identity')
      assert.equal(env.LUMO_RELEASE_SIGNING_REQUIRED, '1')
    }
  } finally { f.cleanup() }
})

test('explicit signed builds enable preflight before preparing dependencies without requiring a second flag', () => {
  const f = fixture()
  try {
    const result = f.run({ LUMO_RELEASE_SIGNING_MODE: 'signed' })
    assert.equal(result.status, 0, result.stderr)
    for (const { env } of f.records()) {
      assert.equal(env.LUMO_RELEASE_SIGNING_REQUIRED, '1')
      assert.equal(env.LUMO_CUA_SIGNING_IDENTITY, 'fixture-CUA-identity')
    }
  } finally { f.cleanup() }
})

test('conflicting or invalid desktop signing modes fail before preparing dependencies', () => {
  const f = fixture()
  try {
    for (const selection of [
      { LUMO_RELEASE_SIGNING_MODE: 'signed', LUMO_RELEASE_SIGNING_REQUIRED: '0' },
      { LUMO_RELEASE_SIGNING_MODE: 'unsigned', LUMO_RELEASE_SIGNING_REQUIRED: 'invalid' },
      { LUMO_RELEASE_SIGNING_MODE: 'invalid' },
    ]) {
      assert.equal(f.run(selection).status, 1)
      assert.equal(existsSync(f.evidence), false)
    }
  } finally { f.cleanup() }
})

test('image-only builds do not apply desktop signing policy', () => {
  const f = fixture()
  try {
    const result = f.run({ LUMO_RELEASE_SIGNING_MODE: 'unsigned', LUMO_RELEASE_SIGNING_REQUIRED: '1' }, ['--targets', 'images', '--dry-run'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /docker build/u)
    assert.equal(existsSync(f.evidence), false)
  } finally { f.cleanup() }
})
