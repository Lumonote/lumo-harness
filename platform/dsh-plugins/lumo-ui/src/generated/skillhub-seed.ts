/**
 * 本文件由 platform/tools/gen-skillhub-seed.mjs 生成，请勿手工编辑。
 *
 * 真相源：platform/shared/manifests/skillhub-seed.manifest.json
 * 重新生成：pnpm run codegen:skillhub-seed
 * 一致性：platform/shared/manifests/__tests__/skillhub-seed.spec.ts 的漂移锁
 *
 * 为什么是生成物而不是直接 import 清单：lumo-ui 的 tsconfig 是 rootDir: src，跨出包边界的
 * import 直接编译失败；且这份数据是 SkillHub 不可达时的最后兜底，必须编译进包，不能变成
 * 运行期文件读取。
 *
 * 注意：本文件是远端数据的**镜像**（rating / downloads / stars / forks 都是抓取那一刻的
 * 快照）。重新同步时整表替换，不要逐条手改。
 */

/** `skills` 里的一个条目（SkillHub 首页快照的子集）。 */
export interface SeedSkill {
  id: string
  name: string
  tag: string
  description: string
  /** 评分。远端快照，不要手改。 */
  rating: number
  /** 下载量。远端快照，不要手改。 */
  downloads: number
  source: string
  verified: boolean
  command: string
  apiKey: boolean
}

/** `packs` 里的一个条目（SkillHub 首页快照的子集）。 */
export interface SeedPack {
  id: string
  name: string
  role: string
  category: string
  description: string
  /** 包含的技能数量。 */
  skills: number
  source: string
  command: string
}

/** `plugins` 里的一个条目（SkillHub 首页快照的子集）。 */
export interface SeedPlugin {
  id: string
  name: string
  category: string
  description: string
  /** Star 数。远端快照，不要手改。 */
  stars: number
  /** Fork 数。远端快照，不要手改。 */
  forks: number
  source: string
  installable: boolean
  repo: string
}

/** 离线兜底用的技能列表（顺序 = 清单顺序）。 */
export const SEED_SKILLS: SeedSkill[] = [
  { id: 'tencent-docs', name: '腾讯文档 TENCENT DOCS', tag: '办公效率', description: '在线云文档平台,是创建、编辑、管理文档的首选 skill。包括"新建/创建/编辑/读取/查看/搜索文档"、"保存文件"、"云文档"、"腾讯文档"等操作。', rating: 274, downloads: 719000, source: 'SkillHub', verified: true, command: 'tencent-docs', apiKey: true },
  { id: 'coding-expert', name: '编程专家.Skill', tag: '开发编程', description: '编程专家.Skill P8级编程助手,覆盖:软件/网站项目总控、API设计、Bug诊断、代码生成、代码审查、重构、测试用例、性能基准、技术选型、文档生成、任务拆解、Spec 编写。', rating: 160, downloads: 880000, source: 'SkillHub', verified: false, command: 'coding-expert', apiKey: false },
  { id: 'ima-skills', name: 'ima-skills', tag: '知识管理', description: 'ima-skills,支持对笔记、知识库的读取、写入和检索等操作,可以帮你随时记录、收入ima智能管理、随时调用,龙虾输出精准懂你,友好的接入了OpenClaw生态,构建完整知识闭环。', rating: 512, downloads: 295000, source: 'SkillHub', verified: true, command: 'ima-skills', apiKey: true },
  { id: 'search-engines', name: '搜索引擎', tag: '知识管理', description: '多搜索引擎集成,16引擎(7国内+9全球)。Multi search engine integration with 16 engines (7 CN + 9 Global).核心能力:统一搜索入口、多源聚合、结果去重、网页摘要提取、链接溯源。', rating: 17, downloads: 290000, source: 'SkillHub', verified: false, command: 'search-engines', apiKey: false },
  { id: 'anti-fraud', name: '防骗大师.Skill', tag: '生活服务', description: '防骗大师.Skill:你身边的生活防骗专家。当用户贴来可疑的短信、聊天记录、邮件、链接、App或电话转述,想知道"这是不是骗局"时立即出动,一眼看穿套路;当对话涉及转账、退款、刷单等场景时主动预警。', rating: 14, downloads: 256000, source: 'SkillHub', verified: false, command: 'anti-fraud', apiKey: false },
  { id: 'smart-charts', name: 'smart-charts', tag: '数据分析', description: '26种图表、3个主题,2步生成:1.上传数据 — 将CSV/Excel/JSON等格式的数据文件拖入对话框;2.查看结果 — 交互式图表(HTML),可保存图像为图片。', rating: 65, downloads: 250000, source: 'SkillHub', verified: false, command: 'smart-charts', apiKey: false },
]

