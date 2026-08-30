/**
 * The base plugin catalogue is deliberately kept beside the Lumo UI.
 *
 * The package names and versions below are the pinned upstream DSH packages
 * staged by the desktop runtime.  Keeping the product copy here means the
 * workbench can remain Chinese even when a third-party manifest uses an
 * English display name.
 */
export interface BasePluginDescriptor {
  id: string
  packageName: string
  version: string
  label: string
  summary: string
  category: string
  tags: string[]
  repository: string
  license: string
  capability: string
  accent: string
}

export const BASE_PLUGIN_CATALOG: readonly BasePluginDescriptor[] = [
  {
    id: 'dshmarket', packageName: 'dshmarket', version: '1.36.0',
    label: '插件市场', summary: '浏览、搜索、安装和更新 DSH 社区插件。', category: '能力管理',
    tags: ['浏览插件', '一键安装', '离线目录'], repository: 'https://github.com/dsh-market/dsh-market', license: 'MIT',
    capability: '插件发现与生命周期管理', accent: '#f29a62',
  },
  {
    id: 'modlens', packageName: '@liustack/modlens', version: '3.25.2',
    label: '视觉理解', summary: '把图片、截图和附件转换成可追溯的视觉证据。', category: '视觉能力',
    tags: ['图片读取', 'OCR', '视觉证据'], repository: 'https://github.com/liustack/modlens', license: 'MIT',
    capability: 'modlens_read_image 视觉桥接', accent: '#7da9ed',
  },
  {
    id: 'dsh-browser', packageName: '@anweat/dsh-browser', version: '0.1.10',
    label: '浏览器自动化', summary: '通过 Playwright 和 OpenCLI 完成浏览、点击、输入与截图。', category: '自动化',
    tags: ['打开页面', '点击输入', '页面截图'], repository: 'https://github.com/anweat/dsh-browser', license: 'MIT',
    capability: 'browser 服务与 9 个交互工具', accent: '#63c9b9',
  },
  {
    id: 'dsh-context', packageName: 'dsh-context', version: '0.38.1',
    label: '上下文洞察', summary: '查看上下文组成、趋势、注入、压缩和每一步消息。', category: '上下文',
    tags: ['上下文面板', '趋势分析', '事件追踪'], repository: 'https://github.com/bowenliang123/dsh-context', license: 'Apache-2.0',
    capability: 'Context 面板与 /context 命令', accent: '#b796e8',
  },
  {
    id: 'dsh-cost-meter', packageName: 'dsh-cost-meter', version: '1.6.7',
    label: '费用统计', summary: '统计会话、当日和历史费用，支持预算、模型价格和用量。', category: '观测与费用',
    tags: ['会话费用', '预算提醒', '价格目录'], repository: 'https://github.com/Han-1413141/dsh-cost-meter', license: 'MIT',
    capability: 'cost-meter 服务与费用面板', accent: '#e4c66f',
  },
  {
    id: 'gpt-image-2-style-library', packageName: '@lumo/creative-skills', version: '1.0.4',
    label: '图像风格库', summary: '从 500+ 案例和工业模板中选择 GPT Image 2 风格与提示词结构。', category: '图像生成',
    tags: ['风格选择', '提示词模板', '系列图片'], repository: 'https://github.com/freestylefly/awesome-gpt-image-2', license: 'MIT',
    capability: 'GPT Image 2 风格与模板 Skill', accent: '#dc8aa9',
  },
  {
    id: 'ppt-master', packageName: '@lumo/creative-skills', version: '5.1.0',
    label: '演示文稿生成', summary: '从主题、文档或现有模板生成、编辑和增强原生可编辑 PPTX。', category: '演示文稿',
    tags: ['PPTX 生成', '模板填充', '动画旁白'], repository: 'https://github.com/hugohe3/ppt-master', license: 'MIT',
    capability: 'PPT Master 原生演示文稿工作流', accent: '#e59062',
  },
  {
    id: 'ruflo-orchestration', packageName: '@lumo/ruflo-orchestration', version: '3.38.20',
    label: '多智能体编排', summary: '在 Lumo TaskRun 边界内组织 Ruflo 智能体拓扑、分工、复核与回收。', category: '智能体协作',
    tags: ['层级编排', '并行协作', '任务回收'], repository: 'https://github.com/ruvnet/ruflo', license: 'MIT',
    capability: 'Ruflo 固定版本编排运行时', accent: '#65b9d8',
  },
  {
    id: 'open-design', packageName: '@lumo/open-design', version: '0.1.0',
    label: '开放设计', summary: '在输入框下方直接创建可继续编辑的设计产物。', category: '创作',
    tags: ['UI 原型', '线框图', '设计产物'], repository: 'https://github.com/nexu-io/open-design', license: 'Apache-2.0',
    capability: '嵌入式设计创作面板', accent: '#f49a58',
  },
  {
    id: 'archify', packageName: '@lumo/archify', version: '2.16.0',
    label: '架构与调度图', summary: '用可验证 JSON 图谱生成架构、流程、任务运行和多智能体调度视图。', category: '智能体协作',
    tags: ['架构图', '调度拓扑', '生命周期'], repository: 'https://github.com/tt-a1i/archify', license: 'MIT',
    capability: 'Archify 可验证图谱工作流', accent: '#8fa9df',
  },
] as const

export const BASE_PLUGIN_BY_ID: Readonly<Record<string, BasePluginDescriptor>> = Object.fromEntries(
  BASE_PLUGIN_CATALOG.map(plugin => [plugin.id, plugin]),
)
