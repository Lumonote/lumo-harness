import { useEffect, useRef, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CliToolView } from '../../../acp-engines/src/cli-install-catalog.ts'
import { acpCall } from './acp-session-state.ts'
import { ChatButton } from './chat-button.tsx'
import './cli-installation-panel.css'

export function CliInstallationPanel({ engineId, available, onChanged }: { engineId: string; available: boolean; onChanged(): void }) {
  const [open, setOpen] = useState(false)
  return <details className="lumo-cli-installation" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>CLI 安装</summary>
    {open ? <InstallationControls engineId={engineId} available={available} onChanged={onChanged} /> : null}
  </details>
}

function InstallationControls({ engineId, available, onChanged }: { engineId: string; available: boolean; onChanged(): void }) {
  const [tool, setTool] = useState<CliToolView>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(''), [revision, setRevision] = useState(0)
  const request = useRef<AbortController>(), notified = useRef(''), changed = useRef(onChanged)
  const pending = useRef<{ signature: string; id: string }>()
  changed.current = onChanged
  const base = `/lumo/api/acp/engines/${encodeURIComponent(engineId)}/installation`
  const accept = (value: CliToolView) => {
    if (!value || value.engineId !== engineId) throw new Error('CLI 安装状态响应无效')
    setTool(value)
    if (value.job?.status === 'succeeded' && notified.current !== value.job.id) { notified.current = value.job.id; changed.current() }
  }
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const result = await acpCall<{ tool: CliToolView }>(base, { signal: controller.signal })
        if (controller.signal.aborted) return
        accept(result.tool); setError('')
        if (result.tool.job?.status === 'running') timer = setTimeout(() => void load(), 1000)
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer); request.current?.abort() }
  }, [base, revision])
  const mutate = async (action: 'install' | 'reinstall' | 'cancel', retryVersion?: string) => {
    if (request.current || !tool) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('')
    const selectedVersion = retryVersion || version.trim() || (action === 'reinstall' ? tool.installation?.version ?? 'latest' : 'latest')
    const signature = `${action}:${selectedVersion}`
    if (pending.current?.signature !== signature) pending.current = { signature, id: crypto.randomUUID() }
    try {
      const result = await acpCall<{ tool: CliToolView }>(`${base}/${action === 'cancel' ? 'cancel' : 'install'}`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify(action === 'cancel' ? { jobId: tool.job?.id } : { requestId: pending.current.id, action, version: selectedVersion }),
      })
      if (controller.signal.aborted) return
      accept(result.tool); pending.current = undefined; setRevision(n => n + 1)
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (request.current === controller) { request.current = undefined; if (!controller.signal.aborted) setBusy(false) } }
  }
  const running = tool?.job?.status === 'running'
  return <div className="lumo-cli-controls">
    {!tool && !error ? <p role="status">正在读取安装状态…</p> : null}
    {tool ? <>
      <div className="lumo-cli-status"><span>{tool.installation ? `受管版本 ${tool.installation.version}` : available ? '使用本机已有入口' : '尚未安装'}</span><small>{tool.source}</small></div>
      {tool.supported ? <>
        <label className="lumo-native-content">版本<Input aria-label="CLI 安装版本" placeholder="latest" value={version} disabled={busy || running} onChange={event => setVersion(event.target.value)} /></label>
        <div className="lumo-cli-actions">
          <ChatButton type="button" disabled={busy || running} onClick={() => void mutate('install')}>{tool.installation || available ? '安装新版本' : '在线安装'}</ChatButton>
          {tool.installation || available ? <ChatButton type="button" disabled={busy || running} onClick={() => void mutate('reinstall')}>重新安装</ChatButton> : null}
          {running ? <ChatButton type="button" disabled={busy} onClick={() => void mutate('cancel')}>取消安装</ChatButton> : null}
        </div>
        <small className="lumo-muted">安装到 Lumo 管理目录，成功后新会话与群组自动使用。版本留空时安装最新版；重装沿用已管理版本。登录状态需连接确认。</small>
      </> : <p role="status">{tool.reason}</p>}
      <details className="lumo-cli-path"><summary>安装位置</summary><code>{tool.executable ?? tool.directory}</code></details>
      {tool.job ? <div className="lumo-cli-job" aria-label="CLI 安装进度" aria-busy={running}>
        <p role="status">{tool.job.stage}{tool.job.status === 'succeeded' ? ' · 后续连接使用此版本' : ''}</p>
        {running ? <progress aria-label="CLI 安装进行中" /> : null}
        {tool.job.error ? <p role="alert">{tool.job.error}</p> : null}
        {tool.job.log ? <details open={running}><summary>安装日志</summary><pre aria-label="CLI 安装日志">{tool.job.log}</pre></details> : null}
        {['failed', 'cancelled', 'interrupted'].includes(tool.job.status) ? <ChatButton type="button" disabled={busy} onClick={() => void mutate(tool.job!.action, tool.job!.requestedVersion)}>重试安装</ChatButton> : null}
      </div> : null}
    </> : null}
    {error ? <div role="alert"><p>{error}</p><ChatButton type="button" disabled={busy} onClick={() => setRevision(n => n + 1)}>刷新状态</ChatButton></div> : null}
  </div>
}
