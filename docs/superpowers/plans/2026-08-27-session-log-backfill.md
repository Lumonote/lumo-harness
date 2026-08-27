# session-log 回填切片(I1) —— 实现计划

**问题**:`@lumo/session-log` 只订阅 `session/event` firehose;dsh 的构造期 append(store attach 前——permission/preset、sandbox/mode、approval/policy、agent/inbox/spliced、turn/start、subagent/descriptor 等)永不发布。承载 child 会话(PG 实测 seq 0-6 永久缺失)的审计/策略/resume 真相源有洞——冒烟判据 03 的「flaky」实为机制性缺失。
**修法**(终审 I1 指定):`session/created`(store attach 完成、announce)时,把该会话 live 日志(此时含全部构造期事件)经既有写者队列补拷入 PG;`(session_id, seq)` 主键幂等,与已到达的 firehose 写路径任意顺序共存。
**规范对应**:architecture §4.2(复制式日志——真相源完整性);§5.1 治律。
**前置**:`firstLiveSeq`(dsh core/session index.ts:452-478 明载"constructor seeds do not emit");`session/created` 同步监听(throw → attach rollback,core/session:833)——**监听体绝不抛**。

## Global Constraints
- 第一铁律:`deepseek-harness/` 只读(只读引用,不改)。
- 回填必须:①经既有写者队列(fences/tails/ensureToken/fencing 语义一致,不被 fence 利空);②主键幂等(ON CONFLICT DO NOTHING 的既有 append 语义);③热层镜像复用写路径行为(duplicate 不镜像,与既有一致);④监听同步回调内**零 await 零抛**(只入队,错误全捕获——created 抛=attach 回滚,灾难);⑤在 dsh `session/event` 每个用例的既有语义不受影响(仅新增补充路径)。
- 测试纪律:真 PG 门(`LUMO_BACKFILL_TEST_DSN`?复用既有 session-log 测试的 DSN 常量/helper——查 pg-log.spec 的读 DSN 方式并复用);skip 可见。

## Task 1: 计划(本文件)→ 提交
commit: `docs(session-log): 回填切片计划——构造期事件转正(终审 I1)`

## Task 2: 回填实现(红 → 绿)
**Files**:
- Modify `platform/dsh-plugins/session-log/src/index.ts`
- Create `platform/dsh-plugins/session-log/src/backfill.ts`(回填逻辑独立小模块:函数 `queueBackfill(ctx, session, tails, ensureToken, mirror record fn)`——依赖注入,可测)
- Modify/新增 `platform/dsh-plugins/session-log/__tests__/`(真 PG;加 `backfill.spec.ts`)

**接口**:
- `queueBackfill(parts): void`——幂等、异步、不抛(内部 catch→logger.error)。
- 触发:`ctx.on('session/created', (session) => { queueBackfill(...) })`(注册于插件 apply;注意 session-log 插件当前在 index.ts 中挂 firehose;created 监听加同处)。
- 内容:读取 `session.events` 全量(created 时机=attach 完成;此时 events 含构造期全量;任何后续 firehose 事件经既有路径);逐条按既有 `LogRecord` 走 `tails` 队列 + `ensureToken` + `log.append(record, token)`(append 幂等已在既有实现),热层 mirror 复用既有的 append 后 hook(vs `append` 返回 `duplicate` 不镜像——语义与 firehose 写路径一致:若回填先于某 seq 的 firehose 写,正文不重复;若后于,append 返回 duplicate,跳过镜像)。
- 边界(注释明写):①该会话已 fenced → 跳过回填(不动他人写权);②回填失败(库故障)→ 只 error 日志,不 fence、不抛——created 已发出,火树后续事件仍有写路径(重放的语义由……不:失败后 0-6 仍丢——但库故障时 firehose 路径同样失败,非本切片可解;保留「重试语义留给上层」一致性注释);③冷启动恢复旧会话不触发 created(无 create 事件)——本切片覆盖 live create(child/承载场景),恢复场景随「首 sight 缺口检测」后续切片(注释归期)。

**测试(真 PG)**:`backfill.spec.ts`:
1. 核心:boot dsh ctx(mountAgentLoopTestDependencies 或按 pg-log.spec 方式直接对 API)——**最简真实形**:用 dsh `SessionStore.create`(或 ctx.sessions.create)建会话,在**create 的 setup/构造窗口**内 append 3 条(如 `sandbox/mode`、`agent/inbox/spliced`、`subagent/descriptor` 形状的事件;若 setup 不易挂,先用种子构造?——**真实形**:用 `ctx.agents.create` 的 setup 窗口(host.spec 同款)——但 agent create 需要 agent-loop;**降级真实**:直接 `SessionStore.create(SessionId('b-1'))` 得 detached session?detached 不 attach…**实测路径**:看 pg-log.spec 现有如何获得 session——若无,用 `ctx.plugin(SessionStore)` + `store.create(id)`(attach 时发 created)→ 在 created 监听之前注册(插件 boot 顺序:session-log 插件先装)→ 断言 PG 有全部 seq(含构造期)。
2. 幂等:created 回填后,再把同 seq 重 append(mock 路径 or 直接调 queueBackfill 二次)→ 行数不变。
3. 时序与 firehose 共存:created 回填 + 一条 post-attach 事件 → PG seq 连续 0..N(无隙、无重复)。
4. fence 跳过(可选):已 fence 会话回填不写入(构造已 fence 状态——受既有 fence 语义,可用 unit 级 stub)。

**提交**:`feat(session-log): 构造期事件回填——session/created 补拷至 attach 边界(终审 I1)`

## Task 3: 冒烟判据 03 确定性 + 收账
- 验证:`dsh-plugins/subagent-remote/smoke-parent.ts` 判据 03(含 subagent/descriptor)确定性转绿——连续 3 次复跑。
- 文档:`architecture.md` §4.2 实现注记补一句(回填路径+边界:live create 覆盖/恢复场景归期);session-log 插件头注释同。
- **提交**:`feat(session-log): 冒烟判据 03 确定性验证 + §4.2 注记(收账)`
