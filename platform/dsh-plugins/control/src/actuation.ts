/**
 * 生效面：把控制面确立的状态变成对 agent 的**实际动作**（§8.1 的第一个可用切面）。
 *
 * # 为什么停转只有这一条路
 *
 * 上游 `agent/turn-stopping` 的签名是 `Promise<void> | void`，它**只能延长不能缩短**：
 * 循环在 turn 已经结束、且 `inbox.nextStep` 为空时才调它，之后再看一眼
 * `inbox.nextStep` 决定要不要继续（`agent-loop/src/agent.ts` 的 `turn()`）。所以它
 * **不是**挂起点，是个「turn 要结束了」的通知点。
 *
 * 真正能停下来的只有两处：
 *
 *   - `agent/pre-step` 返回 `{ kind: 'reject' }` —— 不开这一步（于是也不开这个 turn）；
 *   - `agent.cancel(cause)` —— 硬取消当前 turn，连在途的模型调用一起断。
 *
 * 前者的语义是「当前这一步跑完就停在 turn 边界」，正好对应 §8.4.1 给 pause / stop 写的
 * 作用点「turn 边界」；后者对应给 abort 写的「会话」。
 *
 * # 拒这一步之前必须把消息放回去
 *
 * `agent-loop` 的 `preStep()` 先 `inbox.claim(...)` 再走瀑布钩子，**claim 是消费**。
 * 于是直接 `reject` 会把用户刚发的消息吞掉——那不是暂停，是丢数据。上游自己的做法是
 * `restoreOtherClaimed()`（`goal-round-driver/src/index.ts`）把不归它管的消息 prepend 回去，
 * 这里照做，只是**全部**放回。
 *
 * # 为什么抽成窄接口
 *
 * 真 `Agent` 在结构上满足 {@link ControllableAgent}。用窄接口而不是 `Agent`，是为了让
 * 这三个动作能被一个假 agent 直接覆盖——**本层自己的判据与顺序**是这里唯一有风险的部分；
 * 「dsh 会不会按契约把钩子发出来」由 dsh 自己的用例保证，本仓库的插件测试一向不重测它。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, UserMessage } from '@deepseek-ai/dsh-session'

import { controlActuation, type ControlActuation } from './gate.ts'

/** 生效面需要的最小 agent 形状（真 `Agent` 结构上满足它）。 */
export interface ControllableAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: { readonly id: string }
  readonly inbox: {
    readonly nextTurn: readonly UserMessage[]
    readonly nextStep: readonly UserMessage[]
    prepend(target: InboxTarget, message: UserMessage): void
  }
  cancel(cause: AgentCancelCause): void
  steer(message: UserMessage): void
}

/** 本插件注入的上下文在模型侧的署名（`MessageSourceMap.plugin`）。 */
export const CONTROL_PLUGIN_ID = 'lumo/control'

/**
 * 被 claim 的那批消息原来在哪个列表里。
 *
 * `agent/pre-step` 的载荷**不含** `target`，但循环里两者的关系是确定的：
 * `agent-loop/src/agent.ts` 的 `turn()` 里 `target` 初值为 `'next-turn'`、第一次迭代之后
 * 才变成 `'next-step'`，而 `step` 取自 `phase.step + 1`、每开一个 turn 由 `phase.step = 0`
 * 归零。所以 `step === 1` ⟺ 这批来自 `next-turn`。
 *
 * 这是从上游实现推出来的**推断，不是契约**。收在一个纯函数里有两个用处：把理由写在唯一
 * 一处；上游改了循环结构时测试会红在这一点上，而不是表现为「消息偶尔被挪到下一个 turn」。
 */
export function claimedTarget(step: number): InboxTarget {
  return step <= 1 ? 'next-turn' : 'next-step'
}

/**
 * 把这次被 claim 掉、但我们不放行的消息**原样放回** inbox，返回放回了几条。
 *
 * **不唤醒**：放回只是让它们继续排队，开不开下一个 turn 由「状态恢复」决定，不由放回决定。
 * 顺序靠倒序 `prepend` 还原。
 *
 * 重复 id 会被跳过。**能撞上的只有「已经在另一个列表里」这一种**：claim 从哪个列表取走，
 * 它就不可能还留在同一个列表里；重复只可能来自别的钩子已经放回过一次。真 inbox 对
 * 「同一 id 同时 pending」是**抛错**的（`inbox.ts` 的 `inboxProjectionSchema.apply`，
 * 抛出来的错会毒掉整份会话日志），所以宁可跳过也不能照抄一遍。上游 `goal-round-driver`
 * 的 `restoreOtherClaimed()` 出于同一个理由做同一件事。
 */
