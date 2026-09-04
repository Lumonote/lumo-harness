# 资料库面板缺口补齐 + 单机版 Obsidian Vault 知识源设计说明

- 日期：2026-09-04
- 前置：`architecture.md` §5.4（向量检索与知识库）/ §5.4.7（协作共享编辑）；
  `plugin-feature-maturity-audit.md` 资料库行与「查看来源详情 ↗ 不可点」证据；
  `2026-09-03-project-scope-sidebar-and-skillhub-paging-design.md` §4 的「知识空间筛选条」预留；
  已在产事实：`dsh-plugins/knowledge`（PG/Milvus 双 Provider + rerank + 评测）、
  `dsh-plugins/lumo-ui` 的 KnowledgeSurface（查询 + 来源 CRUD 表单）、
  collaborator（Yjs 协作 + publish/outbox）、projects（`project_spaces`）
- 状态：设计已与原定方向确认（缺口 1；单机版 = Obsidian Vault 为源 + 插件构建；
  检索档位 = 关键词（sqlite FTS5）默认，嵌入档位为后续切片）

---

## 0. 定位：把审计里「资料库只有查询」补齐，且两版分型

匹配度审计指出资料库现状本质是「查询已发布片段」，必须补齐：空间/来源管理、索引健康、
来源详情和打开原文；「查看来源详情 ↗」当前是 `<span>` 死链接（`lumo-ui/src/client/index.tsx`
KnowledgeSurface 的 hit footer）。

用户拍板的分型（v1 决策）：

| 维度 | 集群版（Standalone/Cluster） | 单机版（Local Desktop） |
|------|------|------|
| 知识源 | PG(Milvus) + 埋入/协作发布 | **Obsidian Vault**（md 文件 + frontmatter） |
| 构建 | 面板来源 CRUD / collaborator publish → outbox | **Obsidian 插件**扫描并触发本机构建 |
| 检索 | 向量（rerank/评测不变） | **sqlite FTS5 关键词**（零新依赖；嵌入档为后续切片） |
| 服务形态 | 远程 seam + 管理 API（现有） | 桌面 runtime 内新插件（`@lumo/knowledge-vault`） |

**本轮四件事（统一 UI 骨架，两版共用）**：

1. 来源详情可点 + 打开原文
2. 知识空间筛选条（面板内，含空间归属显示）
3. 索引健康摘要（来源级徽标 + 顶部汇总）
4. 无源态提示（Milvus 投影形态 / vault 未配置）

## 1. 现状事实（核对后的基线）

- **桌面 local 模式当前不挂任何知识库**：`data-plane/dsh-node/src/index.ts`
  （`localMode ? localStorageRows(...) : ...`）里 `lumo-knowledge` 只在非 local 分支；`lumo-ui`
  服务器注释亦写明 Local Desktop 只连原生 DSH Web server。→ 单机版不是改现状，是补缺。
- 集群版「无源态」已存在一半：`lumo-ui/src/index.ts` 的 `requireKnowledgeAdmin` 对 Milvus 投影
  形态返回 501「unavailable for the configured vector provider」——但 UI 没有针对性提示，
  只把它并进普通 `sourcesError`。
- 空间数据已可拿：projects 服务 `project_spaces`（space_id/project_id/realm/name），dashboard
  `spaces` 字段已下发；`KnowledgeSourceSummary.space` 已有（PG 侧）。
- `KnowledgeHit` 没有 `space` 字段；`2026-09-03` 侧栏 spec 已定「检索接口不改」——
  本轮空间筛选只作用于**来源列表**（listSources 本地过滤），检索结果不过滤（遵守该 spec）。

## 2. 单机版：Obsidian Vault 为源 + 插件构建

### 2.1 形态

```
Obsidian 插件（新增）                      桌面 dsh runtime（local 模式）
┌────────────────────────────┐          ┌──────────────────────────────┐
│ 设置：Lumo 入口(127.0.0.1:  │  HTTP    │ @lumo/knowledge-vault（新插件）│
│  3080) + token             │ ──────▶  │   KnowledgeSeam（sqlite 索引） │
│ 命令：同步到 Lumo 知识库     │          │   FTS5 关键词检索              │
│ 状态：上次同步/文件数/错误   │ ◀──────  │   Sources/query API（面板用）  │
└────────────────────────────┘          └──────────────────────────────┘
```

- **真相源 = vault 本体**。sqlite 里只存索引（doc 元数据 + FTS 分块），删除即删索引，
  不存在第二份内容拷贝（对齐 §5.4「原文与权威元数据永远在源」单机投影）。
- **插件在 vault 内**（`platform/obsidian-vault-source/` 独立工程，`main.ts` + `manifest.json`，
  esbuild 出 `main.js`；用户安装到 `.obsidian/plugins/lumo-vault-source/`）。职责只有三个：
  配置、显式「同步」触发、状态展示。扫描/分块/索引在 dsh 侧插件里做（模型与节流在 Node 侧可控）。
