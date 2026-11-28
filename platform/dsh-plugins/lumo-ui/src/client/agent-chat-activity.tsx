import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { ActivityIcon, NextIcon } from './chat-icons.tsx'

export const activityState: Record<string, string> = { pending: '等待执行', running: '执行中', in_progress: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '结果需核对', new: '尚未启动', idle: '空闲', detached: '待恢复', missing: '会话不可用', starting: '连接中' }
const dotState = (state: string): StateDotState => state === 'completed' ? 'done' : state === 'running' || state === 'in_progress' ? 'ongoing' : state === 'failed' ? 'error' : state === 'interrupted' ? 'warning' : 'idle'
export interface ChatActivity { id: string; title: string; detail: string; state: string; icon?: ReactNode; jump(): void }
export function AgentChatActivity({ running, pending, onPermissions, entries }: { running: boolean; pending: number; onPermissions(): void; entries: ChatActivity[] }) {
  return <div className="lumo-chat-activity lumo-native-content">
    <div className="lumo-dock-project"><StateDot state={pending ? 'warning' : running ? 'ongoing' : 'idle'} /><span>{pending ? `${pending} 项等待确认` : running ? '正在执行' : '当前空闲'}</span></div>
    {pending ? <Button size="sm" type="button" className="lumo-dock-row" onClick={onPermissions}><span>查看权限请求</span><NextIcon size={14} /></Button> : null}
    {!entries.length ? <p className="lumo-dock-hint">暂无执行记录，发送消息后会在这里更新。</p> : <ol className="lumo-dock-timeline">{entries.map(entry => <li key={entry.id} data-state={entry.state}>
      <Button size="sm" type="button" className="lumo-dock-row" title="定位到对话" onClick={entry.jump}>
        {entry.icon ?? <ActivityIcon size={15} />}<span><strong>{entry.title}</strong><small>{entry.detail}</small><small className="lumo-dock-state"><StateDot state={dotState(entry.state)} size={10} />{activityState[entry.state] ?? entry.state}</small></span><NextIcon size={14} />
      </Button>
    </li>)}</ol>}
  </div>
}
