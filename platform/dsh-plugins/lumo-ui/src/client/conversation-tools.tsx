import { useEffect, useState } from 'react'
import type { ConversationTools as Inventory } from '../../../acp-engines/src/conversation-tools.ts'
import { acpCall } from './acp-session-state.ts'
import { ChatButton } from './chat-button.tsx'
import { RefreshIcon } from './chat-icons.tsx'
import { EngineLogo } from './engine-logo.tsx'

const approval = { never: '无需额外确认', auto: '按风险确认', always: '每次确认', source: '按连接器规则确认' }

/** Only the session-bound inventory is displayed; discovery is not permission. */
export function ConversationTools({ scopePath }: { scopePath: string }) {
  const [state, setState] = useState<{ path: string; value?: Inventory; error?: string }>()
  const [revision, refresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState({ path: scopePath })
    acpCall<Inventory>(`${scopePath}/tools`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setState({ path: scopePath, value })
    }).catch(error => { if (!controller.signal.aborted) setState({ path: scopePath, error: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
  }, [scopePath, revision])
  const current = state?.path === scopePath ? state : undefined
  return <div className="lumo-shared-tools">
    <div className="lumo-shared-tools-heading"><small>调用时校验当前用户、项目和会话权限</small><ChatButton type="button" variant="ghost" className="lumo-chat-icon-button" aria-label="刷新共享工具" title="刷新" onClick={() => refresh(value => value + 1)}><RefreshIcon size={14} /></ChatButton></div>
    {current?.error ? <p role="alert">{current.error}</p> : !current?.value ? <p role="status">正在读取共享工具…</p> : current.value.members.map(member => <section key={member.id}>
      <h4 className="lumo-engine-heading"><EngineLogo engineId={member.engineId} small /><span>{member.name}</span></h4>
      {member.supplied ? <small>已向此会话提供工具</small> : <p role="status">{member.reason}</p>}
      {member.supplied && !member.tools.length ? <p>暂无已注册的共享工具</p> : null}
      {member.tools.map(tool => <details key={tool.name}><summary>{tool.name}</summary><p>{tool.description}</p><small>{tool.title} · {approval[tool.approval]}</small><code>{tool.action}</code></details>)}
    </section>)}
  </div>
}
