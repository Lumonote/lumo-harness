/**
 * 从复制日志重建一个**活会话**——§4.2 的「跨节点 resume」在平台侧的落点。
 *
 * # 为什么是「重建」而不是「远程持久化」
 *
 * `shared/seam-contracts/remotability.ts` 把 `ctx.sessionPersistence` 定级为 `needs-design`：
 * 「持久化的是同一套 SessionEvent 词汇，跨节点问题是**复制与一致性**，不是调用转发」。
 * 平台因此刻意**不**把持久化句柄过网（那会得到一个断网即失效的远程句柄），跨节点续跑的
 * 唯一正解是：读复制日志 → 在本地把会话**立起来**。本文件就是那一步。
 *
 * # 可行性是实测过的，不是推出来的
 *
 * `__tests__/reconstruct.spec.ts` 走完了四段的最后一段：在一个容器里造出会话与日志、
 * **销毁它**，再在另一个零共享对象的容器里用这份日志把会话立起来，并**继续追加**。
 *
 * # 走的是 `prepare` + `enter` + `announce`，不是 `create`
 *
 * 这不是风格选择：`create()` 的参数类型是 `CreateSessionOptions`，**它的联合里没有
 * `eventState`**（`PrepareSessionOptions = (CreateSessionOptions & {eventState?: undefined}) |
 * RestoredSessionOptions`）。也就是说「收养一份存量日志」这条路**只能**由 `prepare` 走；
 * 拿 `create` 硬塞一个 `eventState` 会被类型挡下，而绕过类型的写法（`as never`）会让
 * `eventState` 被**静默忽略**后落到 seed 分支——两者都成功、都返回一个会话，差别只体现在
 * 别处，正是最难发现的那种不一致。本仓的 `reconstruct.spec.ts` 第一版就踩了这个坑。
 *
 * # 四处**固有损失**，调用方必须知道（都不会报错，只会让重建出来的会话与原来不同）
 *
 * 1. **header 不在日志里**。日志是事件流，header 是另一份记录（本插件只复制事件）。
 *    `createdAt` 因此无法还原，只能取首个事件的时间**近似**——拿 `Date.now()` 顶上去不报错，
 *    只让一个三天前的会话显示成刚创建。它单独有测试。
 * 2. `cwd` / `parentSession` / `delegationDepth` / `agentPreset` **同样不在日志里**，只能由
 *    调用方以 hints 提供。它们不是装饰：dsh 的注释写着 `delegationDepth`「persisted so a
 *    recursion budget survives restart and resume」、`agentPreset`「a resume that restored a
 *    different composition would replay history the model can no longer act on」——
 *    拿不到就**留空**，不要编一个默认值。
 * 3. **`isSeeded` / `inheritedEventCount` 只能从标记反推**：带种子构造的会话会带一条
 *    `session/end-seed`，其中 `{inherited: true}` 的那条说明这是个继承了父会话前缀的子会话，
 *    它的 seq 就是继承切点。这是本文件里唯一一处**推断**，所以它单独有测试。
 * 4. **重建会往末尾补一条 `session/end-seed`**（dsh 构造函数的行为）：dsh 把「恢复」定义为
 *    「构造种子 = 完整存量日志」，末尾补标记正是它的形状，不是损坏。
 *
 * # 不伪造
 *
 * 日志里没有事件时返回 `undefined`，而不是造一个空会话——空会话与「这个会话本来什么都没
 * 发生过」在运维面上长得一样，而后者会让人以为恢复成功了。与终端网关「未接线事件源时回 503
 * 而不伪造空历史」是同一条规矩。
 */
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'

/** 重建所需的日志读面（本插件的 `sessionLog.read` 满足它）。 */
export interface RestoreLogRead {
  read(sessionRef: string, fromSeq?: number): Promise<LogRecord[]>
}

/** 日志里**没有**、只能由调用方提供的 header 事实。全可选——不给就留空，不猜。 */
export interface RestoreHeaderHints {
  /** 该次执行的委派深度（`governed-run.ts` 构造会话时给的就是它）。 */
  delegationDepth?: number
  /** 父会话 id（子会话谱系）。 */
  parentSession?: string
  /** 会话创建时的工作目录。 */
  cwd?: string
  /** 该会话所绑定的 agent preset 名。 */
  agentPreset?: string
}

