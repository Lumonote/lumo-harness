// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectWorkflowPanel, workflowChecks } from '../src/client/project-workflow-panel.tsx'
import { RoleRoomConversation } from '../src/client/role-room-conversation.tsx'
import { RoleRoomCreate } from '../src/client/role-room-create.tsx'
import { useRoleRooms } from '../src/client/use-role-rooms.ts'
import type { ProjectWorkflow } from '../../acp-engines/src/project-workflow-model.ts'
import type { RoomView } from '../../acp-engines/src/role-room-model.ts'

const now = '2026-11-28T12:00:00Z'
const identity = { realm: 'local', userId: 'owner', projectId: 'project' }
const room: RoomView = { ...identity, id: 'room', name: '项目团队', cwd: '/project', coordinatorId: 'planner', createdAt: now, revision: 1, busy: false, turns: [], sessionStates: {}, roles: [
  { id: 'planner', name: '协调成员', engineId: 'claude-code', instruction: '规划', capabilities: ['planning'] },
  { id: 'developer', name: '开发成员', engineId: 'opencode', instruction: '实现', capabilities: ['frontend', 'testing'] },
  { id: 'reviewer', name: '评审成员', engineId: 'codex', instruction: '评审', capabilities: ['review'] },
] }
const run: ProjectWorkflow = { id: 'run', goal: '完成搜索功能', state: 'draft', createdAt: now, updatedAt: now,
  repository: { root: '/project', commonDir: '/project/.git', branch: 'main', baseCommit: 'a'.repeat(40) },
  rules: { digest: 'b'.repeat(64), files: [{ path: 'AGENTS.md', content: '运行真实测试', digest: 'c'.repeat(64) }], warnings: [] },
  tasks: [{ id: 'search', title: '实现搜索', instruction: '增加搜索接口', dependsOn: [], capabilities: ['frontend'], acceptanceCriteria: ['搜索返回匹配记录'], roleId: 'developer', routingReason: '前端能力匹配', state: 'pending' }],
  checks: [{ id: 'tests', command: 'npm', args: ['test'] }], results: [], reviewerId: 'reviewer', maxParallel: 2,
}
const initial = () => ({ ...room, workflows: [structuredClone(run)] })
const enabled = (name: string) => !(screen.getByRole('button', { name }) as HTMLButtonElement).disabled
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('project workflow editing and evidence', () => {
  it('prepares a scoped draft with selected context and keeps the request id on retry', async () => {
    const action = vi.fn(async () => false)
    render(<ProjectWorkflowPanel room={room} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} initialGoal="实现搜索" context={{ files: ['src/app.ts'], skills: ['review'] }} />)
    fireEvent.change(screen.getByLabelText('项目验收命令'), { target: { value: '["npm","test"]' } })
    fireEvent.click(screen.getByRole('button', { name: '创建计划' })); await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(enabled('创建计划')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '创建计划' })); await waitFor(() => expect(action).toHaveBeenCalledTimes(2))
    expect(action.mock.calls[0]).toEqual(action.mock.calls[1])
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare', goal: '实现搜索', files: ['src/app.ts'], skills: ['review'], checks: [{ id: 'check-1', command: 'npm', args: ['test'] }] }))
  })

  it('validates argv and keeps a modified plan from running before it is saved', async () => {
    const action = vi.fn(async () => true)
    render(<ProjectWorkflowPanel room={initial()} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} />)
    expect(enabled('开始运行')).toBe(true)
    fireEvent.change(screen.getByLabelText('任务 1 名称'), { target: { value: '实现关键词搜索' } })
    expect(enabled('开始运行')).toBe(false); expect(enabled('AI 拆解')).toBe(false)
    fireEvent.change(screen.getByLabelText('项目验收命令'), { target: { value: 'npm test && echo ok' } })
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    expect(screen.getByRole('alert').textContent).toContain('JSON 参数数组'); expect(action).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('项目验收命令'), { target: { value: '["npm","test"]' } })
    fireEvent.click(screen.getByRole('button', { name: '保存计划' })); await waitFor(() => expect(action).toHaveBeenCalledOnce())
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', runId: run.id, tasks: [expect.objectContaining({ title: '实现关键词搜索', roleId: 'developer' })] }))
    expect(workflowChecks(JSON.stringify(['node', '-e', 'console.log("$HOME; echo literal")']))).toEqual([{ id: 'check-1', command: 'node', args: ['-e', 'console.log("$HOME; echo literal")'] }])
  })

  it('detects a dependency cycle and does not submit an invalid plan', () => {
    const action = vi.fn(async () => true)
    const second = { ...run.tasks[0]!, id: 'api', title: '接口', dependsOn: ['search'] }
    render(<ProjectWorkflowPanel room={{ ...room, workflows: [{ ...run, tasks: [...run.tasks, second] }] }} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('任务 1 依赖 接口'))
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    expect(screen.getByRole('alert').textContent).toMatch(/环/); expect(action).not.toHaveBeenCalled()
  })

  it('retains unsaved plans when closing the side panel and separates account drafts', () => {
    const props = { room: initial(), busy: false, action: vi.fn(async () => true), stop: vi.fn(), inspect: vi.fn() }
    const first = render(<ProjectWorkflowPanel {...props} />)
    fireEvent.change(screen.getByLabelText('任务 1 要求'), { target: { value: '保留这段未保存的任务要求' } }); first.unmount()
    const second = render(<ProjectWorkflowPanel {...props} />)
    expect((screen.getByLabelText('任务 1 要求') as HTMLTextAreaElement).value).toBe('保留这段未保存的任务要求'); expect(enabled('开始运行')).toBe(false)
    second.unmount()
    render(<ProjectWorkflowPanel {...props} room={{ ...props.room, userId: 'another-owner' }} />)
    expect((screen.getByLabelText('任务 1 要求') as HTMLTextAreaElement).value).toBe('增加搜索接口')
  })

  it('keeps automatic assignment automatic when editing task requirements', async () => {
    const action = vi.fn(async () => true)
    render(<ProjectWorkflowPanel room={{ ...room, workflows: [{ ...run, tasks: run.tasks.map(task => ({ ...task, assignment: 'auto' })) }] }} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} />)
    expect((screen.getByLabelText('任务 1 成员') as HTMLSelectElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('任务 1 名称'), { target: { value: '调整搜索' } }); fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    await waitFor(() => expect(action).toHaveBeenCalledOnce())
    expect((action.mock.calls[0]![0] as { tasks: Array<{ roleId?: string }> }).tasks[0]!.roleId).toBeUndefined()
  })

  it('shows real task, command and review evidence before the explicit merge action', async () => {
    const action = vi.fn(async () => true), inspect = vi.fn()
    const finished: ProjectWorkflow = { ...run, state: 'ready', commit: 'd'.repeat(40), tasks: [{ ...run.tasks[0]!, state: 'completed', sessionId: 'task-session', reply: '已实现搜索', changes: { head: 'd'.repeat(40), commit: 'd'.repeat(40), status: '', files: ['src/search.ts'], stat: '1 file changed', diff: '+search()', truncated: false } }],
      results: [{ ...run.checks[0]!, state: 'passed', exitCode: 0, output: '12 tests passed', truncated: false, commit: 'd'.repeat(40), startedAt: now, finishedAt: now }],
      review: { verdict: 'approved', summary: '已核对搜索与空结果', findings: [], commit: 'd'.repeat(40), roleId: 'reviewer' } }
    render(<ProjectWorkflowPanel room={{ ...room, workflows: [finished] }} busy={false} action={action} stop={vi.fn()} inspect={inspect} />)
    expect(screen.getByText('+search()')).toBeTruthy(); expect(screen.getByText('12 tests passed')).toBeTruthy(); expect(screen.getByText('独立评审通过')).toBeTruthy()
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '执行详情', hidden: true })); expect(inspect).toHaveBeenCalledWith('task-session')
    fireEvent.click(screen.getByRole('button', { name: '合并到 main' })); await waitFor(() => expect(action).toHaveBeenCalledWith({ action: 'merge', runId: run.id }))
  })

  it('preserves failed runs and creates a new run when reusing configuration', async () => {
    const action = vi.fn(async () => true)
    render(<ProjectWorkflowPanel room={{ ...room, workflows: [{ ...run, state: 'interrupted', error: '运行时已重启' }] }} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '开始运行' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '沿用配置新建' })); fireEvent.click(screen.getByRole('button', { name: '创建计划' }))
    await waitFor(() => expect(action).toHaveBeenCalledOnce())
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare', goal: run.goal, tasks: [expect.objectContaining({ id: 'search' })] }))
    expect((action.mock.calls[0]![0] as { id: string }).id).not.toBe(run.id)
  })

  it('reconciles interrupted merge receipts and revalidates completed work without rerunning development', async () => {
    const action = vi.fn(async () => true)
    const interrupted = { ...run, state: 'interrupted' as const, commit: 'd'.repeat(40), tasks: run.tasks.map(task => ({ ...task, state: 'completed' as const })), review: { verdict: 'approved' as const, summary: '已检查', findings: [], commit: 'd'.repeat(40), roleId: 'reviewer' } }
    render(<ProjectWorkflowPanel room={{ ...room, workflows: [interrupted] }} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '核对合并状态' })); await waitFor(() => expect(action).toHaveBeenCalledWith({ action: 'reconcile', runId: run.id }))
    await waitFor(() => expect(enabled('重新验收')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '重新验收' })); await waitFor(() => expect(action).toHaveBeenCalledWith({ action: 'validate', runId: run.id }))
    expect(screen.queryByRole('button', { name: '开始运行' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '强制结束成员进程' })); expect(action).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(enabled('确认结束进程')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '确认结束进程' })); await waitFor(() => expect(action).toHaveBeenCalledWith({ action: 'terminate', runId: run.id }))
  })

  it('keeps old runs read-only and retains capabilities when creating a team from saved Agents', async () => {
    const action = vi.fn(async () => true)
    const view = render(<ProjectWorkflowPanel room={{ ...room, workflows: [run, { ...run, id: 'newer' }] }} busy={false} action={action} stop={vi.fn()} inspect={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('项目流程记录'), { target: { value: run.id } })
    expect(screen.queryByRole('button', { name: '开始运行' })).toBeNull(); expect((screen.getByLabelText('项目流程目标') as HTMLTextAreaElement).disabled).toBe(true)
    view.unmount()
    const create = vi.fn(async () => true)
    render(<RoleRoomCreate engines={room.roles.map(role => ({ id: role.engineId, label: role.engineId, protocol: 'acp', available: true }))} initialAgents={room.roles.map(role => ({ ...role, ...identity }))} busy={false} create={create} />)
    expect((screen.getByLabelText('角色 2 能力：前端') as HTMLInputElement).checked).toBe(true)
    fireEvent.change(screen.getByLabelText('协作工作区目录'), { target: { value: '/project' } }); fireEvent.click(screen.getByLabelText('角色 2 能力：后端'))
    fireEvent.click(screen.getByRole('button', { name: '创建协作房间' })); await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ roles: expect.arrayContaining([expect.objectContaining({ engineId: 'opencode', capabilities: ['frontend', 'testing', 'backend'] })]) }))
  })
})

