/**
 * @lumo/project —— 项目工作区（§11.1，控制台三入口的组织单元）。
 *
 * 提供：`ctx.projects`（ProjectService）+ 模型可见工具 `project_context`
 * （让 agent 能查询「我在哪个项目、挂了哪些制品、预算还剩多少」）。
 *
 * 铁律 20：项目是计量单元与权限载体，不参与五类制品分类。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { ProjectService } from './service.ts'

export interface ProjectConfig {
  connectionString: string
  /** 本节点绑定的项目（装配层固定；模型不可改 —— 与知识库 realm 同理） */
  projectId: string
  realm: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    projects: ProjectService
  }
}

/** Schemastery validation for {@link ProjectConfig} */
export const Config: z<ProjectConfig> = z.object({
  connectionString: z.string(),
  projectId: z.string(),
  realm: z.string(),
})

export function apply(ctx: Context, config: ProjectConfig): void {
  const service = new ProjectService(config.connectionString)

  ctx.effect(() => () => {
    void service.close()
  })

  ctx.provide('projects', service)
  void service.init()

  const definition: ToolDefinition = {
    name: 'project_context',
    description: '查询当前项目的上下文：成员、已挂载的专家/技能/连接器、知识空间、自动化与用量预算。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['projectId', 'name', 'artifacts', 'spaces', 'usage'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          state: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'name', 'version'],
              properties: {
                kind: { type: 'string' },
                name: { type: 'string' },
                version: { type: 'string' },
              },
            },
          },
          spaces: {
            type: 'array',
            items: {
              type: 'object',
              required: ['spaceId', 'name'],
              properties: { spaceId: { type: 'string' }, name: { type: 'string' } },
            },
          },
          usage: {
            type: 'object',
            required: ['tokens', 'costUsd', 'budgetRemaining'],
            properties: {
              tokens: { type: 'number' },
              costUsd: { type: 'number' },
              budgetRemaining: { type: 'number' },
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: unknown, _exec: ToolRunContext): Promise<unknown> {
      // projectId 由装配层固定注入（模型不可指定 —— 防越权读他人项目）
      const dash = await service.dashboard(config.projectId)
      if (!dash) throw new Error(`project_context: 项目 ${config.projectId} 不存在`)
      return {
        projectId: dash.project.projectId,
        name: dash.project.name,
        state: dash.project.state,
        artifacts: dash.artifacts,
        spaces: dash.spaces,
        usage: dash.usage,
      }
    },
  }

  const unregister = ctx.tools.register(definition)
  ctx.effect(() => () => {
    unregister()
  })
}

export default apply
export { ProjectService }
export type { Project, ProjectDashboard, ProjectRole, ArtifactKind } from './service.ts'
