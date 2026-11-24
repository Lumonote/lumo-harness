/**
 * 示范迁移 1：@lumo/project 的清单。人用页面 = 工作台“项目”分区；Agent 工具 = project_context（只读、低风险）。
 * 放在本包里（而不是 project 包）是为了让 UI 侧也能静态读取清单而不拉起 pg 依赖。
 */
import type { DualPluginManifest } from './manifest.ts'

export const PROJECT_CONTEXT_OUTPUT = {
  type: 'object',
  required: ['projectId', 'name', 'artifacts', 'spaces', 'usage'],
  properties: {
    projectId: { type: 'string' }, name: { type: 'string' }, state: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'object', required: ['kind', 'name', 'version'], properties: { kind: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' } } } },
    spaces: { type: 'array', items: { type: 'object', required: ['spaceId', 'name'], properties: { spaceId: { type: 'string' }, name: { type: 'string' } } } },
    usage: { type: 'object', required: ['tokens', 'costUsd', 'budgetRemaining'], properties: { tokens: { type: 'number' }, costUsd: { type: 'number' }, budgetRemaining: { type: 'number' } } },
  },
  additionalProperties: false,
}

export const PROJECT_MANIFEST: DualPluginManifest = {
  manifestVersion: 1,
  id: 'project',
  title: '项目工作区',
  description: '项目成员、已挂载制品、知识空间与用量预算。',
  pages: [
    { id: 'project-overview', title: '项目概览', kind: 'route', route: '/?lumo=projects', description: '工作台“项目”分区' },
  ],
  tools: [
    {
      name: 'project_context',
      description: '查询当前项目的上下文：成员、已挂载的专家/技能/连接器、知识空间、自动化与用量预算。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: PROJECT_CONTEXT_OUTPUT,
      action: 'project:read',
      risk: 'low',
      approval: 'never',
      page: 'project-overview',
    },
  ],
}
