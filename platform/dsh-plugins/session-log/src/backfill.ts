/**
 * 构造期事件回填(`session/created` 补拷至 attach 边界,终审 I1)。
 *
 * dsh 的 `session/event` firehose 只发布**已 attach** 会话的 append。构造窗口内
 * (store attach 之前)的事件——种子事件、`session/end-seed` 标记、preset/permission、
 * sandbox/mode、subagent/descriptor 等——从不发布,复制式日志因此在 PG 里留下
 * **永久缺失**(承载 child 会话实测 seq 0..N 全无)。本模块把 `session/created`
 * (attach 完成、announce)时刻的 `session.events` 快照经既有写者队列补拷入 PG,
 * 弥补这个缺口。
 *
 * 三条边界:
 * ① 该会话已被本节点 fence → 跳过回填(本节点已停手,不再动他人写权)。
 * ② 回填失败(库故障等)→ 只 error 日志,不 fence、不抛——与 firehose 写路径同语义;
 *    重试的语义留给上层(本切片不做重试)。
 * ③ 冷启动恢复旧会话不触发 `session/created`(无 create 事件)——本切片只覆盖
 *    live create(承载/child 场景);恢复/持久化会话的缺口检测归「首 sight 缺口检测」
 *    后续切片,不在本切片范围。
 *
 * 刻意不做:**firstLiveSeq / end-seed 交互逻辑**。回填是「created 时刻 events 全量」
 * 的忠实拷贝——含种子事件与本进程构造期补的 end-seed 标记;截断、恢复重标是种子/
 * 恢复语义,留给后续切片。
 */
import {
  FencedOutError,
  LogForkError,
  type AppendResult,
  type LogRecord,
} from '../../../shared/seam-contracts/session-log.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 回填对写路径的依赖——由 `index.ts` 注入,与 `session/event` 写路径**共用同一条
 * 每会话队列与同一套 fencing 令牌**。
 */
export interface QueueBackfillDeps {
  /** 每会话的写入队列尾:回填与 firehose 写串行保序 */
  tails: Map<string, Promise<void>>
  /** 该会话是否已被本节点 fence(是则跳过回填) */
  isFenced(sessionRef: string): boolean
  /**
   * 取写者令牌;undefined = 他人持租。回填在此**不 fence**(created 时刻本节点
   * 尚无行为可急停,也没有理由替他人代决;fencing 交给会话既有 firehose 路径在
   * 下一个事件上做),只静默跳过。
   */
  ensureToken(sessionRef: string): Promise<number | undefined>
  /** 追加一条日志(`(session, seq)` 主键幂等:duplicate = 良性重投) */
  append(record: LogRecord, fencingToken: number): Promise<AppendResult>
  /** append 返回 appended 后的热层镜像(fire-and-forget 由调用方装配);缺省 = 无热层 */
  onMirror?(record: LogRecord): void
  /** 日志出口(格式同 firehose 写路径;只 journal,不外抛) */
  logger: {
    error(format: string, ...params: unknown[]): void
  }
}

/**
 * 把一次 created 回填串到该会话既有的写入队列尾。
 *
 * 同步、不抛:直接在 `session/created` 监听体里调用(监听体抛 = attach 回滚,灾难;
 * 成对 disposal 会把整个会话拆掉)。失败全部落在异步任务段的 catch 里,只 error 日志。
 *
 * @param sessionRef - 会话标识(与写路径一致)。
 * @param snapshot - **created 时刻**的 `session.events` 快照,须先取后入队——
 *   队列任务的执行时刻可能晚于后续 append,快照保证回填只补构造期,不抢 firehose。
 * @param deps - 写路径依赖。
 */
export function queueBackfill(
  sessionRef: string,
  snapshot: readonly SessionEvent[],
  deps: QueueBackfillDeps,
): void {
  const prev = deps.tails.get(sessionRef) ?? Promise.resolve()
  // 前一任务若已 rejected(极端:acquire 网络错),不能让它把本任务也带成 rejected——
  // 那样队列尾就断了,该会话后续所有写都会无声失踪。
  const base = prev.catch(() => {})
  const nextTail = base.then(async () => {
    try {
      await runBackfill(sessionRef, snapshot, deps)
    } catch (error) {
      // 兜底:命中上面的任何库故障/中断之后便不会再走这里;真正走到这里的是
      // ensureToken 等未预料的中断——也只 journal(不 fence、不抛,与 firehose
      // 语义一致)。
      deps.logger.error(
        'session-log: 会话 %s 回填任务失败(不 fence、不抛,重试语义留给上层):%s',
        sessionRef,
        error instanceof Error ? error.message : String(error),
      )
    }
  })
  deps.tails.set(sessionRef, nextTail)
}

async function runBackfill(
  sessionRef: string,
  snapshot: readonly SessionEvent[],
  deps: QueueBackfillDeps,
): Promise<void> {
  // 边界①:已被 fence 的会话跳过回填(本节点不复牌,也不动他人写权)
  if (deps.isFenced(sessionRef)) return
  const token = await deps.ensureToken(sessionRef)
  if (token === undefined) {
    // 写权在他手(另一节点运行同一会话):不回填、不 fence,留给既有路径裁决
    deps.logger.error(
      'session-log: 会话 %s 回填跳过——写者租约被他人持有(另一节点已在运行同一会话),不 fence、不抛',
      sessionRef,
    )
    return
  }
  for (const event of snapshot) {
    // 照 firehose handler 构造 LogRecord:payload = 事件整体(seq/time/type 冗余在内)
    const record: LogRecord = {
      sessionRef,
      seq: event.seq,
      type: event.type,
      payload: event,
      time: event.time,
    }
    try {
      const result = await deps.append(record, token)
      if (result.status === 'appended') deps.onMirror?.(record)
      // duplicate:该 seq 已由 firehose 写路径落库(created 后、回填执行前到达的
      // 事件),良性重投幂等吸收;镜像也已由先到的写方完成,不重复镜像。
    } catch (error) {
      if (error instanceof FencedOutError) {
        // 令牌失效:后续逐条必然同错,终止本批(不 fence、不抛——与 firehose
        // 路径区分:那里会就地 fence 急停;created 回填尚无行为可急停)。
        deps.logger.error(
          'session-log: 会话 %s seq=%d 回填写入被拒——写者租约已失效(不 fence、不抛):%s',
          sessionRef, record.seq, error.message,
        )
        return
      }
      if (error instanceof LogForkError) {
        // 数据完整性事故,必须响亮(机器无权择一)。不 fence、不抛,由上层/人工裁定。
        deps.logger.error(
          'session-log: 会话 %s seq=%d 回填分叉事故(不 fence、不抛):%s',
          sessionRef, record.seq, error.message,
        )
        return
      }
      // 其余(网络/库故障)与 firehose 路径同语义:本节点仍持租,重试留给上层;
      // 只 error 日志,不 fence、不抛。逐条独立——继续处理后续事件。
      deps.logger.error(
        'session-log: 会话 %s seq=%d 回填失败(不 fence、不抛):%s',
        sessionRef, record.seq,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
