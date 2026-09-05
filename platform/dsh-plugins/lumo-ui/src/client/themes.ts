import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ThemeDefinition, ThemeSnapshot, ThemeTokens } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  LUMO_THEME_IDENTITY, LUMO_THEME_OPTIONS, type LumoThemeId,
} from '../theme-catalog.ts'

// id / 标签 / 配色模式的唯一真相源在 ../theme-catalog.ts —— 宿主侧的引导脚本
// (../boot-theme.ts) 也读同一张表。这里只负责把它兑现成 dsh 的主题定义并装配。
export {
  isLumoTheme, LUMO_DEFAULT_THEME, LUMO_THEME_IDENTITY, LUMO_THEME_OPTIONS, LUMO_THEME_STORAGE_KEY,
  type LumoThemeId, type LumoThemeIdentity,
} from '../theme-catalog.ts'

interface DarkThemePalette {
  base: string
  layer1: string
  layer2: string
  layer3: string
  overlay: string
  sidebar: string
  border: string
  borderStrong: string
  text: string
  muted: string
  faint: string
  accent: string
  accentHover: string
  accentSoft: string
  accentMuted: string
  error: string
  success: string
  warn: string
}

/** 把一套主题的视觉身份兑现为 `--lumo-*` token，供 `lumo.css` 消费。 */
function identityTokens(id: LumoThemeId): Partial<ThemeTokens> {
  const identity = LUMO_THEME_IDENTITY[id]
  return {
    '--lumo-radius': `${identity.radius}px`,
    '--lumo-radius-sm': `${identity.radiusSm}px`,
    '--lumo-heading': identity.heading,
    '--lumo-body': identity.body,
    '--lumo-surface': identity.surface,
    '--lumo-emphasis': identity.emphasis,
    '--lumo-effects': identity.effects,
  }
}

