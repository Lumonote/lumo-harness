import { describe, expect, it, vi } from 'vitest'

import { lumoBootThemeInjection } from '../src/boot-theme.ts'
import { apply, type Config } from '../src/index.ts'
import { LUMO_DEFAULT_THEME, LUMO_THEME_CATALOG, LUMO_THEME_STORAGE_KEY } from '../src/theme-catalog.ts'

/**
 * 预插件区间的主题引导。上游 ui-theme 在 `webserver/index-inject` 上推一条 body
 * 脚本，按它自己的耐久偏好（默认 `system`）决定 light/dark。Lumo 的四套主题走
 * localStorage，上游那条脚本读不到 —— 于是浅色系统上每次加载都先刷一帧白底。
 *
 * 这里补的是同一事件上的第二条脚本：body 行按 table 顺序拼接（webserver/
 * injections.ts `renderIndexInjections`「each group in table order」），本插件
 * 晚于 ui-theme 注册，所以后写的字段赢。
 */

/** 在 node 环境里跑浏览器脚本：把 document/localStorage 作形参注入,逻辑与线上同一条。 */
function runBootScript(text: string, stored: string | null): { colorScheme: string; dark: boolean } {
  const documentDouble = {
    documentElement: { style: { colorScheme: '' } },
    body: {
      dark: false,
      toggleAttribute(name: string, force: boolean) {
        if (name !== 'data-ds-dark-theme') throw new Error(`unexpected attribute ${name}`)
        this.dark = force
      },
    },
  }
  const localStorageDouble = { getItem: vi.fn(() => stored) }
  // eslint-disable-next-line no-new-func
  new Function('document', 'localStorage', text)(documentDouble, localStorageDouble)
  return { colorScheme: documentDouble.documentElement.style.colorScheme, dark: documentDouble.body.dark }
}

describe('Lumo 引导主题注入', () => {
  it('注册为 body 脚本行,与上游同一放置点', () => {
    const row = lumoBootThemeInjection()
    expect(row.kind).toBe('script')
    expect(row.placement).toBe('body')
  })

  it('无存储值时按默认主题上色', () => {
    const { colorScheme, dark } = runBootScript(lumoBootThemeInjection().text, null)
    expect(colorScheme).toBe(LUMO_THEME_CATALOG[LUMO_DEFAULT_THEME] === 'dark' ? 'dark' : 'light')
    expect(dark).toBe(LUMO_THEME_CATALOG[LUMO_DEFAULT_THEME] === 'dark')
  })

  it('目录里每套主题都能被存储值选中', () => {
    for (const [id, colorScheme] of Object.entries(LUMO_THEME_CATALOG)) {
      expect(runBootScript(lumoBootThemeInjection().text, id)).toEqual({
        colorScheme,
        dark: colorScheme === 'dark',
      })
    }
  })

  it('陌生值与原型链键都退回默认,不读到 Object.prototype 上的东西', () => {
    const fallback = LUMO_THEME_CATALOG[LUMO_DEFAULT_THEME]
    for (const hostile of ['midnight-unknown', '__proto__', 'constructor', 'toString']) {
      expect(runBootScript(lumoBootThemeInjection().text, hostile)).toEqual({
        colorScheme: fallback,
        dark: fallback === 'dark',
      })
    }
  })

  it('localStorage 抛异常时仍然上色(隐私模式下 getItem 会 throw)', () => {
    const text = lumoBootThemeInjection().text
    const documentDouble = {
      documentElement: { style: { colorScheme: '' } },
      body: { dark: false, toggleAttribute(_n: string, force: boolean) { this.dark = force } },
    }
    const hostile = { getItem: () => { throw new Error('SecurityError') } }
    // eslint-disable-next-line no-new-func
    expect(() => { new Function('document', 'localStorage', text)(documentDouble, hostile) }).not.toThrow()
    expect(documentDouble.documentElement.style.colorScheme).toBe(LUMO_THEME_CATALOG[LUMO_DEFAULT_THEME])
  })

  it('脚本内嵌的是目录本身,不是手抄的一份常量', () => {
    // 目录是唯一真相源：将来加一套浅色主题,脚本必须跟着变,而不是继续硬编码 dark。
    const text = lumoBootThemeInjection().text
    expect(text).toContain(JSON.stringify(LUMO_THEME_CATALOG))
    expect(text).toContain(JSON.stringify(LUMO_THEME_STORAGE_KEY))
  })
})

/** 只做本用例需要的四件事：事件登记、服务查表、effect、webServer 注册。 */
function hostContextDouble(): { ctx: unknown; listeners: Map<string, Array<(table: unknown[]) => void>> } {
  const listeners = new Map<string, Array<(table: unknown[]) => void>>()
  const ctx = {
    on(event: string, handler: (table: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return () => {}
    },
    get: () => undefined,
    inject: (_names: string[], body: (c: unknown) => void) => { body(ctx) },
    effect: (body: () => unknown) => { body() },
    webServer: { register: () => () => {} },
  }
  return { ctx, listeners }
}

const LOCAL_CONFIG = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'u1', roles: [], projectId: '', deptId: '',
  controlPlaneToken: '', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'local', storageBackend: 'sqlite', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as unknown as Config

describe('宿主插件装配', () => {
  it('把引导脚本挂到 webserver/index-inject 上', () => {
    const { ctx, listeners } = hostContextDouble()
    apply(ctx as never, LOCAL_CONFIG)

    const handlers = listeners.get('webserver/index-inject') ?? []
    expect(handlers).toHaveLength(1)
    const table: unknown[] = []
    handlers[0]?.(table)
    expect(table).toEqual([lumoBootThemeInjection()])
  })
})
