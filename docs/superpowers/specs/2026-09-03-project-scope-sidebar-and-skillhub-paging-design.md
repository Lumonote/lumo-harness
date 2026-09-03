# 项目上下文、左侧菜单重构与技能市场分页 — 设计

日期：2026-09-03  
范围：`platform/dsh-plugins/lumo-ui`（客户端 `src/client/index.tsx`、`src/client/lumo.css`，服务端 `src/index.ts`、`src/skillhub.ts`，测试 `__tests__/`）  
约束：不触碰 `deepseek-harness/`；只使用已注册的 `sidebar.navigation`、`conversation.*` 插槽与 `/lumo/api/*` 代理。

## 1. 背景与问题

1. 左侧菜单第一项「项目」打开的是 `OperationsSurface`，实为治理大盘（项目/流程/节点/委派/用户/Agent 预设/Worker），名不副实，且没有"我在哪个项目、切换项目"的能力。
2. 对话输入框左侧的「项目 / 空间」两个 chip 由写死的 `studioProjects` mock 驱动，与真实项目服务（`/lumo/api/projects*`）完全不通；mock 里的「空间」是"创意方向"，与 `architecture.md` §5.4.7 / 术语表中的「知识空间 Space = 项目内文档协作单元」语义冲突。该 scope 目前只被开放设计与 PPT 面板用作装饰文字。
3. 技能市场「插件」页签只显示 20 条且不能翻页。根因：SkillHub `/api/v1/plugins` 使用 `page` + `pageSize`（上限 100）分页并支持服务端 `q` 搜索，而服务端传的 `limit=` 被接口忽略，客户端也没有分页 UI。实测总量 8449。

## 2. 决策（已与用户确认）

| 议题 | 决定 |
|---|---|
| 「当前项目」主入口 | 左侧栏顶部项目切换器；输入框不再放项目 chip |
| 对话内「空间」选择 | 删除；知识空间只在资料库面板内管理与筛选 |
| 治理大盘 | 保留为一级菜单，改名「治理」，内容不动 |

## 3. 项目上下文

### 3.1 数据与状态

- 列表：`GET /lumo/api/overview` 的 `projects`（字段 `id / name / status / realm / createdBy`）。
- 详情：`GET /lumo/api/projects/{id}/dashboard`（`project / yourRole / members / spaces / automations / usage / budget`）。
- 新建：`POST /lumo/api/projects`；归档/恢复：`POST /lumo/api/projects/{id}/(archive|unarchive)`。
- 客户端模块级 store `projectScope`，`useProjectScope()` 通过 `useSyncExternalStore` 暴露 `{ projects, current, state, role }`。
  - `current` 持久化到 `localStorage['lumo.project']`；启动时若持久化 id 不在列表中，回退到第一个活跃项目。
  - `state`: `'ready' | 'loading' | 'unavailable'`。`unavailable` 覆盖项目服务 4xx/5xx 与本地模式（`overview.deployment.mode === 'local'` 且列表为空）。
- 删除 `StudioProject / StudioSpace / StudioScope / studioProjects / studioScope* / useStudioScope`。

### 3.2 ProjectSwitcher 组件

渲染于 `SidebarNavigation` 顶部（同一插槽内，位于菜单按钮之上）。

- **宽侧栏**：卡片显示项目名、状态徽标（活跃 / 已归档）、我的角色（来自 dashboard 的 `yourRole`，未加载时留空）。
- **窄侧栏（rail）**：仅首字母徽标，`title` 为项目名。
- 点击弹出 `role="dialog"` 面板：
  - 搜索框（按名称本地过滤）；
  - 活跃项目列表，选中项标「当前」；已归档项目折叠在「已归档 (n)」下；
  - 「新建项目」：内联输入名称 → `POST /lumo/api/projects` → 刷新列表并切换到新项目；
  - 「项目设置」：打开 `ProjectSettingsPanel`。
- 切换项目：更新 store、写 localStorage、关闭面板。Esc / 点击外部关闭。
- **降级**：`unavailable` 时卡片显示「本地工作区」，无下拉箭头，点击无操作；不弹错误。

### 3.3 ProjectSettingsPanel

以 `shell.overlay` 现有的工作台机制打开（新增 Surface `project`，不进入侧栏菜单，只由切换器触发）。内容复用 `OperationsSurface` 里已有的 dashboard 渲染片段（成员、知识空间、自动化、用量/预算、归档/恢复按钮），抽成独立组件 `ProjectDashboard({ projectId })` 供两处共用；不新增后端接口。

