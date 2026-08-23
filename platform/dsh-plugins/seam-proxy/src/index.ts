/**
 * @lumo/seam-proxy —— seam 网络化的客户端侧（§4.1 最高杠杆）。
 *
 * 挂在 **agent 节点**上：把 `ctx.knowledge` / `ctx.knowledgeGraph` 注册成远程
 * Provider，指向运行 @lumo/seam-host 的 capability 节点。Consumer（RAG 工具、
 * GraphRAG 工具）代码一行不改。
 *
 * 形态（§13.2）：Local-lite 用 `mode: local` —— 进程内直连，不过网，
 * 此时本插件不注册任何东西，由 @lumo/knowledge 直接提供本地 Provider。
 *
 * 与 @lumo/knowledge **互斥**：同一 ctx 上只能有一个 knowledge Provider，
 * 重复注册会抛错（Cordis 标准行为，这里正是我们想要的响亮失败）。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { SeamProxyClient } from './client.ts'
import { createRemoteGraph, createRemoteKnowledge } from './remote-seams.ts'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'

export interface SeamProxyPluginConfig {
  /**
   * local  = 进程内直连（Local-lite；本插件空转，由本地 Provider 插件负责）
   * remote = 经 SeamProxy 转发到远端 capability 节点
   */
  mode?: 'local' | 'remote'
  /** 远端 seam host 地址（remote 模式必填；生产由 Nacos 下发后 setEndpoints 热更新） */
  endpoints?: string[]
  realm: string
  userId?: string
  /** 本 realm 的 seam 共享令牌（远端 host 配了 tokens 时必填） */
  token?: string
  timeoutMs?: number
  maxAttempts?: number
  failureThreshold?: number
  openForMs?: number
  /** 要接管的 seam；缺省两个都接管 */
  seams?: Array<'knowledge' | 'knowledgeGraph'>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    seamProxy: SeamProxyClient
  }
}

/** Schemastery validation for {@link SeamProxyPluginConfig} */
export const Config: z<SeamProxyPluginConfig> = z.object({
  // 装配模式：local（进程内直连，Local-lite/单机）| remote（经 SeamProxy 过网，集群）
  mode: z.union(['local', 'remote'] as const),
  endpoints: z.array(z.string()),
  realm: z.string(),
  userId: z.string(),
  token: z.string(),
  timeoutMs: z.number(),
  maxAttempts: z.number(),
  failureThreshold: z.number(),
  openForMs: z.number(),
  seams: z.array(z.union(['knowledge', 'knowledgeGraph'] as const)),
})

export function apply(ctx: Context, config: SeamProxyPluginConfig): void {
  const mode = config.mode ?? 'local'
  if (mode === 'local') {
    // 进程内直连：不注册远程 Provider，本地 Provider 插件照常工作（§13.2 表格）
    ctx.logger.info('seam-proxy: local 模式，seam 调用进程内直连，不过网')
    return
  }

  const endpoints = config.endpoints ?? []
  if (endpoints.length === 0) {
    // 响亮失败：remote 模式却没有端点，只会在第一次检索时才炸，那时已经晚了
    throw new Error('seam-proxy: mode=remote 必须提供至少一个 endpoint')
  }

  const client = new SeamProxyClient({
    endpoints,
    realm: config.realm,
    userId: config.userId,
    token: config.token,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    failureThreshold: config.failureThreshold,
    openForMs: config.openForMs,
  })
  ctx.provide('seamProxy', client)

  const seams = config.seams ?? ['knowledge', 'knowledgeGraph']
  if (seams.includes('knowledge')) {
    ctx.provide('knowledge', createRemoteKnowledge(client))
  }
  if (seams.includes('knowledgeGraph')) {
    ctx.provide('knowledgeGraph', createRemoteGraph(client))
  }

  ctx.logger.info('seam-proxy: remote 模式已挂载 seam=%s endpoints=%s',
    seams.join(','), endpoints.join(','))
}

export default apply
export { SeamProxyClient }
export type { KnowledgeSeam, GraphSeam }