export interface RestoreResult {
  session: Session
  /** 收养的事件条数（**不含** dsh 在末尾补的那条标记）。 */
  restored: number
  /** 把会话从 store 上摘下来的 disposer；调用方拥有它的生命周期。 */
  detach: () => void
}

/** header 中可从日志推导的那部分——导出是为了让它能被单独测。 */
export function deriveHeader(
  sessionRef: string,
  events: readonly SessionEvent[],
  hints: RestoreHeaderHints = {},
): { header: SessionHeader; inheritedEventCount: number } {
  // `{inherited: true}` 只出现在「带种子的子会话」那条标记上（构造函数的两条分支见
  // core/session/src/index.ts:616-619）。用严格相等而不是真值判断：标记的 data 也可能
  // 是 `{}`，而「普通的末尾标记」与「继承切点」必须分开——把它们混为一谈会让重建出来的
  // 子会话丢掉继承关系，表现为递归预算从「第 N 层」重置回顶层。
  let inheritedCut: number | undefined
  for (const event of events) {
    if (event.type !== 'session/end-seed') continue
    if ((event.data as { inherited?: unknown } | undefined)?.inherited === true) inheritedCut = event.seq
  }
  const isSeeded = inheritedCut !== undefined
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(sessionRef),
    // **近似**，不是原值：会话创建时刻不在日志里，首个事件的时间是能拿到的最好值。
    createdAt: events[0]!.time,
    isSeeded,
    ...hints.cwd === undefined ? {} : { cwd: hints.cwd },
    ...hints.parentSession === undefined ? {} : { parentSession: SessionId(hints.parentSession) },
    ...hints.delegationDepth === undefined ? {} : { delegationDepth: hints.delegationDepth },
    ...hints.agentPreset === undefined ? {} : { agentPreset: hints.agentPreset },
  }
  return { header, inheritedEventCount: isSeeded ? inheritedCut! : 0 }
}

/**
 * 按复制日志重建会话；日志为空时返回 `undefined`（不伪造空会话）。
 *
 * 事件必须**从 seq 0 起连续**——dsh 的构造器只接受这种种子（`seq = log.length` 是全系统
 * 依赖的契约）。中间有洞时响亮失败，而不是跳过缺口拼一份看起来连续的日志：那样重建出来的
 * 会话会缺一整段历史，而它在界面上与「这段本来就没发生」完全一样。
 */
export async function restoreSession(
  ctx: Context,
  source: RestoreLogRead,
  sessionRef: string,
  hints: RestoreHeaderHints = {},
): Promise<RestoreResult | undefined> {
  const records = await source.read(sessionRef)
  if (records.length === 0) return undefined

  const events: SessionEvent[] = []
  for (const record of records) {
    if (record.seq !== events.length) {
      throw new Error(`会话 ${sessionRef} 的日志在 seq ${events.length} 处断裂（下一条是 ${record.seq}）；拒绝用有洞的日志重建`)
    }
    events.push(record.payload as SessionEvent)
  }

  const { header, inheritedEventCount } = deriveHeader(sessionRef, events, hints)
  // `prepare` 是唯一接受 `eventState` 的入口（见文件头）。种子的每个事件在这里必须是
  // 独立拥有或已深度冻结的值：`read()` 每次返回新解析的对象，所以是独立拥有的。
  const session = ctx.sessions.prepare(SessionId(sessionRef), {
    seed: events,
    meta: header,
    inheritedEventCount: SessionLogOffset(inheritedEventCount),
    eventState: 'detached',
  })
  const detach = ctx.sessions.enter(session)
  try {
    ctx.sessions.announce(session)
  } catch (error) {
    // `enter` 之后 `announce` 之前抛（某个 `session/created` 监听器拒绝）必须把 attach 回滚，
    // 否则 store 里留下一个永远不会被公布的条目——它与一个正常会话在 `has()` 上无法区分。
    detach()
    throw error
  }
  ctx.logger.info('session-log: 会话 %s 已从复制日志重建（%d 条事件）', sessionRef, events.length)
  return { session, restored: events.length, detach }
}
