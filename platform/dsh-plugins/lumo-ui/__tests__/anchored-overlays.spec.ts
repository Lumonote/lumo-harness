// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasNativeAnchoredOverlays, installAnchoredOverlayFallback, placeAnchoredOverlay } from '../src/client/anchored-overlays.ts'

const disposers: Array<() => void> = []
afterEach(() => { for (const stop of disposers.splice(0).reverse()) stop(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const anchor = { left: 700, top: 500, right: 800, bottom: 530, width: 100, height: 30 }
const bounds = { left: 12, top: 12, width: 976, height: 676 }
const size = { width: 240, height: 120 }

describe('弹层定位几何', () => {
  it('模型菜单在按钮上方并右对齐', () => expect(placeAnchoredOverlay(anchor, size, bounds, { side: 'top', align: 'end', gap: 8 })).toEqual({ x: 560, y: 372 }))
  it('上方空间不足时翻转到底部', () => expect(placeAnchoredOverlay({ ...anchor, top: 40, bottom: 70 }, size, bounds, { side: 'top', align: 'end', gap: 8 })).toEqual({ x: 560, y: 78 }))
  it('下方空间不足时向上翻转，过高弹层夹在可见范围', () => {
    expect(placeAnchoredOverlay({ ...anchor, top: 620, bottom: 650 }, size, bounds, { side: 'bottom', align: 'start', gap: 4 })).toEqual({ x: 700, y: 496 })
    expect(placeAnchoredOverlay(anchor, { width: 2000, height: 2000 }, bounds, { side: 'bottom', align: 'start', gap: 4 })).toEqual({ x: 12, y: 12 })
  })
  it('子菜单右侧不足时向左展开并按行偏移对齐', () => expect(placeAnchoredOverlay(anchor, size, bounds, { side: 'right', align: 'start', gap: 4, rowOffset: 25 })).toEqual({ x: 456, y: 525 }))
  it('窄窗口子菜单页沿用父菜单位置，visualViewport偏移只加一次', () => expect(placeAnchoredOverlay(anchor, size, { left: 500, top: 300, width: 300, height: 200 }, { side: 'right', align: 'start', gap: 4, page: true })).toEqual({ x: 560, y: 380 }))
})

function rect(left: number, top: number, width: number, height: number): DOMRect { return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {} } }
function fixture() {
  vi.stubGlobal('CSS', { supports: () => false })
  const callbacks = new Map<number, FrameRequestCallback>()
  let seq = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callbacks.set(++seq, callback); return seq })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id) })
  const flush = async () => { await Promise.resolve(); const pending = [...callbacks]; callbacks.clear(); for (const [, callback] of pending) callback(0); await Promise.resolve() }
  const trigger = document.createElement('button')
  trigger.style.setProperty('--dsh-model-anchor', '--model-fixture')
  const menu = document.createElement('div')
  menu.setAttribute('data-menu-material', 'translucent')
  menu.style.cssText = 'position:fixed;left:12px;top:12px;max-width:420px;max-height:360px;--dsh-model-anchor:--model-fixture'
  let anchorBox = rect(700, 500, 100, 30)
  trigger.getBoundingClientRect = () => anchorBox
  menu.getBoundingClientRect = () => rect(Number.parseFloat(menu.style.left) || 0, Number.parseFloat(menu.style.top) || 0, 240, 120)
  document.body.append(trigger, menu)
  disposers.push(installAnchoredOverlayFallback(window))
  return { trigger, menu, flush, callbacks, move: (next: DOMRect) => { anchorBox = next } }
}

