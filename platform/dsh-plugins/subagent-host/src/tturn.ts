/**
 * 承载侧 child 的终端词表映射与结果读取(行 5 切片 1)。
 *
 * 与 dsh in-process driver 的 `readResult` / `toStopReason` 同款公开模式
 * (subagent-in-process-driver/src/index.ts),但按本切片的回执形状简化:
 * child 成功发布过,本切片一律按 `ok: true` 寄出 —— 结局由 stopReason 承载
 * (completed/aborted/error/max-tokens/refusal 闭集);`ok: false`(基础设施故障、
 * child 从未发布)由 run.ts 的失败路径寄出(本文件只承担成功侧映射与读取)。
 *
 * 切片 1 无 seed:读到的是 child 全量 events(boundary = 0)。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type {
  ChildResultBody,
  SubagentResultStopReason,
} from '../../../shared/seam-contracts/subagent-host.ts'

/** 把一次会话 turn 的结局映射到 subagent seam 的终端词表。 */
export function toStopReason(reason: TurnEndReason | undefined): SubagentResultStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // pre-step 拒绝把认领的 prompt 丢弃了:这是拒绝,不是完成。
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** 读一个已 settle 的 child:全量事件(切片 1 无 seed,boundary = 0)+ 规范选择规则。 */
export function readChildResult(child: Agent, runId: string): ChildResultBody {
  const own = child.session.snapshotEvents()
  const lastEnd = foldConsumedWork(own).end
  const output = finalAssistantOutput(own) ?? []
  return {
    runId,
    ok: true,
    ...(output.length > 0 ? { output } : {}),
    stopReason: toStopReason(lastEnd?.data.reason),
  }
}