function darkTheme(id: LumoThemeId, palette: DarkThemePalette): ThemeDefinition {
  const tokens: ThemeTokens = {
    ...identityTokens(id),
    '--dsw-alias-bg-base': palette.base,
    '--dsw-alias-bg-layer-1': palette.layer1,
    '--dsw-alias-bg-layer-2': palette.layer2,
    '--dsw-alias-bg-layer-3': palette.layer3,
    '--dsw-alias-bg-overlay': palette.overlay,
    '--dsw-alias-bg-module-platform': palette.layer2,
    '--dsw-alias-bg-multi-select': palette.layer2,
    '--dsw-alias-bg-skeleton': palette.accentMuted,
    '--dsw-alias-border-l1': palette.border,
    '--dsw-alias-border-l2-darkmode-thin': palette.border,
    '--dsw-alias-border-l2': palette.borderStrong,
    '--dsw-alias-border-l3': palette.borderStrong,
    '--dsw-alias-brand-primary-invert': palette.base,
    '--dsw-alias-brand-primary-new-colorprimary-new-color': palette.accent,
    '--dsw-alias-brand-primary': palette.accent,
    '--dsw-alias-brand-text': palette.accent,
    '--dsw-alias-button-contrast-fill': palette.layer3,
    '--dsw-alias-button-elevated-fill': palette.layer2,
    '--dsw-alias-button-floating-fill': palette.layer2,
    '--dsw-alias-button-floating-hover': palette.layer3,
    '--dsw-alias-button-info-fill': palette.accent,
    '--dsw-alias-button-info-hover': palette.accentHover,
    '--dsw-alias-button-primary-dimmed': palette.accentSoft,
    '--dsw-alias-button-primary-fill': palette.accent,
    '--dsw-alias-button-primary-hover': palette.accentHover,
    '--dsw-alias-button-tool-bar-fill': palette.layer2,
    '--dsw-alias-button-tool-bar-hover': palette.layer3,
    '--dsw-alias-interactive-bg-active': palette.accentMuted,
    '--dsw-alias-interactive-bg-hover-accent': palette.accentMuted,
    '--dsw-alias-interactive-bg-hover-solid': palette.layer3,
    '--dsw-alias-interactive-bg-hover': palette.accentMuted,
    '--dsw-alias-label-primary-bluish': palette.text,
    '--dsw-alias-label-primary-dimmed': palette.faint,
    '--dsw-alias-label-primary-foreground': palette.base,
    '--dsw-alias-label-primary-inverted': palette.base,
    '--dsw-alias-label-primary': palette.text,
    '--dsw-alias-label-secondary': palette.muted,
    '--dsw-alias-label-tertiary': palette.faint,
    '--dsw-alias-markdown-citation': palette.layer2,
    '--dsw-alias-markdown-code-block-banner': palette.layer2,
    '--dsw-alias-markdown-code-block': palette.layer1,
    '--dsw-alias-markdown-code-segment-selected': palette.layer2,
    '--dsw-alias-markdown-code-segment-unselected': palette.base,
    '--dsw-alias-markdown-inline-code': palette.layer2,
    '--dsw-alias-markdown-placeholder': palette.layer2,
    '--dsw-alias-markdown-tag': palette.layer2,
    '--dsw-alias-scrollbar-bg-l1': palette.layer2,
    '--dsw-alias-scrollbar-bg-l2': palette.layer3,
    '--dsw-alias-scrollbar-hover-l1': palette.layer3,
    '--dsw-alias-scrollbar-hover-l2': palette.overlay,
    '--dsw-alias-state-business-primary': palette.accent,
    '--dsw-alias-state-business-tertiary': palette.accentSoft,
    '--dsw-alias-state-error-primary': palette.error,
    '--dsw-alias-state-error-secondary': palette.error,
    '--dsw-alias-state-success-primary': palette.success,
    '--dsw-alias-state-success-secondary': palette.success,
    '--dsw-alias-state-success-tertiary': palette.accentSoft,
    '--dsw-alias-state-warn-label': palette.warn,
    '--dsw-alias-state-warn-primary': palette.warn,
    '--dsw-alias-state-warn-secondary': palette.warn,
    '--dsw-alias-state-warn-tertiary': palette.accentSoft,
    '--dsw-alias-toast-bg': palette.layer3,
    '--dsw-alias-tooltip-bg': palette.layer3,
    '--dsw-specific-bubble-highlight': palette.accentSoft,
    '--dsw-specific-bubble': palette.layer2,
    '--dsw-specific-input-major': palette.layer2,
    '--dsw-specific-login-input': palette.layer1,
    '--dsw-specific-menu': palette.layer3,
    '--dsw-specific-selector': palette.layer2,
    '--dsw-specific-sidebar-fill': palette.sidebar,
    '--dsw-specific-sidebar-nav-item-active-accent': palette.accentSoft,
    '--dsw-specific-sidebar-nav-item-active': palette.layer2,
    '--dsw-specific-sidebar-nav-item-hover': palette.layer3,
    '--dsw-specific-tip': palette.layer2,
  }
  return Object.freeze({ id, colorScheme: 'dark', tokens: Object.freeze(tokens) })
}

const themes: readonly ThemeDefinition[] = Object.freeze([
  darkTheme('obsidian-signal', {
    base: '#0b0e11', layer1: '#11161c', layer2: '#18212a', layer3: '#202b35', overlay: '#26343f', sidebar: '#0e1217',
    border: 'rgba(185, 206, 220, 0.10)', borderStrong: 'rgba(185, 206, 220, 0.18)', text: '#eef3f6', muted: '#a4b1bb', faint: '#74818b',
    accent: '#ff914d', accentHover: '#ffad70', accentSoft: '#4d2d21', accentMuted: 'rgba(255, 145, 77, 0.14)', error: '#ff6b72', success: '#63d7d0', warn: '#f4bd6b',
  }),
  darkTheme('ember-foundry', {
    base: '#100d0b', layer1: '#181210', layer2: '#211816', layer3: '#2a1e19', overlay: '#35261f', sidebar: '#140f0d',
    border: 'rgba(255, 198, 150, 0.11)', borderStrong: 'rgba(255, 198, 150, 0.20)', text: '#f8eee7', muted: '#c3aaa0', faint: '#89736a',
    accent: '#f26b3f', accentHover: '#ff8a61', accentSoft: '#4e271d', accentMuted: 'rgba(242, 107, 63, 0.15)', error: '#ff7474', success: '#7ad8c6', warn: '#f5bd70',
  }),
  darkTheme('orbital-glass', {
    base: '#09111b', layer1: '#0f1b2a', layer2: '#14263a', layer3: '#1b3248', overlay: '#24445f', sidebar: '#0b1521',
    border: 'rgba(150, 200, 255, 0.12)', borderStrong: 'rgba(150, 200, 255, 0.22)', text: '#e8f0fa', muted: '#9fb5c9', faint: '#6f879d',
    accent: '#69b7ff', accentHover: '#91ccff', accentSoft: '#1c4466', accentMuted: 'rgba(105, 183, 255, 0.15)', error: '#ff7c86', success: '#71d7d0', warn: '#f3c46f',
  }),
  darkTheme('infrared-grid', {
    base: '#0e0c12', layer1: '#16131b', layer2: '#201923', layer3: '#2b202d', overlay: '#392738', sidebar: '#120e16',
    border: 'rgba(255, 150, 176, 0.12)', borderStrong: 'rgba(255, 150, 176, 0.22)', text: '#f7edf2', muted: '#c1a9b5', faint: '#8d7180',
    accent: '#ff6685', accentHover: '#ff8ca2', accentSoft: '#542336', accentMuted: 'rgba(255, 102, 133, 0.15)', error: '#ff7777', success: '#78d2e4', warn: '#f2bf6d',
  }),
])

