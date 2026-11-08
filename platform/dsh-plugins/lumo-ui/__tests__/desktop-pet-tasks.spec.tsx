// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopPetTasks } from '../src/client/desktop-pet-tasks.tsx'
import { installDesktopPetBridge, type DesktopPetServices, type DesktopSessionSummary } from '../src/client/desktop-pet.ts'

const desktop = window as Window & { __LUMO_DESKTOP__?: boolean }
const disposers: Array<() => void> = []
afterEach(() => { cleanup(); for (const dispose of disposers.splice(0).reverse()) dispose(); delete desktop.__LUMO_DESKTOP__ })

function store<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, set(value: T) { snapshot = value; for (const listener of listeners) listener() } }
}
function mount() {
  desktop.__LUMO_DESKTOP__ = true
  const byId: Record<string, DesktopSessionSummary> = {
    running: { displayTitle: '构建桌宠', running: true, blank: false, updatedAt: 200, cwd: '/work/lumo' },
    stopped: { displayTitle: '整理笔记', running: false, blank: false, updatedAt: 300, cwd: '/work/notes' },
    archived: { displayTitle: '归档项目', running: false, updatedAt: 100 },
    blank: { displayTitle: '未发送草稿', blank: true, running: false, updatedAt: 100 },
    subagent: { displayTitle: '子任务', origin: 'subagent', running: true, updatedAt: 100 },
    fallback: { displayTitle: '仅保留的子会话', running: true, updatedAt: 100 },
  }
  const sessions = store({ phase: 'ready', ids: ['stopped', 'running', 'archived', 'blank', 'subagent'], byId })
  const workspaces = store({ phase: 'ready', items: [], archivedSessionIds: ['archived'] })
  const openSession = vi.fn()
  const services = { sessions: { list: sessions }, workspaces: { list: workspaces }, uiWorkspace: { openSession } } as unknown as DesktopPetServices
  disposers.push(installDesktopPetBridge(window, services))
  const onClose = vi.fn()
  render(<DesktopPetTasks onClose={onClose} />)
  return { sessions, workspaces, openSession, onClose, byId }
}

describe('本机对话任务', () => {
  it('只显示真实Host目录中未归档的主对话，将正在运行的对话置顶', () => {
    mount()
    const dialog = screen.getByRole('dialog', { name: '本机对话任务' })
    const titles = [...dialog.querySelectorAll('li strong')].map(node => node.textContent)
    expect(titles).toEqual(['构建桌宠', '整理笔记'])
    expect(screen.getByText('未在运行')).toBeTruthy()
    expect(screen.getByText(/不代表任务已完成/)).toBeTruthy()
    expect(screen.queryByText('归档项目')).toBeNull()
    expect(screen.queryByText('未发送草稿')).toBeNull()
    expect(screen.queryByText('子任务')).toBeNull()
    expect(screen.queryByText('仅保留的子会话')).toBeNull()
  })

  it('宿主运行状态推送立即更新，支持按状态和工作目录筛选', () => {
    const { sessions, byId } = mount()
    fireEvent.click(screen.getByRole('checkbox', { name: '只看进行中' }))
    expect(screen.queryByText('整理笔记')).toBeNull()
    act(() => sessions.set({ ...sessions.getSnapshot(), byId: { ...byId, stopped: { ...byId['stopped']!, running: true } } }))
    expect(screen.getByText('整理笔记')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), { target: { value: '/work/notes' } })
    expect(screen.getByText('整理笔记')).toBeTruthy()
    expect(screen.queryByText('构建桌宠')).toBeNull()
  })

  it('打开对话沿用原生导航，失败时保留面板并显示错误', () => {
    const { openSession, onClose } = mount()
    openSession.mockImplementationOnce(() => { throw Error('removed') })
    fireEvent.click(screen.getByRole('button', { name: /构建桌宠.*打开对话/u }))
    expect(screen.getByRole('alert').textContent).toContain('暂时无法打开')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /构建桌宠.*打开对话/u }))
    expect(openSession).toHaveBeenCalledWith('running')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('加载态与真实空列表区分，空检索有明确反馈', () => {
    const { sessions } = mount()
    act(() => sessions.set({ phase: 'pending', ids: [], byId: {} }))
    expect(screen.getByRole('status').textContent).toContain('正在同步')
    act(() => sessions.set({ phase: 'ready', ids: [], byId: {} }))
    expect(screen.getByRole('status').textContent).toContain('还没有对话任务')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toContain('没有符合条件')
  })

  it('键盘焦点保留在面板内，Escape退出', () => {
    const { onClose } = mount()
    const close = screen.getByRole('button', { name: '关闭本机对话任务' })
    const back = screen.getByRole('button', { name: '返回对话' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(back)
    fireEvent.keyDown(back, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
