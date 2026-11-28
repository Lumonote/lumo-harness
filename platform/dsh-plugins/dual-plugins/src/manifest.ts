/**
 * 双受众插件清单（P1「插件同时面向人和 Agent」）。
 *
 * 一个插件用**一份清单**同时声明：
 *   - pages：给人用的页面（工作台路由或面板）；
 *   - tools：给 Agent 用的工具（名称、受限长度的简短描述、参数 schema、所需权限动作、风险等级、审批策略、暴露通道）。
 * 参考 gugu App「人用页面、Agent 用工具」的设计，但不照搬实现：清单是纯数据，校验是纯函数，
 * 执行统一走 gateway.ts（权限判定 → 统一 Ask → 运行树）。
 */

export const DUAL_MANIFEST_VERSION = 1
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/u
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,63}$/u
export const PAGE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/u
/** 与权限设计 §2.1 一致：`<domain>:<verb>[:<qualifier>…]`，闭集登记在治理面；这里只校验形状。 */
export const ACTION_RE = /^[a-z][a-z0-9-]*(:[a-z0-9_-]+){1,3}$/u
/** 工具描述直接进模型上下文：限制长度，迫使作者写“简短描述”，细节放 parameters 的 description。 */
export const MAX_TOOL_DESCRIPTION = 200
export const MAX_PARAM_DESCRIPTION = 300
export const MAX_TOOLS_PER_PLUGIN = 32

export type RiskLevel = 'low' | 'medium' | 'high'
/** never：不需要审批；auto：由风险等级决定（high 需要）；always：每次都问 */
export type ApprovalPolicy = 'never' | 'auto' | 'always'
/** platform：注册为 dsh 平台 Agent 工具；acp：经 MCP 暴露给 ACP 引擎会话；ui：人可在页面上直接调用 */
export type ToolChannel = 'platform' | 'acp' | 'ui'
export const ALL_CHANNELS: readonly ToolChannel[] = ['platform', 'acp', 'ui']

export interface JsonSchemaLike {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  additionalProperties?: boolean | JsonSchemaLike
  items?: JsonSchemaLike
  enum?: unknown[]
  maxLength?: number
  minimum?: number
  maximum?: number
}

export interface UiPage {
  id: string
  title: string
  /** route：独立页面（同源路径或 `/?lumo=` 查询）；panel：挂到工作台已有区域的面板 */
  kind: 'route' | 'panel'
  route?: string
  /** 面板挂载区：与 lumo-ui 现有分区名对齐（delivery / operations / settings …） */
  panel?: string
  description?: string
}

export interface AgentToolSpec {
  name: string
  description: string
  parameters: JsonSchemaLike
  output?: JsonSchemaLike
  /** 所需权限动作，交给 Decide 判定 */
  action: string
  risk: RiskLevel
  approval?: ApprovalPolicy
  /** 缺省三个通道都开 */
  channels?: ToolChannel[]
  /** 对应的人用页面 id（UI 上“在页面中打开”） */
  page?: string
}

export interface DualPluginManifest {
  manifestVersion: typeof DUAL_MANIFEST_VERSION
  id: string
  title: string
  description?: string
  pages: UiPage[]
  tools: AgentToolSpec[]
}

export function channelsOf(tool: AgentToolSpec): readonly ToolChannel[] { return tool.channels && tool.channels.length > 0 ? tool.channels : ALL_CHANNELS }
export function approvalOf(tool: AgentToolSpec): ApprovalPolicy { return tool.approval ?? 'auto' }

