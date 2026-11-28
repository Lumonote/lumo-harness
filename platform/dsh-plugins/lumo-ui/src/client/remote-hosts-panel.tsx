/**
 * 远端机器管理面板（P1 SSH 一键接入）。独立组件文件；index.tsx 只挂一行。
 * 录入主机 → 探测 → 一键安装 / 检查升级 / 回滚 / 建立隧道。高风险操作先产生待审批项，
 * 在本面板内批准（同时登记到运行树，运行树面板里可以看到进度）。
 * 私钥只填本机路径或 Vault 引用；ssh-agent 为默认。
 */
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { Button, Input, StateDot, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { AddIcon, RefreshIcon } from './chat-icons.tsx'
import './remote-hosts-panel.css'
import type { Ask } from '../../../../shared/seam-contracts/asks.ts'
import { effectiveStatus } from '../../../../shared/seam-contracts/asks.ts'
import { containsPrivateKey, installBlockers, upgradeVerdict, type ReleaseTarget, type RemoteHost, type RemoteOperation } from '../../../../shared/seam-contracts/remote-hosts.ts'
import { api } from './api.ts'
import { Empty, Notice } from './surface-shell.tsx'

function BusyButton({ busy, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <Button size="sm" {...props} disabled={props.disabled || busy} aria-busy={busy || undefined} />
}

const BASE = '/lumo/api/remote-hosts'
const STATE_LABEL: Record<RemoteHost['state'], string> = {
  registered: '已录入', probed: '已探测', installing: '安装中', installed: '已安装', upgrading: '升级中', failed: '失败', connecting: '连接中', connected: '隧道可用',
}
const VERDICT_LABEL: Record<string, string> = {
  'not-installed': '未安装', 'up-to-date': '已是最新', upgrade: '可升级', 'dsh-mismatch': 'dsh 版本不一致，需要重装', 'remote-newer': '远端版本更新',
}

interface Draft { name: string; address: string; port: string; user: string; authKind: 'agent' | 'key-file' | 'vault'; authValue: string; fingerprint: string; autoUpgrade: boolean }
const EMPTY: Draft = { name: '', address: '', port: '22', user: '', authKind: 'agent', authValue: '', fingerprint: '', autoUpgrade: false }

export function draftToInput(d: Draft): Record<string, unknown> {
  const auth = d.authKind === 'agent' ? { kind: 'agent' } : d.authKind === 'key-file' ? { kind: 'key-file', path: d.authValue.trim() } : { kind: 'vault', ref: d.authValue.trim() }
  return { name: d.name.trim(), address: d.address.trim(), port: Number(d.port), user: d.user.trim(), auth, autoUpgrade: d.autoUpgrade, ...(d.fingerprint.trim() ? { hostKeyFingerprint: d.fingerprint.trim() } : {}) }
}

export function RemoteHostsPanel() {
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [target, setTarget] = useState<ReleaseTarget | undefined>()
  const [asks, setAsks] = useState<Ask[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [disabled, setDisabled] = useState(false)
  const [adding, setAdding] = useState(false)

  const mounted = useRef(true)
  const loading = useRef<AbortController | undefined>(undefined)
  const load = useCallback(async () => {
    loading.current?.abort()
    const request = new AbortController(); loading.current = request
    try {
      const [r, approvals] = await Promise.all([
        api<{ hosts: RemoteHost[]; target: ReleaseTarget }>(BASE, { signal: request.signal }),
        api<{ asks: Ask[] }>(`${BASE}/asks`, { signal: request.signal }),
      ])
      if (!mounted.current || request.signal.aborted) return
      setHosts(r.hosts); setTarget(r.target); setDisabled(false); setAsks(approvals.asks)
    } catch (reason) {
      if (!mounted.current || request.signal.aborted) return
      if ((reason as { status?: number }).status === 404) setDisabled(true)
      else setNotice(reason instanceof Error ? reason.message : String(reason))
    } finally { if (loading.current === request) loading.current = undefined }
  }, [])
  useEffect(() => {
    mounted.current = true; void load()
    return () => { mounted.current = false; loading.current?.abort() }
  }, [load])
  useEffect(() => {
    if (disabled) return
    const refresh = () => { if (!document.hidden && !loading.current) void load() }
    const timer = window.setInterval(refresh, 2500)
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [disabled, load])

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key); setNotice('')
    try { await fn(); if (ok) setNotice(ok); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }

  if (disabled) return <Empty>远端机器接入仅在本机桌面形态可用（或已通过 LUMO_REMOTE_HOSTS=off 关闭）。</Empty>
  const input = draftToInput(draft)
  const leaked = containsPrivateKey(input)
  const pending = asks.filter(a => effectiveStatus(a) === 'pending')
  const request = (h: RemoteHost, op: RemoteOperation) => act(`${h.id}:${op}`, () => api(`${BASE}/${h.id}/${op}`, { method: 'POST', body: '{}' }), '已提交，请在下方「待批准」中确认。')

  return <div className="lumo-remote-hosts lumo-native-content">
    {notice ? <Notice>{notice}</Notice> : null}
    <div className="lumo-remote-toolbar"><span>通过 SSH 管理远端运行环境</span><Button size="sm" aria-label="刷新远端机器" title="刷新" disabled={Boolean(busy)} onClick={() => void act('refresh', load)}><RefreshIcon size={16} /></Button><Button size="sm" aria-label="录入主机" title="录入主机" aria-expanded={adding} onClick={() => setAdding(!adding)}><AddIcon size={16} /></Button></div>
    {target ? <p className="lumo-workspace-note">安装目标：lumo {target.version} · dsh {target.dshTag}（{target.dshSha.slice(0, 12)}）——与本机一致</p> : null}

    {pending.length ? <div role="region" aria-label="待批准">
      <h4>待批准</h4>
      {pending.map(a => <div key={a.id} className="lumo-remote-ask">
        <strong>{a.title}</strong><small>{a.detail}</small>
        <BusyButton disabled={Boolean(busy)} busy={busy === `${a.id}:approve`} onClick={() => void act(`${a.id}:approve`, () => api(`${BASE}/asks/${encodeURIComponent(a.id)}/answer`, { method: 'POST', body: JSON.stringify({ value: 'approve' }) }), '已批准，正在执行；进度见运行树。')}>批准</BusyButton>
        <BusyButton disabled={Boolean(busy)} busy={busy === `${a.id}:reject`} onClick={() => void act(`${a.id}:reject`, () => api(`${BASE}/asks/${encodeURIComponent(a.id)}/answer`, { method: 'POST', body: JSON.stringify({ value: 'reject' }) }), '已拒绝。')}>拒绝</BusyButton>
      </div>)}
    </div> : null}

    {hosts.length ? <div className="lumo-remote-grid">
      {hosts.map(h => {
        const verdict = target ? upgradeVerdict(h.probe?.installed ?? null, target) : 'not-installed'
        const blockers = h.probe ? installBlockers(h.probe) : []
        const working = ['installing', 'upgrading', 'connecting'].includes(h.state)
        return <article key={h.id} className="lumo-remote-card" aria-label={h.name}>
          <header><b>{h.name}</b><span><StateDot size={8} state={h.state === 'connected' ? 'done' : h.state === 'failed' ? 'error' : working ? 'ongoing' : 'idle'} />{STATE_LABEL[h.state]}</span></header>
          <code>{h.user}@{h.address}:{h.port}</code>
          <div className="lumo-remote-facts"><span>{h.probe ? `${h.probe.os} · ${h.probe.arch}` : '等待探测'}</span><span>{h.probe?.installed?.version ?? '未安装'}{h.probe ? ` · ${VERDICT_LABEL[verdict]}` : ''}</span></div>
          {blockers.length ? <small role="status">{blockers.join('；')}</small> : null}
          {h.tunnel?.status === 'up' && Number.isInteger(h.tunnel.localPort) && h.tunnel.localPort > 0 && h.tunnel.localPort <= 65535 ? <a href={`http://127.0.0.1:${h.tunnel.localPort}`} target="_blank" rel="noopener noreferrer">打开远端工作台 · :{h.tunnel.localPort}</a> : null}
          {h.lastError ? <small role="alert">{h.lastError}</small> : null}
          <div className="lumo-remote-actions">
            <BusyButton disabled={Boolean(busy) || working} busy={busy === `${h.id}:probe`} onClick={() => void act(`${h.id}:probe`, () => api(`${BASE}/${h.id}/probe`, { method: 'POST', body: '{}' }))}>探测</BusyButton>
            {verdict === 'not-installed' ? <BusyButton busy={busy === `${h.id}:install`} disabled={Boolean(busy) || working || !h.probe || blockers.length > 0} onClick={() => void request(h, 'install')}>一键安装</BusyButton> : null}
            {verdict === 'upgrade' || verdict === 'dsh-mismatch' ? <BusyButton disabled={Boolean(busy) || working} busy={busy === `${h.id}:upgrade`} onClick={() => void request(h, 'upgrade')}>升级</BusyButton> : null}
            {h.probe?.installed && h.tunnel?.status !== 'up' && !working ? <BusyButton disabled={Boolean(busy) || working} busy={busy === `${h.id}:tunnel`} onClick={() => void request(h, 'tunnel')}>建立隧道</BusyButton> : null}
            {h.tunnel?.status === 'up' || h.state === 'connecting' ? <BusyButton disabled={Boolean(busy)} busy={busy === `${h.id}:close`} onClick={() => void act(`${h.id}:close`, () => api(`${BASE}/${h.id}/tunnel/close`, { method: 'POST', body: '{}' }))}>{h.state === 'connecting' ? '取消连接' : '断开'}</BusyButton> : null}
          </div>
          <details><summary>管理选项</summary><small>{h.auth.kind === 'agent' ? 'ssh-agent' : h.auth.kind === 'key-file' ? `私钥 ${h.auth.path}` : `Vault ${h.auth.ref}`}{h.autoUpgrade ? ' · 自动发起升级' : ''}</small><div className="lumo-remote-actions">
            {h.probe?.installed ? <BusyButton disabled={Boolean(busy) || working} busy={busy === `${h.id}:version`} onClick={() => void act(`${h.id}:version`, () => api(`${BASE}/${h.id}/version`, { method: 'POST', body: '{}' }))}>检查版本</BusyButton> : null}
            {h.probe?.installed ? <BusyButton disabled={Boolean(busy) || working} busy={busy === `${h.id}:rollback`} onClick={() => void request(h, 'rollback')}>回滚</BusyButton> : null}
            <BusyButton disabled={Boolean(busy)} busy={busy === `${h.id}:del`} aria-label={`移除 ${h.name}`} title="移除主机" onClick={() => void act(`${h.id}:del`, () => api(`${BASE}/${h.id}`, { method: 'DELETE' }))}><IconTrashOutlineRegular size={16} /></BusyButton>
          </div></details>
        </article>
      })}
    </div> : <Empty>还没有录入远端机器。</Empty>}

    {adding ? <form className="lumo-remote-form" onSubmit={e => { e.preventDefault(); if (leaked) return; void act('create', async () => { await api(BASE, { method: 'POST', body: JSON.stringify(input) }); setDraft(EMPTY); setAdding(false) }, '已录入；下一步点「探测」。') }}>
      <h4>录入主机</h4>
      <label>名称<Input autoFocus disabled={Boolean(busy)} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} required /></label>
      <label>地址<Input disabled={Boolean(busy)} value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} placeholder="example.com 或 10.0.0.5" required /></label>
      <label>端口<Input disabled={Boolean(busy)} value={draft.port} inputMode="numeric" onChange={e => setDraft({ ...draft, port: e.target.value })} /></label>
      <label>用户<Input disabled={Boolean(busy)} value={draft.user} onChange={e => setDraft({ ...draft, user: e.target.value })} required /></label>
      <label>认证<select disabled={Boolean(busy)} value={draft.authKind} onChange={e => setDraft({ ...draft, authKind: e.target.value as Draft['authKind'], authValue: '' })}>
        <option value="agent">ssh-agent（推荐）</option><option value="key-file">本机私钥文件路径</option><option value="vault">Vault 引用</option>
      </select></label>
      {draft.authKind !== 'agent' ? <label>{draft.authKind === 'key-file' ? '私钥路径' : 'Vault 引用'}<Input disabled={Boolean(busy)} value={draft.authValue} onChange={e => setDraft({ ...draft, authValue: e.target.value })} placeholder={draft.authKind === 'key-file' ? '~/.ssh/id_ed25519' : 'vault:secret/ssh/prod#private_key'} /></label> : null}
      <label>主机指纹（可选）<Input disabled={Boolean(busy)} value={draft.fingerprint} onChange={e => setDraft({ ...draft, fingerprint: e.target.value })} placeholder="SHA256:…" /></label>
      <label><input type="checkbox" checked={draft.autoUpgrade} onChange={e => setDraft({ ...draft, autoUpgrade: e.target.checked })} />检查到新版本时自动发起升级（仍需批准）</label>
      {leaked ? <p role="alert">检测到私钥内容。平台不保存私钥，请改填路径或 Vault 引用。</p> : null}
      <div className="lumo-remote-actions"><BusyButton type="submit" busy={busy === 'create'} disabled={leaked}>录入</BusyButton><Button size="sm" disabled={Boolean(busy)} onClick={() => setAdding(false)}>取消</Button></div>
    </form> : null}
  </div>
}
