import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { upstreamCommit, validateUpstreamRef } from '../resolve-upstream-ref.mjs'
import { prepareSigning, signingInputs, cleanupSigning } from '../prepare-release-signing.mjs'

const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const job = (workflow, name) => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'mu'))?.[1]
const sha = 'a'.repeat(40)
test('only one full master SHA can become the release source identity', () => {
  assert.equal(upstreamCommit(`${sha}\trefs/heads/master\n`), sha)
  for (const output of ['', `abcd refs/heads/master`, `${sha} refs/heads/dev`, `${sha} refs/heads/master\n${sha} refs/heads/master`]) assert.throws(() => upstreamCommit(output))
  assert.equal(validateUpstreamRef('master'), 'master'); assert.equal(validateUpstreamRef(sha), sha)
  for (const value of ['', 'dev', 'main', 'a'.repeat(39), `master\n${sha}`]) assert.throws(() => validateUpstreamRef(value))
})

export function releaseContract(release, ci, cluster) {
  assert.match(job(release, 'source-identity'), /node platform\/tools\/resolve-upstream-ref\.mjs/u)
  for (const name of ['basic-validation', 'cluster-validation']) {
    const body = job(release, name)
    assert.match(body, /needs: source-identity/u)
    assert.match(body, /upstream_ref: \$\{\{ needs\.source-identity\.outputs\.upstream-sha \}\}/u)
  }
  assert.match(job(release, 'basic-validation'), /uses: \.\/\.github\/workflows\/ci\.yml/u)
  assert.match(job(release, 'cluster-validation'), /uses: \.\/\.github\/workflows\/cluster-acceptance\.yml/u)
  assert.match(job(release, 'desktop'), /ref: \$\{\{ needs\.source-identity\.outputs\.upstream-sha \}\}/u)
  assert.match(job(release, 'release'), /needs: \[basic-validation, desktop, cluster-validation\]/u)
  assert.doesNotMatch(job(release, 'release'), /always\(\)|continue-on-error|!cancelled/u)
  for (const workflow of [ci, cluster]) {
    assert.match(workflow, /workflow_call:\n\s+inputs:\n\s+upstream_ref:/u)
    assert.match(workflow, /ref: \$\{\{ inputs\.upstream_ref \|\| 'master' \}\}/u)
    assert.match(workflow, /--validate "\$LUMO_UPSTREAM_REF"/u)
  }
}
test('release requires basic CI and cluster evidence from the same upstream commit', () => releaseContract(read('.github/workflows/release.yml'), read('.github/workflows/ci.yml'), read('.github/workflows/cluster-acceptance.yml')))
test('release contract rejects missing CI dependency, independent master and failure bypass', () => {
  const release = read('.github/workflows/release.yml'), ci = read('.github/workflows/ci.yml'), cluster = read('.github/workflows/cluster-acceptance.yml')
  for (const mutation of [release.replace('needs: [basic-validation, desktop, cluster-validation]', 'needs: [desktop, cluster-validation]'), release.replace('ref: ${{ needs.source-identity.outputs.upstream-sha }}', 'ref: master'), release.replace("  release:\n    if:", "  release:\n    continue-on-error: true\n    if:")]) assert.throws(() => releaseContract(mutation, ci, cluster))
})
test('Go CI supplies live gates, structured package coverage and concurrency checks', () => {
  const body = job(read('.github/workflows/ci.yml'), 'control-plane-go')
  for (const expected of ['LUMO_TEST_REDIS_DSN: redis://', 'LUMO_TEST_REDIS_ADDR: 127.0.0.1:6379', 'LUMO_TEST_S3_ENDPOINT:', 'echo "LUMO_TEST_RMQ_ENDPOINT=', '-count=1 -json ./...', 'verify-go-test-report.mjs', '--packages', 'test_flags+=(-race)', 'matrix.module == \'registry\'', 'matrix.module == \'usage-ledger\'']) assert.ok(body.includes(expected), expected)
  const acceptance = read('platform/deploy/acceptance-cluster.sh')
  assert.match(acceptance, /go test -race -json/u)
  assert.match(acceptance, /verify-platform-test-report\.mjs/u)
  assert.match(acceptance, /verify-go-test-report\.mjs/u)
  assert.doesNotMatch(acceptance, /grep -c '\^--- PASS/u)
})
function desktopSigningContract(workflow) {
  const body = job(workflow, 'desktop')
  const step = name => body.match(new RegExp(`      - name: ${name}\\n([\\s\\S]*?)(?=      - (?:name:|uses:)|$(?![\\s\\S]))`, 'u'))?.[1] ?? ''
  assert.match(workflow, /signing_mode:\n\s+description:.*\n\s+type: choice\n\s+default: auto/u)
  assert.match(step('Select signed or unsigned desktop packaging'), /vars\.LUMO_RELEASE_SIGNING_MODE \|\| 'auto'/u)
  assert.match(step('Select signed or unsigned desktop packaging'), /node platform\/tools\/resolve-release-signing\.mjs/u)
  for (const name of ['Prepare release signing credentials', 'Remove temporary signing credentials', 'Locate Windows SDK signing tool']) {
    const signingStep = step(name)
    assert.match(signingStep, /if: .*steps\.signing-mode\.outputs\.mode == 'signed'/u)
    assert.doesNotMatch(signingStep, /startsWith\(github\.ref/u)
  }
  assert.match(step('Remove temporary signing credentials'), /if: always\(\)/u)
  assert.match(step('Build desktop package'), /LUMO_RELEASE_SIGNING_REQUIRED: \$\{\{ steps\.signing-mode\.outputs\.required \}\}/u)
  assert.match(step('Compute artifact suffix'), /signing_suffix='-unsigned'/u)
  for (const value of ['prepare-release-signing.mjs --cleanup', 'target/runtime-size/', 'target/release/release-evidence/', 'bundle/**/*.release.json']) assert.ok(body.includes(value), value)
}
test('both signed and unsigned packaging preserve evidence and use the resolved per-platform mode', () => desktopSigningContract(read('.github/workflows/release.yml')))
test('desktop signing contract rejects tag-forced signing and bypassed credential cleanup', () => {
  const workflow = read('.github/workflows/release.yml')
  for (const mutation of [
    workflow.replace("LUMO_RELEASE_SIGNING_REQUIRED: ${{ steps.signing-mode.outputs.required }}", "LUMO_RELEASE_SIGNING_REQUIRED: ${{ startsWith(github.ref, 'refs/tags/v') && '1' || '0' }}"),
    workflow.replace("if: steps.signing-mode.outputs.mode == 'signed'", "if: startsWith(github.ref, 'refs/tags/v')"),
    workflow.replace("if: always() && steps.signing-mode.outputs.mode == 'signed'", "if: steps.signing-mode.outputs.mode == 'signed'"),
  ]) assert.throws(() => desktopSigningContract(mutation))
})

const macEnv = () => ({ LUMO_MACOS_SIGNING_P12: 'YWJj', LUMO_MACOS_SIGNING_P12_PASSWORD: 'P12-password-unique', LUMO_MACOS_SIGNING_IDENTITY: 'Developer ID Application: Lumo (ABCDE12345)', LUMO_MACOS_NOTARY_API_KEY: '-----BEGIN PRIVATE KEY-----\nfixture-private-key\n-----END PRIVATE KEY-----', LUMO_MACOS_NOTARY_KEY_ID: 'ABCDE12345', LUMO_MACOS_NOTARY_ISSUER: '12345678-1234-1234-1234-123456789012' })
test('signing inputs fail closed without required credentials or valid certificate framing', () => {
  for (const partial of [{}, { ...macEnv(), LUMO_MACOS_SIGNING_P12: 'not base64' }, { ...macEnv(), LUMO_MACOS_SIGNING_IDENTITY: '-' }, { ...macEnv(), LUMO_MACOS_NOTARY_API_KEY: '' }]) assert.throws(() => signingInputs(partial, 'darwin'))
})
test('Mac credential import never places certificate password or API key content on argv', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-signing-test-'))
  const env = { ...macEnv(), RUNNER_TEMP: root, GITHUB_ENV: join(root, 'github-env') }
  const calls = []
  try {
    const exported = prepareSigning({ env, platform: 'darwin', run: (command, args, options) => { calls.push({ command, args, options }); return '' } })
    assert.equal(exported.LUMO_CUA_SIGNING_IDENTITY, env.LUMO_MACOS_SIGNING_IDENTITY)
    assert.equal(exported.LUMO_CUA_SIGNING_KEYCHAIN, exported.LUMO_MACOS_SIGNING_KEYCHAIN)
    const argv = calls.flatMap(call => call.args).join('\n')
    assert.ok(!argv.includes(env.LUMO_MACOS_SIGNING_P12_PASSWORD) && !argv.includes('fixture-private-key'))
    for (const name of ['identity.p12', 'AuthKey.p8', 'import.swift']) assert.equal(existsSync(join(root, 'lumo-release-signing', name)), false)
    cleanupSigning({ env, platform: 'darwin', run: () => '' })
    assert.equal(existsSync(join(root, 'lumo-release-signing')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('setup failure removes raw secrets and emits no successful environment receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-signing-failure-'))
  try {
    assert.throws(() => prepareSigning({ env: { ...macEnv(), RUNNER_TEMP: root, GITHUB_ENV: join(root, 'github-env') }, platform: 'darwin', run: () => { throw Error('fixture setup rejected') } }), /setup rejected/u)
    assert.equal(existsSync(join(root, 'lumo-release-signing', 'identity.p12')), false)
    assert.equal(existsSync(join(root, 'github-env')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('Windows certificate import returns one identity and cleanup removes it without password argv', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-signing-win-'))
  const env = { LUMO_WINDOWS_SIGNING_PFX: 'YWJj', LUMO_WINDOWS_SIGNING_PFX_PASSWORD: 'unique-pfx-password', LUMO_WINDOWS_TIMESTAMP_URL: 'https://timestamp.example', RUNNER_TEMP: root, GITHUB_ENV: join(root, 'github-env') }
  const calls = []
  try {
    const exported = prepareSigning({ env, platform: 'win32', run: (command, args, options) => {
      calls.push({ command, args, options })
      if (args.at(-1).endsWith('inspect.ps1')) return JSON.stringify({ thumbprints: [sha], signers: [sha], protected_thumbprints: [], shared_private_key: false })
      const path = options.env.LUMO_CI_CERT_RECEIPT
      const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.state = 'imported'; writeFileSync(path, JSON.stringify(receipt))
      return `${sha}\r\n`
    } })
    assert.equal(exported.LUMO_WINDOWS_CERT_THUMBPRINT, sha)
    cleanupSigning({ env, platform: 'win32', run: (command, args, options) => { calls.push({ command, args, options }); return '' } })
    assert.equal(calls.length, 3)
    assert.deepEqual(JSON.parse(calls[2].options.env.LUMO_CI_CERT_THUMBPRINTS), [sha])
    assert.match(calls[2].args.at(-1), /-DeleteKey/u)
    assert.ok(!calls.flatMap(call => call.args).join('\n').includes(env.LUMO_WINDOWS_SIGNING_PFX_PASSWORD))
    assert.equal(existsSync(join(root, 'lumo-release-signing')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
