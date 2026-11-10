import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportReleaseSigning, resolveReleaseSigning } from '../resolve-release-signing.mjs'
import { signingInputKeys } from '../prepare-release-signing.mjs'

const mac = { LUMO_MACOS_SIGNING_P12: 'YWJj', LUMO_MACOS_SIGNING_P12_PASSWORD: 'fixture-password', LUMO_MACOS_SIGNING_IDENTITY: 'Developer ID Application: Lumo (ABCDE12345)', LUMO_MACOS_NOTARY_API_KEY: '-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----', LUMO_MACOS_NOTARY_KEY_ID: 'ABCDE12345', LUMO_MACOS_NOTARY_ISSUER: '12345678-1234-1234-1234-123456789012' }
const windows = { LUMO_WINDOWS_SIGNING_PFX: 'YWJj', LUMO_WINDOWS_SIGNING_PFX_PASSWORD: 'fixture-password', LUMO_WINDOWS_TIMESTAMP_URL: 'https://timestamp.example' }

for (const [platform, credentials, other] of [['darwin', mac, windows], ['win32', windows, mac]]) {
  test(`${platform}: no credentials builds unsigned, independently of the other platform`, () => {
    for (const env of [{}, other, { ...other, LUMO_RELEASE_SIGNING_MODE: 'auto' }]) {
      assert.deepEqual(resolveReleaseSigning(env, platform), { mode: 'unsigned', required: '0' })
    }
  })
  test(`${platform}: complete auto and explicit signed configurations require signing`, () => {
    for (const mode of ['auto', 'signed']) assert.deepEqual(resolveReleaseSigning({ ...credentials, LUMO_RELEASE_SIGNING_MODE: mode }, platform), { mode: 'signed', required: '1' })
  })
  test(`${platform}: a partial or invalid certificate configuration never downgrades to unsigned`, () => {
    for (const key of signingInputKeys(platform)) {
      const partial = { ...credentials }; delete partial[key]
      assert.throws(() => resolveReleaseSigning(partial, platform), new RegExp(key))
    }
    assert.throws(() => resolveReleaseSigning({ ...credentials, [signingInputKeys(platform)[0]]: 'invalid-base64' }, platform), /base64/u)
    assert.throws(() => resolveReleaseSigning({ LUMO_RELEASE_SIGNING_MODE: 'signed' }, platform), /Missing or invalid/u)
  })
  test(`${platform}: explicitly unsigned ignores optional certificate configuration`, () => {
    assert.deepEqual(resolveReleaseSigning({ ...credentials, LUMO_RELEASE_SIGNING_MODE: 'unsigned' }, platform), { mode: 'unsigned', required: '0' })
    assert.deepEqual(resolveReleaseSigning({ [signingInputKeys(platform)[0]]: 'invalid', LUMO_RELEASE_SIGNING_MODE: 'unsigned' }, platform), { mode: 'unsigned', required: '0' })
  })
}
test('invalid signing modes fail without exporting a successful build mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-signing-mode-'))
  try {
    for (const mode of ['automatic', 'SIGNed', 'signed\nunsigned']) {
      assert.throws(() => exportReleaseSigning({ env: { LUMO_RELEASE_SIGNING_MODE: mode, GITHUB_ENV: join(root, 'env'), GITHUB_OUTPUT: join(root, 'output') }, platform: 'darwin' }), /must be auto/u)
    }
    assert.equal(existsSync(join(root, 'env')), false)
    assert.equal(existsSync(join(root, 'output')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('exports only the resolved mode and required flag, preserving multiline secret confidentiality', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-signing-mode-'))
  try {
    const env = { ...mac, GITHUB_ENV: join(root, 'env'), GITHUB_OUTPUT: join(root, 'output') }
    exportReleaseSigning({ env, platform: 'darwin' })
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'LUMO_RELEASE_SIGNING_MODE=signed\nLUMO_RELEASE_SIGNING_REQUIRED=1\n')
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'mode=signed\nrequired=1\n')
    const unsigned = { GITHUB_ENV: join(root, 'unsigned-env'), GITHUB_OUTPUT: join(root, 'unsigned-output') }
    exportReleaseSigning({ env: unsigned, platform: 'win32' })
    assert.equal(readFileSync(unsigned.GITHUB_ENV, 'utf8'), 'LUMO_RELEASE_SIGNING_MODE=unsigned\nLUMO_RELEASE_SIGNING_REQUIRED=0\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
