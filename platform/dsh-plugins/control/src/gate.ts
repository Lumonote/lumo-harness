/**
 * 执行闸门与生效档位：把控制面确立的会话状态翻译成两个问题各自的答案——
 *
 *   - **这次工具调用放不放行**（`controlGate`，消费方 `tools/pre-execute`）；
 *   - **这个 turn 该不该继续**（`controlActuation`，消费方 `agent/pre-step` 与主动轮询）。
 *
 * **一张表、两个投影。** 两个问题都由同一张状态表派生：
 *   - 分成两个函数（而不是一个记录），是因为两个挂点要的粒度不同——工具闸门有「只读放行」
 *     这一档，turn 级没有；
 *   - 分成两张表则会漂移，症状是「按了暂停，工具被拒了但 agent 还在说话」。
 *
 * 纯函数、零依赖，单独成文件有两个原因：
 *   - 它是这一层唯一的判据来源，挂点只消费它的输出——判据散在挂点里会漂移；
 *   - 它能在 `environment: 'node'` 下直接被测试覆盖，不必把整个 cordis 装配拉起来。
 */

/**
 * 工具闸门档位。三档而不是布尔，因为「全拒」与「只拒副作用」对操作者的意义不同：
 * 前者是会话已不可用，后者是**可以继续检视现场**。
 */
export type ControlGate = 'allow' | 'read-only' | 'deny'

/**
 * turn 级动作。
 *
 *   - `run`：照常，包括开新 turn。
 *   - `suspend`：**不再开新步**——当前这一步跑完就停在 turn 边界。可逆。
 *   - `cancel`：硬取消当前 turn（在途的模型调用一起断）。不可逆。
 */
export type ControlActuation = 'run' | 'suspend' | 'cancel'

interface Decision {
  readonly gate: ControlGate
  readonly actuation: ControlActuation
}

/**
 * 状态 → 两个投影。**只在这里写一次。**
 *
 * `suspend` 覆盖 `paused` / `awaiting-approval` / `stopped` 三者，且**不区分**它们是否可逆：
 * 「哪个状态能被 resume」是状态机（Go `internal/state` 的显式矩阵）的知识，本层只负责
 * 「别再往下跑」。在这里复制一份状态机判断，等于给同一个问题留第二份实现——两份一旦漂移，
 * 症状是「控制面说这条指令非法，执行面却按自己的判断继续跑」。
 */
const TABLE: ReadonlyMap<string, Decision> = new Map<string, Decision>([
  ['running', { gate: 'allow', actuation: 'run' }],
  ['paused', { gate: 'read-only', actuation: 'suspend' }],
  ['awaiting-approval', { gate: 'read-only', actuation: 'suspend' }],
  ['stopped', { gate: 'read-only', actuation: 'suspend' }],
  ['aborted', { gate: 'deny', actuation: 'cancel' }],
])

/**
 * 词表外的状态：工具全拒 + **停转**。
 *
 * 状态列里出现五个状态之外的值，意味着写入方与读取方对不齐（本仓库真实发生过一次，
 * 见 `control-schema-contract.spec.ts`）。这时**放行等于留一个后门**——有人已经试着停掉
 * 这个会话，而 agent 照常执行副作用。
 *
 * 这里**不**给 `cancel`：取消不可逆，而「不认识的值」不构成执行不可逆动作的理由。
 * 停转已经足够安全（不放行任何工具、不开新步），状态一旦变得可辨认就能继续。
 *
 * 与存活闸门刻意相反：那条对「未知」fail-open 是为了不让配置问题变成全平台停摆；
 * 这条对「未知」fail-closed 是因为放行的代价是执行了不该执行的写操作。
 *
 * **用 `Map` 而不是对象字面量**：`table[state]` 在 `state === 'constructor'` /
 * `'__proto__'` 时会取到原型上的成员，于是查表「命中」了一个 `gate === undefined` 的
 * 记录——而挂点里 `gate === 'deny'` 判否之后会落到「只读放行」那条分支，未知值就从
 * fail-closed 变成 fail-open。`Map.get` 没有原型链。
 */
const UNKNOWN: Decision = { gate: 'deny', actuation: 'suspend' }

/** 这次工具调用放不放行。 */
export function controlGate(state: string): ControlGate {
  return (TABLE.get(state) ?? UNKNOWN).gate
}

/** 这个 turn 该不该继续。 */
export function controlActuation(state: string): ControlActuation {
  return (TABLE.get(state) ?? UNKNOWN).actuation
}