## 4. 左侧菜单与输入框

- `sidebarSurfaces` 改为 `['knowledge', 'automation', 'skillhub', 'operations', 'market']`，即 **资料库 · 自动化 · 技能市场 · 治理 · 更多**。
- `surfaceMeta.operations` 改为 `label: '治理'`, `eyebrow: '治理工作台'`, `short: '治理'`，描述相应调整；图标沿用。
- 项目内导航跟随当前项目：
  - 自动化面板：流程目录与自动化规则按 `projectId === current.id` 过滤，并在标题处显示当前项目名；无当前项目时不过滤。
  - 资料库面板：新增「知识空间」筛选条，选项来自当前项目 dashboard 的 `spaces`；选中后对 `sources` 列表按 `space` 字段本地过滤。检索接口不改。
- 删除 `ComposerScopeControl`、`HeroComposerScopeControl` 及其 `ctx.slots.register` 调用；删除 `.lumo-composer-scope / .lumo-scope-chip / .lumo-scope-popover / .lumo-project-glyph / .lumo-space-glyph / .lumo-scope-dot / .lumo-scope-icon` 及相关动画与响应式规则。
- 开放设计与 PPT 面板中引用 `project.label` / `space.label` 的位置改为 `current?.name ?? '本地工作区'`。

## 5. 技能市场分页

### 5.1 服务端 `skillhub.ts`

- `SkillHubSearchQuery` 新增 `page?: number`；`SkillHubSearchResult` 新增 `page: number; pageSize: number`。
- 插件分支：请求 `${base}/api/v1/plugins?page=${page}&pageSize=${pageSize}` 并透传 `q`（服务端搜索）与 `categoryKey`；`pageSize = clamp(limit, 1, 100)`，默认 60；**不再本地按文本过滤**，只做 `mapPlugin`。`total` 取接口 `total`。
- 技能/专家包分支保持现有逻辑，返回 `page: 1, pageSize: items.length`。
- `refreshCatalog` 的插件首页改为 `?page=1&pageSize=100`。
- 回退分支（网络失败）对本地目录做分页切片，保证返回结构一致。
- 分类过滤验证：实现时用分类字典中的真实 key 请求并比较 `total`；若接口不过滤，插件分支在响应中加 `categoryFiltered: false`，客户端据此显示「分类仅在本页内筛选」并对本页结果本地过滤。

### 5.2 服务端路由 `index.ts`

`/lumo/api/skillhub/search` 解析 `page`（默认 1，非法回 1），传入 `searchCatalog`。

### 5.3 客户端 `SkillHubSurface`

- 新增 `page` state；`tab / debouncedQuery / filter` 任一变化时重置为 1。
- 插件页签：默认浏览态也走 `/search?kind=plugin&page=n`（不再只读缓存目录），这样无搜索词也能翻页。
- 列表底部新增分页条 `lumo-skillhub-pager`：「上一页 · 第 x / y 页 · 下一页」，`y = ceil(total / pageSize)`；边界禁用。
- 顶部计数：插件显示「共 N 个」；技能/专家包保持「热门 N」。

## 6. 测试

客户端 `__tests__/client.spec.tsx`：
1. 切换器渲染 overview 返回的项目，并把 localStorage 中的 id 设为当前；
2. 选择另一项目后 store 更新、localStorage 写入、面板关闭；
3. overview 项目服务 503 时显示「本地工作区」且无弹层；
4. `conversation.input.left` / `conversation.hero.input.left` 不再有 lumo 注册；
5. 侧栏菜单顺序与「治理」标签；
6. SkillHub 插件页签：mock `/search` 返回 `total: 250, pageSize: 60` 时渲染「第 1 / 5 页」，点「下一页」请求 `page=2`。

服务端新增 `__tests__/skillhub-paging.spec.ts`（mock fetch）：
1. 插件查询 URL 含 `page`/`pageSize`，不含 `limit`；`pageSize` 被夹到 100；
2. 返回 `page/pageSize/total` 来自接口；
3. 网络失败回退时按 page 切片本地目录。

## 7. 不做的事

- 不改 dsh 源码、不新增 dsh 插槽。
- 不改知识检索接口的 space 过滤（只做列表本地筛选）。
- 不重构 `OperationsSurface` 内容，只改名并抽出 dashboard 片段复用。
- 不为技能/专家包页签加分页（上游接口不支持）。
