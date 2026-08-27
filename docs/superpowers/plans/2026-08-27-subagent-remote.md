# 跨节点子代理委派(行 5 切片 1:one-shot spawn) —— TDD 实现计划

**设计说明**:`docs/superpowers/specs/2026-08-26-seam-remote-forms-design.md` §1 行 5 + §2.2
**规范章节**:`architecture.md` §4.1(seam 网络化)/ §6.2(Scheduler 放置)/ §7.1(句柄型 seam 不可跨节点恢复——子代理会话在承载节点本地)
**排序依据**:远程形态设计 §3 P2c(行 5/6/13 互锁组之首;行 6 契约已收账、行 13 依赖本切片)
**前置**:行 5 fork 公开面审计(2026-08-27,design-review A5)——流程是「父侧切片 seed → 承载节点 `SessionStore.create(id, {seed})` 重放」;本切片**不含 seed 传输**(fork 语义),契约为其留位。

---

## Global Constraints

**第一铁律**:`deepseek-harness/` 只读。本切片只 import dsh **公开导出**:`@deepseek-ai/dsh-subagent`(types/`child-agent.ts`/`out-of-process.ts`/`depth.ts`)、`@deepseek-ai/dsh-subagent-in-process-driver`(仅作对照,不 import)、`@deepseek-ai/dsh-agent`(`foldConsumedWork`)、`@deepseek-ai/dsh-session`(`SessionEvent` type)、`@deepseek-ai/cordis`。不改 dsh 一行。

**契约样式对齐 seam-host**(`seam-host/src/server.ts` + `shared/seam-contracts/remote.ts`):
- 身份:`X-Lumo-Realm`(必填)+ `X-Lumo-Seam-Token`(每 realm 共享令牌,`timingSafeEqual`;令牌表空=仅回环匿名,启用即拒绝匿名)。
- 错误闭集复用 `shared/seam-contracts/errors.ts` 的 `SeamError`(`invalid`/`forbidden`/`capabilityUnavailable`);补 `notFound`(承载侧会话不存在)。
- 请求体上限 `maxBodyBytes`(默认 8MiB);参数结构失败即 `invalid`,不返回半截结果。

**域内语义定死**:
- `SubagentRun.localAgent: undefined`(远端 run,`out-of-process.ts` 的 `subprocessRunHandle` 先例)。
- 能力姿态 = `NO_START_CAPABILITIES`(照 `subagent-acp` 先例):`outputSchema`/`depthLimit`/`toolFilter`/`persona` 均不支持,service 层会先拒绝缺能力的请求——**绝不 accept-then-ignore**。
- 承载侧 child 会话的**写者租约经 `@lumo/session-log`**(承载节点进程挂 it):child session 单写者 = 承载节点(与行 2 已落地语义同)。
- **范围外(明写,不做假)**:
  - fork/continuable(seed 传输):契约定契约字段留位,不做传输与重放(`prepareContinuable` 不注册)。
  - 预算联动的放置决策(Scheduler `Pick` 现算法,读预算余量后续切片)。
  - 节点自动登记地址(节点 URL 表为 provider 静态配置,`Node` 结构无地址字段)。
  - 取消经行 6 控制信号通道(本切片用承载侧 `POST /subagent/stop` 直连)。
  - mTLS/OPA、多集群/HA。

**测试纪律**(`architecture.md` §19.5):
- 契约层:纯函数 + 断言(`shared/seam-contracts/__tests__/` 先例,内存 stub 跑断言)。
- Provider 行为:真 HTTP(节点内置 `http` mock server)对打,不 mock `fetch`。
- 承载驱动:真实 dsh `Context` + `mountAgentLoopTestDependencies`(agent-loop-testkit 公开件,dsh fork provider 测试同款)+ `ctx.llm.registerAdapter` 自写 10 行 adapter(无 key 跑真实单 turn)。**不 import dsh 内部测试文件**(MockAdapter 在 `core/agent-loop/tests/`,非公开导出)。
- 本切片无真 PG 用例(承载 child 日志经会话事件流,PG 真相源语义由 `@lumo/session-log` 既有套件覆盖);真 PG 双进程冒烟在 Task 5。

