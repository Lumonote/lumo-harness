/** Import ephemeral CI certificates. Secret values never enter child-process argv. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nonempty = (env, key) => {
  assert.ok(typeof env[key] === 'string' && env[key].trim() && !/[\r\n\0]/u.test(env[key]), `Missing or invalid ${key}`)
  return env[key]
}
const macKeys = ['LUMO_MACOS_SIGNING_P12', 'LUMO_MACOS_SIGNING_P12_PASSWORD', 'LUMO_MACOS_SIGNING_IDENTITY', 'LUMO_MACOS_NOTARY_API_KEY', 'LUMO_MACOS_NOTARY_KEY_ID', 'LUMO_MACOS_NOTARY_ISSUER']
const windowsKeys = ['LUMO_WINDOWS_SIGNING_PFX', 'LUMO_WINDOWS_SIGNING_PFX_PASSWORD', 'LUMO_WINDOWS_TIMESTAMP_URL']

export function signingInputKeys(platform) {
  assert.ok(['darwin', 'win32'].includes(platform), 'Only macOS and Windows release signing is supported')
  return [...(platform === 'darwin' ? macKeys : windowsKeys)]
}

export function signingInputs(env, platform) {
  for (const key of signingInputKeys(platform)) {
    if (key === 'LUMO_MACOS_NOTARY_API_KEY') assert.ok(typeof env[key] === 'string' && env[key].trim() && !/[\0]/u.test(env[key]), `Missing or invalid ${key}`)
    else nonempty(env, key)
  }
  const base64 = env[platform === 'darwin' ? macKeys[0] : windowsKeys[0]]
  assert.ok(/^[A-Za-z0-9+/]+={0,2}$/u.test(base64) && Buffer.from(base64, 'base64').toString('base64') === base64, 'Signing certificate must use canonical base64')
  if (platform === 'darwin') {
    assert.match(env.LUMO_MACOS_SIGNING_IDENTITY, /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u, 'Expected Developer ID Application identity')
    assert.match(env.LUMO_MACOS_NOTARY_KEY_ID, /^[A-Z0-9]{10}$/u, 'Invalid App Store Connect key ID')
    assert.match(env.LUMO_MACOS_NOTARY_ISSUER, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu, 'Invalid App Store Connect issuer')
    assert.ok(env.LUMO_MACOS_NOTARY_API_KEY.includes('-----BEGIN PRIVATE KEY-----'), 'Expected App Store Connect .p8 key')
  } else {
    const url = new URL(env.LUMO_WINDOWS_TIMESTAMP_URL)
    assert.ok(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 'Invalid timestamp service URL')
  }
  return Buffer.from(base64, 'base64')
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  // Tools can print credentials in diagnostic text; expose only an action label.
  if (result.error || result.status !== 0) throw Error(`Release signing credential setup failed in ${command}`)
  return result.stdout
}
export const swiftImport = `import Foundation
import Security
let env = ProcessInfo.processInfo.environment
func require(_ condition: Bool) { if !condition { exit(1) } }
var keychain: SecKeychain?
let password = env["LUMO_CI_KEYCHAIN_PASSWORD"]!
require(SecKeychainCreate(env["LUMO_CI_KEYCHAIN_PATH"]!, UInt32(password.utf8.count), password, false, nil, &keychain) == errSecSuccess)
require(SecKeychainUnlock(keychain!, UInt32(password.utf8.count), password, true) == errSecSuccess)
let data = try Data(contentsOf: URL(fileURLWithPath: env["LUMO_CI_CERT_PATH"]!))
var items: CFArray?
let options = [kSecImportExportPassphrase as String: env["LUMO_MACOS_SIGNING_P12_PASSWORD"]!, kSecImportExportKeychain as String: keychain!] as CFDictionary
require(SecPKCS12Import(data as CFData, options, &items) == errSecSuccess)
let rows = items as! [[String: Any]]
require(!rows.isEmpty)
for row in rows {
  let identity = row[kSecImportItemIdentity as String] as! SecIdentity
  var key: SecKey?
  require(SecIdentityCopyPrivateKey(identity, &key) == errSecSuccess)
  var access: SecAccess?
  require(SecKeychainItemCopyAccess(key! as! SecKeychainItem, &access) == errSecSuccess)
  var trusted: SecTrustedApplication?
  require(SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &trusted) == errSecSuccess)
  var acls: CFArray?
  require(SecAccessCopyACLList(access!, &acls) == errSecSuccess)
  for acl in acls as! [SecACL] {
    var applications: CFArray?; var description: CFString?; var selector = SecKeychainPromptSelector()
    require(SecACLCopyContents(acl, &applications, &description, &selector) == errSecSuccess)
    require(SecACLSetContents(acl, [trusted!] as CFArray, description ?? "Lumo release codesign" as CFString, selector) == errSecSuccess)
  }
  require(SecKeychainItemSetAccess(key! as! SecKeychainItem, access!) == errSecSuccess)
}
`

// Inspect PFX contents without persisting any private key. The complete plan is
// durable before Import-PfxCertificate, including its partial-failure window.
export const windowsInspect = `$ErrorActionPreference='Stop'
$certificates=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
try {
  $certificates.Import($env:LUMO_CI_CERT_PATH,$env:LUMO_WINDOWS_SIGNING_PFX_PASSWORD,[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  $existing=@(Get-ChildItem Cert:\\CurrentUser\\My)
  $keys=@($certificates | ForEach-Object { $_.GetPublicKeyString() })
  $existingKeys=@(Get-ChildItem Cert:\\CurrentUser -Recurse | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509Certificate2] -and $_.HasPrivateKey })
  $shared=@($existingKeys | Where-Object { $keys -contains $_.GetPublicKeyString() })
  @{thumbprints=@($certificates | ForEach-Object { $_.Thumbprint.ToLowerInvariant() }); signers=@($certificates | Where-Object { $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') } | ForEach-Object { $_.Thumbprint.ToLowerInvariant() }); protected_thumbprints=@($existing | ForEach-Object { $_.Thumbprint.ToLowerInvariant() }); shared_private_key=($shared.Count -ne 0)} | ConvertTo-Json -Compress
} finally { foreach($certificate in $certificates){$certificate.Dispose()} }
`

export const windowsImport = `$ErrorActionPreference='Stop'
$path=$env:LUMO_CI_CERT_RECEIPT
$plan=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if($plan.state -ne 'inspected'){throw 'Expected an inspected certificate import plan'}
foreach($thumbprint in $plan.thumbprints){if(Test-Path ('Cert:\\CurrentUser\\My\\'+$thumbprint)){throw 'Certificate already exists; refusing to replace it'}}
function Save-Plan {
  $temporary=$path+'.next'
  [System.IO.File]::WriteAllText($temporary,($plan | ConvertTo-Json -Compress),(New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::Replace($temporary,$path,$null)
}
$plan.state='importing'
Save-Plan
$password=ConvertTo-SecureString $env:LUMO_WINDOWS_SIGNING_PFX_PASSWORD -AsPlainText -Force
$certificates=@(Import-PfxCertificate -FilePath $env:LUMO_CI_CERT_PATH -CertStoreLocation Cert:\\CurrentUser\\My -Password $password)
$actual=@($certificates | ForEach-Object { $_.Thumbprint.ToLowerInvariant() } | Sort-Object -Unique)
if(@(Compare-Object @($plan.thumbprints | Sort-Object) $actual).Count -ne 0){throw 'Imported certificate set differs from inspected plan'}
$plan.state='imported'
Save-Plan
$plan.signer
`

export const windowsCleanup = `$ErrorActionPreference='Stop'
$failed=$false
foreach($thumbprint in @(ConvertFrom-Json $env:LUMO_CI_CERT_THUMBPRINTS)){
  $path='Cert:\\CurrentUser\\My\\'+$thumbprint
  try {
    if(Test-Path $path){
      $certificate=Get-Item -LiteralPath $path
      if($certificate.HasPrivateKey){Remove-Item -LiteralPath $path -DeleteKey -Force -ErrorAction Stop}
      else {Remove-Item -LiteralPath $path -Force -ErrorAction Stop}
    }
  } catch { $failed=$true }
}
if($failed){throw 'Failed to remove every imported certificate and private key'}
`

const receiptSchema = 'lumo-windows-signing-import/v1'
function thumbprints(values, name, { empty = false } = {}) {
  assert.ok(Array.isArray(values) && (empty || values.length > 0), `Invalid ${name}`)
  assert.ok(values.every(value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)), `Invalid ${name}`)
  assert.equal(new Set(values).size, values.length, `Duplicate ${name}`)
  return values
}
export function windowsImportPlan(source) {
  const inspection = JSON.parse(source)
  const candidates = thumbprints(inspection.thumbprints, 'PFX certificate identities')
  const protectedThumbprints = thumbprints(inspection.protected_thumbprints, 'existing certificate identities', { empty: true })
  const signers = thumbprints(inspection.signers, 'code signing identities')
  assert.equal(signers.length, 1, 'Expected exactly one code signing private key')
  assert.ok(candidates.includes(signers[0]), 'Signer is absent from PFX certificate identities')
  assert.ok(candidates.every(value => !protectedThumbprints.includes(value)), 'PFX certificate already exists; refusing to replace it')
  assert.equal(inspection.shared_private_key, false, 'PFX would reuse an existing private key')
  return { schema: receiptSchema, state: 'inspected', thumbprints: candidates, protected_thumbprints: protectedThumbprints, signer: signers[0] }
}
function readWindowsReceipt(path) {
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(receipt.schema, receiptSchema, 'Unknown certificate import receipt')
  assert.ok(['inspected', 'importing', 'imported'].includes(receipt.state), 'Invalid certificate import state')
  const candidates = thumbprints(receipt.thumbprints, 'imported certificate identities')
  const protectedThumbprints = thumbprints(receipt.protected_thumbprints, 'protected certificate identities', { empty: true })
  assert.ok(candidates.includes(receipt.signer), 'Missing imported signer')
  assert.ok(candidates.every(value => !protectedThumbprints.includes(value)), 'Import receipt would delete a pre-existing certificate')
  return receipt
}

export function prepareSigning({ env = process.env, platform = process.platform, run = checked } = {}) {
  const certificate = signingInputs(env, platform)
  const temporary = nonempty(env, 'RUNNER_TEMP')
  const output = nonempty(env, 'GITHUB_ENV')
  const directory = join(temporary, 'lumo-release-signing')
  assert.ok(!existsSync(directory), 'Signing credential directory already exists')
  mkdirSync(directory, { mode: 0o700 })
  const exported = {}
  try {
    const certificatePath = join(directory, platform === 'darwin' ? 'identity.p12' : 'identity.pfx')
    writeFileSync(certificatePath, certificate, { mode: 0o600 })
    if (platform === 'darwin') {
      const keychain = join(directory, 'release.keychain-db')
      const script = join(directory, 'import.swift')
      const notaryKey = join(directory, 'AuthKey.p8')
      const keychainPassword = randomBytes(32).toString('hex')
      writeFileSync(script, swiftImport, { mode: 0o600 })
      writeFileSync(notaryKey, env.LUMO_MACOS_NOTARY_API_KEY, { mode: 0o600 })
      run('/usr/bin/xcrun', ['swift', script], { env: { ...env, LUMO_CI_CERT_PATH: certificatePath, LUMO_CI_KEYCHAIN_PATH: keychain, LUMO_CI_KEYCHAIN_PASSWORD: keychainPassword } })
      const profile = 'lumo-release-ci'
      run('/usr/bin/xcrun', ['notarytool', 'store-credentials', profile, '--key', notaryKey, '--key-id', env.LUMO_MACOS_NOTARY_KEY_ID, '--issuer', env.LUMO_MACOS_NOTARY_ISSUER, '--keychain', keychain])
      Object.assign(exported, { LUMO_MACOS_SIGNING_KEYCHAIN: keychain, LUMO_CUA_SIGNING_KEYCHAIN: keychain, LUMO_MACOS_SIGNING_IDENTITY: env.LUMO_MACOS_SIGNING_IDENTITY, LUMO_CUA_SIGNING_IDENTITY: env.LUMO_MACOS_SIGNING_IDENTITY, LUMO_MACOS_NOTARY_PROFILE: profile })
    } else {
      const inspectScript = join(directory, 'inspect.ps1'), importScript = join(directory, 'import.ps1')
      const receiptPath = join(directory, 'windows-import.json')
      const options = { env: { ...env, LUMO_CI_CERT_PATH: certificatePath, LUMO_CI_CERT_RECEIPT: receiptPath } }
      writeFileSync(inspectScript, windowsInspect, { mode: 0o600 })
      const plan = windowsImportPlan(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', inspectScript], options))
      writeFileSync(receiptPath, JSON.stringify(plan), { mode: 0o600 })
      writeFileSync(importScript, windowsImport, { mode: 0o600 })
      const thumbprint = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', importScript], options).trim().toLowerCase()
      assert.ok(thumbprint === plan.signer, 'Certificate import returned a different signer')
      const receipt = readWindowsReceipt(receiptPath)
      assert.equal(receipt.state, 'imported', 'Certificate import did not complete')
      assert.deepEqual(receipt.thumbprints, plan.thumbprints, 'Certificate import changed the inspected set')
      Object.assign(exported, { LUMO_WINDOWS_CERT_THUMBPRINT: thumbprint, LUMO_WINDOWS_TIMESTAMP_URL: env.LUMO_WINDOWS_TIMESTAMP_URL })
    }
    for (const [key, value] of Object.entries(exported)) appendFileSync(output, `${key}=${value}\n`)
    return exported
  } catch (error) {
    if (platform === 'win32') {
      try { cleanupSigning({ env, platform, run }) }
      catch { throw Error('Windows signing setup failed and cleanup is incomplete; retry --cleanup with the preserved receipt') }
    }
    throw error
  } finally {
    // Keep only the keychain or public import receipt required for later cleanup.
    for (const file of ['identity.p12', 'identity.pfx', 'AuthKey.p8', 'import.swift', 'inspect.ps1', 'import.ps1']) rmSync(join(directory, file), { force: true })
  }
}

export function cleanupSigning({ env = process.env, platform = process.platform, run = checked } = {}) {
  const directory = join(nonempty(env, 'RUNNER_TEMP'), 'lumo-release-signing')
  if (!existsSync(directory)) return
  if (platform === 'darwin' && existsSync(join(directory, 'release.keychain-db'))) run('/usr/bin/security', ['delete-keychain', join(directory, 'release.keychain-db')])
  if (platform === 'win32' && existsSync(join(directory, 'windows-import.json'))) {
    const receipt = readWindowsReceipt(join(directory, 'windows-import.json'))
    if (receipt.state !== 'inspected') run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsCleanup], { env: { ...env, LUMO_CI_CERT_THUMBPRINTS: JSON.stringify(receipt.thumbprints) } })
  }
  // Keep the receipt if cleanup fails so the always step can retry exactly it.
  rmSync(directory, { recursive: true, force: true })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--cleanup', 'Usage: prepare-release-signing.mjs [--cleanup]')
    if (process.argv[2] === '--cleanup') cleanupSigning()
    else prepareSigning()
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