/** 离线兜底用的专家包列表（顺序 = 清单顺序）。 */
export const SEED_PACKS: SeedPack[] = [
  { id: 'automation-testing', name: '自动化测试', role: '高级开发工程师', category: '科技', description: '从TDD方法论指导到自动生成单元测试代码、跨语言测试编写与运行、Playwright/Cypress E2E测试编排、REST/GraphQL API测试自动化,再到QA测试计划与覆盖率矩阵生成的完整工作流。', skills: 6, source: 'SkillHub', command: 'automation-testing' },
  { id: 'bug-triage', name: 'Bug排查', role: '高级开发工程师', category: '科技', description: '从多格式日志解析与错误模式分析到七步调试法、运行时执行追踪、四阶段系统化根因分析,再到零回归修复工作流和快速错误解释的完整Bug排查工作流。支持Python、Node.js、Go。', skills: 6, source: 'SkillHub', command: 'bug-triage' },
  { id: 'clinical-assist', name: '临床辅助', role: '健康信息顾问', category: '医疗', description: '从AI辅助诊断(病历文本分析/实验室结果解读/系统化诊断推理/鉴别诊断/决策支持)与用药安全管理(药物咨询/用药方案/药物相互作用/剂量调整/不良反应),医生级循证临床助手。', skills: 6, source: 'SkillHub', command: 'clinical-assist' },
  { id: 'health-report', name: '健康报告', role: '健康信息顾问', category: '医疗', description: '从全维度健康管理与中西医融合(运动训练/饮食营养/健康数据追踪/中医体质辨识/节气养生)与结构化健康摘要报告生成(体征/症状/药物/生活方式数据汇总),健康数据深度分析。', skills: 6, source: 'SkillHub', command: 'health-report' },
  { id: 'medical-record', name: '病历分析', role: '健康信息顾问', category: '医疗', description: '从智能病历结构化组织(病历规范化/主诉提取/病史整理/电子病历生成)与规范化入院记录撰写(三步流程/入院记录/病历格式化),病历文本辅助诊断(病历分析/实验室结果解读)。', skills: 6, source: 'SkillHub', command: 'medical-record' },
  { id: 'nursing-plan', name: '护理方案', role: '健康信息顾问', category: '医疗', description: '从护理研究理论支持论证(理论选择/文献检索/护理科研开题)与临床护理支持系统(文档记录/患者沟通/护理计划制定),阿尔茨海默症专病照护(疾病认知/日常照护/安全管理/沟通)。', skills: 6, source: 'SkillHub', command: 'nursing-plan' },
  { id: 'resume-screen', name: '简历筛选', role: '组织人才顾问', category: '人力资源', description: '从JD解析与胜任力建模到简历批量初筛、结构化评分、候选人对比与面试提问建议,为招聘者提供可解释、可回溯的简历筛选工作流。', skills: 6, source: 'SkillHub', command: 'resume-screen' },
]

