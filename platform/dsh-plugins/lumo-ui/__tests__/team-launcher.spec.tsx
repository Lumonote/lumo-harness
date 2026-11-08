// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamLauncher } from '../src/client/team-launcher.tsx'

afterEach(cleanup)
const capabilities = { provider: { provider: 'spawn', kind: 'in-process', reason: 'available' }, durableStore: true, durableCourier: true }

describe('team launch via the native captain session', () => {
  it('prepares an editable request with topology and tasks without dispatching', () => {
    const bridge = { getDraft: () => '', setDraft: vi.fn(), submit: vi.fn() }
    const onPrepared = vi.fn()
    render(<TeamLauncher capabilities={capabilities} bridge={bridge} onPrepared={onPrepared} />)
    fireEvent.change(screen.getByRole('textbox', { name: '团队目标' }), { target: { value: '发布验收' } })
    fireEvent.change(screen.getByRole('combobox', { name: '团队协作方式' }), { target: { value: 'pipeline' } })
    fireEvent.change(screen.getByRole('textbox', { name: '团队任务主题' }), { target: { value: '检查\n\n验收' } })
    fireEvent.click(screen.getByRole('button', { name: '准备团队任务' }))
    expect(bridge.setDraft).toHaveBeenCalledOnce()
    expect(bridge.setDraft.mock.calls[0]?.[0]).toContain('协作拓扑：pipeline')
    expect(bridge.setDraft.mock.calls[0]?.[0]).toContain('团队目标：发布验收')
    expect(bridge.setDraft.mock.calls[0]?.[0]).toContain('1. 检查\n2. 验收')
    expect(bridge.submit).not.toHaveBeenCalled()
    expect(onPrepared).toHaveBeenCalledOnce()
  })
  it('preserves existing drafts and keeps the form open', () => {
    const bridge = { getDraft: () => '已有内容', setDraft: vi.fn() }
    const onPrepared = vi.fn()
    render(<TeamLauncher capabilities={capabilities} bridge={bridge} onPrepared={onPrepared} />)
    fireEvent.change(screen.getByRole('textbox', { name: '团队目标' }), { target: { value: '目标' } })
    fireEvent.click(screen.getByRole('button', { name: '准备团队任务' }))
    expect(screen.getByRole('alert').textContent).toContain('未发送的内容')
    expect(bridge.setDraft).not.toHaveBeenCalled()
    expect(onPrepared).not.toHaveBeenCalled()
  })
  it.each([{capabilities:null,bridge:{getDraft:()=>'',setDraft:vi.fn()}},{capabilities,bridge:null}])('disables preparation when execution or the composer is unavailable', props => {
    render(<TeamLauncher {...props} onPrepared={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: '团队目标' }), { target: { value: '目标' } })
    expect((screen.getByRole('button', { name: '准备团队任务' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

it.each(['read', 'write'] as const)('keeps the goal visible if the composer %s fails', phase => {
 const onPrepared = vi.fn()
 const bridge = { getDraft: () => { if (phase === 'read') throw Error('session changed'); return '' }, setDraft: vi.fn(() => { throw Error('composer unavailable') }) }
 render(<TeamLauncher capabilities={capabilities} bridge={bridge} onPrepared={onPrepared} />)
 fireEvent.change(screen.getByRole('textbox', { name: '团队目标' }), { target: { value: '必须保留的目标' } })
 fireEvent.click(screen.getByRole('button', { name: '准备团队任务' }))
 expect(screen.getByRole('alert').textContent).toContain('团队目标已保留')
 expect((screen.getByRole('textbox', { name: '团队目标' }) as HTMLTextAreaElement).value).toBe('必须保留的目标')
 expect(onPrepared).not.toHaveBeenCalled()
})

it('does not close the launcher when a composer explicitly declines a draft', () => {
 const onPrepared = vi.fn()
 render(<TeamLauncher capabilities={capabilities} bridge={{ getDraft: () => '', setDraft: () => false }} onPrepared={onPrepared} />)
 fireEvent.change(screen.getByRole('textbox', { name: '团队目标' }), { target: { value: '保留拒收目标' } })
 fireEvent.click(screen.getByRole('button', { name: '准备团队任务' }))
 expect(screen.getByRole('alert').textContent).toContain('当前输入框未接收内容')
 expect(onPrepared).not.toHaveBeenCalled()
})
