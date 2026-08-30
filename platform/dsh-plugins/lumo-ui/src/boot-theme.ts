/**
 * 预插件区间的主题引导。
 *
 * 上游 ui-theme 在 `webserver/index-inject` 上推一条 body 脚本，按它自己的耐久偏好
 * （settings 文档，默认 `system`）决定 light/dark。Lumo 的四套主题不写那份文档
 * ——`setTheme` 只对 `THEME_PREFERENCES` 里的 id 落盘，注册进去的产品主题不在其中
 * ——而是走 localStorage（见 `client/themes.ts`）。上游那条脚本读不到，于是浅色
 * 系统上每次加载都会先刷一帧白底，直到客户端插件树激活。
 *
 * 这里补的是同一事件上的第二条脚本。body 行按 table 顺序拼接（webserver 的
 * `renderIndexInjections`：「each group in table order」），本插件晚于 ui-theme
 * 注册，所以后写的 DOM 字段赢。写的字段与上游完全一致，ui-layout 的
 * ThemePresenter 激活后仍然接管，二者不冲突。
 *
 * 这是 dsh 的公开扩展点（Cordis 事件），不改上游源码一行。
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

import { LUMO_DEFAULT_THEME, LUMO_THEME_CATALOG, LUMO_THEME_STORAGE_KEY } from './theme-catalog.ts'

/**
 * 生成引导脚本正文。目录整张内嵌，浏览器侧不再依赖任何 Lumo 模块。
 * @returns 立即执行的脚本正文。
 */
function bootThemeScript(): string {
  // hasOwnProperty 而非 `in`：存储值可以是 '__proto__' / 'constructor'，
  // 用 `in` 会命中 Object.prototype 从而把 undefined 当成合法配色。
  return `(() => {
  const catalog = ${JSON.stringify(LUMO_THEME_CATALOG)}
  let stored = null
  try { stored = localStorage.getItem(${JSON.stringify(LUMO_THEME_STORAGE_KEY)}) } catch { stored = null }
  const id = Object.prototype.hasOwnProperty.call(catalog, stored) ? stored : ${JSON.stringify(LUMO_DEFAULT_THEME)}
  const dark = catalog[id] === 'dark'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
})()`
}

/**
 * Lumo 的引导主题注入行。
 * @returns 紧跟 `<body>` 的内联脚本行，放置点与上游 ui-theme 相同。
 */
export function lumoBootThemeInjection(): IndexInjection {
  return { kind: 'script', placement: 'body', text: bootThemeScript() }
}