测试命令:`cd platform && <env> ./node_modules/.bin/vitest run <dir>`。
类型检查:`cd platform && pnpm typecheck`(alias 走 tsconfig path)。

---

## Task 1: 设计 + 计划(本文件)

- [ ] 本文件 → 提交:
```bash
git add docs/superpowers/plans/2026-08-27-subagent-remote.md
git commit -m "docs(subagent-remote): 行 5 切片 1 实现计划——父描述/承载面/回执结集"
```

---

## Task 2: 契约 `subagent-host.ts`(红 → 绿)

**Files**:
- Create `platform/shared/seam-contracts/subagent-host.ts`
- Create `platform/shared/seam-contracts/__tests__/subagent-host.spec.ts`

**Interfaces**:
- Produces 契约类型(与 dsh 型**结构等价、不 import dsh**,session-log.ts 先例):

```ts
/** 父会话的可传输描述(替代跨节点不可序列化的 parent: Agent)。 */
export interface ChildParentDescriptor {
  /** 父会话 id(child 的 meta.parentSession)。 */
  readonly sessionId: string
  /** 父会话 header 的 cwd(承载侧的 child 工作区)。 */
  readonly cwd?: string
  /** 父会话持久化的委派深度(承载侧 childDepth = +1;`delegationDepthOf` 的传输形态)。 */
  readonly delegationDepth: number
  /** 父 agent 路由 —— child 继承(照 `resolveChildAgentOptions` 的传输面)。 */
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  /** 照 `captureDelegatedPolicyOverrides` 的序列化面。 */
  readonly sandboxMode?: string
  readonly approvalPolicy?: 'never'
}

/** 承载侧建立远端子代理的确定性输入。 */
export interface StartChildRequest {
  /** 父侧 mint 的 child session id(幂等键:承载侧已存在 → notFound/invalid)。 */
  readonly childId: string
  readonly realm: string
  readonly label?: string
  /** 子代理用户消息内容(模型面 JSON,`ContentBlock[]` 结构等价)。 */
  readonly prompt: unknown[]
  /** 子代理描述(`SubagentDescriptorData` 结构等价;承载侧 append `subagent/descriptor`)。 */
  readonly descriptor: unknown
  readonly parent: ChildParentDescriptor
  /** 完成/中止结果回执端点(承载侧 POST `ChildResultBody`)。 */
  readonly callbackUrl: string
}

export interface StartChildOk {
  ok: true
  readonly childId: string
}
export interface StartChildFail {
  ok: false
  readonly code: string
  readonly message: string
}
export type StartChildResponse = StartChildOk | StartChildFail

/** 回执信封:`ok: false` = 基础设施故障(reject);`ok: true` 内 stopReason 承载 child 结局 */
export interface ChildResultBody {
  readonly runId: string
  readonly ok: boolean
  readonly output?: unknown[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason?: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  readonly code?: string
  readonly message?: string
}
```

- Produces 纯函数(契约锁点):

```ts
/** 结构校验(失败抛 invalid('subagent-host: 原因'))。 */
export function assertStartChildRequest(v: unknown): asserts v is StartChildRequest
/** 结果回执校验(失败抛 invalid)。 */
export function assertChildResultBody(v: unknown): asserts v is ChildResultBody
/** 承载侧运行表键:realm 段隔离(与对象存储键同训:越狱身份重叠即拒绝)。 */
export function runKeyOf(realm: string, childId: string): string
/** child 深度 = 父深度 + 1;非安全整数抛 invalid(与 `resolveChildDepth` 同一理由)。 */
export function childDepthOf(parent: ChildParentDescriptor): number
```

- [ ] 测试(红 → 绿),用例:`assertStartChildRequest` 接受完整/拒绝缺字段与坏形状;`childDepthOf(0→1)`,负数/非整数抛;`runKeyOf` realm 隔离;`assertChildResultBody` 接受终端词表内 stopReason、拒绝词表外;`StartChildOk`/`Fail` 判别。

```bash
cd platform && ./node_modules/.bin/vitest run shared/seam-contracts/__tests__/subagent-host.spec.ts
```

