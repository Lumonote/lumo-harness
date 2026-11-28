// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer } from '../src/client/chat-composer.tsx'
import { useChatAttachments } from '../src/client/chat-attachments.tsx'
const stop = vi.fn(), send = vi.fn()
function Composer({ running = false, initial = '', context = {} }: { running?: boolean; initial?: string; context?: { skills?: string[] } }) {
  const attachments = useChatAttachments('composer-test'), [value, onChange] = useState(initial)
  return <ChatComposer value={value} onChange={onChange} context={context} setContext={vi.fn()} commands={[]} scopePath="/session" label="输入消息" send={send} stop={stop} attachments={attachments} cwd="/project" project={vi.fn()} running={running} busy={false} />
}
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })
describe('shared external conversation composer', () => {
  it('blocks empty submits and IME/Shift Enter, and sends an ordinary Enter exactly once', () => {
    render(<Composer />); const input = screen.getByRole('textbox', { name: '输入消息' })
    fireEvent.keyDown(input, { key: 'Enter' }); expect(send).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' }); expect(send).toHaveBeenCalledOnce()
    expect(input.getAttribute('rows')).toBe('1'); expect(screen.getByRole('button', { name: '添加附件' }).textContent).toBe('')
  })
  it('allows a skill-only message and disables sending/upload while running without losing the draft', () => {
    const view = render(<Composer context={{ skills: ['proof'] }} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' })); expect(send).toHaveBeenCalledOnce()
    view.rerender(<Composer running context={{ skills: ['proof'] }} />)
    const input = screen.getByRole('textbox', { name: '输入消息' }); fireEvent.change(input, { target: { value: 'next message' } }); fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect((screen.getByRole('button', { name: '添加附件' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '停止' })); expect(stop).toHaveBeenCalledOnce()
    view.rerender(<Composer context={{ skills: ['proof'] }} />); expect((input as HTMLTextAreaElement).value).toBe('next message')
  })
})
