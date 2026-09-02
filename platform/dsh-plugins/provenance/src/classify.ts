/**
 * 工具的来源档位与副作用等级分类。
 *
 * 两条铁规：
 * ① 分类由**装配层声明，不由工具自报**——自报等于让被注入方自证清白；
 * ② 未声明一律 fail closed（来源 external + 副作用 write-external），
 *    错判成安全的代价是数据外发，错判成危险的代价只是多一次人工确认。
 */
import type { Provenance, ToolEffect } from '../../../shared/seam-contracts/provenance.ts'

/**
 * dsh 内置工具的默认来源档位。
 *
 * `read` / `grep` / `glob` / `ls` 暴露的是工作区字节或路径名。即使当前用户选择了
 * 项目，提交者、依赖下载、解压归档、协作者或攻击者仍可能写入其中；把它们标成
 * `internal` 会让恶意仓库文件在模型上下文中绕过能力封闭。故它们一律是 `external`：
 * 读取工作区后，同一 turn 的出平台写必须走人工确认。宁可增加一次确认，也不能把
 * 可写工作区伪装成平台受控数据。
 */
export const BUILTIN_PROVENANCE: Readonly<Record<string, Provenance>> = Object.freeze({
  // 工作区内容与路径名可由非受信方写入，见上文
  read: 'external',
  glob: 'external',
  grep: 'external',
  ls: 'external',

  // 平台内受控数据：只有平台自己写得进去
  todo_write: 'internal',
  write: 'internal',
  edit: 'internal',
  multi_edit: 'internal',
  notebook_edit: 'internal',

  // 存在非受信撰写者
  knowledge_query: 'external',
  web_search: 'external',
  web_fetch: 'external',

  // 任意命令：产出内容完全不可控
  bash: 'external',
  pwsh: 'external',
  subprocess: 'external',
})

/** dsh 内置工具的默认副作用等级 */
export const BUILTIN_EFFECT: Readonly<Record<string, ToolEffect>> = Object.freeze({
  read: 'read',
  glob: 'read',
  grep: 'read',
  ls: 'read',
  knowledge_query: 'read',
  web_search: 'read',
  web_fetch: 'read',

  write: 'write-local',
  edit: 'write-local',
  multi_edit: 'write-local',
  notebook_edit: 'write-local',
  todo_write: 'write-local',
  knowledge_publish: 'write-local',

  // 可发起任意网络请求 —— 无法静态判断，fail closed
  bash: 'write-external',
  pwsh: 'write-external',
  subprocess: 'write-external',
})

/** 前缀规则：连接器等统一前缀的工具批量声明 */
export interface PrefixRule {
  prefix: string
  provenance: Provenance
  effect: ToolEffect
}

export interface ClassifierConfig {
  /** 按名覆盖来源档位 */
  overrides?: Record<string, Provenance>
  /** 按名覆盖副作用等级 */
  effectOverrides?: Record<string, ToolEffect>
  /** 前缀批量规则（如 connector_ → external / write-external） */
  prefixes?: PrefixRule[]
}

export class ProvenanceClassifier {
  private readonly overrides: Record<string, Provenance>
  private readonly effectOverrides: Record<string, ToolEffect>
  private readonly prefixes: PrefixRule[]
  /** 已告警过的未声明工具（避免每次调用刷屏） */
  private readonly warned = new Set<string>()

  constructor(config: ClassifierConfig = {}) {
    this.overrides = config.overrides ?? {}
    this.effectOverrides = config.effectOverrides ?? {}
    this.prefixes = config.prefixes ?? []
  }

  provenanceOf(toolName: string): Provenance {
    const override = this.overrides[toolName]
    if (override) return override
    const builtin = BUILTIN_PROVENANCE[toolName]
    if (builtin) return builtin
    for (const rule of this.prefixes) {
      if (toolName.startsWith(rule.prefix)) return rule.provenance
    }
    return 'external' // fail closed
  }

  effectOf(toolName: string): ToolEffect {
    const override = this.effectOverrides[toolName]
    if (override) return override
    const builtin = BUILTIN_EFFECT[toolName]
    if (builtin) return builtin
    for (const rule of this.prefixes) {
      if (toolName.startsWith(rule.prefix)) return rule.effect
    }
    return 'write-external' // fail closed
  }

  /** 该工具是否两项都未声明（走了 fail closed 兜底） */
  private isUndeclared(toolName: string): boolean {
    if (this.overrides[toolName] || this.effectOverrides[toolName]) return false
    if (BUILTIN_PROVENANCE[toolName] || BUILTIN_EFFECT[toolName]) return false
    return !this.prefixes.some((r) => toolName.startsWith(r.prefix))
  }

  /** 首次遇到未声明工具时返回告警文案（供插件记日志）；重复遇到返回 undefined */
  warnOnce(toolName: string): string | undefined {
    if (!this.isUndeclared(toolName)) return undefined
    if (this.warned.has(toolName)) return undefined
    this.warned.add(toolName)
    return `工具 "${toolName}" 未声明来源档位与副作用等级，按 external / write-external 处理`
      + '（受污染 turn 内将转人工确认）。请在 provenance 插件的 overrides 中显式声明。'
  }
}