- [ ] 提交:
```bash
git add platform/shared/seam-contracts/subagent-host.ts platform/shared/seam-contracts/__tests__/subagent-host.spec.ts
git commit -m "feat(contracts): 跨节点子代理委派契约——父描述/回执闭集/运行键(行 5)"
```

---

## Task 3: `@lumo/subagent-host`(承载节点)(红 → 绿)

**Files**:
- Create `platform/dsh-plugins/subagent-host/package.json`
- Create `platform/dsh-plugins/subagent-host/src/index.ts`
- Create `platform/dsh-plugins/subagent-host/src/server.ts`
- Create `platform/dsh-plugins/subagent-host/src/run.ts`
- Create `platform/dsh-plugins/subagent-host/src/tturn.ts`(终端词表映射 + 结果读取)
- Create `platform/dsh-plugins/subagent-host/__tests__/host.spec.ts`

**Interfaces**:
- Consumes:Task 2 契约(`assertStartChildRequest`/`runKeyOf`/`childDepthOf`/`ChildResultBody`);dsh 公开件(`ctx.agents.create`、`childSessionMeta` 不用——**meta 手工构造**,因为 parent 不可用;`captureDelegatedPolicyOverrides` 不用——overrides 由传输值直接注入 `appendDelegatedPolicyOverrides(session, overrides)`;`SUBAGENT_DELEGATION_CONTEXT`、`assertSubagentMaxDepth`、`createUserMessage`、`foldConsumedWork`、`finalAssistantOutput`,均从 `@deepseek-ai/dsh-subagent` / `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` 公开导入)。
- Produces:`createSubagentHost(options): Server` + `registerSubagentHost(ctx, config)`(插件 `apply`,挂 `ctx.effect` 保证 disposable);`runChild(ctx, req): Promise<void>`(HTTP 层错误 → `StartChildFail`;成功 → 200 `StartChildOk`;child 结算 → 回执 callbackUrl)。

**核心实现要点(plan 作者已核验,dsh 只读,行 5 审计依据)**:

```ts
// run.ts —— 一个子代理的完整生命周期(节点侧)
async function runChild(ctx: Context, req: StartChildRequest): Promise<void> {
  // 1. 深度与上限:assertSubagentMaxDepth(childDepth, undefined) —— 公开件,远程形态无 cap
  const depth = childDepthOf(req.parent)
  // 2. 公开 item:session meta(手工构造 —— parent 在承载节点不存在,行 5 审计明示
  //    「spawn 本体进程内」;meta 只在 header,是纯数据)
  const meta = {
    ...req.parent.cwd !== undefined ? { cwd: req.parent.cwd } : {},
    parentSession: req.parent.sessionId,
    origin: 'subagent',
    delegationDepth: depth,
  }
  // 3. 创建(child 的 setup 窗口 = 同 in-process driver 的公开模式)
  const handle = await ctx.agents.create({
    sessionId: SessionId(req.childId),
    meta,
    agentOptions: {
      ...req.parent.provider !== undefined ? { provider: req.parent.provider } : {},
      ...req.parent.model !== undefined ? { model: req.parent.model } : {},
      ...req.parent.maxTokens !== undefined ? { maxTokens: req.parent.maxTokens } : {},
      subagentDepth: depth,
    },
    setup(childCtx) {
      const child = childCtx.agent as Agent
      appendDelegatedPolicyOverrides(child.session, {
        sandboxMode: req.parent.sandboxMode as SandboxMode | undefined,
        approvalPolicy: req.parent.approvalPolicy,
      })
      childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
      attachDescriptorAppend(childCtx, req.descriptor)
    },
  })
  // 4. 驱动单 turn(与 in-process driver 同公开模式:followup + whenIdle + cancel 绑定)
  const child = handle.agent
  child.followup(createUserMessage({ content: req.prompt as ContentBlock[], source: { kind: 'user' } }))
  await child.whenIdle()
  // 5. 读取结果(全量 events;boundary 0 —— 切片 1 无 seed)
  const body = readChildResult(child, req.childId)  // ChildResultBody(ok:true)
  // 6. 回执(重试 1 次,退避 200ms;失败 → settleBody 置为失败,运行表条目标注"unsettled")
  await deliverCallback(req.callbackUrl, body)
}
```