/** 选择器视图：一个已注册主题的 id、中文名（尽力推演）与强调色取样。 */
export interface RegisteredThemeView { id: string; label: string; accent: string }
export interface ThemeRegistryState { themes: RegisteredThemeView[]; activeId: string }

let themeRegistryState: ThemeRegistryState = { themes: [], activeId: '' }
const themeRegistryListeners = new Set<() => void>()

export function getThemeRegistryState(): ThemeRegistryState { return themeRegistryState }
export function subscribeThemeRegistry(listener: () => void): () => void {
  themeRegistryListeners.add(listener)
  return () => { themeRegistryListeners.delete(listener) }
}
function publishThemeRegistry(next: ThemeRegistryState): void {
  themeRegistryState = next
  themeRegistryListeners.forEach(listener => listener())
}

function themeLabel(id: string): string {
  const known = LUMO_THEME_OPTIONS.find(option => option.id === id)
  if (known !== undefined) return known.label
  const humanized = id.replace(/^(dream|mirage|lumo|ds|dark|light)-?/iu, '').replace(/[-_]+/gu, ' ').trim()
  return humanized === '' ? id : humanized.replace(/\b\w/gu, character => character.toUpperCase())
}

function themeAccent(theme: ThemeDefinition): string {
  const primary = theme.tokens['--dsw-alias-brand-primary']
  if (typeof primary === 'string' && primary !== '') return primary
  let hash = 0
  for (const character of theme.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 72% 60%)`
}

function buildRegistry(snapshot: ThemeSnapshot): ThemeRegistryState {
  return {
    activeId: snapshot.active.id,
    themes: snapshot.themes.map(theme => ({ id: theme.id, label: themeLabel(theme.id), accent: themeAccent(theme) })),
  }
}

export function installLumoThemes(ctx: ClientContext): void {
  ctx.effect(() => {
    // Loader replays can evaluate a fresh copy of this bundle while the shared
    // theme service still owns the previous copy's registrations. Only claim
    // missing ids; registrations we did not create must not be disposed here.
    const registered = new Set(ctx.theme.getTheme().themes.map(theme => theme.id))
    const disposers = themes
      .filter(theme => !registered.has(theme.id))
      .map(theme => ctx.theme.register(theme))
    // 注册表视图随主题服务任意变化（含 dsh-dream-skin 等第三方皮肤插件）实时刷新。
    // 主题切换完全交给 DSH 设置（theme.setTheme）——这里绝不能做「自愈」回放
    // localStorage 里的 Lumo 主题，否则用户在设置里每切一个皮肤主题都会被立即覆盖；
    // Lumo 表面本身的颜色走 --dsw-alias-* 契约，自动跟随任何激活主题。
    const offThemeChange = ctx.on('theme/change', (snapshot: ThemeSnapshot) => {
      publishThemeRegistry(buildRegistry(snapshot))
    })
    publishThemeRegistry(buildRegistry(ctx.theme.getTheme()))
    return () => {
      offThemeChange()
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'lumo-ui: product theme registry')
}
