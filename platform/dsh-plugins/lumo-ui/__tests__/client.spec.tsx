// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { apply } from '../src/client/index.tsx'

interface Registered {
  id: string
  name: string
  Component: ComponentType<Record<string, unknown>>
}

const overview = {
  generatedAt: new Date().toISOString(),
  deployment: { mode: 'cluster', label: '服务器集群', storage: 'postgres', middleware: ['PostgreSQL', 'Nacos'], distributed: true, desktop: false, clusterReady: true, clusterOnly: true },
  services: { scheduler: { ok: true, status: 200 }, governance: { ok: true, status: 200 } },
  cluster: { leader: { holder: 'node-a' }, nodes: [] },
  projects: [],
  flows: [],
  connectors: [{ id: 'orders', name: '订单中台', protocol: 'http', operations: [] }],
  plugins: [{ id: 'metering', label: '用量计量', description: 'ledger', surface: 'operations', kind: 'governance' }],
}
const governance = {
  features: { ok: true, status: 200, data: {} },
  departments: { ok: true, status: 200, data: { departments: [] } },
  roles: { ok: true, status: 200, data: { roles: [] } },
  catalog: { ok: true, status: 200, data: { skills: [] } },
  effective: { ok: true, status: 200, data: { skills: [] } },
}

/**
 * 最小 ClientContext 替身。三个面缺一不可:
 * - slots:记录挂载点与组件
 * - effect:**必须真执行 body**。Cordis 的 ctx.effect 立即跑 body 并登记 disposer,
 *   替身若只记不跑,installLumoThemes 就等于没装,测试与生产语义分叉
 * - theme:上游公开的 register/setTheme 扩展点(dsh HEAD 原生,非本仓改动)
 */
function mountLumo(): Registered[] {
  const registered: Registered[] = []
  const slots = {
    inject: (_name: string, mount: () => unknown) => { mount() },
    register: (meta: { id: string; name: string }, Component: ComponentType<Record<string, unknown>>) => {
      registered.push({ ...meta, Component })
      return () => {}
    },
  }
  const theme = { register: () => () => {}, setTheme: () => {} }
  apply({ slots, theme, effect: (body: () => unknown) => { body() } } as never)
  return registered
}

describe('Lumo native Harness integration', () => {
  const calls: string[] = []

  beforeEach(() => {
    history.replaceState({}, '', '/')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    })
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString()
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      const body =
        path === '/lumo/api/overview' ? overview :
        path === '/lumo/api/skills' ? { complete: true, skills: [{ name: 'archify', description: '运行时技能', invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'lumo-local-snapshot' }] } :
        path === '/lumo/api/governance' ? governance :
        path === '/lumo/api/knowledge/query' ? { query: '审批', scope: 'published', hits: [{ docId: 'doc-ops', sourceVersion: 4, score: .92, text: '连接器需要审批。' }] } :
        path === '/auth/account' ? { mode: 'session', provider: 'lumo-governance', username: 'palmer', displayName: 'Palmer', userId: 'palmer', realm: 'dev', roles: ['operator'], department: 'platform', clientIp: '127.0.0.1', captchaMode: 'always' } :
        {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('mounts one workspace launcher and keeps capabilities in the upper-left menu', async () => {
    const registered = mountLumo()

    const entries = registered.filter(item => item.name === 'sidebar.footer.action')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    expect(entries.map(item => item.id)).toEqual(['lumo-workspace'])
    expect(overlay).toBeDefined()
    const Overlay = overlay!.Component

    render(<div>{entries.map(({ id, Component }) => <Component key={id} wide />)}<Overlay /></div>)
    fireEvent.click(screen.getByRole('button', { name: '打开 Lumo 工作区' }))
    expect(await screen.findByRole('button', { name: '知识库' })).toBeTruthy()
    const rail = screen.getByRole('navigation', { name: 'Lumo 能力工作台' })
    fireEvent.click(within(rail).getByRole('button', { name: '知识库' }))
    expect(await screen.findByRole('heading', { name: '知识库' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '向知识空间提问' }), { target: { value: '审批' } })
    fireEvent.click(screen.getByRole('button', { name: '检索知识' }))
    expect(await screen.findByText('doc-ops · v4')).toBeTruthy()

    fireEvent.click(within(rail).getByRole('button', { name: '专家技能' }))
    // 技能名经 localizedSkillName 落地;断言渲染出的中文名,证明 /lumo/api/skills 的响应真驱动了这块
    expect(await screen.findByText('架构与调度图')).toBeTruthy()
    const spotlight = document.querySelector<HTMLElement>('.lumo-skill-card')!
    fireEvent.pointerMove(spotlight, { clientX: 40, clientY: 30 })
    expect(spotlight.style.getPropertyValue('--spot-x')).not.toBe('')

    fireEvent.click(within(rail).getByRole('button', { name: '连接器' }))
    expect(await screen.findByText('订单中台')).toBeTruthy()
    fireEvent.click(within(rail).getByRole('button', { name: '运营管理' }))
    expect(await screen.findByText('用量计量')).toBeTruthy()
    fireEvent.click(within(rail).getByRole('button', { name: '用户中心' }))
    expect(await screen.findByText('Palmer')).toBeTruthy()

    // 点击火花:目标元素只要落在 ClickSpark 包裹内即可(onPointerDown 冒泡),这里借用上一步已定位的身份行
    fireEvent.pointerDown(screen.getByText('Palmer'), { clientX: 120, clientY: 80 })
    await waitFor(() => expect(document.querySelector('.lumo-spark')).not.toBeNull())
    for (const path of ['/lumo/api/knowledge/query', '/lumo/api/skills', '/lumo/api/governance', '/auth/account']) {
      expect(calls.some(call => call.includes(path))).toBe(true)
    }

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.lumo-workbench')).toBeNull())
  }, 15000)

  it('embeds project scope and OpenDesign directly around the native composer', () => {
    const registered = mountLumo()

    const scope = registered.find(item => item.name === 'conversation.input.left')
    const openDesign = registered.find(item => item.name === 'conversation.composer.dock')
    expect(scope).toBeDefined()
    expect(openDesign).toBeDefined()
    const Scope = scope!.Component
    const OpenDesign = openDesign!.Component

    render(<><Scope /><OpenDesign /></>)
    expect(screen.getByRole('button', { name: '选择项目：Lumo Desktop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择空间：产品设计' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '选择项目：Lumo Desktop' }))
    const project = screen.getByText('增长实验室').closest('button')
    expect(project).not.toBeNull()
    fireEvent.click(project!)
    expect(screen.getByRole('button', { name: '选择项目：增长实验室' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择空间：发布策略' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '选择空间：发布策略' }))
    const space = screen.getByText('创意活动').closest('button')
    expect(space).not.toBeNull()
    fireEvent.click(space!)

    expect(screen.getByRole('region', { name: '开放设计嵌入式创作面板' }).textContent).toContain('增长实验室/创意活动')
    fireEvent.click(screen.getByRole('tab', { name: '选择开放设计类型：线框图' }))
    const prompt = screen.getByRole('textbox', { name: '开放设计创作意图' })
    fireEvent.change(prompt, { target: { value: '为新品准备一个审批流' } })
    fireEvent.click(screen.getByRole('button', { name: '准备设计意图' }))
    expect(screen.getByRole('status').textContent).toContain('已为 增长实验室 / 创意活动 准备 线框图：为新品准备一个审批流')
  })
})