```ts
// server.ts —— HTTP 面(seam-host 先例:令牌表 + 闭源错误 + 白名单路径)
POST /subagent/start  → requireRealmAndToken(req) → assertStartChildRequest
      → runTable.set(runKeyOf(realm, childId), entry) → 200 StartChildOk | StartChildFail
POST /subagent/stop   → requireRealmAndToken → runTable.get → entry.cancel()(child.cancel({kind:'parent'}))
      → reponse 200 {ok:true}(stop 幂等:未知 runId 也是 200,行 6 kill 同款 no-op)
```

`runTable` = `Map<string, { cancel: () => void }>`(`key = runKeyOf(realm, childId)`),`cancel` 持有 callback 使 `whenIdle` 结算为 `aborted`(child.cancel 后 `whenIdle` 返回,`readChildResult` 依 `foldConsumedWork` → `aborted`)。

**`tturn.ts` 完整代码(终端词表 + 结果读取,照 in-process-driver 的公开模式逐行对齐,`@deepseek-ai/dsh-agent` 的 `foldConsumedWork` 与 `@deepseek-ai/dsh-subagent` 的 `finalAssistantOutput` 公开)**:

```ts
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** Map a session turn outcome to the subagent seam's terminal vocabulary。 */
export function toStopReason(reason: TurnEndReason | undefined): SubagentResultStopReason {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    // A pre-step rejection discarded the claimed prompt: declined, not done。
    case 'blocked': return 'refusal'
    case 'error':
    case 'interrupted':
    default: return 'error'
  }
}

/** 读一个已 settle 的 child:全量事件(切片 1 无 seed,boundary = 0)+ 规范选择规则。 */
export function readChildResult(child: Agent, runId: string): ChildResultBody {
  const own = child.session.events
  const lastEnd = foldConsumedWork(own).end
  const output = finalAssistantOutput(own) ?? []
  return {
    runId,
    ok: true,
    ...output.length > 0 ? { output } : {},
    stopReason: toStopReason(lastEnd?.data.reason),
  }
}
```

**`attachDescriptorAppend` 与 `deliverCallback`(run.ts 内部件,与 driver 委托面同款)**:

```ts
/** 在 child 首个 pre-step 的 enter 判决处 append 描述(照 driver 的公开事件模式)。 */
function attachDescriptorAppend(childCtx: Context, descriptor: unknown): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/** 回执:200ms 退避重试 1 次;失败标记 unsettled 但不重投 child(事件流已在日志)。 */
async function deliverCallback(url: string, body: ChildResultBody): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) return true
    } catch { /* 网络错 —— 落在退避重试 */ }
    if (attempt === 0) await new Promise(r => setTimeout(r, 200))
  }
  return false
}
```

**测试(cordis ctx,host.spec.ts)**——harness 照 dsh fork provider 测试的公开模式:

```ts
// host.spec.ts 头(每用例复用)
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { registerSubagentHost, type SubagentHostConfig } from '../src/index.ts'
import { hostOptions } from './harness.ts'  // tokens: {dev: 't0k'}, callback 用起端口的小 server

/** 10 行最小 mock:指定文本输出后 finish(等价 MockAdapter 的效果,零 dsh 内部 import)。 */
function textOnlyAdapter(text: string) {
  return async function* () {
    yield { type: 'text', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], textOnlyAdapter('child 答复')) as never
  const host = createSubagentHost(hostOptions())
  return { ctx, host }
}
```

用例 1(身份/契约):`start` 缺令牌/错令牌 → 403 + `StartChildFail{code:'forbidden'}`;坏 JSON 体 → 400 `invalid`;请求体 realm 与令牌 realm 不符 → 403(载荷不越身份,gate 先例)。
用例 2(承载驱动):`start`(childId/derived parent) → 200 `StartChildOk`;等待回调收到 `ChildResultBody{ok:true, stopReason:'completed', output:[{type:'text',text:'child 答复'}]}`;child 会话(经 `ctx.agents.get(childId).session`)header 断言 `meta.parentSession`/`origin:'subagent'`/`delegationDepth = parentDepth+1`,`subagent/descriptor` 事件存在于日志。
用例 3(stop):start 后立即 stop → 回调 `stopReason:'aborted'`;再次 stop → 仍 200 + 不变。
用例 4(回执网络失败):callbackUrl 指向关闭端口 → `deliverCallback` 返回 false,内部 no-crash、不重投(冒烟脚本负责真回执)。

