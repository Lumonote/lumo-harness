import { describe, expect, it } from 'vitest'
import { compareVersions, containsPrivateKey, installBlockers, normalizeArch, normalizeHostInput, parseProbeOutput, releaseId, remoteRunEvent, remoteScriptArgs, upgradeVerdict } from '../remote-hosts.ts'

const target = { version: '1.2.3', dshSha: '4b399c39a6d1479cd84ca591b4d7c88e24d38a96', dshTag: 'dsh-v0.2.3-alpha.2' }

describe('remote hosts contract', () => {
  it('normalizes host input with defaults', () => {
    const r = normalizeHostInput({ name: 'gpu-1', address: 'gpu.example.com', user: 'ubuntu', auth: { kind: 'agent' } })
    expect(r.ok && r.value).toMatchObject({ port: 22, installRoot: '~/.lumo-remote', autoUpgrade: false })
  })
  it('rejects private key material anywhere', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
    expect(containsPrivateKey({ auth: { kind: 'key-file', path: pem } })).toBe(true)
    expect(normalizeHostInput({ name: 'a', address: 'h', user: 'u', auth: { kind: 'key-file', path: pem } }).ok).toBe(false)
  })
  it('validates address, user, port, auth', () => {
    const base = { name: 'a', address: 'h.example', user: 'u', auth: { kind: 'agent' } }
    expect(normalizeHostInput({ ...base, address: '-oProxyCommand=x' }).ok).toBe(false)
    expect(normalizeHostInput({ ...base, user: 'a b' }).ok).toBe(false)
    expect(normalizeHostInput({ ...base, port: 70000 }).ok).toBe(false)
    expect(normalizeHostInput({ ...base, auth: { kind: 'password', value: 'x' } }).ok).toBe(false)
    expect(normalizeHostInput({ ...base, auth: { kind: 'key-file', path: 'relative/id' } }).ok).toBe(false)
    expect(normalizeHostInput({ ...base, auth: { kind: 'vault', ref: 'vault:secret/ssh#key' } }).ok).toBe(true)
    expect(normalizeHostInput({ ...base, installRoot: '/opt/../etc' }).ok).toBe(false)
    expect(normalizeHostInput({ ...base, address: '10.0.0.5' }).ok).toBe(true)
  })
  it('parses probe output', () => {
    const p = parseProbeOutput('os=Linux\narch=x86_64\ndep.node=v22.20.0\ndep.tar=tar 1.34\ndep.curl=curl 8\ndep.frpc=missing\ninstalled.version=1.2.2\ninstalled.dsh=abc\n', 'now')
    expect(p).toMatchObject({ os: 'linux', arch: 'x64', deps: { node: 'v22.20.0', frpc: null }, installed: { version: '1.2.2', dshSha: 'abc' } })
    expect(installBlockers(p)).toEqual([])
    expect(installBlockers({ ...p, deps: { ...p.deps, node: 'v20.1.0', curl: null } })).toHaveLength(2)
    expect(installBlockers({ ...p, os: 'windows' })[0]).toContain('不支持')
    expect(normalizeArch('aarch64')).toBe('arm64')
  })
  it('decides upgrades with dsh pin as a hard constraint', () => {
    expect(upgradeVerdict(null, target)).toBe('not-installed')
    expect(upgradeVerdict({ version: '1.2.2', dshSha: target.dshSha }, target)).toBe('upgrade')
    expect(upgradeVerdict({ version: '1.2.3', dshSha: target.dshSha }, target)).toBe('up-to-date')
    expect(upgradeVerdict({ version: '1.2.3', dshSha: 'other' }, target)).toBe('dsh-mismatch')
    expect(upgradeVerdict({ version: '1.10.0', dshSha: target.dshSha }, target)).toBe('remote-newer')
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1)
    expect(releaseId(target)).toBe('1.2.3-4b399c39a6d1')
  })
  it('builds script args and run-tree events', () => {
    expect(remoteScriptArgs('install', { installRoot: '~/.lumo-remote' }, target)).toEqual(['install', '--root', '~/.lumo-remote', '--version', '1.2.3', '--dsh-sha', target.dshSha, '--dsh-tag', target.dshTag])
    expect(remoteScriptArgs('rollback', { installRoot: '/opt/l' }, target)).toEqual(['rollback', '--root', '/opt/l'])
    const ev = remoteRunEvent({ id: 'h', name: 'gpu' }, 'install', '1', 'failed', 'x', 'T')
    expect(ev).toMatchObject({ type: 'node.upsert', node: { id: 'run:remote-install-h-1', kind: 'run', status: 'failed', endedAt: 'T' } })
  })
})
