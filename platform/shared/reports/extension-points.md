# 零侵入扩展点核验清单（评审 A5 → 阶段 0 产出）

> 核验基准：`deepseek-harness/` @ `dsh-v0.1.1-rc.2`（只读）。每条给出「支持 / 不支持 / 需扩展动作」+ 证据 + 实现路径。
> 核验方法：源码直读（文件:行）。

| # | 平台设计 | 核验结论 | 证据 | 实现路径 |
|---|---------|---------|------|---------|
| A1 | 跨节点 fork/resume（§4.2「`ctx.sessions.fork()` 的跨节点版」） | **支持（以存档重放实现，非透明迁移）** | `fork()` 是 store 进程内 API（`packages/core/session/src/index.ts:1081`）；但 `CreateSessionOptions.seed: SessionEvent[]`（`types.ts:106`）语义即「replay/fork 历史」；事件记录为 JSON 可序列化（`session/event` append feed 在 `index.ts:66`） | 平台侧：日志档案（PG/MinIO 冷层）→ 读事件序列 → 用 `seed` 构造新 Session。**需要设计注意**：resume 后 `header.seedLength`（types.ts:111）标记 fork 亲缘边界，平台需保留该边界语义 |
| A2 | 计量单截面 `ctx.llm`（§6.4：所有 LLM 调用流经一处） | **支持（且 dsh 原生已提供核算底座）** | ① `llm/stream` 事件瀑布是唯一模型调用截面（`packages/llm/llm/src/index.ts:65`，监听必须 `next()`）；② **dsh 原生 `ctx.tokenMeter`**（`packages/llm/token-meter`，`TokenMeter extends Service`，README：`measure(session)` / `estimateMessage`，`TokenUsageProjection` = uncachedInput/output/cacheRead/cacheWrite） | **设计修订**：dsh 已有 token 核算底座（估算 + 投影 + 会话核算），计量平台=「归因 + 双树预算 + usage_ledger 台账」建立在 `ctx.tokenMeter` 与 `llm/stream` 瀑布之上，不重造估算 —— 已落地 `platform/dsh-plugins/metering`（首 token 前前置拦截 + 流结束扣账） |
| A3 | `session/event` 订阅（多端/复制日志/审计） | **支持** | append feed listener（`packages/core/session/src/index.ts:66`） | 平台在 ctx 上 `ctx.on('session/event', ...)`（或 session event feed）消费广播 |
| A4 | `tools/pre-execute` OPA 挂点（§6.3） | **支持** | 瀑布事件确认：`tools/pre-execute` / `tools/execute` / `tools/post-execute` 序列化（`packages/core/tools/src/invariant.ts:94-110`）、`agent/pre-step`（`packages/core/agent-loop/src/agent.ts:235`）、`agent/turn-stopping` 串行（`agent.ts:296`） | 平台插件挂 `waterfall` 监听（必须 `next()`），按 OPA 决策改写/拒绝 |
| A5 | SeamProxy 远程调用（§4.1） | **需扩展动作（自建传输层）** | seam 是**进程内接口**（TS interface + `declare module` 注入 `Context`，如 `ctx.shell: ShellExecutor`）；无现成「seam RPC 魔法」。唯一相关：dsh 的远程沙箱能力（文档称 fs/subprocess 指向远程沙箱、Bash/PTY/LSP 一并迁移），但其本质是 provider 实现由**沙箱抽象**支撑，而非任意 seam 序列化 | 平台自建：P2 为**每 seam 定义 RPC 契约**（proto）**必须粗粒度**；本地侧 proxy 实现同接口（Consumer 无感）。dsh 的沙箱能力仅作模板，不算免费 |
| A6 | 外部包作为 Cordis 插件挂载（§2/§3.1） | **支持** | plugin = `name + apply(ctx)`（cordis 插件元数据）；裸包经 `cordis.patch.yml` 的 `- id; name: '@deepseek-ai/dsh-*'` 解析（`packages/bundle/headless/cordis.patch.yml`）；官方启动路径 `@deepseek-ai/dsh-app-boot` 的 `boot(binName, configPath, patches?, prepare?, bareModuleBaseUrl?)`（`packages/boot/app-boot/src/index.ts:757`） | **platform 宿主（dsh-node）**：我们维护 `cordis.yml` + `dependencies: link:` 引 dsh 源码包；`boot()` 直接启动。**零侵入：dsh 源码只读、仅作依赖**。待安装后运行验证（非理论） |
| A7 | preset / `isolate` realm（租户） | **支持** | 厂商 API 存在于 loader（`vendor/loader/src/config/isolate.ts`、`preset/agent-presets`） | 平台复用其职责在宿主装配 |

## 需要额外核验的两个务实点（首批运行时验证）

1. **bare plugin 从我们 `platform/` node_modules 解析**：`boot()` 的第 5 参 `bareModuleBaseUrl` 控制裸包解析锚点 —— 第一验证路径：`boot('lumo', '<our>/cordis.yml', undefined, undefined, pathToFileURL('<platform root>/'))` 之后 `pnpm --filter @lumo/example boot` 应出现 `activated entry: lumo-example @ @lumo/example`。
2. **`session/event` 事件名与负载结构**：会话 feed 的精确事件名由 `KNOWN_SESSION_EVENT_TYPES`（`packages/core/session/src/known-event-types.ts`）兜底；**阶段 1 知识库插件订阅时直接以该常量校验**，避免手打串错。

## 裁决综述

- 设计宣称的核心扩展面 **全部成立，零侵入框架可行** —— 但「跨节点 fork」的实现路径（A1）必须按**存档重放**而非「透明迁移」写进阶段 1 计划（评审 R2 恢复契约与此同源）。
- **SeamProxy（A5）是唯一无免费房**：需要为每个 seam 自定义 RPC 契约，且只能粗粒度 —— 佐证评审 R1「seam 远程化边界 + 粗粒度硬规矩」为 P0 且已生效验证。
- A6 的运行验证是阶段 0 的收尾看门人：**通过即证明「外部插件进 dsh」闭环**。