/** 离线兜底用的插件列表（顺序 = 清单顺序）。 */
export const SEED_PLUGINS: SeedPlugin[] = [
  { id: 'dsh-routing-suite', name: 'yjh051108/dsh-routing-suite', category: '模型推理', description: 'dsh-routing-suite - injector + router-standard kit: install the runtime injector first, then the task-aware reasoning-mode router preset (measured P1-P23).', stars: 7000, forks: 147, source: 'GitHub', installable: true, repo: 'yjh051108/dsh-routing-suite' },
  { id: 'modlens', name: 'liustack/modlens', category: '模型推理', description: 'The first vision plugin for DeepSeek Harness, and the vision bridge for every text-only coding agent. Paste an image, get structured JSON evidence (OCR, layout, semantics).', stars: 3800, forks: 112, source: 'GitHub', installable: true, repo: 'liustack/modlens' },
  { id: 'dsh-dream-skin', name: 'RevolutionLA/dsh-dream-skin', category: '趣味换装', description: 'DSH 主题换肤与每用户强调色。', stars: 2600, forks: 128, source: 'GitHub', installable: true, repo: 'RevolutionLA/dsh-dream-skin' },
  { id: 'dsh-context', name: 'bowenliang123/dsh-context', category: '记忆', description: '查看上下文组成、趋势、注入、压缩和每一步消息。', stars: 2400, forks: 96, source: 'GitHub', installable: true, repo: 'bowenliang123/dsh-context' },
  { id: 'dsh-cost-meter', name: 'Han-1413141/dsh-cost-meter', category: '安全管理', description: '统计会话、预算、模型价格与历史费用。', stars: 1800, forks: 63, source: 'GitHub', installable: true, repo: 'Han-1413141/dsh-cost-meter' },
  { id: 'dsh-task-board', name: 'scwlkq/dsh-task-board', category: '工作流', description: 'Host 权威任务台帐、定时调度与执行历史。', stars: 2100, forks: 84, source: 'GitHub', installable: true, repo: 'scwlkq/dsh-task-board' },
  { id: 'dsh-agent-teams', name: 'NanmiCoder/dsh-agent-teams', category: '工作流', description: '自然语言编排多智能体团队协作。', stars: 1900, forks: 72, source: 'GitHub', installable: true, repo: 'NanmiCoder/dsh-agent-teams' },
  { id: 'dsh-univer-office', name: 'dream-num/dsh-univer-office', category: '工作流', description: 'DSH × Univer 协作网关与办公文档查看器。', stars: 1700, forks: 58, source: 'GitHub', installable: true, repo: 'dream-num/dsh-univer-office' },
  { id: 'dsh-market', name: 'dsh-market/dsh-market', category: '客户端', description: 'The plugin market inside DeepSeek Harness - browse, search, one-click install. - DSH 可视化插件市场', stars: 3100, forks: 162, source: 'GitHub', installable: true, repo: 'dsh-market/dsh-market' },
  { id: 'dsh-tui', name: 'ccch1mneyyy/dsh-tui', category: '客户端', description: 'DSH 官方公众号收录的 TUI 补位插件:Claude Code 风,鲸鱼顶栏/实时状态/流式思考/双击 Esc 回滚/上下文进度+TPS。npm 一键装。DSH official WeChat featured.', stars: 2800, forks: 147, source: 'GitHub', installable: true, repo: 'ccch1mneyyy/dsh-tui' },
]

export const SKILL_CATEGORIES: string[] = [
  '全部',
  '办公效率',
  '开发编程',
  '知识管理',
  '生活服务',
  '数据分析',
]

export const PACK_CATEGORIES: string[] = [
  '全部',
  '金融',
  '科技',
  '设计',
  '营销',
  '法律',
  '学术',
  '教育',
  '人力资源',
  '电商',
  '媒体',
  '医疗',
  '玄学',
]

export const PLUGIN_CATEGORIES: string[] = [
  '全部分类',
  '趣味换装',
  '联网工具',
  '记忆',
  '工作流',
  '模型推理',
  '客户端',
  '安全管理',
]

/** 种子数据的来源站点。 */
export const SKILLHUB_SEED_SOURCE: string = 'https://skillhub.cn'