- **桌面 local 模式挂载** `@lumo/knowledge-vault`，`realm` 固定 `'local'`（单用户、无租户，
  不引入 realm 语义）；面板/查询 API 复用现有 `/lumo/api/knowledge/*` 路由（manager 运行时检测，
  与集群版同一契约面）。

### 2.2 索引语义（`@lumo/knowledge-vault`）

| 概念 | 映射 |
|------|------|
| doc_id | `base64url(vault 相对路径)`——路由 `/lumo/api/knowledge/sources/{docId}` 只接受 `[^/]+`，
  相对路径含 `/` 会破路由；base64url 保证 URL/路由安全且稳定可逆。人读的路径走
  vault 专属 summary 子集的 `path` 字段（不污染共享契约；UI 显示路径而非哈希） |
| space | 一级文件夹名；无 frontmatter 的根文件 = `general`；`space: <id>` frontmatter 可覆盖 |
| title | frontmatter `title` ?? 文件名 |
| sourceVersion | 内容最后修改的 Unix 秒（number，`KnowledgeSourceManager` 契约是 number）。
  同秒覆盖重写属单用户罕见情形，接受（哈希语义后续切片再做——显式记录为欠账） |
| chunk | 按 `## `/`# ` 标题切块；无标题整篇一块；纯文本分块策略见欠账清单 |
| 检索 | `sqlite` FTS5 中文分词（unicode61 + token 化按字符），BM25 排序，按 space 过滤，topK |
| scope | 恒 `published`（vault 文件=用户已定稿；`draft` 不支持——文档注明） |
| 删除同步 | 文件删除/移动 → `removeSource`（tombstone 语义同集群最小版：删索引即可） |
| realm 隔离 | 单机只有一个 realm `local`；其它 realm 查询返回空（对齐契约断言，尽管无多租户场景） |

**不为 vault provider 跑共享契约测试**（`assertKnowledgeContract`）：那是多租户（realm-a/b）与
「重建= 从源全量回放」的生产语义，单机 vault 无租户且「重建= 重扫 vault」。单机给
**自己的行为测试**（doc↔path、space 映射、FTS 命中、deleted 同步、vault 缺失 fail-closed）。
契约注释写明适用范围，防止将来误把 vault provider 投进共享契约套房。

**检索档位降级（与 §20 对称）**：

- 档位 A `keyword`（默认）：FTS5；不配置任何模型即此档。面板徽标显示「关键词检索引擎」。
- 档位 B `embedding`：预留配置面（`embedding.baseUrl/model`），检测到本机 TEI/模型即启用；
  本轮只做「检测 + 状态显示」，不捆绑模型（捆绑小模型是独立切片，见欠账）。
- 不可用 = fail-closed（vault 路径不存在/无读取权限 → `CapabilityUnavailable`，不伪造空列表）。

### 2.3 存储与依赖

- 存储：`node:sqlite`（v24.19.0 内置，零新原生依赖）+ FTS5；库文件
  `$LUMO_RUNTIME_STATE_DIR/knowledge-vault.sqlite`（随 DSH_HOME 走）。
  ⚠️ FTS5 是否为该构建启用需在实现首步以单测验证；若未启用，降级 `LIKE '%…%'` 全文扫描
  并保留 FTS5 开关（实现期内定，测试先行的判据）。
- 插件包不新增 gem/native 依赖；Obsidian 插件用官方 API + `obsidian-uri` 协议。

### 2.4 本地 API 扩展（仅 local 模式挂载）

```
GET  /lumo/api/knowledge/vault/status     # vault 路径、上次扫描时间、文件数、chunk 数、档位、最后错误
POST /lumo/api/knowledge/vault/sync       # 强制重扫（插件按钮触发；幂等，可并发防抖）
```

`/lumo/api/knowledge/sources`、`/query` 复用现有路由，manager 由 vault provider 提供。

### 2.5 面板增强（两版共用，单机版差异注明）

- **来源详情抽屉**：点击来源行（及查询起的「查看来源详情 ↗」）打开抽屉而不是回显三个字段：
  docId、空间、版本、嵌入模型/档位、chunk 数、更新时间 + chunk 全文预览；
  集群版数据来自 `getSource`（已有），单机版来自 sqlite 索引。
- **打开原文**：集群版 = 抽屉内「整篇预览」（chunks 拼接只读视图；§5.4.6 MinIO 原文桶是欠账，
  本轮不建桶——**显式命名**）；单机版 = `obsidian://open?vault=<name>&file=<path>`
  （Mac/Linux/Windows 均支持该 URI；url-encode）。
- **空间筛选条**：面板顶部 chip 条，选项 = 当前项目 dashboard `spaces`（集群）；
  单机版 = vault 一级文件夹列表（来自 vault status）；选中后对来源列表本地过滤（检索接口不改）。
- **索引健康摘要**：来源行徽标（chunk 数 / vN / 模型或「关键词档」/ 时间）+ 顶部汇总条
  （来源数、总 chunk 数、档位、最后构建时间、错误）。