```bash
cd platform && ./node_modules/.bin/vitest run dsh-plugins/subagent-host/__tests__/host.spec.ts
```

- [ ] 提交:
```bash
git add platform/dsh-plugins/subagent-host
git commit -m "feat(subagent-host): 承载节点子代理面——公开件建子代理+单 turn 驱动+回执结集(行 5)"
```

---

## Task 4: `@lumo/subagent-remote`(父侧 provider)(红 → 绿)

**Files**:
- Create `platform/dsh-plugins/subagent-remote/package.json`
- Create `platform/dsh-plugins/subagent-remote/src/callback.ts`
- Create `platform/dsh-plugins/subagent-remote/src/client.ts`
- Create `platform/dsh-plugins/subagent-remote/src/provider.ts`
- Create `platform/dsh-plugins/subagent-remote/src/index.ts`
- Create `platform/dsh-plugins/subagent-remote/__tests__/provider.spec.ts`

**Interfaces**:
- Consumes:Task 2 契约(`ChildResultBody` 校验);dsh 公开件(`SubagentProvider`/`NO_START_CAPABILITIES`/`SubagentRun`/`SubagentRunId`/`captureDelegatedPolicyOverrides`——**父侧本地真实采集**!/`delegationDepthOf`/`SessionId`/`randomUUID`);Task 3 的 wire(URL 两段)。
- Produces:

```ts
interface RemoteConfig {
  /** Scheduler base(经 X-Lumo-Realm 头信任注入;生产经边缘网关,§6.3 转 mTLS)。 */
  readonly schedulerUrl: string
  /** 放置应答 node_id → 承载节点 base URL(静态表;节点自我登记后续切片)。 */
  readonly nodeUrls: Readonly<Record<string, string>>
  /** host 端点共享令牌(承载侧 `tokens` 同值)。 */
  readonly hostTokens: Readonly<Record<string, string>>
  readonly realm: string
  /** 回调接收端口(provider 进程内 createServer)。 */
  readonly callbackPort: number
  readonly callbackHost?: string
}

class RemoteSubagentProvider implements SubagentProvider {
  readonly name: string  // 默认 'lumo-remote'
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
}
```

