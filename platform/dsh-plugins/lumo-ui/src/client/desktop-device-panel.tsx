import { useEffect, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, ApiError } from './api.ts'
import { AddIcon, RefreshIcon } from './chat-icons.tsx'
import type { SavedServer } from './server-book.ts'

export interface DeviceConfig {
  gateway: string; realm: string; node_id: string; trust_file: string; server_ca: string
  task_runner_socket: string; allowed_digests: string[]; client_version: string; paused?: boolean
}
export interface DeviceSnapshot {
  available: boolean; config: DeviceConfig | null
  status: { state: string; connected: boolean; paused: boolean; desired_paused?: boolean; process_running?: boolean
    certificate_expires?: string; certificate_valid?: boolean; last_gateway_at?: string; active_tasks?: number; gateway_state?: string; error?: string }
}
const BASE = '/lumo/api/environment/device'
const empty = (): DeviceConfig => ({ gateway: '', realm: '', node_id: '', trust_file: '', server_ca: '', task_runner_socket: '', allowed_digests: [], client_version: '0.1.0' })
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0 ? new Date(value).toLocaleString() : '未签发'

export function DesktopDevicePanel({ servers }: { servers: SavedServer[] }) {
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [unsupported, setUnsupported] = useState(false), [draft, setDraft] = useState<DeviceConfig>(), [code, setCode] = useState('')
  const [digests, setDigests] = useState('')
  const load = async () => {
    try { const next = await api<DeviceSnapshot>(BASE); if (!next || typeof next.available !== 'boolean') return; setSnapshot(next); setError(''); setUnsupported(false) }
    catch (reason) { if (reason instanceof ApiError && [404, 501].includes(reason.status)) setUnsupported(true); else setError(reason instanceof Error ? reason.message : '设备状态不可用') }
  }
  useEffect(() => { void load(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, 5000); return () => clearInterval(timer) }, [])
  const action = async (name: 'activate' | 'pause' | 'resume' | 'leave') => {
    setBusy(true); setError('')
    try {
      const body = name === 'activate' && draft ? { config: { ...draft, allowed_digests: digests.split(/[\s,]+/u).filter(Boolean) }, code: code.trim() } : {}
      setSnapshot(await api<DeviceSnapshot>(`${BASE}/${name}`, { method: 'POST', body: JSON.stringify(body) }))
      if (name === 'activate') { setCode(''); setDraft(undefined) }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '设备操作失败') }
    finally { setBusy(false) }
  }
  const status = snapshot?.status, configured = !!snapshot?.config
  const label = status?.desired_paused || status?.paused ? status.paused ? '已暂停接单' : '正在暂停接单' : status?.connected ? '设备通道已连接' : status?.process_running ? '正在连接设备网关' : configured ? '设备通道未连接' : '尚未接入'
  if (unsupported) return null
  return <section className="lumo-device-connection" aria-label="本机接入集群">
    <header><h2>本机接入</h2><div className="lumo-environment-actions"><Button size="sm" aria-label="刷新本机接入" title="刷新" disabled={busy} onClick={() => void load()}><RefreshIcon size={15} /></Button>{!configured && !draft ? <Button size="sm" aria-label="激活本机设备" title="激活本机设备" disabled={!snapshot?.available || busy} onClick={() => setDraft({ ...empty(), gateway: servers.find(s => s.origin.startsWith('https:'))?.origin ?? '' })}><AddIcon size={16} /></Button> : null}</div></header>
    <p><StateDot size={8} state={status?.connected ? 'done' : status?.process_running ? 'ongoing' : 'error'} /> {label}</p>
    {error || status?.error ? <p role="alert">{error || status?.error}</p> : null}
    {snapshot && !snapshot.available ? <p>此桌面运行包缺少设备代理，请更新桌面包。</p> : null}
    {configured && !draft ? <><dl className="lumo-device-details"><dt>网关</dt><dd>{snapshot.config!.gateway}</dd><dt>设备</dt><dd>{snapshot.config!.realm} / {snapshot.config!.node_id}</dd><dt>证书有效期</dt><dd>{time(status?.certificate_expires)}{status?.certificate_expires && !status.certificate_valid ? '（未生效或已过期）' : ''}</dd><dt>网关状态</dt><dd>{status?.gateway_state || '等待服务器确认'}</dd><dt>执行中</dt><dd>{status?.active_tasks ?? 0}</dd></dl><div className="lumo-environment-actions"><Button size="sm" disabled={busy} onClick={() => void action(status?.desired_paused || status?.paused || !status?.process_running ? 'resume' : 'pause')}>{status?.desired_paused || status?.paused ? '恢复接单' : status?.process_running ? '暂停接单' : '重新连接'}</Button>{!status?.process_running ? <Button size="sm" disabled={busy} onClick={() => { setDraft(snapshot.config!); setDigests(snapshot.config!.allowed_digests.join(', ')) }}>更新激活码</Button> : null}<Button size="sm" disabled={busy} onClick={() => void action('leave')}>退出本机接入</Button></div><p className="lumo-server-note">暂停后当前任务继续完成。退出会停止本机进程并清除设备私钥；服务器设备记录由管理员撤销。</p></> : !draft ? <p>使用管理员签发的一次激活码接入；任务按服务器批准的策略分配。</p> : null}
    {draft ? <form className="lumo-device-form" onSubmit={e => { e.preventDefault(); void action('activate') }}>
      <label>设备网关<Input aria-label="设备网关" value={draft.gateway} required placeholder="https://devices.example.com" onChange={e => setDraft({ ...draft, gateway: e.target.value })} /></label>
      <label>Realm<Input aria-label="设备 Realm" value={draft.realm} required maxLength={128} onChange={e => setDraft({ ...draft, realm: e.target.value })} /></label>
      <label>设备 ID<Input aria-label="设备 ID" value={draft.node_id} required maxLength={128} onChange={e => setDraft({ ...draft, node_id: e.target.value })} /></label>
      <label>一次激活码<Input aria-label="一次激活码" type="password" autoComplete="off" value={code} required minLength={43} maxLength={43} onChange={e => setCode(e.target.value)} /></label>
      <label>发布者信任文件<Input aria-label="发布者信任文件" value={draft.trust_file} required placeholder="/绝对路径/publishers.json" onChange={e => setDraft({ ...draft, trust_file: e.target.value })} /></label>
      <small>使用管理员通过独立渠道提供的本机信任文件。激活不自动授权任意程序执行。</small>
      <details><summary>运行器与证书</summary><label>网关 CA<Input aria-label="网关 CA" value={draft.server_ca} placeholder="留空使用系统证书" onChange={e => setDraft({ ...draft, server_ca: e.target.value })} /></label><label>任务运行器 Socket<Input aria-label="任务运行器 Socket" value={draft.task_runner_socket} placeholder="/绝对路径/task-runner.sock" onChange={e => setDraft({ ...draft, task_runner_socket: e.target.value })} /></label><label>客户端版本<Input aria-label="设备客户端版本" value={draft.client_version} required onChange={e => setDraft({ ...draft, client_version: e.target.value })} /></label><label>批准运行的摘要<Input aria-label="批准运行的摘要" value={digests} placeholder="sha256:…，多个用逗号分隔" onChange={e => setDigests(e.target.value)} /></label></details>
      <div className="lumo-environment-actions"><Button size="sm" type="submit" disabled={busy}>{busy ? '等待本机确认…' : '激活并连接'}</Button><Button size="sm" type="button" disabled={busy} onClick={() => { setDraft(undefined); setCode('') }}>取消</Button></div>
    </form> : null}
  </section>
}
