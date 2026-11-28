import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { RemoteHost } from '../../../shared/seam-contracts/remote-hosts.ts'
import { atomicPrivateWrite } from './remote-host-store.ts'
import { runSshCommand, type CommandRunner } from './remote-ssh-process.ts'

export function pinnedKnownHostsFile(host: RemoteHost, knownHostsFile: string): string {
  if (!host.hostKeyFingerprint) return knownHostsFile
  const hash = createHash('sha256').update(`${host.address}:${host.port}:${host.hostKeyFingerprint}`).digest('hex')
  return `${knownHostsFile}.pins/${hash}`
}

export function publicKeyFingerprint(key: string): string {
  const fields = key.trim().split(/\s+/u)
  const data = fields.at(-1) ?? ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error('无效 SSH 公钥')
  return `SHA256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/u, '')}`
}

function keyRecords(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(line => {
    const fields = line.split(/\s+/u)
    // Marked entries (including @revoked) must never be silently converted into trusted keys.
    if (fields[0]?.startsWith('@')) throw new Error('known_hosts 包含受标记的主机密钥，请先核对该记录')
    if (fields.length < 3) throw new Error('known_hosts 主机密钥格式无效')
    return `${fields[1]} ${fields[2]}`
  })
}

/** Verify a user-supplied SHA256 pin before authentication; the same exact key is used by SSH and SCP. */
export async function prepareHostTrust(host: RemoteHost, knownHostsFile: string, command: CommandRunner = runSshCommand, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('操作已取消')
  if (!existsSync(knownHostsFile)) atomicPrivateWrite(knownHostsFile, '')
  if (!host.hostKeyFingerprint) return
  const expected = host.hostKeyFingerprint.replace(/=+$/u, '')
  const lookup = host.port === 22 ? host.address : `[${host.address}]:${host.port}`
  const find = async () => {
    const result = await command('ssh-keygen', ['-F', lookup, '-f', knownHostsFile], { timeoutMs: 5000, ...(signal ? { signal } : {}) })
    if (result.code !== 0 && result.code !== 1) throw new Error(`无法读取 known_hosts：${result.stderr}`)
    const keys = keyRecords(result.stdout)
    if (keys.length && !keys.some(k => publicKeyFingerprint(k) === expected)) throw new Error('主机指纹与已保存的 known_hosts 冲突，请核对后再连接')
    return keys
  }
  await find()
  const scanned = await command('ssh-keyscan', ['-T', '10', '-p', String(host.port), host.address], { timeoutMs: 15_000, ...(signal ? { signal } : {}) })
  if (scanned.code !== 0) throw new Error(`无法取得 SSH 主机密钥：${scanned.stderr}`)
  const selected = keyRecords(scanned.stdout).find(k => publicKeyFingerprint(k) === expected)
  if (!selected) throw new Error('SSH 主机指纹不匹配，连接已拒绝')
  if (signal?.aborted) throw new Error('操作已取消')
  // Recheck after the network wait: another connection may have added a different trusted key.
  const existing = await find()
  if (signal?.aborted) throw new Error('操作已取消')
  if (!existing.length) {
    const contents = readFileSync(knownHostsFile, 'utf8')
    atomicPrivateWrite(knownHostsFile, `${contents}${contents.endsWith('\n') || !contents ? '' : '\n'}${lookup} ${selected}\n`)
  }
  atomicPrivateWrite(pinnedKnownHostsFile(host, knownHostsFile), `${lookup} ${selected}\n`)
}
