/**
 * 示范迁移 2：ACP 引擎会话插件的清单。人用页面 = “引擎会话”面板；Agent 工具 = acp_engines_list（只读，
 * 让平台 Agent / 其他引擎知道本机有哪些可用编码引擎）。高风险的“开会话 / 发提示”故意不开放给 Agent。
 */
import type { DualPluginManifest } from './manifest.ts'

export const ACP_ENGINES_MANIFEST: DualPluginManifest = {
  manifestVersion: 1,
  id: 'acp-engines',
  title: '引擎会话',
  description: '在工作台里驱动 Claude Code / Codex / Gemini CLI 等 ACP 引擎。',
  pages: [
    { id: 'acp-session-panel', title: '引擎会话', kind: 'panel', panel: 'delivery', description: '交付区“引擎会话”面板' },
  ],
  tools: [
    {
      name: 'acp_engines_list',
      description: '列出本机可用的 ACP 编码引擎（Claude Code / Codex / Gemini CLI 等）及不可用原因。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      action: 'agent:engine:list',
      risk: 'low',
      approval: 'never',
      channels: ['platform', 'ui'],
      page: 'acp-session-panel',
    },
  ],
}
