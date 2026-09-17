/**
 * dsh 内置工具的能力档案：一张表，一行一个工具，三列 —— 来源档位 / 副作用等级 / 幂等性。
 *
 * **为什么合成一张表**：三列描述的是同一个对象（某工具能读进什么、能把什么送出去、重放安不安全），
 * 此前它们分散在两个包里：`provenance` 插件持前两列，`recovery` 插件持第三列。后果是「加一个内置
 * 工具」要在两个包、三张 map 里各写一次，而漏写是**静默**的 —— 两个分类器各自 fail closed，代码跑得
 * 通，只是档位悄悄变保守、且告警文案里看不出是「忘了写」还是「故意不写」。`knowledge_publish` 就是
 * 现成的例子：它只声明了副作用，另两列全靠兜底。
 *
 * **三列的缺省语义不是「没写就没事」，而是 fail closed**：
 * - `provenance` 缺省 → `ProvenanceClassifier` 兜 `external`（存在非受信撰写者）
 * - `effect` 必填：`ToolEffect` 里没有比 `write-external` 更保守的值可用
 * - `idempotency` 缺省 → `IdempotencyClassifier` 兜 `unknown`（按 non-idempotent 处理）
 *
 * 各档位的判据见 `provenance.ts` / `recovery.ts` 的类型注释。本文件只放**事实**，不放判定逻辑：
 * 分类顺序（override → 本表 → 前缀规则 → 兜底）仍由各插件自己的分类器决定，装配层仍可用
 * `overrides` / `prefixes` 收窄或放宽。行序只为人读，语义完全由三列决定。
 */
import type { Provenance, ToolEffect } from './provenance.ts'
import type { Idempotency } from './recovery.ts'

/** 一个内置工具的能力档案。 */
export interface BuiltinToolProfile {
  /** dsh 内置工具名（与工具注册名一致）。 */
  name: string
  /**
   * 来源档位。缺省 = 不声明，由 provenance 分类器按 `external` 兜底。
   * 留空必须是**有意的**：等于声明「这个工具读进来的东西按有非受信撰写者处理」。
   */
  provenance?: Provenance
  /** 副作用等级。必填。 */
  effect: ToolEffect
  /**
   * 幂等性。缺省 = 不声明，由 recovery 分类器按 `unknown` 兜底（按 non-idempotent 处理）。
   */
  idempotency?: Idempotency
}

/**
 * 表体。
 *
 * 分组只为人读。每组第一行的注释解释该组三列取值的共同理由。
 */
export const BUILTIN_TOOL_PROFILES: readonly BuiltinToolProfile[] = Object.freeze([
  // ── 工作区读取 ────────────────────────────────────────────────────────────
  // provenance=external：工作区字节与路径名可由提交者、依赖下载、解压归档、协作者或攻击者写入。
  // 标 internal 会让恶意仓库文件在模型上下文中绕过能力封闭。effect=read、重放无副作用。
  { name: 'read', provenance: 'external', effect: 'read', idempotency: 'idempotent' },
  { name: 'glob', provenance: 'external', effect: 'read', idempotency: 'idempotent' },
  { name: 'grep', provenance: 'external', effect: 'read', idempotency: 'idempotent' },
  { name: 'ls', provenance: 'external', effect: 'read', idempotency: 'idempotent' },

  // ── 平台内写入 · 覆盖写 ───────────────────────────────────────────────────
  // provenance=internal：只有平台自己写得进去。effect=write-local：副作用不出平台。
  // 覆盖写同参数重放收敛到同一状态 → idempotent。
  { name: 'write', provenance: 'internal', effect: 'write-local', idempotency: 'idempotent' },
  { name: 'todo_write', provenance: 'internal', effect: 'write-local', idempotency: 'idempotent' },

  // ── 平台内写入 · 增量改写 ─────────────────────────────────────────────────
  // 同样是平台内受控写，但增量改写重放会二次应用或直接失败 → non-idempotent。
  { name: 'edit', provenance: 'internal', effect: 'write-local', idempotency: 'non-idempotent' },
  { name: 'multi_edit', provenance: 'internal', effect: 'write-local', idempotency: 'non-idempotent' },
  { name: 'notebook_edit', provenance: 'internal', effect: 'write-local', idempotency: 'non-idempotent' },

  // ── 有非受信撰写者的读取 ──────────────────────────────────────────────────
  // provenance=external：知识库正文由业务用户撰写且不经审核；连接器响应与网页抓取同理。
  // 读取本身无副作用 → effect=read、idempotent。
  { name: 'knowledge_query', provenance: 'external', effect: 'read', idempotency: 'idempotent' },
  { name: 'web_search', provenance: 'external', effect: 'read', idempotency: 'idempotent' },
  { name: 'web_fetch', provenance: 'external', effect: 'read', idempotency: 'idempotent' },

  // ── 任意命令 ──────────────────────────────────────────────────────────────
  // 产出内容完全不可控（provenance=external），可发起任意网络请求（effect=write-external），
  // 无法静态判断是否会重复执行 → idempotency=unknown（按 non-idempotent 处理）。
  { name: 'bash', provenance: 'external', effect: 'write-external', idempotency: 'unknown' },
  { name: 'pwsh', provenance: 'external', effect: 'write-external', idempotency: 'unknown' },
  { name: 'subprocess', provenance: 'external', effect: 'write-external', idempotency: 'unknown' },

  // ── 已声明副作用，但来源与幂等未声明 ──────────────────────────────────────
  // 这是**现状，不是设计**：该工具被 control 插件（`SIDE_EFFECT_TOOL_PREFIXES`）与 provenance
  // 的副作用表同时认作「有副作用」，却从没声明过来源档位与幂等性，于是分别兜底成
  // external（provenance）与 unknown（recovery）。
  // 改这两列等于**改安全默认**（provenance 从 external 变 internal 会放宽人工确认），
  // 必须先单独评审，不要顺手补。见 __tests__/tool-profiles.spec.ts 的半声明白名单。
  { name: 'knowledge_publish', effect: 'write-local' },
])

/** 按某列取子集：只收显式声明了该列的行，键为工具名。 */
function column<T>(select: (profile: BuiltinToolProfile) => T | undefined): Readonly<Record<string, T>> {
  const out: Record<string, T> = {}
  for (const profile of BUILTIN_TOOL_PROFILES) {
    const value = select(profile)
    if (value !== undefined) out[profile.name] = value
  }
  return Object.freeze(out)
}

/** 工具名 → 来源档位（只含显式声明了 provenance 的行）。provenance 插件的默认表。 */
export const BUILTIN_PROVENANCE: Readonly<Record<string, Provenance>> = column(profile => profile.provenance)

/** 工具名 → 副作用等级。provenance 插件的默认表。 */
export const BUILTIN_EFFECT: Readonly<Record<string, ToolEffect>> = column(profile => profile.effect)

/** 工具名 → 幂等性（只含显式声明了 idempotency 的行）。recovery 插件的默认表。 */
export const BUILTIN_IDEMPOTENCY: Readonly<Record<string, Idempotency>> = column(profile => profile.idempotency)
