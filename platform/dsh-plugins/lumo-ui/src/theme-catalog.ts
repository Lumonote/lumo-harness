/**
 * 主题目录 —— 宿主侧与浏览器侧共用的唯一真相源，不依赖 DOM 也不依赖 dsh 客户端类型，
 * 因此 `src/index.ts`（Node）与 `src/client/themes.ts`（浏览器）可以同时导入它。
 *
 * 之所以要拆出来：预插件区间的引导脚本（`src/boot-theme.ts`）必须在宿主侧生成，
 * 而它决定 light/dark 的依据正是这张表。表留在 `src/client/` 里的话，宿主侧要么
 * 拿不到，要么只能手抄一份常量 —— 将来加一套浅色主题就会静默分叉。
 */

/** 浏览器持久化键；同名 cookie 供登录页等预壳层读取（见 user-auth/src/html.ts）。 */
export const LUMO_THEME_STORAGE_KEY = 'lumo-theme'

/** 主题 id → 配色模式。四套产品主题当前均为深色，但该事实由本表承载而非硬编码。 */
export const LUMO_THEME_CATALOG = {
  'obsidian-signal': 'dark',
  'ember-foundry': 'dark',
  'orbital-glass': 'dark',
  'infrared-grid': 'dark',
} as const satisfies Record<string, 'dark' | 'light'>

export type LumoThemeId = keyof typeof LUMO_THEME_CATALOG

/** 存储值缺失或不可识别时的回退主题。 */
export const LUMO_DEFAULT_THEME: LumoThemeId = 'obsidian-signal'

/** 主题选择器的展示顺序与中文名。 */
export const LUMO_THEME_OPTIONS = [
  { id: 'obsidian-signal', label: '曜石信号' },
  { id: 'ember-foundry', label: '余烬工坊' },
  { id: 'orbital-glass', label: '轨道玻璃' },
  { id: 'infrared-grid', label: '红外网格' },
] as const satisfies readonly { id: LumoThemeId; label: string }[]

/**
 * 每套主题的「视觉身份」——不只换一个强调色，而是整套外观语言。
 *
 * 这些字段被 `src/client/themes.ts` 兑现为 `--lumo-*` token，并被 `lumo.css`
 * 消费；因此切主题时圆角、标题字体、表面处理、强调方式与特效强度会一起变化，
 * 而不是只变 accent。表名刻意与 `LUMO_THEME_CATALOG` 分开，前者只回答
 * light/dark，后者回答「这套主题长什么样」。
 */
export interface LumoThemeIdentity {
  /** 基础圆角（px），用于卡片、面板。 */
  radius: number
  /** 小元素圆角（px），用于按钮、输入框、标签。 */
  radiusSm: number
  /** 卡片/面板表面处理：渐变、玻璃、平铺、网格。 */
  surface: 'gradient' | 'glass' | 'flat' | 'grid'
  /** 主按钮的强调方式：实体填充、渐变、描边。 */
  emphasis: 'solid' | 'gradient' | 'outline'
  /** 标题字族栈。 */
  heading: string
  /** 正文与通用字族栈。 */
  body: string
  /** 等宽/标注字族栈。 */
  mono: string
  /** 装饰性动效强度：无、弱、丰富。 */
  effects: 'none' | 'subtle' | 'rich'
}

/**
 * 表面底色混入强调色的比例（0~1）；`flat` 与 `grid` 主题把该值压到接近 0，
 * 使面板回归中性，视觉靠网格与描边而非彩色渐变承载。
 */
export const LUMO_THEME_IDENTITY: Record<LumoThemeId, LumoThemeIdentity> = {
  // 曜石信号：签名主题 —— 渐变强调、抬升表面、衬线标题、克制动效。信号橙贯穿全站。
  'obsidian-signal': {
    radius: 12, radiusSm: 8, surface: 'gradient', emphasis: 'gradient',
    heading: 'Georgia, "Songti SC", serif',
    body: '"Avenir Next", Avenir, "Noto Sans SC", "PingFang SC", ui-sans-serif, sans-serif',
    mono: '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
    effects: 'subtle',
  },
  // 余烬工坊：暖色锻造 —— 实体强调、平铺表面、短粗衬线标题、暖光动效。炉芯橙。
  'ember-foundry': {
    radius: 8, radiusSm: 6, surface: 'flat', emphasis: 'solid',
    heading: '"Songti SC", "Noto Sans SC", ui-serif, serif',
    body: '"Avenir Next", Avenir, "Noto Sans SC", "PingFang SC", ui-sans-serif, sans-serif',
    mono: '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
    effects: 'subtle',
  },
  // 轨道玻璃：冷色未来 —— 玻璃表面、几何无衬线标题、大圆角、静音动效。冰蓝。
  'orbital-glass': {
    radius: 18, radiusSm: 12, surface: 'glass', emphasis: 'solid',
    heading: '"Avenir Next", Avenir, "Noto Sans SC", "PingFang SC", ui-sans-serif, sans-serif',
    body: '"Avenir Next", Avenir, "Noto Sans SC", "PingFang SC", ui-sans-serif, sans-serif',
    mono: '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
    effects: 'none',
  },
  // 红外网格：终端军械 —— 描边强调、网格表面、等宽标题、方角、无动效。红珊瑚。
  'infrared-grid': {
    radius: 6, radiusSm: 4, surface: 'grid', emphasis: 'outline',
    heading: '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
    body: '"Avenir Next", Avenir, "Noto Sans SC", "PingFang SC", ui-sans-serif, sans-serif',
    mono: '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
    effects: 'none',
  },
}

/**
 * 判定一个未知值是否为已登记主题 id。
 * @param value - 来自 localStorage / cookie / 事件载荷的未信任值。
 * @returns 该值是否命中目录中的自有属性。
 */
export function isLumoTheme(value: unknown): value is LumoThemeId {
  return typeof value === 'string' && Object.hasOwn(LUMO_THEME_CATALOG, value)
}
