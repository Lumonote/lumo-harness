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
  projects: [{ id: 'growth', name: '增长项目', status: 'active', realm: 'dev' }],
  flows: [{ id: 'launch-flow', name: '发布流程', projectId: 'growth', status: 'published', version: 2 }],
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
function createLumoContext(preloadedThemes: string[] = []): { context: unknown; registered: Registered[] } {
  const registered: Registered[] = []
  const slots = {
    inject: (_name: string, mount: () => unknown) => { mount() },
    register: (meta: { id: string; name: string }, Component: ComponentType<Record<string, unknown>>) => {
      registered.push({ ...meta, Component })
      return () => {}
    },
  }
  const themeIDs = new Set(preloadedThemes)
  const theme = {
    getTheme: () => ({ themes: [...themeIDs].map(id => ({ id })) }),
    register: (definition: { id: string }) => {
      if (themeIDs.has(definition.id)) throw new Error(`theme "${definition.id}" is already registered`)
      themeIDs.add(definition.id)
      return () => { themeIDs.delete(definition.id) }
    },
    setTheme: () => {},
  }
  const context = { root: {}, slots, theme, effect: (body: () => unknown) => { body() } }
  return { context, registered }
}

function mountLumo(): Registered[] {
  const { context, registered } = createLumoContext()
  apply(context as never)
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
		init?.method === 'POST' && path === '/lumo/api/flows/launch-flow/run' ? { order: ['start'], outputs: { start: { source: 'lumo-ui-manual' } } } :
		init?.method === 'POST' && path === '/lumo/api/flows/launch-flow/runs/12/replay' ? { status: 'queued', replay_trigger_id: 13, already_queued: false } :
		path === '/lumo/api/flows/launch-flow/versions/1' ? { flow_id: 'launch-flow', version: 1, reviewer: 'reviewer-a', definition: { nodes: [{ id: 'start', operator: 'identity' }], edges: [] } } :
		path === '/lumo/api/flows/launch-flow/versions/2' ? { flow_id: 'launch-flow', version: 2, reviewer: 'reviewer-b', definition: { nodes: [{ id: 'start', operator: 'echo' }, { id: 'publish', operator: 'identity' }], edges: [{ from: 'start', to: 'publish' }] } } :
        init?.method === 'PUT' && path === '/lumo/api/projects/growth/automations/release-check' ? { automationId: 'release-check', projectId: 'growth', triggerKind: 'event', triggerSpec: 'release.ready', flowRef: 'launch-flow', enabled: false } :
			init?.method === 'PATCH' && path === '/lumo/api/agent-presets/contract-review' ? { id: 'contract-review', name: '合同复核 Agent', status: 'disabled', revision: 2 } :
        path === '/lumo/api/overview' ? overview :
			path === '/lumo/api/agent-presets' ? { agent_presets: [{ id: 'contract-review', name: '合同复核 Agent', owner_user_id: 'palmer', status: calls.includes('PATCH /lumo/api/agent-presets/contract-review') ? 'disabled' : 'active', version: '1.0.0', revision: calls.includes('PATCH /lumo/api/agent-presets/contract-review') ? 2 : 1, provider: 'openai', model_ref: 'gpt-5', connector_ids: ['crm'], knowledge_space_ids: ['legal'], max_concurrency: 2, max_budget_cents: 0, timeout_seconds: 3600, max_delegation_depth: 0 }] } :
			path === '/lumo/api/workers' ? { workers: [{ worker_id: 'agent:contract-review', worker_kind: 'agent', display_name: '合同复核 Agent', status: 'active', runtime_status: 'active', active_tasks: 1, max_concurrency: 2, load: .5, eligible: true }] } :
        path === '/lumo/api/projects/growth/automations' ? { automations: [{ automationId: 'release-check', projectId: 'growth', triggerKind: 'event', triggerSpec: 'release.ready', flowRef: 'launch-flow', enabled: true }] } :
        path === '/lumo/api/flows/launch-flow/runs' ? { runs: [{ id: 12, trigger_id: 8, automation_id: 'release-check', flow_id: 'launch-flow', flow_version: 2, status: 'failed', output_available: false, error: 'upstream unavailable', started_at: '2026-08-31T00:00:00Z', finished_at: '2026-08-31T00:00:01Z' }] } :
        path === '/lumo/api/skills' ? { complete: true, skills: [
          { name: 'open-design', description: '以产物优先的方式创建、完善、预览并导出真实设计产物。', whenToUse: '适用于原型、落地页、看板和视觉升级。', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'lumo-open-design' },
          { name: 'ppt-master', description: '从主题、文档或现有模板生成、编辑和增强原生可编辑 PPTX。', whenToUse: '适用于演示文稿生成、模板填充和原生 PPTX 编辑。', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'lumo-creative-skills' },
          { name: 'archify', description: '运行时技能', invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'lumo-local-snapshot' },
        ] } :
        path === '/lumo/api/governance' ? governance :
        init?.method === 'POST' && path === '/lumo/api/registry/plan' ? { root: 'sha256:plan-root', scopes: ['project:read'], shape: { olap: false, graph: false, vector: false, object: false, gpu: false }, items: [{
          name: 'release-flow', version: '1.2.0', kind: 'Flow', publisher: 'lumo-platform', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', scopes: ['project:read'],
        }] } :
		init?.method === 'PUT' && path === '/lumo/api/registry/rollouts/release-flow' ? { rollout: { channel: 'stable', name: 'release-flow', version: '1.2.0', percent: 100 }, source: 'desired_state' } :
		init?.method === 'PUT' && path === '/lumo/api/knowledge/sources/doc-ops' ? { source: { docId: 'doc-ops', realm: 'dev', space: 'operations', title: '连接器审批边界（修订）', sourceVersion: 5, embeddingModel: 'bge-m3', chunkCount: 1, updatedAt: '2026-09-01T00:00:00Z' }, state: 'synchronized' } :
		path === '/lumo/api/registry/rollouts/release-flow?node_id=cluster-a.dsh-0' ? { rollout: { channel: 'stable', name: 'release-flow', version: '1.2.0', previous_version: '1.1.0', percent: 100 }, selection: { node_id: 'cluster-a.dsh-0', version: '1.2.0', cohort: 'target' }, source: 'desired_state' } :
		path === '/lumo/api/registry/rollouts' ? { source: 'desired_state', channel: 'stable', items: [{ channel: 'stable', name: 'release-flow', version: '1.2.0', percent: 100, updated_at: '2026-09-01T00:00:00Z' }] } :
		path === '/lumo/api/registry/artifacts/release-flow' ? { items: [{ name: 'release-flow', version: '1.2.0', kind: 'Flow', publisher: 'lumo-platform', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', scopes: ['project:read'], requires: { object: true }, deps: [], published_at: '2026-08-31T00:00:00Z' }, { name: 'release-flow', version: '1.1.0', kind: 'Flow', publisher: 'lumo-platform', digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', scopes: ['project:read'], requires: { object: true }, deps: [], published_at: '2026-08-30T00:00:00Z' }] } :
        path === '/lumo/api/registry/installations?limit=100' ? { source: 'provisioner_reports', items: [{
          node_id: 'cluster-a.dsh-0', state: 'converged', root: 'release-flow@1.2.0', reported_at: '2026-08-31T00:00:00Z', shape: { olap: false, graph: false, vector: false, object: true, gpu: false }, installed: [{
            name: 'release-flow', version: '1.2.0', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }],
        }] } :
		path === '/lumo/api/registry/artifacts?limit=100' ? { source: 'registry_index', state: 'discoverable', items: [{
          name: 'release-flow', version: '1.2.0', kind: 'Flow', publisher: 'lumo-platform', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          scopes: ['project:read'], requires: { object: true }, deps: [], published_at: '2026-08-31T00:00:00Z',
        }] } :
		path === '/lumo/api/knowledge/sources/doc-ops' ? { source: { doc: { docId: 'doc-ops', realm: 'dev', space: 'operations', title: '连接器审批边界', sourceVersion: 4, embeddingModel: 'bge-m3' }, chunks: [{ text: '连接器需要审批。', metadata: { owner: 'platform' } }] }, state: 'synchronized' } :
		path === '/lumo/api/knowledge/sources' ? { realm: 'dev', state: 'synchronized', sources: [{ docId: 'doc-ops', realm: 'dev', space: 'operations', title: '连接器审批边界', sourceVersion: 4, embeddingModel: 'bge-m3', chunkCount: 1, updatedAt: '2026-09-01T00:00:00Z' }] } :
        path === '/lumo/api/knowledge/query' ? { query: '审批', scope: 'published', hits: [{ docId: 'doc-ops', sourceVersion: 4, score: .92, text: '连接器需要审批。' }] } :
        path === '/auth/account' ? { mode: 'session', provider: 'lumo-governance', username: 'palmer', displayName: 'Palmer', userId: 'palmer', realm: 'dev', roles: ['operator'], department: 'platform', clientIp: '127.0.0.1', captchaMode: 'always' } :
        {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('mounts the requested product navigation without putting creative plugins in the sidebar', async () => {
    const registered = mountLumo()

    const entries = registered.filter(item => item.name === 'sidebar.navigation')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    expect(entries.map(item => item.id)).toEqual(['lumo-navigation'])
    expect(overlay).toBeDefined()
    const Overlay = overlay!.Component

    render(<div>{entries.map(({ id, Component }) => <Component key={id} wide />)}<Overlay /></div>)
    const navigation = screen.getByRole('navigation', { name: 'Lumo 功能菜单' })
    expect(within(navigation).getAllByRole('button').map(button => button.textContent)).toEqual([
      '项目', '专家 · 技能 · 连接器', '自动化', '资料库', '更多应用 · 灵感',
    ])
    expect(within(navigation).queryByRole('button', { name: '开放设计' })).toBeNull()
    expect(within(navigation).queryByRole('button', { name: 'PPT 生成' })).toBeNull()

    fireEvent.click(within(navigation).getByRole('button', { name: '项目' }))
    expect(await screen.findByText('用量计量')).toBeTruthy()
    expect(await screen.findByText('合同复核 Agent')).toBeTruthy()
		expect(await screen.findByText('启用 · 2 并发 · 执行态 active · 1/2 运行中')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: '版本差异' }))
		expect(await screen.findByText('流程版本对比')).toBeTruthy()
		expect(await screen.findByText('新增节点：publish')).toBeTruthy()
		expect(calls.some(call => call === 'GET /lumo/api/flows/launch-flow/versions/1')).toBe(true)
		expect(calls.some(call => call === 'GET /lumo/api/flows/launch-flow/versions/2')).toBe(true)
		const agentAssets = document.querySelector<HTMLElement>('.lumo-agent-preset-layout')!
		fireEvent.click(within(agentAssets).getByRole('button', { name: '停用' }))
		expect(await within(agentAssets).findByRole('button', { name: '启用' })).toBeTruthy()
		expect(calls.some(call => call === 'PATCH /lumo/api/agent-presets/contract-review')).toBe(true)

    fireEvent.click(within(navigation).getByRole('button', { name: '资料库' }))
    expect(await screen.findByRole('heading', { name: '资料库' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '向知识空间提问' }), { target: { value: '审批' } })
    fireEvent.click(screen.getByRole('button', { name: '检索知识' }))
    expect(await screen.findByText('doc-ops · v4')).toBeTruthy()
		expect(await screen.findByText('来源管理')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: '查看 / 编辑' }))
		await screen.findByDisplayValue('连接器审批边界')
		fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '连接器审批边界（修订）' } })
		fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
		await screen.findByText(/已保存 doc-ops 的 v5/)
		expect(calls.some(call => call === 'PUT /lumo/api/knowledge/sources/doc-ops')).toBe(true)

    fireEvent.click(within(navigation).getByRole('button', { name: '专家 · 技能 · 连接器' }))
    // 技能名经 localizedSkillName 落地;断言渲染出的中文名,证明 /lumo/api/skills 的响应真驱动了这块
    expect(await screen.findByText('架构与调度图')).toBeTruthy()
    const spotlight = document.querySelector<HTMLElement>('.lumo-skill-card')!
    fireEvent.pointerMove(spotlight, { clientX: 40, clientY: 30 })
    expect(spotlight.style.getPropertyValue('--spot-x')).not.toBe('')

    fireEvent.change(screen.getByRole('textbox', { name: '技能名称' }), { target: { value: 'campaign-review' } })
    fireEvent.change(screen.getByRole('textbox', { name: '技能版本内容' }), { target: { value: '# Campaign review\nReview the launch plan.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存治理版本' }))
    expect(await screen.findByText(/内容已进入治理目录/)).toBeTruthy()
    expect(calls.some(call => call === 'POST /lumo/api/governance/skills')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '连接器管理' }))
    expect(await screen.findByText('订单中台')).toBeTruthy()
    expect(calls.some(call => call === 'GET /lumo/api/connectors?includeDisabled=true')).toBe(true)

    // 点击火花:目标元素只要落在 ClickSpark 包裹内即可(onPointerDown 冒泡)。
    fireEvent.pointerDown(screen.getByText('订单中台'), { clientX: 120, clientY: 80 })
    await waitFor(() => expect(document.querySelector('.lumo-spark')).not.toBeNull())
    for (const path of ['/lumo/api/knowledge/query', '/lumo/api/skills', '/lumo/api/governance', '/lumo/api/overview']) {
      expect(calls.some(call => call.includes(path))).toBe(true)
    }

    fireEvent.click(within(navigation).getByRole('button', { name: '自动化' }))
    expect(await screen.findByText('发布流程')).toBeTruthy()
    expect(await screen.findByText('release-check')).toBeTruthy()
    expect(await screen.findByText('自动化实际运行')).toBeTruthy()
    expect(calls.some(call => call === 'GET /lumo/api/flows/launch-flow/runs')).toBe(true)
		fireEvent.click(screen.getByRole('button', { name: '重放失败运行' }))
		expect(await screen.findByText('失败运行 #12 已排入重放队列。')).toBeTruthy()
		expect(calls.some(call => call === 'POST /lumo/api/flows/launch-flow/runs/12/replay')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '停用' }))
    expect(await screen.findByRole('button', { name: '启用' })).toBeTruthy()
    expect(calls.some(call => call === 'PUT /lumo/api/projects/growth/automations/release-check')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '执行已发布版本' }))
    expect(await screen.findByText('最近一次手动执行')).toBeTruthy()
    expect(calls.some(call => call === 'POST /lumo/api/flows/launch-flow/run')).toBe(true)
    fireEvent.click(within(navigation).getByRole('button', { name: '更多' }))
    expect(await screen.findByText('已连接制品注册表')).toBeTruthy()
    expect((await screen.findAllByText('release-flow')).length).toBeGreaterThan(0)
    expect(screen.queryByText('基础插件已装配')).toBeNull()
    expect(calls.some(call => call.includes('/lumo/api/registry/artifacts?limit=100'))).toBe(true)
		expect((await screen.findAllByText('cluster-a.dsh-0')).length).toBeGreaterThan(1)
		expect(calls.some(call => call.includes('/lumo/api/registry/installations?limit=100'))).toBe(true)
		expect(await screen.findByText('Stable 通道期望状态')).toBeTruthy()
		expect(await screen.findByText('目标 cohort')).toBeTruthy()
		expect(calls.some(call => call === 'GET /lumo/api/registry/rollouts/release-flow?node_id=cluster-a.dsh-0')).toBe(true)
		await screen.findByRole('option', { name: '1.1.0' })
		const rolloutVersion = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Stable 期望版本' })
		fireEvent.change(rolloutVersion, { target: { value: '1.1.0' } })
		expect(rolloutVersion.value).toBe('1.1.0')
		const rolloutPercent = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Stable 灰度比例' })
		fireEvent.change(rolloutPercent, { target: { value: '25' } })
		expect(rolloutPercent.value).toBe('25')
		fireEvent.click(screen.getByRole('button', { name: '设为 Stable 期望版本' }))
		await waitFor(() => expect(calls.some(call => call === 'PUT /lumo/api/registry/rollouts/release-flow')).toBe(true))
		expect(await screen.findByText(/Stable 通道已将 release-flow@1.1.0 灰度至 25%/)).toBeTruthy()
		expect(calls.some(call => call === 'PUT /lumo/api/registry/rollouts/release-flow')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '生成签名计划' }))
    expect(await screen.findByText('计划闭包 · 1 个制品')).toBeTruthy()
    expect(calls.some(call => call === 'POST /lumo/api/registry/plan')).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.lumo-workbench')).toBeNull())
  }, 15000)

  it('shows design and PPT samples below the hero composer and submits through the original skills', async () => {
    const registered = mountLumo()

    const scope = registered.find(item => item.name === 'conversation.hero.input.left')
    const openDesign = registered.find(item => item.name === 'conversation.hero.composer.dock')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    expect(scope).toBeDefined()
    expect(openDesign).toBeDefined()
    expect(overlay).toBeDefined()
    const Scope = scope!.Component
    const OpenDesign = openDesign!.Component
    const Overlay = overlay!.Component
    let draft = ''
    const submitted: string[] = []
    const inputActions = {
      setDraft: (text: string) => { draft = text },
      submit: () => { submitted.push(draft) },
    }

    render(<><Scope /><OpenDesign inputActions={inputActions} /><Overlay /></>)
    expect(screen.getByRole('button', { name: '选择项目：Lumo Desktop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择空间：产品设计' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '创作能力' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /^开放设计开放设计$/ })).toBeTruthy()
    expect(screen.queryByText('智能协作工作台')).toBeNull()

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

    fireEvent.click(screen.getByRole('button', { name: /^开放设计开放设计$/ }))
    expect(await screen.findByRole('heading', { name: '开放设计' })).toBeTruthy()
    expect((await screen.findByRole('status')).textContent).toContain('开放设计')
    fireEvent.click(screen.getByRole('tab', { name: '选择开放设计类型：线框图' }))
    const prompt = screen.getByRole('textbox', { name: '开放设计创作意图' })
    fireEvent.change(prompt, { target: { value: '为新品准备一个审批流' } })
    fireEvent.click(screen.getByRole('button', { name: '发送到 OpenDesign' }))
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('/open-design 在项目「增长实验室」的空间「创意活动」中创建线框图。为新品准备一个审批流')
    await waitFor(() => expect(screen.queryByRole('heading', { name: '开放设计' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'PPT 生成' }))
    fireEvent.change(screen.getByRole('textbox', { name: '用 # 选择 PPT 样例' }), { target: { value: '#' } })
    const chooser = await screen.findByRole('dialog', { name: '选择演示样例' })
    fireEvent.click(within(chooser).getByRole('button', { name: /演示文稿生成/ }))
    const pptPrompt = screen.getByRole('textbox', { name: 'PPT 对话输入' })
    fireEvent.change(pptPrompt, { target: { value: '#演示文稿生成 面向研发团队，控制在 15 分钟。' } })
    fireEvent.click(screen.getByRole('button', { name: '发送到 PPT Master' }))
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toContain('/ppt-master 在项目「增长实验室」的空间「创意活动」中，使用「演示文稿生成」样例生成原生可编辑 PPTX。')
    expect(submitted[1]).toContain('面向研发团队，控制在 15 分钟。')
  }, 15000)

  it('keeps keyboard focus inside nested workbench dialogs and restores its opener', async () => {
    const registered = mountLumo()
    const entry = registered.find(item => item.name === 'sidebar.navigation')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    expect(entry).toBeDefined()
    expect(overlay).toBeDefined()
    const Entry = entry!.Component
    const Overlay = overlay!.Component

    render(<><Entry wide /><Overlay /></>)
    const opener = screen.getByRole('button', { name: '项目' })
    opener.focus()
    fireEvent.click(opener)
    const workbench = await screen.findByRole('dialog', { name: '项目工作台' })
    await waitFor(() => expect(workbench.contains(document.activeElement)).toBe(true))

    fireEvent.click(within(workbench).getByRole('button', { name: /跳转/ }))
    const palette = await screen.findByRole('dialog', { name: 'Lumo 工作区菜单' })
    const search = within(palette).getByRole('textbox', { name: '搜索工作区' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })
    expect(palette.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lumo 工作区菜单' })).toBeNull())
    expect(workbench.contains(document.activeElement)).toBe(true)
    fireEvent.click(within(workbench).getByRole('button', { name: '关闭工作台' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '项目工作台' })).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('does not duplicate root contributions when the client entry is replayed', () => {
    const { context, registered } = createLumoContext()
    apply(context as never)
    const first = registered.map(item => `${item.name}:${item.id}`)

    apply(context as never)

    expect(registered.map(item => `${item.name}:${item.id}`)).toEqual(first)
  })

  it('reuses product themes already owned by the shared theme service', () => {
    const { context } = createLumoContext([
      'obsidian-signal', 'ember-foundry', 'orbital-glass', 'infrared-grid',
    ])

    expect(() => { apply(context as never) }).not.toThrow()
  })
})
