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

interface SlashClaim { token: string; hint?: string; submit(args: string): Promise<{ kind: string }> }
interface SlashSource {
  trigger: string
  name: string
  candidates(session: unknown, req: { query: string }): Promise<ReadonlyArray<{ name: string; description?: string }>>
  onPick(pick: { candidate: { name: string } }): { claim: SlashClaim } | undefined
  matchEnter(session: unknown, line: string): Promise<{ claim: SlashClaim } | undefined>
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
const skillhubCatalog = {
  source: 'seed',
  generatedAt: new Date().toISOString(),
  counts: { skills: 1, packs: 1, plugins: 1 },
  skills: [{ id: 'tencent-docs', name: '腾讯文档 TENCENT DOCS', tag: '办公效率', description: '在线云文档平台。', rating: 274, downloads: 719000, source: 'SkillHub', verified: true, command: 'tencent-docs', apiKey: true }],
  packs: [{ id: 'automation-testing', name: '自动化测试', role: '高级开发工程师', category: '科技', description: '从 TDD 到 E2E 测试。', skills: 6, source: 'SkillHub', command: 'automation-testing' }],
  plugins: [{ id: 'modlens', name: 'liustack/modlens', category: '模型推理', description: 'DSH 视觉插件。', stars: 3800, forks: 112, source: 'GitHub', installable: true, repo: 'liustack/modlens' }],
  installed: { skills: [], packs: [], plugins: [] },
}

/**
 * 最小 ClientContext 替身。三个面缺一不可:
 * - slots:记录挂载点与组件
 * - effect:**必须真执行 body**。Cordis 的 ctx.effect 立即跑 body 并登记 disposer,
 *   替身若只记不跑,installLumoThemes 就等于没装,测试与生产语义分叉
 * - theme:上游公开的 register/setTheme 扩展点(dsh HEAD 原生,非本仓改动)
 */
function createLumoContext(preloadedThemes: string[] = []): { context: unknown; registered: Registered[]; sources: SlashSource[] } {
  const registered: Registered[] = []
  const sources: SlashSource[] = []
  const slots = {
    inject: (_name: string, mount: () => unknown) => { mount() },
    register: (meta: { id: string; name: string }, Component: ComponentType<Record<string, unknown>>) => {
      registered.push({ ...meta, Component })
      return () => {}
    },
  }
  const themeIDs = new Set(preloadedThemes)
  const theme = {
    getTheme: () => ({ active: { id: [...themeIDs][0] ?? 'default' }, themes: [...themeIDs].map(id => ({ id, tokens: {} })) }),
    register: (definition: { id: string }) => {
      if (themeIDs.has(definition.id)) throw new Error(`theme "${definition.id}" is already registered`)
      themeIDs.add(definition.id)
      return () => { themeIDs.delete(definition.id) }
    },
    setTheme: () => {},
  }
  // inputTriggers 是上游 ui-input-trigger 的公开服务；替身只记录登记的 `/` 源。
  const inputTriggers = { registerSource: (source: SlashSource) => { sources.push(source); return () => { sources.splice(sources.indexOf(source), 1) } } }
  const context: Record<string, unknown> = { root: {}, slots, theme, effect: (body: () => unknown) => { body() }, on: () => () => {} }
  context['get'] = (name: string) => name === 'inputTriggers' ? inputTriggers : undefined
  context['inject'] = (_deps: string[], body: (ctx: unknown) => void) => { body(context) }
  return { context, registered, sources }
}

function mountLumo(): Registered[] {
  return mountLumoWithSources().registered
}

function mountLumoWithSources(): { registered: Registered[]; sources: SlashSource[] } {
  const { context, registered, sources } = createLumoContext()
  apply(context as never)
  return { registered, sources }
}

describe('Lumo native Harness integration', () => {
  const calls: string[] = []

  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() },
    })
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
			init?.method === 'POST' && path === '/lumo/api/agent-presets' ? { id: 'research-expert', name: '研究专家', description: '整理证据并给出结论', owner_user_id: 'palmer', status: 'active', version: '1.0.0', revision: 1, provider: 'openai', model_ref: 'gpt-5', connector_ids: [], knowledge_space_ids: [], max_concurrency: 1, max_budget_cents: 0, timeout_seconds: 3600, max_delegation_depth: 0 } :
        path === '/lumo/api/overview' ? overview :
			path === '/lumo/api/agent-presets' ? { agent_presets: [{ id: 'contract-review', name: '合同复核 Agent', owner_user_id: 'palmer', status: calls.includes('PATCH /lumo/api/agent-presets/contract-review') ? 'disabled' : 'active', version: '1.0.0', revision: calls.includes('PATCH /lumo/api/agent-presets/contract-review') ? 2 : 1, provider: 'openai', model_ref: 'gpt-5', connector_ids: ['crm'], knowledge_space_ids: ['legal'], max_concurrency: 2, max_budget_cents: 0, timeout_seconds: 3600, max_delegation_depth: 0 }] } :
			path === '/lumo/api/workers' ? { workers: [{ worker_id: 'agent:contract-review', worker_kind: 'agent', display_name: '合同复核 Agent', status: 'active', runtime_status: 'active', active_tasks: 1, max_concurrency: 2, load: .5, eligible: true }] } :
        path === '/lumo/api/projects/growth/automations' ? { automations: [{ automationId: 'release-check', projectId: 'growth', triggerKind: 'event', triggerSpec: 'release.ready', flowRef: 'launch-flow', enabled: true }] } :
        path === '/lumo/api/flows/launch-flow/runs' ? { runs: [{ id: 12, trigger_id: 8, automation_id: 'release-check', flow_id: 'launch-flow', flow_version: 2, status: 'failed', output_available: false, error: 'upstream unavailable', started_at: '2026-08-31T00:00:00Z', finished_at: '2026-08-31T00:00:01Z' }] } :
        path === '/lumo/api/skills/demos/upstream?skill=open-design' ? { available: true, gallery: { skill: 'open-design', title: 'OpenDesign 演示', source: 'https://github.com/nexu-io/open-design/blob/main/docs/i18n/README.zh-CN.md#演示', fetchedAt: '2026-09-03T00:00:00Z', collections: [
          { id: 'open-design:1', title: '原型——Web · 桌面 · 移动端', description: '默认输出面。', category: '原型——Web · 桌面 · 移动端', tags: [], cover: '/lumo/api/skills/demos/upstream/asset?url=a', pages: [
            { title: 'Web 原型', description: '带滚动条、KPI、图表的编辑类仪表盘。', url: '/lumo/api/skills/demos/upstream/asset?url=a' },
            { title: '移动端应用原型', description: '三屏游戏化流程。', url: '/lumo/api/skills/demos/upstream/asset?url=b' },
          ], downloads: [] },
          { id: 'open-design:2', title: '实时工件与仪表盘', description: '', category: '实时工件与仪表盘', tags: [], cover: '/lumo/api/skills/demos/upstream/asset?url=c', pages: [
            { title: '实时仪表盘', description: '可编辑的 KPI 大屏。', url: '/lumo/api/skills/demos/upstream/asset?url=c' },
          ], downloads: [] },
        ] } } :
        path === '/lumo/api/skills/demos/upstream?skill=ppt-master' ? { available: true, gallery: { skill: 'ppt-master', title: 'PPT Master 示例库', source: 'https://hugohe3.github.io/ppt-master-examples/', fetchedAt: '2026-09-03T00:00:00Z', collections: [
          { id: 'ppt169_pritzker_2026_quick', title: 'Pritzker 2026 (Quick)', description: '2026 普利兹克大师季 — 8 座新作深读', category: 'Architecture Editorial', tags: ['editorial', 'Architecture'], cover: '/lumo/api/skills/demos/upstream/asset?url=thumb', pages: [
            { title: 'cover', description: '2026 普利兹克奖大师季', url: '/lumo/api/skills/demos/upstream/asset?url=p1' },
            { title: 'timeline', description: '一年之内，八座大师新作接连揭幕', url: '/lumo/api/skills/demos/upstream/asset?url=p2' },
            { title: 'toc', description: '目录', url: '/lumo/api/skills/demos/upstream/asset?url=p3' },
          ], downloads: [{ label: '下载 PPTX', url: 'https://hugohe3.github.io/ppt-master-examples/examples/ppt169_pritzker_2026_quick/exports/pritzker_2026_quick.pptx' }] },
          { id: 'ppt169_swiss_grid_systems', title: 'Swiss Grid Systems', description: '瑞士网格', category: 'Swiss Editorial', tags: ['editorial'], cover: '/lumo/api/skills/demos/upstream/asset?url=thumb2', pages: [{ title: 'cover', description: '', url: '/lumo/api/skills/demos/upstream/asset?url=s1' }], downloads: [] },
        ] } } :
        path === '/lumo/api/skills/demos' ? { complete: true, demos: [
          { id: 'ppt-master:deck:中国电信', skill: 'ppt-master', title: '中国电信', summary: '克制的红灰品牌视觉', kind: 'image', url: '/lumo/api/skills/demos/asset?skill=ppt-master&path=templates%2Fdecks%2F%E4%B8%AD%E5%9B%BD%E7%94%B5%E4%BF%A1%2Ftemplates%2F01_cover.svg' },
          { id: 'archify:example:dataflow-product-analytics.html', skill: 'archify', title: 'dataflow product analytics', summary: '技能自带的 HTML 示例', kind: 'html', url: '/lumo/api/skills/demos/asset?skill=archify&path=examples%2Fdataflow-product-analytics.html' },
        ] } :
        path === '/lumo/api/skillhub/catalog' ? skillhubCatalog :
        path.startsWith('/lumo/api/skillhub/search') ? (path.includes('kind=pack')
          ? { kind: 'pack', q: '', category: '', source: 'seed', total: 1, page: 1, pageSize: 24, skills: [], packs: [skillhubCatalog.packs[0]!], plugins: [] }
          : { kind: 'skill', q: '', category: '', source: 'seed', total: 1, page: 1, pageSize: 24, skills: [skillhubCatalog.skills[0]!], packs: [], plugins: [] }) :
        init?.method === 'POST' && path === '/lumo/api/skillhub/install' ? { ...skillhubCatalog, installed: { skills: ['tencent-docs'], packs: ['automation-testing'], plugins: ['modlens'], commands: { 'skill:tencent-docs': ['docs-live'], 'pack:automation-testing': ['automation-testing'] } } } :
        path === '/lumo/api/skills' ? { complete: true, skills: [
          { name: 'open-design', description: '以产物优先的方式创建、完善、预览并导出真实设计产物。', whenToUse: '适用于原型、落地页、看板和视觉升级。', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'lumo-open-design' },
          { name: 'ppt-master', description: '从主题、文档或现有模板生成、编辑和增强原生可编辑 PPTX。', whenToUse: '适用于演示文稿生成、模板填充和原生 PPTX 编辑。', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'lumo-creative-skills' },
          { name: 'archify', description: '架构图与数据流的视觉化设计', invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'lumo-local-snapshot' },
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
      // 集群版服务端对 vault 知识源统一回 501（见 lumo-ui/src/index.ts 的 vault/status 分支），
      // 客户端吃 501 后按「无 vault 档」渲染来源目录；模拟它，否则走不了非 vault 分支。
      if (path === '/lumo/api/knowledge/vault/status') {
        return new Response(JSON.stringify({ error: 'vault 知识源未装配（集群版不适用）' }), { status: 501, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('mounts the requested product navigation without putting creative plugins in the sidebar', async () => {
    const registered = mountLumo()

    const entries = registered.filter(item => item.name === 'sidebar.navigation')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    expect(entries.map(item => item.id)).toEqual(['lumo-navigation'])
    // 品牌名槽由 Lumo 占下产品名，避免外壳回退到「DSH 本地构建」文案。
    expect(registered.some(item => item.name === 'sidebar.brand.name')).toBe(true)
    expect(overlay).toBeDefined()
    const Overlay = overlay!.Component

    render(<div>{entries.map(({ id, Component }) => <Component key={id} wide />)}<Overlay /></div>)
    const navigation = screen.getByRole('navigation', { name: 'Lumo 功能菜单' })
    expect(within(navigation).getAllByRole('button').map(button => button.textContent)).toEqual([
      '资料库', '技能中心', '项目', '更多应用 · 灵感',
    ])
    expect(within(navigation).queryByRole('button', { name: '开放设计' })).toBeNull()
    expect(within(navigation).queryByRole('button', { name: 'PPT 生成' })).toBeNull()

    fireEvent.click(within(navigation).getByRole('button', { name: '项目' }))
    expect(await screen.findByText('用量计量')).toBeTruthy()
    expect((await screen.findAllByText('合同复核 Agent')).length).toBeGreaterThan(0)
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

    fireEvent.click(within(navigation).getByRole('button', { name: '技能中心' }))
    // 技能与专家拆分后，从「技能」页进入已安装技能治理。
    fireEvent.click(await screen.findByRole('tab', { name: /技能/ }))
    fireEvent.click(await screen.findByRole('button', { name: '管理已安装技能' }))
    // 技能名经 localizedSkillName 落地;断言渲染出的中文名,证明 /lumo/api/skills 的响应真驱动了这块
    expect(await screen.findByText('架构与调度图')).toBeTruthy()
    const spotlight = document.querySelector<HTMLElement>('.lumo-skill-card')!
    fireEvent.pointerMove(spotlight, { clientX: 40, clientY: 30 })
    expect(spotlight.style.getPropertyValue('--spot-x')).not.toBe('')
    fireEvent.change(screen.getByRole('textbox', { name: '技能名称' }), { target: { value: 'campaign-review' } })
    fireEvent.change(screen.getByRole('textbox', { name: '技能版本内容' }), { target: { value: '# Campaign review\nReview the launch plan.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存技能草稿' }))
    expect(await screen.findByText(/内容已进入治理目录/)).toBeTruthy()
    expect(calls.some(call => call === 'POST /lumo/api/governance/skills')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '连接器管理' }))
    expect(await screen.findByText('订单中台')).toBeTruthy()
    expect(calls.some(call => call === 'GET /lumo/api/connectors?includeDisabled=true')).toBe(true)

    // ClickSpark 已退化为纯包装（不再渲染 .lumo-spark 动画元素）：确认指针事件可穿透、组件不崩溃。
    fireEvent.pointerDown(screen.getByText('订单中台'), { clientX: 120, clientY: 80 })
    for (const path of ['/lumo/api/knowledge/query', '/lumo/api/skills', '/lumo/api/governance', '/lumo/api/overview']) {
      expect(calls.some(call => call.includes(path))).toBe(true)
    }

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

  it('hides 项目/资料库/更多 in the local standalone sidebar', async () => {
    const registered = mountLumo()
    const entry = registered.find(item => item.name === 'sidebar.navigation')
    const Navigation = entry!.Component
    // 单机版（deployment.mode=local，桌面本地 runtime）不显示服务端工作台与资料库
    // 入口：左侧只保留技能中心。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      generatedAt: new Date().toISOString(),
      deployment: { mode: 'local', label: '本地单机', storage: 'sqlite', middleware: [], distributed: false, desktop: true, clusterReady: false, clusterOnly: false },
      services: {}, cluster: { nodes: [] }, projects: [], flows: [], connectors: [], plugins: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<Navigation wide />)
    const navigation = screen.getByRole('navigation', { name: 'Lumo 功能菜单' })
    await waitFor(() => expect(within(navigation).getAllByRole('button').map(button => button.textContent)).toEqual(['技能中心']))
    expect(within(navigation).queryByRole('button', { name: '项目' })).toBeNull()
    expect(within(navigation).queryByRole('button', { name: '资料库' })).toBeNull()
    expect(within(navigation).queryByRole('button', { name: '更多' })).toBeNull()
  })

  it('separates experts from skills and supports creating an expert', async () => {
    const registered = mountLumo()
    const entry = registered.find(item => item.name === 'sidebar.navigation')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    const Entry = entry!.Component
    const Overlay = overlay!.Component
    const Dock = registered.find(item => item.name === 'conversation.hero.composer.dock')!.Component
    const setDraft = vi.fn()
    render(<><Entry wide /><Overlay /><Dock inputActions={{ setDraft, submit: vi.fn() }} /></>)

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Lumo 功能菜单' })).getByRole('button', { name: '技能中心' }))
    // 默认专家 tab：专属专家与 SkillHub 专家模板分区显示。
    expect(await screen.findByText('我的专家')).toBeTruthy()
    expect(await screen.findByText('专家模板')).toBeTruthy()
    expect(screen.getByText('合同复核 Agent')).toBeTruthy()
    expect(screen.getByText('自动化测试')).toBeTruthy()
    expect(calls.some(call => call === 'GET /lumo/api/skillhub/catalog')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '＋ 新建专家' }))
    fireEvent.change(screen.getByRole('textbox', { name: '专家名称' }), { target: { value: '研究专家' } })
    fireEvent.change(screen.getByRole('textbox', { name: '职责说明' }), { target: { value: '整理证据并给出结论' } })
    fireEvent.click(screen.getByRole('button', { name: '创建专家' }))
    expect(await screen.findByText(/专家「研究专家」已创建/)).toBeTruthy()
    expect(calls.some(call => call === 'POST /lumo/api/agent-presets')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '添加专家' }))
    expect(calls.some(call => call === 'POST /lumo/api/skillhub/install')).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: '在对话中使用 自动化测试' }))
    expect(setDraft).toHaveBeenLastCalledWith('/automation-testing ')

    // 技能 tab 只呈现单项技能及安装动作。
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Lumo 功能菜单' })).getByRole('button', { name: '技能中心' }))
    fireEvent.click(screen.getByRole('tab', { name: /技能/ }))
    expect(await screen.findByText('腾讯文档 TENCENT DOCS')).toBeTruthy()
    expect(screen.getByText('下载 71.9万')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByText('已安装')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /在对话中使用 腾讯文档/ }))
    expect(setDraft).toHaveBeenLastCalledWith('/docs-live ')
  }, 15000)

  it('keeps the home composer clean and opens creative workbenches only through /design and /ppt', async () => {
    const { registered, sources } = mountLumoWithSources()

    const dock = registered.find(item => item.name === 'conversation.hero.composer.dock')
    const overlay = registered.find(item => item.name === 'shell.overlay')
    expect(dock).toBeDefined()
    expect(overlay).toBeDefined()
    const Dock = dock!.Component
    const Overlay = overlay!.Component
    let draft = ''
    const submitted: string[] = []
    const inputActions = {
      setDraft: (text: string) => { draft = text },
      submit: () => { submitted.push(draft) },
    }

    const { container } = render(<><Dock inputActions={inputActions} /><Overlay /></>)
    // 首页不再常驻创作工作台：没有「创作能力」导航，也没有任何样例卡片。
    expect(screen.queryByRole('navigation', { name: '创作能力' })).toBeNull()
    expect(screen.queryByText('创作工作台')).toBeNull()
    expect(container.querySelector('.lumo-home-creative')).toBeNull()

    // 创作入口登记进原生 `/` 菜单。
    const lumo = sources.find(source => source.trigger === '/' && source.name === 'lumo')
    expect(lumo).toBeDefined()
    expect((await lumo!.candidates({}, { query: '' })).map(item => item.name)).toEqual(['design', 'ppt'])
    expect((await lumo!.candidates({}, { query: 'p' })).map(item => item.name)).toEqual(['ppt'])
    expect(await lumo!.matchEnter({}, '/goal 别的命令')).toBeUndefined()
    expect(lumo!.onPick({ candidate: { name: 'unknown' } })).toBeUndefined()

    const design = await lumo!.matchEnter({}, '/design 为新品准备一个审批流')
    expect(design?.claim.token).toBe('/design')
    expect((await design!.claim.submit('为新品准备一个审批流')).kind).toBe('success')
    expect(await screen.findByRole('heading', { name: '开放设计' })).toBeTruthy()
    const prompt = screen.getByRole('textbox', { name: '开放设计创作意图' }) as HTMLTextAreaElement
    expect(prompt.value).toBe('为新品准备一个审批流')
    // OpenDesign 官方示例：README「演示」章节的每张截图都是一张卡片，可按小节筛选、逐张查看。
    const designGallery = await screen.findByRole('region', { name: 'OpenDesign 官方示例' })
    expect(within(designGallery).getAllByRole('button', { name: /^查看样例：/ })).toHaveLength(3)
    fireEvent.click(within(designGallery).getByRole('button', { name: '原型——Web · 桌面 · 移动端' }))
    expect(within(designGallery).getAllByRole('button', { name: /^查看样例：/ })).toHaveLength(2)
    fireEvent.click(within(designGallery).getByRole('button', { name: '查看样例：Web 原型' }))
    const designViewer = await screen.findByRole('dialog', { name: '样例：原型——Web · 桌面 · 移动端' })
    expect(within(designViewer).getByText('1 / 2')).toBeTruthy()
    expect(within(designViewer).getByRole('img', { name: 'Web 原型' }).getAttribute('src')).toBe('/lumo/api/skills/demos/upstream/asset?url=a')
    fireEvent.keyDown(designViewer, { key: 'ArrowRight' })
    expect(within(designViewer).getByText('2 / 2')).toBeTruthy()
    expect(within(designViewer).getByRole('img', { name: '移动端应用原型' })).toBeTruthy()
    // 查看器里的 Esc 只关自己，工作台还在。
    fireEvent.keyDown(designViewer, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^样例：/ })).toBeNull())
    expect(screen.getByRole('heading', { name: '开放设计' })).toBeTruthy()
    fireEvent.click(within(designGallery).getByRole('button', { name: '查看样例：移动端应用原型' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: /^样例：/ })).getByRole('button', { name: '以此样例创建' }))
    expect(prompt.value).toContain('参考 OpenDesign 官方示例「移动端应用原型」（原型——Web · 桌面 · 移动端）：三屏游戏化流程。')
    // 本地技能示例仍保留为第二组：真实文件渲染成 <img>/<iframe>，而不是 CSS 假预览。
    const htmlDemo = await screen.findByRole('button', { name: '使用原生示例：dataflow product analytics' })
    expect(htmlDemo.querySelector('iframe')?.getAttribute('src')).toContain('/lumo/api/skills/demos/asset?skill=archify')
    expect(container.querySelector('.lumo-design-preview')).toBeNull()
    fireEvent.click(htmlDemo)
    expect(prompt.value).toContain('参考「dataflow product analytics」这个原生示例')
    fireEvent.click(screen.getByRole('tab', { name: '选择开放设计类型：线框图' }))
    fireEvent.change(prompt, { target: { value: '为新品准备一个审批流' } })
    fireEvent.click(screen.getByRole('button', { name: '发送到 OpenDesign' }))
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('/archify 在项目「Lumo Desktop」中使用「架构与调度图」能力创建线框图。为新品准备一个审批流')
    await waitFor(() => expect(screen.queryByRole('heading', { name: '开放设计' })).toBeNull())

    const ppt = lumo!.onPick({ candidate: { name: 'ppt' } })
    expect(ppt?.claim.token).toBe('/ppt')
    await ppt!.claim.submit('面向研发团队，控制在 15 分钟。')
    expect(await screen.findByRole('heading', { name: 'PPT 生成' })).toBeTruthy()
    const pptPrompt = screen.getByRole('textbox', { name: 'PPT 对话输入' }) as HTMLTextAreaElement
    expect(pptPrompt.value).toBe('面向研发团队，控制在 15 分钟。')
    // PPT Master 官方示例：完整项目卡片，点开可逐页翻看全部幻灯片并下载 PPTX。
    const pptGallery = await screen.findByRole('region', { name: 'PPT Master 官方示例' })
    expect(within(pptGallery).getAllByRole('button', { name: /^查看样例：/ })).toHaveLength(2)
    fireEvent.click(within(pptGallery).getByRole('button', { name: 'Architecture Editorial' }))
    expect(within(pptGallery).getAllByRole('button', { name: /^查看样例：/ })).toHaveLength(1)
    fireEvent.click(within(pptGallery).getByRole('button', { name: '查看样例：Pritzker 2026 (Quick)' }))
    const deckViewer = await screen.findByRole('dialog', { name: '样例：Pritzker 2026 (Quick)' })
    expect(within(deckViewer).getByText('1 / 3')).toBeTruthy()
    expect(within(deckViewer).getAllByRole('tab')).toHaveLength(3)
    fireEvent.click(within(deckViewer).getByRole('tab', { name: '第 3 页：toc' }))
    expect(within(deckViewer).getByText('3 / 3')).toBeTruthy()
    fireEvent.click(within(deckViewer).getByRole('button', { name: '下一页' }))
    expect(within(deckViewer).getByText('1 / 3')).toBeTruthy()
    expect(within(deckViewer).getByRole('link', { name: '下载 PPTX' }).getAttribute('href')).toContain('pritzker_2026_quick.pptx')
    fireEvent.click(within(deckViewer).getByRole('button', { name: '用这个样例生成' }))
    expect(pptPrompt.value).toBe('#演示文稿生成 参考 PPT Master 官方示例「Pritzker 2026 (Quick)」（Architecture Editorial，共 3 页，当前看的是「cover」）：2026 普利兹克大师季 — 8 座新作深读。面向研发团队，控制在 15 分钟。')
    fireEvent.click(screen.getByRole('button', { name: '发送到 PPT Master' }))
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toContain('/ppt-master 在项目「Lumo Desktop」中，使用「演示文稿生成」样例生成原生可编辑 PPTX。')
    expect(submitted[1]).toContain('参考 PPT Master 官方示例「Pritzker 2026 (Quick)」（Architecture Editorial，共 3 页，当前看的是「cover」）：2026 普利兹克大师季 — 8 座新作深读。')
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

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Lumo 工作区菜单' })
    const search = within(palette).getByRole('textbox', { name: '搜索工作区' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })
    expect(palette.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lumo 工作区菜单' })).toBeNull())
    expect(workbench.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
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
