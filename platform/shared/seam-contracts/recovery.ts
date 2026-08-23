/**
 * Turn 级恢复契约（评审 R2 —— 全篇最重要的正确性缺口）。
 *
 * 问题：SessionEvent 日志按 dsh 的规矩只记录**模型可见**状态。而 turn 执行中
 * 存在大量非模型可见状态：已发出但未落日志的工具结果、瀑布位置、开着的句柄。
 * 崩溃点若落在「已向外部系统发出非幂等写」与「结果落日志」之间，
 * 任务重投 → 从日志 resume → **重复执行该外部写**。
 *
 * 解法：工具调用边界 + 写前意图记录（WAL）。执行前先落 intent，执行后落 outcome；
 * resume 时「有 intent 无 outcome」= 危险区，按幂等分类决定能否自动重试。
 */

/**
 * 工具幂等分类。**未分类一律按 non-idempotent 处理**（fail closed）——
 * 「不知道会不会重复扣款」必须当作「会重复扣款」。
 */
export type Idempotency =
  /** 纯读，或以幂等键去重的写。重放安全，resume 可自动重试。 */
  | 'idempotent'
  /** 外部可见副作用且无去重保证（POST 下单、发消息、转账）。resume 必须 HITL 确认。 */
  | 'non-idempotent'
  /** 未分类。**按 non-idempotent 处理**，并告警要求补分类。 */
  | 'unknown'

/** 一次工具调用的写前意图（执行前落库） */
export interface CallIntent {
  /**
   * 幂等键：同一 (session, turn, tool, args) 的重放必须产生同一个键。
   * 因此三个分量都必须是**日志派生**的——掺进进程内计数器或时间戳，
   * resume 到新节点就算不出同一个键，重放识别随之失效。
   */
  idempotencyKey: string
  sessionRef: string
  /** Turn 序号，取会话日志中 `user/message` 的条数（`seed` 重放后可重建） */
  turn: number
  toolName: string
  /** 参数指纹（不存原文——参数可能含敏感数据，§6.3 凭证不落日志） */
  argsFingerprint: string
  idempotency: Idempotency
  /** 记录时刻（执行开始前） */
  startedAt: number
}

/** 意图的落地结果（执行后落库） */
export type CallOutcome =
  | { status: 'completed'; finishedAt: number }
  | { status: 'failed'; finishedAt: number; error: string }
  /** 执行前被策略/控制指令拒绝——未触达外部系统，重放安全 */
  | { status: 'rejected'; finishedAt: number; reason: string }

/** resume 时对孤儿意图的裁决 */
export type ResumeVerdict =
  /** 可自动重试（幂等，或已确认未触达外部） */
  | { action: 'retry'; reason: string }
  /** 必须人工确认后才能重试（非幂等且可能已触达外部） */
  | { action: 'require-confirmation'; reason: string; intent: CallIntent }
  /** 已完成，跳过（幂等键命中已完成记录） */
  | { action: 'skip'; reason: string }

export interface RecoverySeam {
  /** 执行前记录意图。返回是否为重放（幂等键已存在且已完成 → 调用方应跳过执行） */
  recordIntent(intent: CallIntent): Promise<{ replay: boolean; priorOutcome?: CallOutcome }>
  /** 执行后记录结果 */
  recordOutcome(idempotencyKey: string, outcome: CallOutcome): Promise<void>
  /** 列出该会话的孤儿意图（有 intent 无 outcome）—— resume 的危险区 */
  orphans(sessionRef: string): Promise<CallIntent[]>
  /** 对孤儿意图裁决 */
  adjudicate(intent: CallIntent): ResumeVerdict
  /** 人工确认放行（HITL 后调用；写入审计） */
  confirm(idempotencyKey: string, actor: string): Promise<void>
}

/**
 * 裁决规则（纯函数，便于独立验证）。
 * **唯一的自动放行条件是 idempotent**；其余一律要人确认。
 */
export function adjudicateIntent(intent: CallIntent, confirmed: boolean): ResumeVerdict {
  if (confirmed) {
    return { action: 'retry', reason: `已由人工确认放行（${intent.toolName}）` }
  }
  if (intent.idempotency === 'idempotent') {
    return { action: 'retry', reason: `幂等工具，重放安全（${intent.toolName}）` }
  }
  const why = intent.idempotency === 'unknown'
    ? '未分类工具按非幂等处理（fail closed）'
    : '非幂等工具可能已触达外部系统'
  return {
    action: 'require-confirmation',
    reason: `${why}：${intent.toolName}`,
    intent,
  }
}