class EventSourceStub {
  static sources: EventSourceStub[] = []
  handlers = new Map<string, (event: { data: string }) => void>()
  constructor() { EventSourceStub.sources.push(this) }
  addEventListener(type: string, fn: (event: { data: string }) => void) { this.handlers.set(type, fn) }
  emit(type: string, value: unknown) { this.handlers.get(type)?.({ data: JSON.stringify(value) }) }
  close() {}
}

describe('workflow conversation integration', () => {
  it('interleaves conversations and workflows by creation time and preserves equal-time order', () => {
    const turn = (id: string, text: string, createdAt: string): RoomView['turns'][number] => ({ id, text, createdAt, mode: 'direct', targetRoleId: 'developer', state: 'completed', steps: [] })
    const chronological = { ...room, turns: [turn('before', '开始之前', '2026-11-28T11:59:00Z'), turn('same-time-first', '同时记录一', now), turn('same-time-second', '同时记录二', now), turn('after', '流程之后的聊天', '2026-11-28T12:01:00Z')], workflows: [run, { ...run, id: 'later', goal: '后续流程', createdAt: '2026-11-28T12:02:00Z' }] }
    const view = render(<RoleRoomConversation room={chronological} asks={[]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} workflowAction={vi.fn()} />)
    const messages = () => [...screen.getByRole('log').querySelectorAll('.lumo-role-round > .lumo-chat-user')].map(element => element.textContent)
    expect(messages()).toEqual(['开始之前', '同时记录一', '同时记录二', run.goal, '流程之后的聊天', '后续流程'])
    view.rerender(<RoleRoomConversation room={{ ...chronological, revision: 2 }} asks={[]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} workflowAction={vi.fn()} />)
    expect(messages()).toEqual(['开始之前', '同时记录一', '同时记录二', run.goal, '流程之后的聊天', '后续流程'])
  })

  it('opens the clicked historical workflow and keeps the normal rail entry on the latest record', () => {
    const latest = { ...run, id: 'latest', goal: '最近流程', createdAt: '2026-11-28T12:02:00Z' }
    render(<RoleRoomConversation room={{ ...room, workflows: [run, latest] }} asks={[]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} workflowAction={vi.fn()} />)
    const openHistory = () => fireEvent.click(within(screen.getByRole('region', { name: `项目流程：${run.goal}` })).getByRole('button', { name: /项目流程 ·/ }))
    openHistory()
    expect((screen.getByLabelText('项目流程记录') as HTMLSelectElement).value).toBe(run.id)
    expect((screen.getByLabelText('项目流程目标') as HTMLTextAreaElement).value).toBe(run.goal)
    expect((screen.getByLabelText('项目流程目标') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('项目流程记录'), { target: { value: latest.id } }); openHistory()
    expect((screen.getByLabelText('项目流程记录') as HTMLSelectElement).value).toBe(run.id)
    fireEvent.click(screen.getByRole('button', { name: '关闭侧栏' })); fireEvent.click(screen.getByRole('button', { name: '项目流程', exact: true }))
    expect((screen.getByLabelText('项目流程记录') as HTMLSelectElement).value).toBe(latest.id)
  })

  it('opens the native workflow rail and attributes task approvals and actual replies', async () => {
    const workflowAction = vi.fn(async () => true)
    const active = { ...run, state: 'running' as const, tasks: [{ ...run.tasks[0]!, state: 'running' as const, sessionId: 'work-session', reply: '正在实现搜索' }] }
    render(<RoleRoomConversation room={{ ...room, workflows: [active], busy: true }} asks={[{ id: 'ask', title: '修改搜索文件', source: { session_ref: 'work-session' }, options: [{ id: 'once', label: '允许一次' }] }]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} workflowAction={workflowAction} />)
    expect(screen.getByRole('log').textContent).toContain('正在实现搜索')
    expect(screen.getByText('开发成员 · 实现搜索', { selector: '.lumo-permission-source' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '项目流程', exact: true }))
    expect(screen.getByRole('complementary', { name: '项目流程' })).toBeTruthy(); expect(screen.getByRole('button', { name: '停止流程' })).toBeTruthy()
  })

  it('edits existing group capabilities without replacing engines and exposes the slash workflow entry', async () => {
    const workflowAction = vi.fn(async () => true)
    render(<RoleRoomConversation room={room} asks={[]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} workflowAction={workflowAction} />)
    fireEvent.click(screen.getByRole('button', { name: '群组成员' }))
    fireEvent.click(screen.getByLabelText('开发成员 能力：后端'))
    fireEvent.click(screen.getByRole('button', { name: '保存协作能力', hidden: true }))
    await waitFor(() => expect(workflowAction).toHaveBeenCalledWith({ action: 'capabilities', roles: room.roles.map(role => ({ id: role.id, capabilities: role.id === 'developer' ? ['frontend', 'testing', 'backend'] : role.capabilities })) }))
    fireEvent.click(screen.getByRole('button', { name: '关闭侧栏' }))
    fireEvent.change(screen.getByLabelText('协作消息输入'), { target: { value: '/workflow' } })
    expect(screen.getByRole('option', { name: /项目流程/ })).toBeTruthy()
  })

  it('applies workflow SSE deltas and includes workflow session approvals during refresh', async () => {
    EventSourceStub.sources = []; vi.stubGlobal('EventSource', EventSourceStub)
    let latest = room
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/rooms?') ? { rooms: [latest], identity } : path.includes('/rooms/room') ? { room: latest, identity } : path.includes('/asks') ? { asks: [{ id: 'task-approval', title: '执行任务', source: { session_ref: 'workflow-session' }, options: [] }, { id: 'foreign', title: '外部审批', source: { session_ref: 'foreign-session' }, options: [] }] } : { engines: [] })))
    function Harness() { const state = useRoleRooms(); return <><span data-testid="state">{state.room?.workflows?.at(-1)?.state}</span><span data-testid="asks">{state.asks.map(ask => ask.id).join(',')}</span></> }
    render(<Harness />); await waitFor(() => expect(EventSourceStub.sources.length).toBe(1))
    const active = { ...run, state: 'running' as const, sessionHistory: ['workflow-session'], tasks: [{ ...run.tasks[0]!, sessionId: 'current-session' }] }
    latest = { ...room, revision: 2, workflows: [active], busy: true }
    await act(async () => EventSourceStub.sources[0]!.emit('room.changed', { identity, change: { id: room.id, revision: 2, busy: true, workflows: [active], roleSessions: {}, refresh: true } }))
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('running'))
    await waitFor(() => expect(screen.getByTestId('asks').textContent).toBe('task-approval'))
  })
})
