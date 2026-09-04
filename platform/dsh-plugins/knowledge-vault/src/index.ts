/**
 * @lumo/knowledge-vault —— 单机版知识库（Obsidian vault 为源，sqlite FTS5 关键词档）。
 *
 * 只应在 Local Desktop（deploymentMode=local）装配。与集群版 @lumo/knowledge 的关系：
 * - 两者都可以挂 `ctx.knowledge`（seam 装配点二选一；本插件的 Provider 实现
 *   KnowledgeSeam.query/rebuild 与 KnowledgeSourceManager 形状，宿主同构消费）；
 * - 本插件额外提供 `ctx.knowledgeVault`（status/sync）给面板显示构建状态。
 *
 * 检索工具：与 @lumo/knowledge 同构的 defineKnowledgeTool（本包内嵌的副本，
 * 见 src/consumer.ts；打包独立运行没有 @lumo/knowledge 可解析），
 * realm 与角色由装配层固定（§5.4.1）；vault 无多租户，角色参数不参与判定。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { defineKnowledgeTool } from './consumer.ts'
import { VaultKnowledgeProvider, VAULT_REALM } from './provider.ts'

export interface VaultKnowledgeConfig {
  /** Obsidian vault 根目录；空串 = 未配置（面板引导，不伪造状态） */
  vaultRoot: string
  /** sqlite 索引库路径（父目录自动创建） */
  dbPath: string
  /** 本机身份 realm（与装配层身份一致；单机无多租户，仅用于过滤一致性） */
  realm?: string
}

// 注意 schemastery 3.18 的取舍：必填字段显式 `.required()`，省略即可选；
// 没有 `.optional()` 方法（旧式 dsh API），写了会在加载时直接 TypeError。
export const Config: z<VaultKnowledgeConfig> = z.object({
  vaultRoot: z.string().required(),
  dbPath: z.string().required(),
  realm: z.string(),
})

export const inject = ['tools']

export function apply(ctx: Context, config: VaultKnowledgeConfig): void {
  const provider = new VaultKnowledgeProvider({
    vaultRoot: config.vaultRoot,
    dbPath: config.dbPath,
    realm: config.realm ?? VAULT_REALM,
  })

  ctx.provide('knowledgeVault', provider)
  ctx.provide('knowledge', provider)

  // 启动即做一次后台同步（失败仅 warn——vault 未配置时加载不报错，面板显示引导）。
  const unregister = defineKnowledgeTool(ctx, provider, {
    realm: provider.realm,
    roles: ['viewer', 'operator'],
    defaultTopK: 5,
  })
  ctx.effect(() => () => {
    void provider.sync().catch((error: unknown) => {
      ctx.logger.warn('knowledge-vault: 启动同步失败（可经面板重新同步）: %s', error)
    })
  })

  ctx.effect(() => () => {
    unregister()
    void provider.close()
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledgeVault: VaultKnowledgeProvider
  }
}

export default apply
export { VaultKnowledgeProvider, VAULT_REALM }
