/**
 * 提示注入的结构性防护契约（评审 R5）。
 *
 * 本机制**不判断内容说了什么，只约束内容来源能触发什么**（规格 §7）：
 * 不做正则/分类器识别「忽略先前指令」——改写、翻译、编码、跨片段拆分都能绕过，
 * 上线后却会被当作已解决而挤掉结构性防护。故承诺边界是
 * 「外部内容不能在无人确认的情况下把副作用送出平台」，而非「能识别注入」。
 */

/**
 * 内容来源档位。判据是**「谁能写这段字节」，不是「字节从哪个进程来」**：
 * 知识库虽是平台自己的 PG，但正文由业务用户撰写且不经审核 → external；
 * 计量读数同样来自 PG，但只有平台写得进去 → internal。
 * 判错档位比没有机制更危险——它给出虚假的安全感。
 */
export type Provenance =
  /** 装配层注入，模型与用户均不可改：系统提示、preset、工具定义 */
  | 'system'
  /** 当前会话中经认证用户的直接输入 */
  | 'user'
  /** 平台内受控数据，无外部撰写者 */
  | 'internal'
  /** 存在非受信撰写者的内容：知识库正文、连接器响应、网页抓取 */
  | 'external'

/** 档位秩：污点单调取高，一旦置 external 不可降级 */
export const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = Object.freeze({
  system: 0,
  user: 1,
  internal: 2,
  external: 3,
})

/**
 * 工具副作用等级。与来源档位是**两个正交维度**，不要混用：
 * 来源说「读进来的东西可信吗」，副作用说「做出去的事收得回吗」。
 */
export type ToolEffect =
  /** 无副作用 */
  | 'read'
  /** 副作用限于本平台内：写知识库草稿、建任务 */
  | 'write-local'
  /** 副作用出平台：连接器 POST、外发邮件、任意命令执行 */
  | 'write-external'

/**
 * 会话事件的结构化最小视图。
 * 故意不 import dsh 的 `SessionEvent`——契约层保持对 dsh 类型零依赖，
 * 测试因此能用纯字面量构造日志（与现有 seam 契约的结构化断言口径一致）。
 */
export interface SessionEventLike {
  type: string
  data?: Record<string, unknown>
}

/** 某个 turn 的污点状态（会话日志的纯函数结果） */
export interface TaintState {
  /** dsh 原生 turn 号（`turn/start` 事件的 turn 字段）；无开启的 turn 时为 0 */
  turn: number
  /** 本 turn 上下文的最高来源档位 */
  level: Provenance
  /** 引入污点的工具名（去重、保序）——HITL 提示需要它作判据 */
  sources: string[]
}

/** 交给 OPA 的策略输入（§6.3 策略点复用，本插件只供事实不做裁决） */
export interface ProvenanceFacts {
  turn: number
  turnTaint: Provenance
  taintSources: string[]
  toolEffect: ToolEffect
  toolName: string
}

/** 单次调用的裁决 */
export type CallVerdict =
  /** 放行 */
  | { action: 'allow'; reason: string }
  /** 放行但记审计（受污染 turn 内的平台内写） */
  | { action: 'allow-audited'; reason: string }
  /** 转人工确认（受污染 turn 内的出平台写） */
  | { action: 'require-confirmation'; reason: string }

/** 取来源档位的较高者 */
export function maxProvenance(a: Provenance, b: Provenance): Provenance {
  return PROVENANCE_RANK[a] >= PROVENANCE_RANK[b] ? a : b
}

/**
 * 判决规则（纯函数，便于独立验证）。
 *
 * 关键取舍（规格 §4）：受污染 turn 内的 `write-external` **转人工而非禁止**。
 * 禁止会让「读了知识库就不能干活」，用户会绕开机制（改用未声明的工具、
 * 把内容手工粘进提问）；转人工保住能力，把判断交给唯一有权判断的人。
 * 代价诚实写在这里：**它依赖人真的会看**。因此 reason 必须带判据
 * （哪个工具引入了污点），而不是一句「是否允许」——审批疲劳会磨平这道闸。
 */
export function adjudicateCall(
  taint: TaintState,
  effect: ToolEffect,
  confirmed: boolean,
): CallVerdict {
  if (confirmed) {
    return { action: 'allow', reason: '已由人工确认放行' }
  }
  if (effect === 'read') {
    return { action: 'allow', reason: '只读调用无副作用' }
  }
  if (taint.level !== 'external') {
    return { action: 'allow', reason: `turn ${taint.turn} 未受外部内容污染（${taint.level}）` }
  }
  const via = taint.sources.join(', ') || '未知来源'
  if (effect === 'write-local') {
    return {
      action: 'allow-audited',
      reason: `turn ${taint.turn} 已被外部内容污染（经 ${via}），平台内写放行但留审计`,
    }
  }
  return {
    action: 'require-confirmation',
    reason: `turn ${taint.turn} 已被外部内容污染（经 ${via}）——出平台写需人工确认`,
  }
}

/** provenance seam：只供事实，不做裁决（裁决在 OPA，执行在 control 插件） */
export interface ProvenanceSeam {
  /** 当前 turn 的污点（从会话事件日志重算） */
  taint(events: readonly SessionEventLike[]): TaintState
  /** 组装 OPA 策略输入 */
  facts(events: readonly SessionEventLike[], toolName: string): ProvenanceFacts
}
