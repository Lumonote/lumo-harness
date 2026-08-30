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
 * 判定一个未知值是否为已登记主题 id。
 * @param value - 来自 localStorage / cookie / 事件载荷的未信任值。
 * @returns 该值是否命中目录中的自有属性。
 */
export function isLumoTheme(value: unknown): value is LumoThemeId {
  return typeof value === 'string' && Object.hasOwn(LUMO_THEME_CATALOG, value)
}
