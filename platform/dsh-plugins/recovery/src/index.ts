/**
 * @lumo/recovery —— Turn 级恢复契约与工具幂等（评审 R2）。
 *
 * 防的是这个场景：节点在「已向外部系统发出非幂等写」之后、「结果落日志」之前宕机。
 * 任务重投 → 从日志 resume → 重复执行该外部写（重复下单/重复转账）。
 *
 * 作用点（dsh 公开瀑布挂点，零侵入）：
 *   - `tools/pre-execute`：**执行前**落写前意图（WAL）；识别重放并按幂等分类裁决
 *   - `tools/post-execute`：落执行结果，把意图从「孤儿」状态解除
 *
 * 幂等键 = (session, turn, tool, argsFingerprint)。turn 取 dsh 原生 `turn/start`
 * 事件的 turn 号（`invariant.ts` 强制严格连续），由日志派生，`seed` 重放后能重建出
 * 同一个值，因此跨节点 resume 时稳定。
 *
 * 曾用「数 `user/message` 条数」，那是错的：该事件含 `agent.inject()` 合成消息
 * （文件变更通知等），turn 中途一次 inject 就让计数 +1，同参重放算出不同的键 →
 * 不被识别为重放 → 保护恰好在它存在的意义上失效。口径与 provenance 插件共用。
 *
 * 同一 turn 内以相同参数二次调用非幂等工具，本身就是可疑的重复（如 edit 二次应用
 * 会出错），按重放拦截；下一 turn 的同参调用是新意图，正常放行。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { PgRecoveryJournal } from './pg-journal.ts'
import { IdempotencyClassifier, fingerprintArgs, idempotencyKey } from './classify.ts'
import type { CallIntent, Idempotency, RecoverySeam } from '../../../shared/seam-contracts/recovery.ts'
import type { SessionEventLike } from '../../../shared/seam-contracts/provenance.ts'
import { currentTurn } from '../../provenance/src/taint.ts'

export interface RecoveryConfig {
  connectionString: string
  /** 工具幂等分类覆盖（连接器等外部写工具应在此显式声明） */
  overrides?: Record<string, Idempotency>
  /** 前缀批量声明（如 connector_ → non-idempotent） */
  prefixes?: Array<{ prefix: string; idempotency: Idempotency }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    recovery: RecoverySeam
  }
}

/** Schemastery validation for {@link RecoveryConfig} */
export const Config: z<RecoveryConfig> = z.object({
  connectionString: z.string(),
  overrides: z.dict(z.union(['idempotent', 'non-idempotent', 'unknown'] as const)),
  prefixes: z.array(z.object({
    prefix: z.string(),
    idempotency: z.union(['idempotent', 'non-idempotent', 'unknown'] as const),
  })),
}) as unknown as z<RecoveryConfig>

/** 工具服务须先挂载（本插件挂其执行瀑布） */
export const inject = ['tools']

export function apply(ctx: Context, config: RecoveryConfig): void {
  const journal = new PgRecoveryJournal(config.connectionString)
  const classifier = new IdempotencyClassifier({
    overrides: config.overrides,
    prefixes: config.prefixes,
  })

  void journal.init()
  ctx.provide('recovery', journal)
  ctx.effect(() => () => {
    void journal.close()
  })

  // callId → 幂等键（post-execute 据此回填结果）
  const pending = new Map<string, string>()

  ctx.on('tools/pre-execute', async function (exec, next) {
    const session = (exec as {
      agent?: {
        session?: {
          id?: string
          // 与 `provenance/src/index.ts` 同一理由：`Session#events` 属性已随上游
          // `2026-09-09-deprecate-synchronous-session-event-reads` 删除，读事件要走
          // `snapshotEvents()`（运行时实测 `Session.prototype.events === undefined`）。
          snapshotEvents?: () => readonly SessionEventLike[]
          events?: readonly SessionEventLike[]
        }
      }
    }).agent?.session
    const sessionRef = session?.id
    // 无会话上下文（系统内部调用）不记账：它们不属于可 resume 的 turn
    if (!sessionRef) return next()

    // 键里的 turn 必须是真的：`currentTurn([])` 恒返 0，于是所有 turn 的幂等键都落在同一
    // 命名空间上，第 2 轮里重复的同参调用会被当成第 1 轮的重复而吸收。
    const turn = currentTurn(session?.snapshotEvents?.() ?? session?.events ?? [])
    const toolName = exec.name
    const warning = classifier.warnOnce(toolName)
    if (warning) ctx.logger.warn(warning)

    const idempotency = classifier.classify(toolName)
    const argsFingerprint = fingerprintArgs(exec.arguments)
    const key = idempotencyKey(String(sessionRef), turn, toolName, argsFingerprint)

    const intent: CallIntent = {
      idempotencyKey: key,
      sessionRef: String(sessionRef),
      turn,
      toolName,
      argsFingerprint,
      idempotency,
      startedAt: Date.now(),
    }

    const { replay, priorOutcome } = await journal.recordIntent(intent)

    if (replay && idempotency !== 'idempotent') {
      if (priorOutcome?.status === 'completed') {
        // 正是 R2 要防的：非幂等调用已成功执行过，重放会造成二次副作用
        throw new Error(
          `lumo/recovery: 拒绝重复执行非幂等工具 "${toolName}"（该调用已成功完成）。`
          + `如确需重跑，请以不同参数发起，或经 recovery.confirm() 人工放行。`,
        )
      }
      if (!priorOutcome) {
        // 孤儿意图：上次执行中断，外部副作用状态未知 —— fail closed
        const verdict = await journal.adjudicateAsync(intent)
        if (verdict.action === 'require-confirmation') {
          throw new Error(
            `lumo/recovery: ${verdict.reason}。该调用上次执行未留下结果（可能已触达外部系统），`
            + `需人工确认后放行：recovery.confirm("${key}", <actor>)`,
          )
        }
      }
    }

    pending.set(String(exec.callId), key)
    return next()
  })

  ctx.on('tools/post-execute', async function (exec, result, next) {
    const key = pending.get(String(exec.callId))
    if (key) {
      pending.delete(String(exec.callId))
      const failed = (result as { isError?: boolean }).isError === true
      await journal.recordOutcome(key, failed
        ? { status: 'failed', finishedAt: Date.now(), error: '工具返回错误结果' }
        : { status: 'completed', finishedAt: Date.now() })
    }
    return next()
  })
}

export default apply
export { PgRecoveryJournal } from './pg-journal.ts'
export { IdempotencyClassifier, BUILTIN_IDEMPOTENCY } from './classify.ts'
export type { RecoverySeam }
