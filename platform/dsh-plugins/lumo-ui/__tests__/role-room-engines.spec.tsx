// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoleRoomCreate } from '../src/client/role-room-create.tsx'
import type { RoomConfig } from '../../acp-engines/src/role-room-model.ts'
import type { EngineProbeView } from '../src/client/acp-session-panel.tsx'

afterEach(cleanup)
const engines: EngineProbeView[] = [
  { id: 'opencode', label: 'OpenCode', protocol: 'acp', available: true },
  { id: 'qwen-code', label: 'Qwen Code', protocol: 'acp', available: true },
  { id: 'workbuddy', label: 'WorkBuddy', protocol: 'acp', available: true },
  { id: 'gemini', label: 'Gemini CLI', protocol: 'acp', available: false, reason: '未找到 gemini 启动入口' },
]
const selected = () => [1, 2, 3].map(index => (screen.getByLabelText(`角色 ${index} 引擎`) as HTMLSelectElement).value)

describe('group engine discovery', () => {
  it('creates a group using detected tools beyond Claude and Codex and shows unavailable reasons', async () => {
    const create = vi.fn(async (_config: RoomConfig) => true), refreshEngines = vi.fn(), manageTools = vi.fn()
    render(<RoleRoomCreate engines={engines} busy={false} create={create} refreshEngines={refreshEngines} manageTools={manageTools} />)
    expect(selected()).toEqual(['opencode', 'qwen-code', 'workbuddy'])
    const choices = within(screen.getByLabelText('角色 1 引擎')).getAllByRole('option') as HTMLOptionElement[]
    expect(choices.map(option => option.value)).toEqual(engines.map(engine => engine.id))
    expect(choices[3]!.disabled).toBe(true); expect(choices[3]!.textContent).toContain(engines[3]!.reason)
    fireEvent.click(screen.getByRole('button', { name: '重新检测群组工具' })); expect(refreshEngines).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '工具与模型' })); expect(manageTools).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByLabelText('协作工作区目录'), { target: { value: '/workspace' } })
    fireEvent.click(screen.getByRole('button', { name: '创建协作房间' }))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create.mock.calls[0]![0].roles.map(role => role.engineId)).toEqual(['opencode', 'qwen-code', 'workbuddy'])
  })
  it('fills asynchronous detection once and keeps explicit selections across refreshes', () => {
    const create = vi.fn(async (_config: RoomConfig) => true)
    const { rerender } = render(<RoleRoomCreate engines={[]} busy={false} create={create} />)
    expect(selected()).toEqual(['', '', ''])
    rerender(<RoleRoomCreate engines={engines} busy={false} create={create} />)
    expect(selected()).toEqual(['opencode', 'qwen-code', 'workbuddy'])
    fireEvent.change(screen.getByLabelText('角色 1 引擎'), { target: { value: 'qwen-code' } })
    const unavailable = engines.map(engine => ({ ...engine, available: false }))
    rerender(<RoleRoomCreate engines={unavailable} busy={false} create={create} />)
    expect(selected()).toEqual(['qwen-code', 'qwen-code', 'workbuddy'])
    expect((screen.getByRole('button', { name: '创建协作房间' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<RoleRoomCreate engines={[...engines].reverse()} busy={false} create={create} />)
    expect(selected()).toEqual(['qwen-code', 'qwen-code', 'workbuddy'])
  })
  it('retains saved unavailable Agent engines and models until the user changes them', () => {
    const initialAgents = ['a', 'b'].map(id => ({ id, name: id, engineId: 'custom', modelId: 'chosen-model', instruction: 'Review', realm: 'local', userId: 'local' }))
    render(<RoleRoomCreate engines={engines} initialAgents={initialAgents} busy={false} create={vi.fn()} />)
    expect((screen.getByLabelText('角色 1 引擎') as HTMLSelectElement).value).toBe('custom')
    expect(screen.getAllByText(/chosen-model/)).toHaveLength(2)
    expect((screen.getByRole('button', { name: '创建协作房间' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
