import { describe, expect, it } from 'vitest'

import { reduceTranscript, type TranscriptItem } from '../src/client/acp-session-panel.tsx'

describe('AcpSessionPanel reduceTranscript', () => {
  it('合并相邻 agent 文本、按 toolCallId 更新工具、非正常结束给提示', () => {
    let items: TranscriptItem[] = []
    items = reduceTranscript(items, { type: 'message.chunk', role: 'user', text: 'hi' })
    items = reduceTranscript(items, { type: 'message.chunk', role: 'agent', text: 'he' })
    items = reduceTranscript(items, { type: 'message.chunk', role: 'agent', text: 'llo' })
    items = reduceTranscript(items, { type: 'tool.call', toolCallId: 't', title: 'ls', status: 'pending' })
    items = reduceTranscript(items, { type: 'tool.update', toolCallId: 't', status: 'completed' })
    items = reduceTranscript(items, { type: 'turn.ended', stopReason: 'end_turn' })
    expect(items).toEqual([
      { kind: 'text', role: 'user', text: 'hi' },
      { kind: 'text', role: 'agent', text: 'hello' },
      { kind: 'tool', toolCallId: 't', title: 'ls', status: 'completed' },
    ])
    items = reduceTranscript(items, { type: 'turn.ended', stopReason: 'cancelled' })
    expect(items.at(-1)).toEqual({ kind: 'notice', text: '回合结束：cancelled' })
  })
})
