/**
 * 统一审批 / 提问面板（P0-1）。读 /lumo/api/asks，按 kind 渲染：approval 用批准/拒绝，
 * choice 用选项按钮，question 用文本框。订阅 /lumo/api/asks/events（SSE）做刷新提示，
 * 事件流不可用时退化为手动刷新——列表接口永远是事实来源。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Ask } from '../../../../shared/seam-contracts/asks.ts'
import { effectiveStatus } from '../../../../shared/seam-contracts/asks.ts'
import { api } from './api.ts'
import { BusyButton, Empty, Notice, Section } from './surface-shell.tsx'
import { answerPath, isApproveOption, isHighRisk, loadAllAsks, sourceOf, visibleOptions } from './ask-sources.ts'
import './device-actions-panel.css'

export const ASK_STATUS_LABEL: Record<string, string> = {
  pending: '等待处理', answered: '已回答', rejected: '已拒绝', expired: '已过期', cancelled: '已撤回',
}

export function askStatusLabel(ask: Pick<Ask, 'status' | 'expires_at' | 'source_status'>, now?: number): string {
  const status = effectiveStatus(ask, now)
  if (status === 'answered' && ask.source_status === 'approved') return '已批准 · 等待一次执行'
  if (status === 'answered' && ask.source_status === 'consumed') return '已批准 · 已执行'
  return ASK_STATUS_LABEL[status] ?? status
}

export function AsksPanel({ onChange }: { onChange?: () => void }) {
  const [asks, setAsks] = useState<Ask[]>([])
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    // 统一列表 ∪ 插件工具审批 ∪ SSH 远端操作 ∪ ACP 会话权限（ask-sources.ts）；未启用的来源静默跳过
    try { const r = await loadAllAsks(path => api<{ asks?: Ask[] }>(path)); setAsks(r.asks); if (r.errors.length) setNotice(r.errors.join('；')) } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/lumo/api/asks/events')
    const refresh = () => { void load() }
    for (const type of ['ask.created', 'ask.answered', 'ask.rejected', 'ask.expired', 'ask.cancelled', 'ask.consumed']) source.addEventListener(type, refresh)
    source.onerror = () => source.close()
    return () => source.close()
  }, [load])

  const answer = async (ask: Ask, value: string) => {
    setBusy(`${ask.id}:${value}`); setNotice('')
    try {
      await api(answerPath(ask), { method: 'POST', body: JSON.stringify({ value }) })
      setNotice(/^(reject|deny)/u.test(value) ? '已拒绝。' : '已提交；申请方可继续执行。')
      await load(); onChange?.()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }

  const pending = asks.filter(ask => effectiveStatus(ask) === 'pending').length
  return <Section title="待处理审批与提问" meta={`${pending} 项待处理 · 共 ${asks.length} 项`} actions={<BusyButton busy={loading} onClick={() => void load()}>刷新</BusyButton>}>
    {notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    {asks.length ? <div className="lumo-market-note-grid">{asks.map(ask => {
      const live = effectiveStatus(ask) === 'pending'
      return <div key={ask.id} data-ask-id={ask.id} data-risk={isHighRisk(ask) ? 'high' : 'normal'}>
        <span>{askStatusLabel(ask)}</span>
        <small className="lumo-ask-source">{sourceOf(ask).label}{isHighRisk(ask) ? ' · 高风险' : ''}</small>
        <b>{ask.title}</b>
        <small>{ask.detail ? `${ask.detail} · ` : ''}申请人 {ask.requester_user_id} · 到期 {ask.expires_at}{ask.answer ? ` · 处理人 ${ask.answer.answered_by}` : ''}</small>
        {live && ask.kind === 'question' ? <span className="lumo-surface-actions"><input aria-label="回答" value={drafts[ask.id] ?? ''} onChange={event => setDrafts(current => ({ ...current, [ask.id]: event.target.value }))} /><BusyButton busy={busy === `${ask.id}:text`} onClick={() => void answer(ask, drafts[ask.id] ?? '')}>提交</BusyButton></span> : null}
        {live && ask.kind !== 'question' ? <span className="lumo-surface-actions">{visibleOptions(ask).map(option => <BusyButton key={option.id} className={isApproveOption(option.id) ? 'lumo-primary' : ''} busy={busy === `${ask.id}:${option.id}`} onClick={() => void answer(ask, option.id)}>{option.label}</BusyButton>)}</span> : null}
      </div>
    })}</div> : <Empty>当前没有需要人工处理的审批或提问。</Empty>}
  </Section>
}
