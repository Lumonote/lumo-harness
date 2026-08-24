/**
 * 污点重算 —— 本设计的承重件（规格 §2）。
 *
 * **污点状态必须能从 SessionEvent 日志重算，绝不能只存进程内存。**
 * 理由不是健壮性，而是它构成一个可被主动利用的漏洞：会话可跨节点 resume
 * （§7.1，走 `CreateSessionOptions.seed` 重放日志），内存里的污点会被 resume
 * 洗白。攻击者恰好有能力触发迁移——让 agent 跑一个高耗时工具把 Slot 打到超时
 * 即可。于是「先注入、再逼迁移」就能解除能力封闭。
 *
 * 附带好处：判决可复算、可举证，审计上不是「当时那台机器认为如此」。
 *
 * Turn 边界取 dsh 原生的 `turn/start`（`packages/core/session/src/invariant.ts`
 * 强制 turn 号严格连续，是核心自校验的权威值）。**不数 `user/message`**——
 * 该事件含 `agent.inject()` 的合成消息，一个 turn 内可出现 0 或多条。
 */
import {
  maxProvenance,
  type Provenance,
  type SessionEventLike,
  type TaintState,
} from '../../../shared/seam-contracts/provenance.ts'
import type { ProvenanceClassifier } from './classify.ts'

/** 当前（最后开启的）turn 号；日志中尚无 `turn/start` 时为 0 */
export function currentTurn(events: readonly SessionEventLike[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      return typeof turn === 'number' ? turn : 0
    }
  }
  return 0
}

/**
 * 重算当前 turn 的污点。
 *
 * 只看 `tool/call`（`{ turn, step, callId, name, arguments }`）——`tool/result`
 * 的载荷里没有工具名，而且失败调用的错误文案同样进上下文、同样可载注入，
 * 所以**不问结果成败**：本 turn 出现过 external 工具的调用即置污点。
 */
export function computeTaint(
  events: readonly SessionEventLike[],
  classifier: ProvenanceClassifier,
): TaintState {
  const turn = currentTurn(events)

  // 只扫最后一个 turn/start 之后的事件：能力封闭是 turn 级的
  let from = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/start') {
      from = i
      break
    }
  }

  let level: Provenance = 'user' // 基线：turn 由用户输入开启
  const sources: string[] = []
  const seen = new Set<string>()

  for (let i = from; i < events.length; i += 1) {
    const event = events[i]
    if (event.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name !== 'string') continue

    const provenance = classifier.provenanceOf(name)
    level = maxProvenance(level, provenance)
    if (provenance === 'external' && !seen.has(name)) {
      seen.add(name)
      sources.push(name)
    }
  }

  return { turn, level, sources }
}
