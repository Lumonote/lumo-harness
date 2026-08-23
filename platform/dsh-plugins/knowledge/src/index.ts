/**
 * @lumo/knowledge —— 知识库组件（组件化契约 §4.3 首次落地）。
 *
 * 提供：`ctx.knowledge`（seam，契约于 shared/seam-contracts/knowledge.ts）
 *      + RAG 检索工具（Consumer，注册进 ctx.tools，走 §5.4.7 只读 published）。
 *
 * 插件形态：与 dsh 官方插件一致（tmux-context 惯例：
 * `export const inject` / `interface Config` + `const Config: z<Config>` /
 * `apply(ctx, config)`；额外提供 default 导出供 loader unwrap 兜底）。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { PgKnowledgeProvider } from './pg-provider.ts'
import { defineKnowledgeTool } from './consumer.ts'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'

export interface KnowledgeConfig {
  /** pgvector 连接串。standalone/cluster 形态应切换 milvus provider（同契约） */
  connectionString: string
  /** 本节点/本 agent 的 realm —— 检索隔离边界（§5.4.1） */
  realm: string
  /** 允许检索角色（OPA 下沉实现；缺省 viewer） */
  roles?: string[]
  /** RAG 检索默认 topK */
  defaultTopK?: number
}

/** Schemastery validation for {@link KnowledgeConfig}（可选性由 interface 的 `?` 表达） */
export const Config: z<KnowledgeConfig> = z.object({
  connectionString: z.string(),
  realm: z.string(),
  roles: z.array(z.string()),
  defaultTopK: z.number(),
})

/** 依赖注入：ctx.tools 必须先于本插件 mount（Consumer 注册工具面） */
export const inject = ['tools']

export function apply(ctx: Context, config: KnowledgeConfig): void {
  const provider = new PgKnowledgeProvider({
    connectionString: config.connectionString,
    allowedRoles: config.roles ?? ['viewer'],
  })

  ctx.effect(() => () => {
    void provider.close()
  })

  // seam 注册：一 ctx 一 provider（重复注册抛错是 Cordis 标准行为）
  ctx.provide('knowledge', provider)

  // Consumer：RAG 工具（装配层固定 realm、只读 published —— 铁律 17）
  const unregister = defineKnowledgeTool(ctx, provider, {
    realm: config.realm,
    roles: config.roles ?? ['viewer'],
    defaultTopK: config.defaultTopK ?? 5,
  })
  ctx.effect(() => () => {
    unregister()
  })

  // 幂等初始化（建表/索引）；失败即加载失败（响亮失败，§15）
  void provider.init()
}

export default apply
export type { KnowledgeSeam }