describe('平台CSS anchor兼容层', () => {
  it('动态portal读取公开anchor变量，随scroll和resize更新，清理后还原原样式', async () => {
    const { menu, flush, move, callbacks } = fixture()
    await flush()
    expect(menu.style.left).toBe('560px')
    expect(menu.style.top).toBe('372px')
    move(rect(400, 350, 100, 30))
    document.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    expect(callbacks.size).toBe(1)
    await flush()
    expect(menu.style.left).toBe('260px')
    expect(menu.style.top).toBe('222px')
    disposers.pop()!()
    expect(menu.style.left).toBe('12px')
    expect(menu.style.top).toBe('12px')
    expect(menu.style.maxWidth).toBe('420px')
    expect(menu.hasAttribute('data-lumo-anchor-fallback')).toBe(false)
  })

  it('不更改居中的设置dialog或无锚定的modal', async () => {
    const { flush } = fixture()
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center'
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.style.cssText = 'position:relative;width:800px;height:600px'
    overlay.append(dialog); document.body.append(overlay)
    const original = overlay.getAttribute('style')
    await flush()
    expect(overlay.getAttribute('style')).toBe(original)
    expect(dialog.hasAttribute('data-lumo-anchor-fallback')).toBe(false)
  })

  it('保留组件自己的calc和min尺寸上限，夹住极窄窗口中的最小宽度', async () => {
    const { menu, flush } = fixture()
    vi.stubGlobal('innerWidth', 200)
    menu.style.setProperty('min-width', '240px')
    menu.style.setProperty('max-width', 'min(420px, calc(100vw - 24px))')
    menu.style.setProperty('max-height', 'min(360px, calc(100dvh - 96px))')
    await flush()
    expect(menu.style.minWidth).toBe('calc(176px)')
    expect(menu.style.maxWidth).toContain('176px')
    expect(menu.style.maxWidth).toContain('100vw')
    expect(menu.style.maxHeight).toContain('360px')
    expect(menu.style.maxHeight).toContain('100dvh')
    disposers.pop()!()
    expect(menu.style.minWidth).toBe('240px')
    expect(menu.style.maxWidth).toBe('min(420px, calc(100vw - 24px))')
  })

  it('窄窗口打开后扩大窗口，重新读取组件尺寸限制', async () => {
    const { menu, flush } = fixture()
    const original = window.getComputedStyle.bind(window)
    let available = 176
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = original(element)
      if (element !== menu) return style
      return new Proxy(style, { get(target, name) {
        if (name === 'maxWidth') return menu.style.maxWidth === '420px' ? `${Math.min(420, available)}px` : target.maxWidth
        if (name === 'maxHeight') return menu.style.maxHeight === '360px' ? `${Math.min(360, available)}px` : target.maxHeight
        return Reflect.get(target, name)
      } })
    })
    await flush()
    expect(menu.style.maxWidth).toContain('176px')
    available = 976
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(menu.style.maxWidth).toContain('420px')
    expect(menu.style.maxHeight).toContain('360px')
  })

  it('组件在菜单打开时更新inline尺寸，重新定位与卸载都保留新值', async () => {
    const { menu, flush } = fixture()
    await flush()
    menu.style.maxHeight = '100px'
    menu.style.maxWidth = '200px'
    await flush()
    expect(menu.style.maxHeight).toBe('calc(100px)')
    expect(menu.style.maxWidth).toBe('calc(200px)')
    disposers.pop()!()
    expect(menu.style.maxHeight).toBe('100px')
    expect(menu.style.maxWidth).toBe('200px')
    expect(menu.style.left).toBe('12px')
  })

  it('同步卸载发生在observer通知前，也保留组件刚写入的尺寸', async () => {
    const { menu, flush } = fixture()
    await flush()
    menu.style.setProperty('max-height', '100px', 'important')
    disposers.pop()!()
    expect(menu.style.maxHeight).toBe('100px')
    expect(menu.style.getPropertyPriority('max-height')).toBe('important')
  })

  it('遵循弹层继承的桌面顶栏安全区，右键菜单仍使用窗口边距', async () => {
    const { menu, move, flush } = fixture()
    move(rect(100, 20, 100, 28))
    menu.style.setProperty('--dsh-frame-overlay-top', '60px')
    await flush()
    expect(menu.style.top).toBe('60px')
    menu.setAttribute('data-context-menu', '')
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(menu.style.top).toBe('56px')
  })

  it('支持旧引擎 React style属性与external Menu setProperty赋值并完整恢复prototype', async () => {
    const { menu, trigger, flush } = fixture()
    menu.style.removeProperty('--dsh-model-anchor')
    menu.setAttribute('data-anchor-side', 'top')
    menu.setAttribute('data-anchor-align', 'end')
    trigger.style.setProperty('anchor-name', '--external-trigger')
    menu.style.setProperty('position-anchor', '--external-trigger')
    expect(trigger.style.getPropertyValue('anchor-name')).toBe('--external-trigger')
    await flush()
    expect(menu.style.top).toBe('376px')
    trigger.style.removeProperty('anchor-name')
    expect(trigger.style.getPropertyValue('anchor-name')).toBe('')
  })

  it('能力probe按真实几何判断，不把CSS.supports当完整支持', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    expect(hasNativeAnchoredOverlays(window)).toBe(false)
    expect(document.body.children.length).toBe(0)
  })

  it('原生能力完整时保留正常菜单，仅修复独立滞留左上的模型popup', async () => {
    vi.stubGlobal('CSS', { supports: () => true })
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.style.getPropertyValue('position-anchor') === '--lumo-position-probe') return rect(240, 242, 100, 50)
      return originalRect.call(this)
    })
    const callbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callbacks.push(callback); return callbacks.length })
    const trigger = document.createElement('button')
    trigger.style.setProperty('--dsh-model-anchor', '--capable-model')
    trigger.getBoundingClientRect = () => rect(700, 500, 100, 30)
    const createMenu = (correct: boolean) => {
      const menu = document.createElement('div')
      menu.style.cssText = 'position:fixed;left:12px;top:12px;--dsh-model-anchor:--capable-model'
      menu.setAttribute('data-menu-material', 'translucent')
      menu.getBoundingClientRect = () => correct ? rect(560, 372, 240, 120) : rect(Number.parseFloat(menu.style.left), Number.parseFloat(menu.style.top), 240, 120)
      return menu
    }
    const good = createMenu(true); const bad = createMenu(false)
    document.body.append(trigger, good, bad)
    disposers.push(installAnchoredOverlayFallback(window))
    for (const callback of callbacks.splice(0)) callback(0)
    expect(good.hasAttribute('data-lumo-anchor-fallback')).toBe(false)
    expect(bad.style.left).toBe('560px')
    expect(bad.style.top).toBe('372px')
  })

  it('新菜单出现可定位，关闭后无需timer或全DOM轮询', async () => {
    const { menu, trigger, flush, callbacks } = fixture()
    await flush()
    menu.remove()
    await flush()
    const second = document.createElement('div')
    second.style.cssText = 'position:fixed;position-anchor:--second;left:0;top:0;max-width:400px'
    second.setAttribute('data-anchor-side', 'bottom')
    trigger.style.setProperty('anchor-name', '--second')
    second.style.setProperty('position-anchor', '--second')
    second.getBoundingClientRect = () => rect(0, 0, 200, 80)
    document.body.append(second)
    await flush()
    expect(second.style.left).toBe('700px')
    expect(second.style.top).toBe('534px')
    await flush()
    expect(callbacks.size).toBe(0)
  })
})
