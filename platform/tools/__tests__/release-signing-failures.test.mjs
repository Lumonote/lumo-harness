import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanupSigning, prepareSigning, windowsImportPlan } from '../prepare-release-signing.mjs'

const signer = 'a'.repeat(40), chain = 'b'.repeat(40), existing = 'c'.repeat(40)
const inspection = (extra = {}) => ({ thumbprints: [signer, chain], signers: [signer], protected_thumbprints: [existing], shared_private_key: false, ...extra })
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lumo-signing-fault-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'lumo-release-signing'), receipt = join(directory, 'windows-import.json')
  return { root, directory, receipt, env: { LUMO_WINDOWS_SIGNING_PFX: 'YWJj', LUMO_WINDOWS_SIGNING_PFX_PASSWORD: 'private-password-not-argv', LUMO_WINDOWS_TIMESTAMP_URL: 'https://timestamp.example', RUNNER_TEMP: root, GITHUB_ENV: join(root, 'github-env') } }
}

test('rejects pre-existing certificates, shared keys and ambiguous signers before persisting private keys', () => {
  for (const extra of [
    { protected_thumbprints: [signer] }, { shared_private_key: true },
    { signers: [signer, chain] }, { signers: [] }, { thumbprints: [signer, signer] },
  ]) assert.throws(() => windowsImportPlan(JSON.stringify(inspection(extra))))
})

test('inspection rejection never invokes import or deletes an existing certificate', t => {
  const f = fixture(t), calls = []
  const run = (command, args) => { calls.push(args); return JSON.stringify(inspection({ protected_thumbprints: [signer] })) }
  assert.throws(() => prepareSigning({ env: f.env, platform: 'win32', run }), /already exists/u)
  assert.equal(calls.length, 1); assert.ok(calls[0].at(-1).endsWith('inspect.ps1'))
  assert.equal(existsSync(f.directory), false); assert.equal(existsSync(f.env.GITHUB_ENV), false)
})

test('partial import failure removes every planned certificate and private key while protecting pre-existing identities', t => {
  const f = fixture(t), store = new Set([existing]), deleted = [], calls = []
  const run = (command, args, options) => {
    calls.push(args)
    if (args.at(-1).endsWith('inspect.ps1')) return JSON.stringify(inspection())
    if (args.at(-1).endsWith('import.ps1')) {
      // The durable plan precedes persistent mutation; a native partial failure
      // need not return a signer or finish writing a success receipt.
      const plan = JSON.parse(readFileSync(f.receipt, 'utf8'))
      assert.deepEqual(plan.thumbprints, [signer, chain]); assert.equal(plan.state, 'inspected')
      plan.state = 'importing'; writeFileSync(f.receipt, JSON.stringify(plan)); store.add(signer)
      throw Error('partial native import failed')
    }
    assert.match(args.at(-1), /-DeleteKey/u)
    for (const thumbprint of JSON.parse(options.env.LUMO_CI_CERT_THUMBPRINTS)) { deleted.push(thumbprint); store.delete(thumbprint) }
    return ''
  }
  assert.throws(() => prepareSigning({ env: f.env, platform: 'win32', run }), /partial native import/u)
  assert.deepEqual(deleted, [signer, chain]); assert.deepEqual([...store], [existing])
  assert.equal(calls.length, 3); assert.equal(existsSync(f.directory), false)
  assert.equal(existsSync(f.env.GITHUB_ENV), false)
  assert.ok(!calls.flat().join('\n').includes(f.env.LUMO_WINDOWS_SIGNING_PFX_PASSWORD))
})

test('changed signer output after completed import still triggers complete cleanup', t => {
  const f = fixture(t), removed = []
  const run = (command, args, options) => {
    if (args.at(-1).endsWith('inspect.ps1')) return JSON.stringify(inspection())
    if (args.at(-1).endsWith('import.ps1')) {
      const plan = JSON.parse(readFileSync(f.receipt, 'utf8')); plan.state = 'imported'; writeFileSync(f.receipt, JSON.stringify(plan))
      return 'unexpected native stdout'
    }
    removed.push(...JSON.parse(options.env.LUMO_CI_CERT_THUMBPRINTS)); return ''
  }
  assert.throws(() => prepareSigning({ env: f.env, platform: 'win32', run }), /different signer/u)
  assert.deepEqual(removed, [signer, chain]); assert.equal(existsSync(f.env.GITHUB_ENV), false)
})

test('an import collision detected before mutation does not delete the newly observed existing certificate', t => {
  const f = fixture(t); let cleanupCalled = false
  const run = (command, args) => {
    if (args.at(-1).endsWith('inspect.ps1')) return JSON.stringify(inspection())
    if (args.at(-1).endsWith('import.ps1')) throw Error('certificate now exists before importing')
    cleanupCalled = true; return ''
  }
  assert.throws(() => prepareSigning({ env: f.env, platform: 'win32', run }), /now exists/u)
  assert.equal(cleanupCalled, false); assert.equal(existsSync(f.directory), false)
})

test('cleanup failure retains its exact public receipt for a retry but removes raw secrets', t => {
  const f = fixture(t)
  const run = (command, args) => {
    if (args.at(-1).endsWith('inspect.ps1')) return JSON.stringify(inspection())
    if (args.at(-1).endsWith('import.ps1')) {
      const plan = JSON.parse(readFileSync(f.receipt, 'utf8')); plan.state = 'importing'; writeFileSync(f.receipt, JSON.stringify(plan)); throw Error('partial import')
    }
    throw Error('native cleanup unavailable')
  }
  assert.throws(() => prepareSigning({ env: f.env, platform: 'win32', run }), /cleanup is incomplete/u)
  assert.equal(existsSync(f.receipt), true)
  for (const file of ['identity.pfx', 'inspect.ps1', 'import.ps1']) assert.equal(existsSync(join(f.directory, file)), false)
  let deleted
  cleanupSigning({ env: f.env, platform: 'win32', run: (command, args, options) => { deleted = JSON.parse(options.env.LUMO_CI_CERT_THUMBPRINTS); return '' } })
  assert.deepEqual(deleted, [signer, chain]); assert.equal(existsSync(f.directory), false)
})

test('malformed cleanup receipt cannot authorize deleting a pre-existing certificate', t => {
  const f = fixture(t); mkdirSync(f.directory)
  writeFileSync(f.receipt, JSON.stringify({ ...windowsImportPlan(JSON.stringify(inspection())), state: 'importing', protected_thumbprints: [signer] }))
  let called = false
  assert.throws(() => cleanupSigning({ env: f.env, platform: 'win32', run: () => { called = true; return '' } }), /pre-existing/u)
  assert.equal(called, false); assert.equal(existsSync(f.receipt), true)
})
