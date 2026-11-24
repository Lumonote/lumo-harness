/**
 * 平台 Agent 通道：把清单工具转成 dsh `ToolDefinition`，由插件 `ctx.tools.register` 注册（现有工具注册机制）。
 * execute 一律走 gateway.invoke(channel='platform')；deny / reject 抛错，模型看到原因（不伪装成空结果）。
 */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { Caller, DualPluginGateway, InvokeResult } from './gateway.ts'
import type { AgentToolSpec } from './manifest.ts'

export type CallerResolver = (exec: ToolRunContext) => Omit<Caller, 'channel'>

/** 从 dsh 执行上下文取会话 id 与 agent id（与 knowledge consumer、agent-teams 同一形状）。 */
export function callerFromExec(exec: ToolRunContext): Omit<Caller, 'channel'> {
  const agent = (exec as { agent?: { id?: unknown; session?: { id?: unknown } } }).agent
  const session = agent?.session?.id
  const id = agent?.id
  return { ...(session !== undefined && session !== null ? { sessionRef: String(session) } : {}), ...(typeof id === 'string' && id ? { agentId: id } : {}) }
}

export class DualToolError extends Error {
  constructor(readonly result: Extract<InvokeResult, { ok: false }>) { super(`${result.code}: ${result.error}`); this.name = 'DualToolError' }
}

const ANY_OUTPUT = {} as ToolDefinition['output']['schema']

export function toDshTool(gateway: DualPluginGateway, spec: AgentToolSpec, resolve: CallerResolver = callerFromExec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as ToolDefinition['parameters'],
    output: {
      schema: (spec.output ?? ANY_OUTPUT) as ToolDefinition['output']['schema'],
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const result = await gateway.invoke(spec.name, args, { ...resolve(exec), channel: 'platform' }, (exec as { signal?: AbortSignal }).signal)
      if (!result.ok) throw new DualToolError(result)
      return result.value
    },
  } as ToolDefinition
}

/** 注册某个插件开放给 platform 通道的全部工具；返回注销函数。 */
export function registerDshTools(tools: { register(def: ToolDefinition): () => void }, gateway: DualPluginGateway, specs: readonly AgentToolSpec[], resolve?: CallerResolver): () => void {
  const disposers = specs.filter(s => !s.channels || s.channels.includes('platform')).map(s => tools.register(toDshTool(gateway, s, resolve)))
  return () => { for (const d of disposers) d() }
}
