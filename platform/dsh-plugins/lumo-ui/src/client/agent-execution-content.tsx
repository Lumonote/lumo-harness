import { CodeBlock, DiffBlock, DisclosureRow, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { memo, useState } from 'react'
import type { TranscriptItem } from './acp-session-state.ts'
import './conversation-details.css'
export const codeLabels = { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '文本', wrapLabel: '自动换行', unwrapLabel: '取消换行' } }
const status: Record<string, string> = { pending: '等待中', in_progress: '执行中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止' }
export const AgentToolResult = memo(({ item }: { item: Extract<TranscriptItem, {kind: 'tool'}> }) => {
  const [open, setOpen] = useState(false)
  const expandable = !!(item.input || item.output || item.diffs?.length || item.locations?.length || item.exitCode !== undefined)
  return <div className="lumo-native-content lumo-execution-content"><DisclosureRow icon={null} title={`${item.title} · ${status[item.status] ?? item.status}`} open={open} expandable={expandable} onToggle={() => setOpen(!open)}>
    {item.input ? <div aria-label="工具输入"><CodeBlock code={item.input} {...codeLabels} /></div> : null}
    {item.locations?.map(location => <div key={`${location.path}:${location.line ?? ''}`}><PathLabel path={location.path} />{location.line ? <small>:{location.line}</small> : null}</div>)}
    {item.diffs?.length ? <DiffBlock diffs={item.diffs.map(diff => ({ ...diff, oldText: diff.oldText ?? null }))} labels={{ ...codeLabels.toolbarLabels, copy: '复制差异', copied: '已复制', collapseAria: '收起差异', expandAria: count => `展开 ${count} 行`, collapse: '收起', expand: count => `展开 ${count} 行` }} /> : null}
    {item.output ? <div aria-label="工具输出"><CodeBlock code={item.output} streaming={item.status === 'in_progress' || item.status === 'running'} {...codeLabels} /></div> : null}
    {item.exitCode !== undefined ? <small>退出码 {item.exitCode}</small> : null}
  </DisclosureRow></div>
})
export const AgentPlan = memo(({ entries }: { entries: Extract<TranscriptItem, {kind: 'plan'}>['entries'] }) => <ol className="lumo-execution-plan" aria-label="执行计划">{entries.map((entry, index) => <li key={`${index}:${entry.content}`} data-state={entry.status}><span aria-hidden="true">{entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◉' : '○'}</span><span>{entry.content}</span><small>{status[entry.status] ?? entry.status}</small></li>)}</ol>)
