/**
 * 本机设备动作面板（P1）。数据来自 /lumo/api/device-actions（注册表 + 判定）与 /calls（调用账本）。
 * - 列出动作、风险、开关、macOS 权限状态与去设置的指引；
 * - 只允许手动触发“低风险且判定为 allow”的动作；
 * - 高风险动作的确认只在本机原生确认框里完成，这里只显示“等待本机确认”，可撤回。
 * 样式在 device-actions-panel.css，只用 lumo.css 的 --lumo-* 变量；组件里不写颜色。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import { BusyButton, Empty, Notice } from './surface-shell.tsx'
import './device-actions-panel.css'

const BASE = '/lumo/api/device-actions'

export interface DeviceDecision { effect: 'allow' | 'ask' | 'deny'; reason?: string; code?: string; settings_url?: string }
export interface DeviceActionSpec { id: string; family: string; title: string; risk: 'low' | 'high' | string; permissions: string[]; optional: boolean; args?: string }
export interface DeviceCatalog { actions: Array<{ spec: DeviceActionSpec; decision: DeviceDecision }>; switches: { enabled: boolean; input: boolean; always_ask: boolean } }
export interface DeviceCall { id: string; action: string; risk: string; state: string; caller?: { session_ref?: string; run_id?: string; agent?: string }; created_at: number; updated_at?: number; summary?: string; error?: string }

export const CALL_STATE_LABEL: Record<string, string> = {
  confirming: '等待本机确认', running: '执行中', succeeded: '成功', failed: '失败', denied: '被策略拒绝', rejected: '本机已拒绝', cancelled: '已撤回',
}
export const EFFECT_LABEL: Record<string, string> = { allow: '可直接执行', ask: '需本机确认', deny: '不可用' }
export const PERMISSION_LABEL: Record<string, string> = { accessibility: '辅助功能', 'screen-recording': '屏幕录制' }

export const DEFAULT_ARGS: Record<string, unknown> = {
  'open.url': { url: 'https://' }, 'open.path': { path: '/' }, 'open.app': { name: 'Finder' },
  'clipboard.write': { text: '' }, 'system.notify': { title: 'Lumo', body: '来自工作台的测试通知' },
}

/** 只有低风险且当前判定为 allow 的动作可在界面上手动触发。 */
export function canTrigger(item: { spec: Pick<DeviceActionSpec, 'risk'>; decision: Pick<DeviceDecision, 'effect'> }): boolean {
  return item.spec.risk === 'low' && item.decision.effect === 'allow'
}
/** 缺系统权限：decision.code=os_permission_missing。 */
export function missingPermission(item: { spec: Pick<DeviceActionSpec, 'permissions'>; decision: DeviceDecision }): string | undefined {
  if (item.decision.code !== 'os_permission_missing') return undefined
  return item.spec.permissions[0]
}
/** 账本时间可能是秒或毫秒。 */
export function callTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const ms = value < 1e12 ? value * 1000 : value
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
export function parseArgs(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { const value = text.trim() === '' ? {} : JSON.parse(text) as unknown; return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ok: true, value } : { ok: false, error: '参数必须是 JSON 对象' } } catch { return { ok: false, error: '参数不是合法 JSON' } }
}

