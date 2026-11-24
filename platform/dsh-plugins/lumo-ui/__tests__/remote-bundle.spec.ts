import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleBaseUrl, DEFAULT_RELEASE_BASE, findLocalBundle, incomingDir, scpArgs, serverBundleName } from '../src/remote-bundle.ts'

const target = { version: '1.2.3', dshSha: '4b399c39a6d1479cd84ca591b4d7c88e24d38a96', dshTag: 'dsh-v0.2.3-alpha.2' }

describe('remote server bundle helpers', () => {
  it('names bundles like pack-server.mjs', () => {
    expect(serverBundleName('1.2.3', 'linux', 'x86_64')).toBe('lumo-server-1.2.3-linux-x64.tar.gz')
    expect(serverBundleName('1.2.3', 'linux', 'arm64')).toBe('lumo-server-1.2.3-linux-arm64.tar.gz')
  })
  it('resolves release directory, https only, off switch', () => {
    expect(bundleBaseUrl(target, {})).toBe(`${DEFAULT_RELEASE_BASE}/v1.2.3/`)
    expect(bundleBaseUrl(target, { LUMO_REMOTE_BUNDLE_BASE: 'https://mirror.example.com/lumo//' })).toBe('https://mirror.example.com/lumo/')
    expect(bundleBaseUrl(target, { LUMO_REMOTE_BUNDLE_BASE: 'http://insecure' })).toBeUndefined()
    expect(bundleBaseUrl(target, { LUMO_REMOTE_BUNDLE_BASE: 'off' })).toBeUndefined()
  })
  it('finds a local offline bundle and writes sidecar sha256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumo-bundles-'))
    const name = 'lumo-server-1.2.3-linux-x64.tar.gz'
    writeFileSync(join(dir, name), 'a')
    const host = { probe: { os: 'linux', arch: 'x64', deps: {}, installed: null, probedAt: '' } }
    const found = await findLocalBundle(dir, target, host)
    expect(found?.sha256).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
    expect(readFileSync(join(dir, `${name}.sha256`), 'utf8')).toContain(name)
    expect(await findLocalBundle(dir, { ...target, version: '9.9.9' }, host)).toBeUndefined()
    expect(await findLocalBundle(undefined, target, host)).toBeUndefined()
  })
  it('builds scp args from ssh safety options', () => {
    const base = ['-p', '2222', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', 'ubuntu@h.example.com']
    expect(scpArgs(base, ['/tmp/a.tgz'], '.lumo-remote/incoming/')).toEqual(['-q', '-B', '-P', '2222', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', '/tmp/a.tgz', 'ubuntu@h.example.com:.lumo-remote/incoming/'])
    expect(incomingDir('~/.lumo-remote')).toBe('.lumo-remote/incoming/')
    expect(incomingDir('/opt/lumo/')).toBe('/opt/lumo/incoming/')
  })
})