/** 返回错误列表；空数组 = 合法。 */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = []
  if (typeof m !== 'object' || m === null) return ['清单必须是对象']
  const x = m as Partial<DualPluginManifest>
  if (x.manifestVersion !== DUAL_MANIFEST_VERSION) errors.push(`manifestVersion 必须是 ${DUAL_MANIFEST_VERSION}`)
  if (typeof x.id !== 'string' || !PLUGIN_ID_RE.test(x.id)) errors.push('id 必须匹配 ^[a-z][a-z0-9-]{1,63}$')
  if (typeof x.title !== 'string' || x.title.trim() === '' || x.title.length > 80) errors.push('title 必填且不超过 80 字')
  const pages = Array.isArray(x.pages) ? x.pages : (errors.push('pages 必须是数组'), [])
  const tools = Array.isArray(x.tools) ? x.tools : (errors.push('tools 必须是数组'), [])
  if (pages.length === 0 && tools.length === 0) errors.push('至少声明一个页面或工具')
  if (tools.length > MAX_TOOLS_PER_PLUGIN) errors.push(`工具数不超过 ${MAX_TOOLS_PER_PLUGIN}`)
  const pageIds = new Set<string>()
  for (const [i, p] of pages.entries()) {
    const at = `pages[${i}]`
    if (typeof p?.id !== 'string' || !PAGE_ID_RE.test(p.id)) errors.push(`${at}.id 非法`)
    else if (pageIds.has(p.id)) errors.push(`${at}.id 重复：${p.id}`)
    else pageIds.add(p.id)
    if (typeof p?.title !== 'string' || p.title.trim() === '') errors.push(`${at}.title 必填`)
    if (p?.kind === 'route') {
      if (typeof p.route !== 'string' || !p.route.startsWith('/') || p.route.startsWith('//')) errors.push(`${at}.route 必须是同源绝对路径`)
    } else if (p?.kind === 'panel') {
      if (typeof p.panel !== 'string' || !PAGE_ID_RE.test(p.panel)) errors.push(`${at}.panel 必须是面板区名`)
    } else errors.push(`${at}.kind 只能是 route | panel`)
  }
  const names = new Set<string>()
  for (const [i, t] of tools.entries()) {
    const at = `tools[${i}]`
    if (typeof t?.name !== 'string' || !TOOL_NAME_RE.test(t.name)) errors.push(`${at}.name 必须匹配 ^[a-z][a-z0-9_]{2,63}$`)
    else if (names.has(t.name)) errors.push(`${at}.name 重复：${t.name}`)
    else names.add(t.name)
    if (typeof t?.description !== 'string' || t.description.trim() === '') errors.push(`${at}.description 必填`)
    else if ([...t.description].length > MAX_TOOL_DESCRIPTION) errors.push(`${at}.description 超过 ${MAX_TOOL_DESCRIPTION} 字`)
    if (typeof t?.action !== 'string' || !ACTION_RE.test(t.action)) errors.push(`${at}.action 必须形如 domain:verb[:qualifier]`)
    if (!['low', 'medium', 'high'].includes(t?.risk as string)) errors.push(`${at}.risk 只能是 low | medium | high`)
    if (t?.approval !== undefined && !['never', 'auto', 'always'].includes(t.approval)) errors.push(`${at}.approval 只能是 never | auto | always`)
    if (t?.risk === 'high' && t.approval === 'never') errors.push(`${at}: 高风险工具不能声明 approval=never`)
    if (t?.channels !== undefined && (!Array.isArray(t.channels) || t.channels.some(c => !ALL_CHANNELS.includes(c)))) errors.push(`${at}.channels 只能取 platform | acp | ui`)
    if (t?.page !== undefined && !pageIds.has(t.page)) errors.push(`${at}.page 引用了未声明的页面：${t.page}`)
    const p = t?.parameters
    if (typeof p !== 'object' || p === null || p.type !== 'object') errors.push(`${at}.parameters 必须是 type=object 的 JSON Schema`)
    else for (const [k, v] of Object.entries(p.properties ?? {})) {
      if (typeof v?.description === 'string' && [...v.description].length > MAX_PARAM_DESCRIPTION) errors.push(`${at}.parameters.${k}.description 超过 ${MAX_PARAM_DESCRIPTION} 字`)
    }
  }
  return errors
}

export function assertManifest(m: unknown): DualPluginManifest {
  const errors = validateManifest(m)
  if (errors.length > 0) throw new TypeError(`插件清单不合法：${errors.join('；')}`)
  return m as DualPluginManifest
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'null': return v === null
    default: return true
  }
}

/**
 * 参数校验（支持清单里会用到的 JSON Schema 子集）。MCP / UI 通道没有 dsh 执行器替我们校验，
 * 所以 gateway 在每个通道都跑一遍；dsh 通道重复校验无害。
 */
export function validateArgs(schema: JsonSchemaLike, value: unknown, path = 'args'): string[] {
  const errors: string[] = []
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(t => typeOk(t, value))) return [`${path} 类型应为 ${types.join('|')}`]
  }
  if (schema.enum && !schema.enum.some(e => e === value)) errors.push(`${path} 不在可选值内`)
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} 超过最大长度 ${schema.maxLength}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} 小于 ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} 大于 ${schema.maximum}`)
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validateArgs(schema.items!, v, `${path}[${i}]`)))
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const k of schema.required ?? []) if (obj[k] === undefined) errors.push(`${path}.${k} 必填`)
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k]
      if (sub) errors.push(...validateArgs(sub, v, `${path}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${k} 不是允许的参数`)
      else if (typeof schema.additionalProperties === 'object') errors.push(...validateArgs(schema.additionalProperties, v, `${path}.${k}`))
    }
  }
  return errors
}
