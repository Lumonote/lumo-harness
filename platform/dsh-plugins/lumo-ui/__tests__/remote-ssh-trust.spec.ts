import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pinnedKnownHostsFile, prepareHostTrust, publicKeyFingerprint } from '../src/remote-ssh-trust.ts'
import { sshBaseArgs } from '../src/remote-ssh.ts'
import { scpArgs } from '../src/remote-bundle.ts'
import type { RemoteHost } from '../../../shared/seam-contracts/remote-hosts.ts'
import type { CommandRunner } from '../src/remote-ssh-process.ts'

function ed25519(n: number): string {
  const name = Buffer.from('ssh-ed25519'), size = Buffer.alloc(4), keySize = Buffer.alloc(4)
  size.writeUInt32BE(name.length); keySize.writeUInt32BE(32)
  return `ssh-ed25519 ${Buffer.concat([size, name, keySize, Buffer.alloc(32, n)]).toString('base64')}`
}
const key = ed25519(7), other = ed25519(8), dirs: string[] = []
const host: RemoteHost = { id: 'test-host-id-12', name: 'test', address: 'host.example', port: 2222, user: 'user', auth: { kind: 'agent' }, hostKeyFingerprint: publicKeyFingerprint(key), installRoot: '~/.lumo-remote', autoUpgrade: false, state: 'registered', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
function fixture(known = '', scanned = `[host.example]:2222 ${key}\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-trust-')); dirs.push(dir)
  const file = join(dir, 'known_hosts'); writeFileSync(file, known)
  const command = vi.fn<CommandRunner>(async cmd => cmd === 'ssh-keygen' ? { code: known ? 0 : 1, stdout: known, stderr: '' } : { code: 0, stdout: scanned, stderr: '' })
  return { file, command }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('SSH host key pinning', () => {
  it('computes the same SHA256 fingerprint as OpenSSH', () => {
    const f = fixture(), keyFile = `${f.file}.pub`; writeFileSync(keyFile, key)
    const result = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', keyFile], { encoding: 'utf8' })
    expect(result.split(' ')[1]).toBe(publicKeyFingerprint(key))
  })
  it('accepts a correct first-use pin and pins the exact key for SSH and SCP', async () => {
    const f = fixture()
    await prepareHostTrust(host, f.file, f.command)
    const pinned = pinnedKnownHostsFile(host, f.file)
    expect(readFileSync(pinned, 'utf8')).toBe(`[host.example]:2222 ${key}\n`)
    expect(readFileSync(f.file, 'utf8')).toContain(key)
    expect(statSync(pinned).mode & 0o777).toBe(0o600)
    const args = sshBaseArgs(host, f.file)
    expect(args).toContain(`UserKnownHostsFile=${pinned}`)
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(scpArgs(args, ['/tmp/package'], 'incoming/')).toContain(`UserKnownHostsFile=${pinned}`)
    expect(f.command.mock.calls[1]?.slice(0, 2)).toEqual(['ssh-keyscan', ['-T', '10', '-p', '2222', 'host.example']])
  })
  it('rejects a mismatched supplied fingerprint and leaves known_hosts untouched', async () => {
    const f = fixture('', `[host.example]:2222 ${other}\n`)
    await expect(prepareHostTrust(host, f.file, f.command)).rejects.toThrow('指纹不匹配')
    expect(readFileSync(f.file, 'utf8')).toBe('')
  })
  it('does not override a pre-existing or hashed known_hosts conflict', async () => {
    const existing = `|1|opaque|hashed ${other}\n`, f = fixture(existing)
    await expect(prepareHostTrust(host, f.file, f.command)).rejects.toThrow('known_hosts 冲突')
    expect(f.command).toHaveBeenCalledTimes(1)
    expect(f.command.mock.calls[0]?.[1]).toEqual(['-F', '[host.example]:2222', '-f', f.file])
    expect(readFileSync(f.file, 'utf8')).toBe(existing)
  })
  it('rejects revoked keys rather than copying them to a new trust file', async () => {
    const f = fixture(`@revoked [host.example]:2222 ${key}\n`)
    await expect(prepareHostTrust(host, f.file, f.command)).rejects.toThrow('受标记')
  })
  it('accepts the selected algorithm from multiple scanned host keys', async () => {
    const f = fixture('', `[host.example]:2222 ${other}\n[host.example]:2222 ${key}\n`)
    await prepareHostTrust(host, f.file, f.command)
    expect(readFileSync(pinnedKnownHostsFile(host, f.file), 'utf8')).not.toContain(other)
  })
  it('cancellation during scan cannot save a newly trusted key', async () => {
    const f = fixture(), abort = new AbortController()
    const command: CommandRunner = async (cmd, args, options) => { const r = await f.command(cmd, args, options); if (cmd === 'ssh-keyscan') abort.abort(); return r }
    await expect(prepareHostTrust(host, f.file, command, abort.signal)).rejects.toThrow('取消')
    expect(readFileSync(f.file, 'utf8')).toBe('')
  })
  it('uses persistent accept-new trust when no explicit fingerprint was supplied', async () => {
    const f = fixture(), unpinned = { ...host }; delete unpinned.hostKeyFingerprint
    await prepareHostTrust(unpinned, f.file, f.command)
    expect(f.command).not.toHaveBeenCalled()
    expect(sshBaseArgs(unpinned, f.file)).toContain('StrictHostKeyChecking=accept-new')
  })
})