**`start()` 时序(best-effort 与 fail-closed 已定)**:
1. `childId = SessionId(randomUUID())`(父侧 mint;承载侧幂等键)。
2. `POST {schedulerUrl}/v1/placements`,body `{task_id: childId, cluster_id: '', requires: [], priority: 0}`,头 `X-Lumo-Realm: realm` → **201**(解析 `node_id`)| **202**(排队 → `SubagentError('REMOTE_PLACEMENT_QUEUED')`,明示「队列不支持,域外」)| 其它 → `SubagentError`(基础设施)。
3. `nodeUrl = nodeUrls[node_id]`,缺失 → `SubagentError('NODE_URL_UNKNOWN')`。
4. `POST {nodeUrl}/subagent/start`(头 realm + token),body = `StartChildRequest`(parent 描述:**本地真实采集**——`sessionId: parent.session.header.id`、`cwd: parent.session.header.cwd`、`delegationDepth: delegationDepthOf(parent)`、`provider/model/maxTokens: parent.options.*`、`sandboxMode/approvalPolicy: captureDelegatedPolicyOverrides(parent)`、`callbackUrl: http://{callbackHost}:{callbackPort}/subagent/result`、`label/prompt/descriptor` 直传)→ 200 `StartChildOk` | 错误 → `StartChildFail`(code 透传。
5. 注册回执表(`runKeyOf(realm, childId) → pending resolver`),返回句柄:

```ts
return {
  id: childId,
  localAgent: undefined,
  result: myPromise,   // callback.ts 的 resolve(defer) — 见下
  dispose: async () => {
    await fetch(`${nodeUrl}/subagent/stop`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ runId: childId }) })
    // stop 后 host 回执 aborted → myPromise 已结;dispose 幂等
  },
}
```

6. **回调面 `callback.ts`**:`createServer`(`POST /subagent/result`)→ 校验 `ChildResultBody` → 仅对**已注册 runId** resolve(未注册 → 404,不反馈细节);result 完成时(无论结局)`POST {schedulerUrl}/v1/tasks/{childId}/result` best-effort(终态上报,失败不阻塞回调结集);回调 server 在插件 `apply` 里 `ctx.effect` 起停(disposable)。

**测试(provider.spec.ts)**:三 mock server(`node:http` 起真端口):fake scheduler / fake host / 本进程 callback。
1. happy path:place 201 → host start 200 → 回调 body → `result` resolve `{stopReason:'completed', output}`;断言 scheduler 收到的终态上报。
2. 排队 202 → start reject `REMOTE_PLACEMENT_QUEUED`,host 无请求(fetch 计数 0)。
3. 令牌错 host 403 → reject `SeamError`(code 透传,重试与否由 code 定)。
4. dispose → host stop 收到;回调 `aborted`,`dispose` 幂等(两次调用只一次 fetch)。
5. 回执体 runId 未注册 → 404,且不 resolve。

```bash
cd platform && ./node_modules/.bin/vitest run dsh-plugins/subagent-remote
```

- [ ] 提交:
```bash
git add platform/dsh-plugins/subagent-remote
git commit -m "feat(subagent-remote): 跨节点委派 provider——Scheduler 放置+承载回执+句柄接驳(行 5)"
```

---

## Task 5: 装配 + 双进程冒烟 + 收账

**Files**:
- Modify `platform/data-plane/dsh-node/src/index.ts`(承载节点 patch:注入 `lumo-subagent-host` 段;父进程装配注入 `lumo-subagent-remote`——按 `LUMO_ROLE=node|agent`)
- Create `platform/dsh-plugins/subagent-remote/smoke-node.ts` 与 `smoke-parent.ts`(tsx 直跑,object-store smoke 先例)
- Modify `docs/README.md`(已定案行:「Seam 可远程化边界」→ 行 5 状态)
- Modify `docs/architecture.md`(§4.1 实现注记追加;§19.1 待补行不动——跨节点 resume 真机 e2e 仍待补,那是 fork 重放与 session 层的事)
- Modify `docs/superpowers/specs/2026-08-26-seam-remote-forms-design.md`(行 5 落注记)

**冒烟判据(真双进程,无 key)**:
1. 承载节点进程:`corepack pnpm dsh --profile headless --patch <node-patch>`(stdin 保持开放长驻;patch 含 `lumo-subagent-host`,配置 tokens/端口)。
2. 父进程:`smoke-parent.ts`——cordis ctx(`mountAgentLoopTestDependencies` + `ctx.plugin(AgentLoop)` + 10 行 `textOnlyAdapter` 注册 mock、Task 3 同款 harness)+ `@lumo/subagent-remote` + 一个真 parent Agent(`ctx.agentLoop.create(SessionId('parent'), {provider: 'mock'})`,先补一个已完结 turn)调 `ctx.subagents.start({provider: 'lumo-remote', …})`。
3. 断言:child 会话在承载节点进程的 PG 日志中(`meta.parentSession` = 父会话 id,`delegationDepth` = 1);父侧 `result.stopReason==='completed'` 且 output 非空;scheduler 放置与终态落账。跳过错法:任何断言失败 → 冒烟脚本 exit 非 0。

**收账(三处状态对齐,README/architecture/remote-forms)**:
- 行 5 状态:`已落地(2026-08-27,one-shot spawn 切片;fork/continuable seed 传输、预算联动放置、取消经行 6 控制通道 随 P2c/后续切片)`。
- `README.md` 已定案行「Seam 可远程化边界」:行 5 从「未」加入已落地序列。
- `architecture.md` §4.1/§7.1 实现注记:`@lumo/subagent-host` + `@lumo/subagent-remote` + 承载节点语义(句柄型 seam 会话在承载节点,节点丢失=child 会话作废,结果事件已落日志)。

- [ ] 提交:
```bash
git add platform/ docs/README.md docs/architecture.md docs/superpowers/specs/2026-08-26-seam-remote-forms-design.md
git commit -m "feat(subagent-remote): 行 5 切片 1 收账——装配/双进程冒烟/状态三处对齐"
```
