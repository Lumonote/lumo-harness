import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeHostInput, type RemoteHost, type RemoteProbe } from '../../../shared/seam-contracts/remote-hosts.ts'

const STATES = new Set(['registered', 'probed', 'installing', 'installed', 'upgrading', 'failed', 'connecting', 'connected'])
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const port = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 65535

function validProbe(v: unknown): v is RemoteProbe {
  if (!record(v) || typeof v.os !== 'string' || typeof v.arch !== 'string' || !date(v.probedAt) || !record(v.deps)) return false
  if (v.kernel !== undefined && typeof v.kernel !== 'string') return false
  if (!Object.values(v.deps).every(x => x === null || typeof x === 'string')) return false
  return v.installed === undefined || v.installed === null || (record(v.installed) && typeof v.installed.version === 'string' && typeof v.installed.dshSha === 'string')
}

/** Invalid records are never converted to an empty writable configuration. */
export function readRemoteHosts(file: string): RemoteHost[] {
  if (!existsSync(file)) return []
  try {
    const root: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!record(root) || !Array.isArray(root.hosts)) throw new Error('缺少 hosts 数组')
    if (root.version !== undefined && root.version !== 1) throw new Error('不支持的配置版本')
    const ids = new Set<string>(), addresses = new Set<string>()
    return root.hosts.map((raw: unknown) => {
      if (!record(raw)) throw new Error('无效主机记录')
      const normalized = normalizeHostInput(raw)
      if (!normalized.ok) throw new Error(normalized.error)
      if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{12,40}$/u.test(raw.id) || ids.has(raw.id)) throw new Error('主机 ID 无效或重复')
      const key = `${normalized.value.user}@${normalized.value.address}:${normalized.value.port}`
      if (addresses.has(key)) throw new Error('主机地址重复')
      ids.add(raw.id); addresses.add(key)
      if (!STATES.has(String(raw.state)) || !date(raw.createdAt) || !date(raw.updatedAt)) throw new Error('主机状态或时间无效')
      if (raw.probe !== undefined && !validProbe(raw.probe)) throw new Error('主机探测记录无效')
      if (raw.tunnel !== undefined && (!record(raw.tunnel) || !['ssh-local-forward', 'frpc'].includes(String(raw.tunnel.mode)) || !['starting', 'up', 'down'].includes(String(raw.tunnel.status)) || !port(raw.tunnel.localPort) || !port(raw.tunnel.remotePort) || (raw.tunnel.pid !== undefined && (!Number.isInteger(raw.tunnel.pid) || Number(raw.tunnel.pid) <= 0)))) throw new Error('主机隧道记录无效')
      if (raw.lastError !== undefined && typeof raw.lastError !== 'string') throw new Error('主机错误记录无效')
      if (raw.deviceId !== undefined && typeof raw.deviceId !== 'string') throw new Error('主机设备标识无效')
      return { ...raw, ...normalized.value } as unknown as RemoteHost
    })
  } catch (error) {
    throw new Error(`远端主机配置无法读取，原文件已保留：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Same-directory exclusive temporary file + fsync + rename. Failed writes leave the original intact. */
export function atomicPrivateWrite(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, contents, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(tmp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

export function writeRemoteHosts(file: string, hosts: RemoteHost[]): void {
  try { atomicPrivateWrite(file, JSON.stringify({ version: 1, hosts }, null, 2)) }
  catch (error) { throw new Error(`远端主机配置保存失败：${error instanceof Error ? error.message : String(error)}`) }
}

/** Process-owned state never survives a backend restart. */
export function resetRemoteRuntime(host: RemoteHost): RemoteHost {
  const h = structuredClone(host)
  if (h.tunnel) { h.tunnel.status = 'down'; delete h.tunnel.pid }
  delete h.deviceId
  if (h.state === 'connected' || h.state === 'connecting') h.state = h.probe?.installed ? 'installed' : h.probe ? 'probed' : 'registered'
  if (h.state === 'installing' || h.state === 'upgrading') { h.state = 'failed'; h.lastError = '上次操作因服务重启中断，请重新探测远端状态' }
  return h
}