export function restoreClaimed(
  agent: ControllableAgent,
  claimed: readonly UserMessage[],
  step: number,
): number {
  const target = claimedTarget(step)
  const pending = new Set<string>([
    ...agent.inbox.nextTurn.map((message) => String(message.id)),
    ...agent.inbox.nextStep.map((message) => String(message.id)),
  ])
  let restored = 0
  for (const message of claimed.toReversed()) {
    const id = String(message.id)
    if (pending.has(id)) continue
    agent.inbox.prepend(target, message)
    pending.add(id)
    restored += 1
  }
  return restored
}

/**
 * 硬取消当前 turn。`kind: 'hook'` 是上游给「某个生命周期扩展点发起的取消」留的那一档，
 * 与 `'user'`（用户按了取消）、`'disposed'`（插件卸载）区分开——审计要能回答是谁停的。
 */
export function cancelSession(agent: ControllableAgent, state: string): void {
  agent.cancel({ kind: 'hook', reason: `${CONTROL_PLUGIN_ID}: 会话处于 ${state}` })
}

/**
 * 该不该主动唤醒。**只有「确实有人等着」才唤醒**：
 * `steer()` 对一个 idle 的 driver 会**开一个 turn**，而一个只有唤醒注记、没有待办输入的
 * turn 是一次纯粹的模型调用开销——「恢复」不该变成「凭空烧一次调用」。
 */
export function hasPendingWork(agent: ControllableAgent): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
}

/** 轮询每轮对单个会话该做什么。 */
export type ActuationStep = 'none' | 'cancel' | 'wake'

/**
 * 主动轮询的动作判据。抽成纯函数，是因为这里唯一的风险是**重复**：1s 一轮会把 `cancel`
 * 刷成每秒一次（`cancel` 不是幂等的，它每次都新开一次取消），把唤醒刷成反复注入注记。
 *
 *   - `cancel`：同一状态只发一次；状态**变过**再变回来才算新的一次。
 *   - `suspend`：挂起由 `agent/pre-step` 在步边界完成，轮询这边什么都不用做。
 *   - `run`：只有在「上一轮还是挂起」且「确实有输入等着」时才唤醒。前者防重复，
 *     后者防「恢复」变成凭空开一个只有注记的 turn。
 */
export function actuationStep(
  previous: ControlActuation | undefined,
  actuation: ControlActuation,
  pending: boolean,
): ActuationStep {
  if (actuation === 'cancel') return previous === 'cancel' ? 'none' : 'cancel'
  if (actuation === 'suspend') return 'none'
  return previous === 'suspend' && pending ? 'wake' : 'none'
}

/**
 * 从挂起恢复：注入一条 continuation 注记并唤醒（§8.1 的 `agent.inject()` 那一档）。
 *
 * 用 `steer` 而不是 `inject`：`inject` 明确「**不唤醒** driver」（它只把上下文排进下一个
 * pre-step），单独用它等于恢复了个寂寞。`steer` 落点同样是步边界，但对 idle 的 driver
 * 会开 turn——「唤醒续跑」要的正是后半句。
 *
 * 注记必须是一条**新**消息（新 id）：inbox 拒绝重复 id，用一条已在 pending 里的消息去
 * `steer` 会当场抛错。这也不是权宜——§8.1 本来就把 resume 定义成「触发器到达 → 注入
 * 唤醒续跑」，注入的那句话就是触发器到达的可见痕迹。
 */
export function wakeSession(agent: ControllableAgent, state: string): void {
  agent.steer(createUserMessage({
    content: [{
      type: 'text',
      text: `会话 ${String(agent.session.id)} 的执行控制已恢复（当前状态 ${state}）。`
        + '此前的暂停由控制面下发，不是错误、也不是你的判断；现在可以继续未完成的工作。',
    }],
    source: { kind: 'plugin', plugin: CONTROL_PLUGIN_ID },
  }))
}

/** `agent/pre-step` 这一步的结论。 */
export type PreStepDecision = { kind: 'pass' } | { kind: 'reject'; restored: number }

/**
 * `agent/pre-step` 的判据：给定状态与这批被 claim 的消息，决定放行还是拒、拒之前放回几条。
 *
 * 抽成纯函数是为了让**唯一的风险点**（拒之前有没有把消息放回去、放回了几条）能脱离 PG
 * 与 cordis 直接覆盖——挂点本身只剩「读状态 → 调它 → 记日志」三行。
 */
export function preStepDecision(
  state: string,
  agent: ControllableAgent,
  messages: readonly UserMessage[],
  step: number,
): PreStepDecision {
  if (controlActuation(state) !== 'suspend') return { kind: 'pass' }
  return { kind: 'reject', restored: restoreClaimed(agent, messages, step) }
}
