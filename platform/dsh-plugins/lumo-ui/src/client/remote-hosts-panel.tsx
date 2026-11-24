/**
 * 远端机器管理面板（P1 SSH 一键接入）。独立组件文件；index.tsx 只挂一行。
 * 录入主机 → 探测 → 一键安装 / 检查升级 / 回滚 / 建立隧道。高风险操作先产生待审批项，
 * 在本面板内批准（同时登记到运行树，运行树面板里可以看到进度）。
 * 私钥只填本机路径或 Vault 引用；ssh-agent 为默认。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Ask } from '../../../../shared/seam-contracts/asks.ts'
import { effectiveStatus } from '../../../../shared/seam-contracts/asks.ts'
import { containsPrivateKey, installBlockers, upgradeVerdict, type ReleaseTarget, type RemoteHost, type RemoteOperation } from '../../../../shared/seam-contracts/remote-hosts.ts'
import { api } from './api.ts'
import { BusyButton, Empty, Notice } from './surface-shell.tsx'

const BASE = '/lumo/api/remote-hosts'
const STATE_LABEL: Record<RemoteHost['state'], string> = {
  registered: '已录入', probed: '已探测', installing: '安装中', installed: '已安装', upgrading: '升级中', failed: '失败', connected: '已接入',
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

  const load = useCallback(async () => {
    try {
      const r = await api<{ hosts: RemoteHost[]; target: ReleaseTarget }>(BASE)
      setHosts(r.hosts); setTarget(r.target)
      setAsks((await api<{ asks: Ask[] }>(`${BASE}/asks`)).asks)
    } catch (reason) {
      if ((reason as { status?: number }).status === 404) setDisabled(true)
      else setNotice(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key); setNotice('')
    try { await fn(); if (ok) setNotice(ok); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }

  if (disabled) return <Empty>远端机器接入仅在本机桌面形态可用（或已通过 LUMO_REMOTE_HOSTS=off 关闭）。</Empty>
  const input = draftToInput(draft)
  const leaked = containsPrivateKey(input)
  const pending = asks.filter(a => effectiveStatus(a) === 'pending')
  const request = (h: RemoteHost, op: RemoteOperation) => act(`${h.id}:${op}`, () => api(`${BASE}/${h.id}/${op}`, { method: 'POST', body: '{}' }), '已提交，请在下方「待批准」中确认。')

  return <div className="lumo-remote-hosts">
    {notice ? <Notice>{notice}</Notice> : null}
    {target ? <p className="lumo-workspace-note">安装目标：lumo {target.version} · dsh {target.dshTag}（{target.dshSha.slice(0, 12)}）——与本机一致</p> : null}

    {pending.length ? <div role="region" aria-label="待批准">
      <h4>待批准</h4>
      {pending.map(a => <div key={a.id} className="lumo-remote-ask">
        <strong>{a.title}</strong><small>{a.detail}</small>
        <BusyButton busy={busy === `${a.id}:approve`} onClick={() => void act(`${a.id}:approve`, () => api(`${BASE}/asks/${encodeURIComponent(a.id)}/answer`, { method: 'POST', body: JSON.stringify({ value: 'approve' }) }), '已批准，正在执行；进度见运行树。')}>批准</BusyButton>
        <BusyButton busy={busy === `${a.id}:reject`} onClick={() => void act(`${a.id}:reject`, () => api(`${BASE}/asks/${encodeURIComponent(a.id)}/answer`, { method: 'POST', body: JSON.stringify({ value: 'reject' }) }), '已拒绝。')}>拒绝</BusyButton>
      </div>)}
    </div> : null}

    {hosts.length ? <table className="lumo-remote-table"><thead><tr><th>名称</th><th>地址</th><th>环境</th><th>版本</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {hosts.map(h => {
        const verdict = target ? upgradeVerdict(h.probe?.installed ?? null, target) : 'not-installed'
        const blockers = h.probe ? installBlockers(h.probe) : []
        return <tr key={h.id}>
          <td>{h.name}{h.autoUpgrade ? <small> · 自动升级</small> : null}</td>
          <td><code>{h.user}@{h.address}:{h.port}</code><br /><small>{h.auth.kind === 'agent' ? 'ssh-agent' : h.auth.kind === 'key-file' ? `私钥 ${h.auth.path}` : `Vault ${h.auth.ref}`}</small></td>
          <td>{h.probe ? `${h.probe.os}-${h.probe.arch}` : '—'}{blockers.length ? <><br /><small title={blockers.join('；')}>⚠ {blockers.length} 项不满足</small></> : null}</td>
          <td>{h.probe?.installed?.version ?? '—'}<br /><small>{h.probe ? VERDICT_LABEL[verdict] : ''}</small></td>
          <td>{STATE_LABEL[h.state]}{h.tunnel?.status === 'up' ? <><br /><small>隧道 127.0.0.1:{h.tunnel.localPort}</small></> : null}{h.lastError ? <><br /><small role="alert">{h.lastError}</small></> : null}</td>
          <td className="lumo-remote-actions">
            <BusyButton busy={busy === `${h.id}:probe`} onClick={() => void act(`${h.id}:probe`, () => api(`${BASE}/${h.id}/probe`, { method: 'POST', body: '{}' }))}>探测</BusyButton>
            {verdict === 'not-installed' ? <BusyButton busy={busy === `${h.id}:install`} disabled={!h.probe || blockers.length > 0} onClick={() => void request(h, 'install')}>一键安装</BusyButton> : null}
            {verdict === 'upgrade' || verdict === 'dsh-mismatch' ? <BusyButton busy={busy === `${h.id}:upgrade`} onClick={() => void request(h, 'upgrade')}>升级</BusyButton> : null}
            {h.probe?.installed ? <BusyButton busy={busy === `${h.id}:version`} onClick={() => void act(`${h.id}:version`, () => api(`${BASE}/${h.id}/version`, { method: 'POST', body: '{}' }))}>检查版本</BusyButton> : null}
            {h.probe?.installed ? <BusyButton busy={busy === `${h.id}:rollback`} onClick={() => void request(h, 'rollback')}>回滚</BusyButton> : null}
            {h.probe?.installed && h.tunnel?.status !== 'up' ? <BusyButton busy={busy === `${h.id}:tunnel`} onClick={() => void request(h, 'tunnel')}>建立隧道</BusyButton> : null}
            {h.tunnel?.status === 'up' ? <BusyButton busy={busy === `${h.id}:close`} onClick={() => void act(`${h.id}:close`, () => api(`${BASE}/${h.id}/tunnel/close`, { method: 'POST', body: '{}' }))}>断开</BusyButton> : null}
            <BusyButton busy={busy === `${h.id}:del`} onClick={() => void act(`${h.id}:del`, () => api(`${BASE}/${h.id}`, { method: 'DELETE' }))}>移除</BusyButton>
          </td>
        </tr>
      })}
    </tbody></table> : <Empty>还没有录入远端机器。</Empty>}

    <form className="lumo-remote-form" onSubmit={e => { e.preventDefault(); if (leaked) return; void act('create', async () => { await api(BASE, { method: 'POST', body: JSON.stringify(input) }); setDraft(EMPTY) }, '已录入；下一步点「探测」。') }}>
      <h4>录入主机</h4>
      <label>名称<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} required /></label>
      <label>地址<input value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} placeholder="example.com 或 10.0.0.5" required /></label>
      <label>端口<input value={draft.port} inputMode="numeric" onChange={e => setDraft({ ...draft, port: e.target.value })} /></label>
      <label>用户<input value={draft.user} onChange={e => setDraft({ ...draft, user: e.target.value })} required /></label>
      <label>认证<select value={draft.authKind} onChange={e => setDraft({ ...draft, authKind: e.target.value as Draft['authKind'], authValue: '' })}>
        <option value="agent">ssh-agent（推荐）</option><option value="key-file">本机私钥文件路径</option><option value="vault">Vault 引用</option>
      </select></label>
      {draft.authKind !== 'agent' ? <label>{draft.authKind === 'key-file' ? '私钥路径' : 'Vault 引用'}<input value={draft.authValue} onChange={e => setDraft({ ...draft, authValue: e.target.value })} placeholder={draft.authKind === 'key-file' ? '~/.ssh/id_ed25519' : 'vault:secret/ssh/prod#private_key'} /></label> : null}
      <label>主机指纹（可选）<input value={draft.fingerprint} onChange={e => setDraft({ ...draft, fingerprint: e.target.value })} placeholder="SHA256:…" /></label>
      <label><input type="checkbox" checked={draft.autoUpgrade} onChange={e => setDraft({ ...draft, autoUpgrade: e.target.checked })} />检查到新版本时自动发起升级（仍需批准）</label>
      {leaked ? <p role="alert">检测到私钥内容。平台不保存私钥，请改填路径或 Vault 引用。</p> : null}
      <BusyButton type="submit" busy={busy === 'create'} disabled={leaked}>录入</BusyButton>
    </form>
  </div>
}
