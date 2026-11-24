export interface RuntimeSkill { name: string; description: string; whenToUse?: string; invocation: { modelInvocable: boolean; userInvocable: boolean }; source: string; provider: string }
const skillNameLabels: Record<string, string> = {
  'open-design': '开放设计',
  '@lumo/open-design': '开放设计',
  archify: '架构与调度图',
  '@lumo/archify': '架构与调度图',
  'gpt-image-2-style-library': '图像风格库',
  'ppt-master': '演示文稿生成',
  'ruflo-orchestration': '多智能体编排',
  'dsh-market': '插件市场',
  dshmarket: '插件市场',
  modlens: '视觉理解',
  '@liustack/modlens': '视觉理解',
  'dsh-browser': '浏览器自动化',
  '@anweat/dsh-browser': '浏览器自动化',
  'dsh-context': '上下文洞察',
  'dsh-cost-meter': '费用统计',
}
const skillProviderLabels: Record<string, string> = {
  'lumo-open-design': 'Lumo 内置',
  'lumo-archify': 'Lumo 内置',
  'lumo-creative-skills': 'Lumo 创作能力',
  'lumo-ruflo': 'Lumo 编排能力',
  'lumo-local-snapshot': '本地技能快照',
  '@lumo/open-design': 'Lumo 内置',
  '@lumo/archify': 'Lumo 内置',
  dshmarket: '插件市场',
  '@liustack/modlens': '视觉理解',
  '@anweat/dsh-browser': '浏览器自动化',
  'dsh-context': '上下文洞察',
  'dsh-cost-meter': '费用统计',
}

export function localizedSkillName(name: string): string {
  const normalized = name.toLowerCase()
  if (normalized.includes('open-design')) return '开放设计'
  if (normalized.includes('archify')) return '架构与调度图'
  if (normalized.includes('gpt-image-2') || normalized.includes('style-library')) return '图像风格库'
  if (normalized.includes('ppt-master')) return '演示文稿生成'
  if (normalized.includes('ruflo')) return '多智能体编排'
  if (normalized.includes('modlens')) return '视觉理解'
  if (normalized.includes('browser')) return '浏览器自动化'
  if (normalized.includes('context')) return '上下文洞察'
  if (normalized.includes('cost-meter') || normalized.includes('costmeter')) return '费用统计'
  if (normalized.includes('dshmarket') || normalized.includes('dsh-market')) return '插件市场'
  const fallback = name.replace(/^.*\//u, '').replace(/[-_]+/gu, ' ').trim()
  return skillNameLabels[name] ?? skillNameLabels[name.replace(/^.*\//u, '')] ?? (fallback || '未命名技能')
}

export function localizedProvider(provider: string): string {
  const normalized = provider.toLowerCase()
  if (normalized.includes('open-design')) return '开放设计'
  if (normalized.includes('archify')) return '架构图'
  if (normalized.includes('creative-skills')) return 'Lumo 创作能力'
  if (normalized.includes('ruflo')) return 'Lumo 编排能力'
  if (normalized.includes('modlens')) return '视觉理解'
  if (normalized.includes('browser')) return '浏览器自动化'
  if (normalized.includes('context')) return '上下文洞察'
  if (normalized.includes('cost-meter') || normalized.includes('costmeter')) return '费用统计'
  if (normalized.includes('dshmarket') || normalized.includes('dsh-market')) return '插件市场'
  return skillProviderLabels[provider] ?? '已装配插件'
}

export function localizedSource(source: string): string {
  if (source === 'bundled') return '随应用内置'
  if (source === 'custom') return '本地快照'
  if (source === 'remote') return '远程插件'
  if (source === 'community') return '社区插件'
  return '已装配插件'
}

export function localizedSkillKind(kind: string): string {
  return ({ prompt: '提示词', workflow: '工作流', tool: '工具', connector: '连接器' } as Record<string, string>)[kind] ?? '其他能力'
}

export function localizedVisibility(visibility: string): string {
  return ({ private: '私有', public: '公开', internal: '内部' } as Record<string, string>)[visibility] ?? '未分类'
}

export function localizedSkillDescription(skill: Pick<RuntimeSkill, 'name' | 'description'>): string {
  const name = skill.name.toLowerCase()
  if (name.includes('dshmarket') || name.includes('dsh-market')) return '浏览、搜索、安装和更新 DSH 社区插件。'
  if (name.includes('modlens')) return '读取图片、截图和附件，提供 OCR 与视觉证据。'
  if (name.includes('browser')) return '通过 Playwright 和 OpenCLI 打开页面、点击、输入、滚动、读取和截图。'
  if (name.includes('context')) return '查看当前会话上下文组成、趋势、事件和消息。'
  if (name.includes('cost-meter') || name.includes('costmeter')) return '统计会话、当日与历史费用，支持预算和模型价格。'
  if (name.includes('gpt-image-2') || name.includes('style-library')) return '从固定版本风格库选择图片模板、风格标签和提示词结构。'
  if (name.includes('ppt-master')) return '从主题、文档或模板生成、编辑和增强原生可编辑 PPTX。'
  if (name.includes('ruflo')) return '在 Lumo 任务运行边界内组织多智能体拓扑、分工、复核和回收。'
  return /[\u4e00-\u9fff]/u.test(skill.description) ? skill.description : '由已装配插件提供的运行时能力。'
}

export function localizedSkillWhenToUse(skill: Pick<RuntimeSkill, 'name' | 'whenToUse'>): string {
  const name = skill.name.toLowerCase()
  if (name.includes('dshmarket') || name.includes('dsh-market')) return '用于发现、安装和管理 DSH 插件。'
  if (name.includes('modlens')) return '用于图片理解、截图分析和 OCR。'
  if (name.includes('browser')) return '用于网页访问、交互操作和页面证据采集。'
  if (name.includes('context')) return '用于查看上下文预算、组成与注入事件。'
  if (name.includes('cost-meter') || name.includes('costmeter')) return '用于费用、预算、价格和用量分析。'
  if (name.includes('gpt-image-2') || name.includes('style-library')) return '用于海报、UI、信息图、品牌视觉和系列图片提示词。'
  if (name.includes('ppt-master')) return '用于演示文稿生成、模板填充、PPT 美化、动画和旁白。'
  if (name.includes('ruflo')) return '用于复杂任务的多智能体并行、复核、分阶段交付和失败重派。'
  return skill.whenToUse && /[\u4e00-\u9fff]/u.test(skill.whenToUse) ? skill.whenToUse : '可在当前工作区按策略调用。'
}