- **无源态提示**：
  - Milvus/远程投影（`sourceManager` 检测到 501/缺能力）：面板顶部明确提示
    「当前投影引擎不支持来源管理；来源管理与重建由集成侧提供」，隐藏来源管理表单，
    查询区照常可用。
  - 单机 vault 未配置：提示配置 vault 路径（插件或面板设置里提供路径输入）。
- 错误区分（顺手收口）：`optionalApi` 吞 401/403/503 为空的旧习，本轮在知识面板改为
  「无数据 / 无权限 / 引擎不支持」三类明确态（`knowledgeManagementStatus` 已能区分 409/501）。

## 3. 集群版：不动契约与 Provider

- `shared/seam-contracts/knowledge.ts`、PG/Milvus Provider、rerank/eval **零改动**；
  契约测试必须全绿（这是边界成立的证明——任何契约改动说明能力被错误下沉）。
- 面板增强全部走现有管理 API；空间筛选基于 dashboard `spaces`（不新建接口）。
- Milvus 形态：管理 API 已 501，配 2.5 的明确提示态即闭环。

## 4. 文件清单

新增：

- `platform/dsh-plugins/knowledge-vault/`（provider：VaultKnowledgeProvider + FTS5 索引 +
  分块 + vault status/sync API 装配）
- `platform/dsh-plugins/knowledge-vault/__tests__/`（doc↔path/space 映射、分块、FTS 命中、
  删除同步、fail-closed、sync 幂等；FTS5 可用性测试）
- `platform/obsidian-vault-source/`（Obsidian 插件工程：manifest.json + main.ts +
  esbuild 构建脚本 + README）
- `platform/dsh-plugins/lumo-ui` 内：来源详情抽屉、空间筛选条、健康摘要、无源态、
  vault status/sync 面板（local）
- `platform/data-plane/dsh-node/src/index.ts`：local 分支挂载 `lumo-knowledge-vault` +
  `/lumo/api/knowledge/vault/*` 路由（仅 local）
- `platform/shared/seam-contracts/`：不改；`knowledge-vault` 包内声明自己的 ManagerSeam 子集
  （`VaultSourceSummary` 等），避免污染共享契约。

修改（最小）：

- `platform/dsh-plugins/lumo-ui/src/index.ts`：vault 路由注册（local 条件）+ 无源态区分
- `platform/dsh-plugins/lumo-ui/src/client/index.tsx`：KnowledgeSurface 面板增强

## 5. 验收标准

1. 集群版：`shared/seam-contracts/knowledge.ts` 与 PG/Milvus provider、rerank/eval **零改动**，
   契约测试全绿；`pnpm run kb:eval` 不受影响。
2. 来源详情可点：点击后抽屉展示四类信息 + 全文预览（集群）/ 原文打开按钮（单机，`obsidian://`）。
3. 空间筛选：集群版按 dashboard spaces 过滤来源列表；单机版按文件夹过滤；检索接口调用零变化。
4. 索引健康摘要正确显示（来源徽标 + 汇总 + 档位「关键词检索引擎」）。
5. Milvus 投影形态：明确「引擎不支持来源管理」提示且查询可用（既有契约测试已覆盖 Provider 行为，
   本项为 UI 测试）。
6. 单机版：vault 覆盖层单测（FTS 命中/删除同步/路径映射/fail-closed）+ 面板 UI 测试；
   `obsidian://` 命令用 URL 编码断言（不真开 Obsidian）。
7. `deepseek-harness/` 未被修改：`git -C deepseek-harness describe --tags --dirty` 无 `-dirty`，
   `git status --porcelain -uno` 为空。

## 6. 显式命名的不做清单（欠账，不假装）

| 欠账 | 归属 |
|------|------|
| 本地嵌入档位（捆绑小模型、向量索引、评测） | 独立切片；本轮只做档位检测与显示 |
| vault 版本语义用内容哈希（当前为 mtime 秒） | 随嵌入切片刻 |
| §5.4.6 MinIO 原文桶（集群「打开原文」= 整篇预览而非链接原文） | 独立切片 |
| 来源版本链/回滚 UI（审计第 4 项） | 后续切片 |
| 采集进度（outbox 回放状态可见化，审计第 3 项） | 后续切片 |
| Space 级权限（read/edit/comment/publish，§5.4.7.1） | 权限层大项，另立设计 |
| collaborator 发布 → 知识索引的状态衔接 | 随采集进度切片 |

## 7. 风险

| 风险 | 影响 | 应对 |
|------|------|------|
| node:sqlite 未启用 FTS5（或 SQLite 版本差异） | 单机检索退化为 LIKE | 实现首步单测验证；不达标降级 LIKE 并显式声明档位标签 |
| Obsidian 插件与桌面 runtime 双向鉴权 | 插件拿错 token 拉空/越权 | 插件设置里标题化 token（复用桌面 handoff token 文件路径），本地回环+短 token |
| vault 文件量大（>1k md）时首次同步慢 | 构建体验差 | sync 限流 + stats（文件数/耗时）展示；单文件楔入进度后续切 |
| 面板「打开原文」在无 Obsidian 环境静默无效果 | 用户困惑 | 单机面板提供配置态（确认 Obsidian 已安装）；URI 失败给错误提示 |
