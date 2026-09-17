/**
 * 工具幂等分类与幂等键生成。
 *
 * 分类原则：**只有能证明重放安全的才标 idempotent**。拿不准就留 unknown，
 * 由 adjudicateIntent 当作非幂等处理（fail closed）——错判成幂等的代价是
 * 重复下单/重复转账，错判成非幂等的代价只是多一次人工确认。
 */
import { createHash } from 'node:crypto'
import type { Idempotency } from '../../../shared/seam-contracts/recovery.ts'
import { BUILTIN_IDEMPOTENCY } from '../../../shared/seam-contracts/tool-profiles.ts'

// 表体见 shared/seam-contracts/tool-profiles.ts —— 三列（来源 / 副作用 / 幂等）一行一个工具，
// 与 provenance 插件共用同一份事实。这里再导出一次只是为了保持本插件的公共 API 不变。
export { BUILTIN_IDEMPOTENCY }

export interface ClassifierConfig {
  /** 覆盖或补充内置分类（连接器工具应在此显式声明） */
  overrides?: Record<string, Idempotency>
  /** 名称前缀规则：连接器工具统一前缀时批量声明（如 connector_ → non-idempotent） */
  prefixes?: Array<{ prefix: string; idempotency: Idempotency }>
}

export class IdempotencyClassifier {
  private readonly overrides: Record<string, Idempotency>
  private readonly prefixes: Array<{ prefix: string; idempotency: Idempotency }>
  /** 已告警过的未分类工具（避免每次调用刷屏） */
  private readonly warned = new Set<string>()

  constructor(config: ClassifierConfig = {}) {
    this.overrides = config.overrides ?? {}
    this.prefixes = config.prefixes ?? []
  }

  classify(toolName: string): Idempotency {
    const override = this.overrides[toolName]
    if (override) return override

    const builtin = BUILTIN_IDEMPOTENCY[toolName]
    if (builtin) return builtin

    for (const rule of this.prefixes) {
      if (toolName.startsWith(rule.prefix)) return rule.idempotency
    }
    return 'unknown'
  }

  /** 首次遇到未分类工具时返回告警文案（供插件记日志）；重复遇到返回 undefined */
  warnOnce(toolName: string): string | undefined {
    if (this.classify(toolName) !== 'unknown') return undefined
    if (this.warned.has(toolName)) return undefined
    this.warned.add(toolName)
    return `工具 "${toolName}" 未做幂等分类，按非幂等处理（resume 需人工确认）。`
      + '请在 recovery 插件的 overrides 中显式声明。'
  }
}

/**
 * 参数指纹：稳定哈希，**不保留原文**（参数可能含凭证/PII，§6.3）。
 * 键顺序归一化，保证同一逻辑调用在重放时产生同一指纹。
 */
export function fingerprintArgs(args: unknown): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 32)
}

/**
 * 幂等键：同一 (session, turn, tool, args) 的重放必须落到同一个键 ——
 * 这是「重放识别」的唯一依据，不能掺入时间戳或随机数。
 */
export function idempotencyKey(
  sessionRef: string,
  turn: number,
  toolName: string,
  argsFingerprint: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionRef, turn, toolName, argsFingerprint]))
    .digest('hex')
    .slice(0, 40)
}

/** 键排序的 JSON 序列化（对象键顺序不影响指纹） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