export function DeviceActionsPanel({ initial, initialCalls }: { initial?: DeviceCatalog; initialCalls?: DeviceCall[] } = {}) {
  const [catalog, setCatalog] = useState<DeviceCatalog | undefined>(initial)
  const [calls, setCalls] = useState<DeviceCall[]>(initialCalls ?? [])
  const [unavailable, setUnavailable] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [selected, setSelected] = useState('')
  const [args, setArgs] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, l] = await Promise.all([api<DeviceCatalog>(BASE), api<{ calls: DeviceCall[] }>(`${BASE}/calls`)])
      setCatalog(c); setCalls(l.calls ?? []); setUnavailable('')
    } catch (reason) { setUnavailable(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (!initial) void load() }, [load, initial])
  // 有调用在等待本机确认时轮询账本，确认框关闭后状态自动更新
  const waiting = calls.some(c => c.state === 'confirming' || c.state === 'running')
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => { void api<{ calls: DeviceCall[] }>(`${BASE}/calls`).then(r => setCalls(r.calls ?? []), () => undefined) }, 3000)
    return () => clearInterval(timer)
  }, [waiting])

  const pick = (id: string) => { setSelected(id); setArgs(JSON.stringify(DEFAULT_ARGS[id] ?? {}, null, 2)) }
  const run = async () => {
    const parsed = parseArgs(args)
    if (!parsed.ok) { setNotice(parsed.error); return }
    setBusy(`run:${selected}`); setNotice('')
    try {
      const r = await api<{ state?: string; error?: string }>(`${BASE}/invoke`, { method: 'POST', body: JSON.stringify({ action: selected, args: parsed.value }) })
      setNotice(`${selected}：${CALL_STATE_LABEL[r.state ?? ''] ?? r.state ?? '已提交'}`)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(''); void load() }
  }
  const request = async (perm: string) => {
    setBusy(`perm:${perm}`)
    try { await api(`${BASE}/permissions/${perm}/request`, { method: 'POST', body: '{}' }); setNotice('已打开系统授权；勾选 Lumo 后需要重启应用。') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }
  const cancel = async (id: string) => {
    setBusy(`cancel:${id}`)
    try { await api(`${BASE}/calls/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }) } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(''); void load() }
  }

  if (unavailable && !catalog) return <div className="lumo-device-actions" data-device-actions="v1"><Notice error close={() => void load()}>{unavailable}</Notice><Empty>设备动作仅在桌面单机版可用；请确认 Lumo Desktop 正在运行。</Empty></div>
  if (!catalog) return <div className="lumo-device-actions" data-device-actions="v1"><Empty>{loading ? '正在读取本机设备动作' : '尚未读取'}</Empty></div>
  const sw = catalog.switches
  const current = catalog.actions.find(a => a.spec.id === selected)
  return <div className="lumo-device-actions" data-device-actions="v1">
    {notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <div className="lumo-device-switches">
      <span data-on={sw.enabled}>总开关 {sw.enabled ? '开' : '关'}</span>
      <span data-on={sw.input}>键鼠输入 {sw.input ? '开' : '关'}</span>
      <span data-on={sw.always_ask}>全部需确认 {sw.always_ask ? '开' : '关'}</span>
      <BusyButton busy={loading} onClick={() => void load()}>刷新</BusyButton>
    </div>
    <ul className="lumo-device-list">{catalog.actions.map(item => {
      const perm = missingPermission(item)
      return <li key={item.spec.id} data-risk={item.spec.risk} data-effect={item.decision.effect} aria-selected={selected === item.spec.id}>
        <div><b>{item.spec.title}</b><code>{item.spec.id}</code></div>
        <div className="lumo-device-tags">
          <span className="lumo-device-risk">{item.spec.risk === 'high' ? '高风险' : '低风险'}</span>
          <span className="lumo-device-effect">{EFFECT_LABEL[item.decision.effect] ?? item.decision.effect}</span>
          {item.spec.permissions.map(p => <span key={p} className="lumo-device-perm" data-missing={perm === p}>{PERMISSION_LABEL[p] ?? p}{perm === p ? ' · 未授权' : ''}</span>)}
          {item.spec.optional ? <span>可选能力</span> : null}
        </div>
        {item.decision.effect === 'deny' && item.decision.reason ? <small>{item.decision.reason}</small> : null}
        {perm ? <span className="lumo-surface-actions"><BusyButton busy={busy === `perm:${perm}`} onClick={() => void request(perm)}>请求授权</BusyButton>{item.decision.settings_url ? <a href={item.decision.settings_url}>打开系统设置</a> : null}</span> : null}
        {canTrigger(item) ? <span className="lumo-surface-actions"><button type="button" onClick={() => pick(item.spec.id)}>手动触发…</button></span> : item.spec.risk === 'high' ? <small>高风险：由 Agent 调用时在本机弹框确认，这里不能代为允许。</small> : null}
      </li>
    })}</ul>
    {current && canTrigger(current) ? <div className="lumo-device-trigger">
      <label><span>{current.spec.id} 参数 JSON{current.spec.args ? `（${current.spec.args}）` : ''}</span><textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} /></label>
      <span className="lumo-surface-actions"><BusyButton className="lumo-primary" busy={busy === `run:${current.spec.id}`} onClick={() => void run()}>执行</BusyButton><button type="button" onClick={() => setSelected('')}>取消</button></span>
    </div> : null}
    <h4 className="lumo-inspector-label">最近调用</h4>
    {calls.length ? <ul className="lumo-device-calls">{calls.slice(0, 30).map(call => <li key={call.id} data-state={call.state}>
      <span className="lumo-device-state">{CALL_STATE_LABEL[call.state] ?? call.state}</span>
      <b>{call.action}</b>
      <small>{callTime(call.created_at)}{call.caller?.agent ? ` · ${call.caller.agent}` : ''}{call.caller?.session_ref ? ` · 会话 ${call.caller.session_ref}` : ''}{call.summary ? ` · ${call.summary}` : ''}{call.error ? ` · ${call.error}` : ''}</small>
      {call.state === 'confirming' ? <span className="lumo-surface-actions"><small>请在本机弹出的确认框中处理</small><BusyButton busy={busy === `cancel:${call.id}`} onClick={() => void cancel(call.id)}>撤回</BusyButton></span> : null}
    </li>)}</ul> : <Empty>还没有设备动作调用记录。调用也会出现在运行树里（device:&lt;call_id&gt; 节点）。</Empty>}
  </div>
}
