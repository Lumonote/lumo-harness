/**
 * CSS anchor compatibility for unsupported engines and individually unresolved popups.
 * Runs as a platform client extension: upstream components and their event handlers stay intact.
 */
interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface Bounds { left: number; top: number; width: number; height: number }
type Side = 'top' | 'bottom' | 'right'
interface Placement { side: Side; align: 'start' | 'end'; gap: number; rowOffset?: number; page?: boolean }

export function placeAnchoredOverlay(anchor: Box, size: { width: number; height: number }, bounds: Bounds, placement: Placement): { x: number; y: number } {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  const clamp = (value: number, start: number, end: number) => Math.min(Math.max(value, start), Math.max(start, end))
  if (placement.page) return { x: clamp(anchor.left, bounds.left, right - size.width), y: clamp(anchor.top, bounds.top, bottom - size.height) }
  let x = placement.align === 'end' ? anchor.right - size.width : anchor.left
  let y = placement.side === 'top' ? anchor.top - placement.gap - size.height : anchor.bottom + placement.gap
  if (placement.side === 'right') {
    x = anchor.right + placement.gap
    y = anchor.top + (placement.rowOffset ?? 0)
    if (x + size.width > right && anchor.left - placement.gap - size.width >= bounds.left) x = anchor.left - placement.gap - size.width
  } else if (placement.side === 'top') {
    if (y < bounds.top && anchor.bottom + placement.gap + size.height <= bottom) y = anchor.bottom + placement.gap
  } else if (y + size.height > bottom && anchor.top - placement.gap - size.height >= bounds.top) y = anchor.top - placement.gap - size.height
  return { x: clamp(x, bounds.left, right - size.width), y: clamp(y, bounds.top, bottom - size.height) }
}

/** A geometry probe catches partial implementations that CSS.supports alone would accept. */
export function hasNativeAnchoredOverlays(view: Window & typeof globalThis): boolean {
  if (!view.CSS?.supports?.('position-anchor', '--lumo-probe') || !view.CSS.supports('right', 'anchor(right)')) return false
  const host = view.document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none'
  const anchor = view.document.createElement('span')
  anchor.style.cssText = 'position:fixed;anchor-name:--lumo-position-probe;left:300px;top:300px;width:40px;height:30px'
  const target = view.document.createElement('span')
  target.style.cssText = 'position:fixed;position-anchor:--lumo-position-probe;left:0;top:0;right:anchor(right);bottom:calc(anchor(top) + 8px);justify-self:safe end;align-self:safe end;width:100px;height:50px;margin:0'
  host.append(anchor, target)
  view.document.body.append(host)
  try { const rect = target.getBoundingClientRect(); return Math.abs(rect.left - 240) < 1 && Math.abs(rect.top - 242) < 1 }
  finally { host.remove() }
}

const ACTIVE = Symbol.for('@lumo/anchored-overlays')
type CompatibilityWindow = Window & { [ACTIVE]?: () => void }

function property(style: CSSStyleDeclaration, name: string): string {
  const camel = name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
  return style.getPropertyValue(name) || String((style as unknown as Record<string, unknown>)[camel] ?? '')
}

/**
 * React assigns unknown style properties through JS while Menu's external anchors use setProperty.
 * Preserve only the two missing anchor properties as custom properties on old engines.
 */
function retainUnsupportedInlineAnchors(view: Window & typeof globalThis): () => void {
  if (view.CSS?.supports?.('anchor-name', '--lumo-probe')) return () => {}
  const prototype = view.CSSStyleDeclaration.prototype
  const originalSet = prototype.setProperty
  const originalRemove = prototype.removeProperty
  const originalGet = prototype.getPropertyValue
  const originalPriority = prototype.getPropertyPriority
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const aliases: Record<string, string> = { 'anchor-name': '--lumo-anchor-name', 'position-anchor': '--lumo-position-anchor' }
  const replacement: typeof originalSet = function (this: CSSStyleDeclaration, name, value, priority) { return originalSet.call(this, aliases[name] ?? name, value, priority) }
  const remove: typeof originalRemove = function (this: CSSStyleDeclaration, name) { return originalRemove.call(this, aliases[name] ?? name) }
  const get: typeof originalGet = function (this: CSSStyleDeclaration, name) { return originalGet.call(this, aliases[name] ?? name) }
  const priority: typeof originalPriority = function (this: CSSStyleDeclaration, name) { return originalPriority.call(this, aliases[name] ?? name) }
  prototype.setProperty = replacement
  prototype.removeProperty = remove
  prototype.getPropertyValue = get
  prototype.getPropertyPriority = priority
  for (const [name, alias] of Object.entries(aliases)) {
    const camel = name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
    descriptors.set(camel, Object.getOwnPropertyDescriptor(prototype, camel))
    Object.defineProperty(prototype, camel, { configurable: true, get() { return this.getPropertyValue(alias) }, set(value: string) { originalSet.call(this, alias, value) } })
  }
  return () => {
    if (prototype.setProperty === replacement) prototype.setProperty = originalSet
    if (prototype.removeProperty === remove) prototype.removeProperty = originalRemove
    if (prototype.getPropertyValue === get) prototype.getPropertyValue = originalGet
    if (prototype.getPropertyPriority === priority) prototype.getPropertyPriority = originalPriority
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(prototype, name, descriptor); else delete (prototype as unknown as Record<string, unknown>)[name] }
  }
}

/** Install once per Window; geometry observers track only live popup/anchor pairs. */
export function installAnchoredOverlayFallback(view: Window & typeof globalThis): () => void {
  const shared = view as CompatibilityWindow
  // Non-rendering test/SSR documents have no CSS capability API. Native-capable engines
  // still receive a per-popup geometry check: unresolved anchors can fail independently.
  if (shared[ACTIVE] !== undefined || typeof view.CSS?.supports !== 'function') return () => {}
  const nativeCapable = hasNativeAnchoredOverlays(view)
  const restoreInline = retainUnsupportedInlineAnchors(view)
  const candidates = new Set<HTMLElement>()
  const owned = new Map<HTMLElement, Map<string, { value: string; priority: string }>>()
  const writtenStyles = new WeakMap<HTMLElement, string | null>()
  const writtenProperties = new WeakMap<HTMLElement, Map<string, { value: string; priority: string }>>()
  const configurations = new WeakMap<HTMLElement, { minWidth: string; maxWidth: string; maxHeight: string; side: Side; align: 'start' | 'end' }>()
  const resizeTargets = new Set<Element>()
  let disposed = false
  let frame = 0
  const schedule = () => { if (!disposed && !frame) frame = view.requestAnimationFrame(update) }
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : undefined
  const retainExternalStyles = (element: HTMLElement): void => {
    for (const [name, previous] of writtenProperties.get(element) ?? []) {
      const current = { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }
      if (current.value !== previous.value || current.priority !== previous.priority) owned.get(element)?.set(name, current)
    }
  }
  const restore = (element: HTMLElement): void => {
    retainExternalStyles(element)
    const original = owned.get(element)
    if (original === undefined) return
    for (const [name, item] of original) { if (item.value === '') element.style.removeProperty(name); else element.style.setProperty(name, item.value, item.priority) }
    element.removeAttribute('data-lumo-anchor-fallback')
    writtenStyles.set(element, element.getAttribute('style'))
    owned.delete(element)
    writtenProperties.delete(element)
    configurations.delete(element)
  }
  const write = (element: HTMLElement, name: string, value: string): void => {
    let original = owned.get(element)
    if (original === undefined) { original = new Map(); owned.set(element, original); element.dataset.lumoAnchorFallback = '' }
    if (!original.has(name)) original.set(name, { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })
    if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== 'important') element.style.setProperty(name, value, 'important')
    let written = writtenProperties.get(element)
    if (written === undefined) { written = new Map(); writtenProperties.set(element, written) }
    written.set(name, { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })
  }
  const add = (element: Element): boolean => {
    if (element instanceof view.HTMLElement && (element.getAttribute('style')?.includes('anchor') || element.matches('[data-menu-material],[data-menu-backing],[role="menu"],[role="dialog"]') || property(element.style, 'anchor-name') || property(element.style, 'position-anchor'))) { candidates.add(element); return true }
    return false
  }
  const collect = (root: Element): boolean => { let relevant = add(root); root.querySelectorAll('*').forEach(element => { relevant = add(element) || relevant }); return relevant }
  const resolve = (value: string, style: CSSStyleDeclaration): string => value.replace(/var\(\s*(--[\w-]+)\s*\)/gu, (_, name: string) => style.getPropertyValue(name).trim()).trim()
  const anchorNames = (element: HTMLElement, style: CSSStyleDeclaration): string[] => {
    const value = property(element.style, 'anchor-name') || style.getPropertyValue('anchor-name') || style.getPropertyValue('--lumo-anchor-name')
    const model = element.tagName === 'BUTTON' ? style.getPropertyValue('--dsh-model-anchor') : ''
    const surface = element.hasAttribute('data-menu-material') ? element.style.getPropertyValue('--dsh-menu-anchor') : ''
    const primary = resolve(value, style)
    return (primary.startsWith('--') ? primary : resolve(model || surface, style)).split(/[\s,]+/u).filter(name => name.startsWith('--'))
  }
  const relation = (element: HTMLElement, style: CSSStyleDeclaration): string => {
    // The ModelSelect shares this public variable with its trigger. MenuSurface contributes
    // its own anchor name too, so an unrelated surface name must not replace the model anchor.
    const model = element.hasAttribute('data-menu-material') ? element.style.getPropertyValue('--dsh-model-anchor').trim() : ''
    if (model) return model
    const value = property(element.style, 'position-anchor') || style.getPropertyValue('position-anchor') || style.getPropertyValue('--lumo-position-anchor')
    if (value && value !== 'auto' && value !== 'none') return resolve(value, style)
    if (element.hasAttribute('data-menu-backing')) return element.style.getPropertyValue('--dsh-menu-anchor').trim()
    const submenu = element.style.getPropertyValue('--dsh-submenu-parent').trim()
    if (submenu) return submenu
    if (element.hasAttribute('data-menu-material')) return element.style.getPropertyValue('--dsh-model-anchor').trim()
    return ''
  }
  const observe = (elements: Set<Element>): void => {
    for (const element of resizeTargets) if (!elements.has(element)) { resize?.unobserve(element); resizeTargets.delete(element) }
    for (const element of elements) if (!resizeTargets.has(element)) { resizeTargets.add(element); resize?.observe(element) }
  }
  function update(): void {
    frame = 0
    if (disposed) return
    const anchors = new Map<string, HTMLElement>()
    const targets: Array<{ element: HTMLElement; name: string; style: CSSStyleDeclaration }> = []
    for (const element of candidates) {
      if (!element.isConnected) { restore(element); candidates.delete(element); continue }
      // Computed min()/viewport units may resolve to pixels. Read the component's
      // original sizing again after a viewport change, rather than freezing the
      // maximum observed when the menu first opened in a smaller window.
      const original = owned.get(element)
      for (const name of ['min-width', 'max-width', 'max-height']) {
        const item = original?.get(name)
        if (item !== undefined) { if (item.value === '') element.style.removeProperty(name); else element.style.setProperty(name, item.value, item.priority) }
      }
      const style = view.getComputedStyle(element)
      if (style.display === 'none') continue
      for (const name of anchorNames(element, style)) anchors.set(name, element)
      const name = relation(element, style)
      if (name && (style.position === 'fixed' || element.hasAttribute('data-menu-backing'))) targets.push({ element, name, style })
    }
    // Submenus depend on the root menu, and backing rectangles depend on both. DOM order alone
    // cannot express this because React portals can append a backing before the visible menu.
    targets.sort((a, b) => Number(a.element.hasAttribute('data-menu-backing')) - Number(b.element.hasAttribute('data-menu-backing')) || Number(a.element.hasAttribute('data-submenu-layout')) - Number(b.element.hasAttribute('data-submenu-layout')))
    const observed = new Set<Element>()
    const active = new Set<HTMLElement>()
    const viewport = view.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportWidth = viewport?.width ?? view.innerWidth
    const viewportHeight = viewport?.height ?? view.innerHeight
    for (const { element, name, style } of targets) {
      const anchor = anchors.get(name)
      if (anchor === undefined || anchor === element || anchor.closest('[hidden]') !== null) { restore(element); continue }
      active.add(element); observed.add(element); observed.add(anchor)
      const anchorBox = anchor.getBoundingClientRect()
      if (element.hasAttribute('data-menu-backing')) {
        if (nativeCapable && !owned.has(anchor)) continue
        write(element, 'left', `${anchorBox.left}px`); write(element, 'top', `${anchorBox.top}px`)
        write(element, 'width', `${anchorBox.width}px`); write(element, 'height', `${anchorBox.height}px`)
        writtenStyles.set(element, element.getAttribute('style')); continue
      }
      const contextual = element.hasAttribute('data-context-menu') || element.hasAttribute('data-contextual')
      const safeTop = contextual ? 12 : Math.max(12, Number.parseFloat(style.getPropertyValue('--dsh-frame-overlay-top')) || 12)
      const bounds = { left: viewportLeft + 12, top: viewportTop + safeTop, width: Math.max(0, viewportWidth - 24), height: Math.max(0, viewportHeight - safeTop - 12) }
      const model = element.style.getPropertyValue('--dsh-model-anchor') !== ''
      const submenu = element.hasAttribute('data-submenu-layout')
      let config = configurations.get(element)
      if (config === undefined) {
        config = { minWidth: style.minWidth, maxWidth: style.maxWidth, maxHeight: style.maxHeight, side: model || style.alignSelf.includes('end') ? 'top' : 'bottom', align: model || style.justifySelf.includes('end') ? 'end' : 'start' }
        configurations.set(element, config)
      } else { config.minWidth = style.minWidth; config.maxWidth = style.maxWidth; config.maxHeight = style.maxHeight }
      const side: Side = submenu ? 'right' : ['right', 'top', 'bottom'].includes(element.dataset.anchorSide ?? '') ? element.dataset.anchorSide as Side : config.side
      const align = element.dataset.anchorAlign === 'end' ? 'end' : element.dataset.anchorAlign === 'start' ? 'start' : config.align
      const expected = placeAnchoredOverlay(anchorBox, element.getBoundingClientRect(), bounds, { side, align, gap: model ? 8 : 4, page: element.dataset.submenuLayout === 'page', rowOffset: Number.parseFloat(style.getPropertyValue('--dsh-submenu-row-offset')) || 0 })
      const current = element.getBoundingClientRect()
      const strandedAtOrigin = current.left <= viewportLeft + 24 && current.top <= viewportTop + safeTop + 12 && (Math.abs(current.left - expected.x) > 40 || Math.abs(current.top - expected.y) > 40)
      if (nativeCapable && !owned.has(element) && !strandedAtOrigin) continue
      write(element, 'position', 'fixed'); write(element, 'right', 'auto'); write(element, 'bottom', 'auto'); write(element, 'margin', '0px')
      write(element, 'align-self', 'auto'); write(element, 'justify-self', 'auto')
      const limit = (value: string, pixels: number): string => !value || value === 'none' || value === 'auto' ? `${pixels}px` : `min(${value}, ${pixels}px)`
      // Keep component-authored min()/calc() limits intact. parseFloat would silently
      // drop these limits on engines that retain their computed CSS expression.
      write(element, 'max-width', limit(config.maxWidth, bounds.width))
      write(element, 'max-height', limit(config.maxHeight, bounds.height))
      const minWidth = !config.minWidth || config.minWidth === 'auto' ? '0px' : config.minWidth
      write(element, 'min-width', element.hasAttribute('data-match-anchor-width') || element.dataset.submenuLayout === 'page' ? `${Math.min(bounds.width, anchorBox.width)}px` : limit(minWidth, bounds.width))
      const size = element.getBoundingClientRect()
      const placement = placeAnchoredOverlay(anchorBox, size, bounds, { side, align, gap: model ? 8 : 4, page: element.dataset.submenuLayout === 'page', rowOffset: Number.parseFloat(style.getPropertyValue('--dsh-submenu-row-offset')) || 0 })
      // Fixed body portals and top-layer popovers share the current document's viewport; no
      // parent-frame offsets are added. Each iframe installs against its own owner Window.
      write(element, 'left', `${placement.x}px`); write(element, 'top', `${placement.y}px`)
      writtenStyles.set(element, element.getAttribute('style'))
    }
    for (const element of owned.keys()) if (!active.has(element)) restore(element)
    observe(observed)
  }
  const observer = new view.MutationObserver(records => {
    let changed = false
    for (const record of records) {
      if (record.type === 'attributes') {
        const element = record.target as HTMLElement
        if (record.attributeName === 'style' && writtenStyles.has(element) && writtenStyles.get(element) === element.getAttribute('style')) continue
        if (record.attributeName === 'style') {
          // Owners can legitimately change inline sizing while a menu is open.
          // Preserve their latest value when it differs from our last override,
          // both for the next layout and for cleanup when the menu closes.
          retainExternalStyles(element)
        }
        changed = add(element) || resizeTargets.size > 0 || changed
      } else {
        record.addedNodes.forEach(node => { if (node instanceof view.Element) changed = collect(node) || node.tagName === 'STYLE' || changed })
        changed = resizeTargets.size > 0 || changed
      }
    }
    if (changed) schedule()
  })
  collect(view.document.body)
  observer.observe(view.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-anchor-side', 'data-anchor-align', 'data-submenu-layout'] })
  view.addEventListener('resize', schedule)
  view.document.addEventListener('scroll', schedule, true)
  view.visualViewport?.addEventListener('resize', schedule)
  view.visualViewport?.addEventListener('scroll', schedule)
  schedule()
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (frame) view.cancelAnimationFrame(frame)
    observer.disconnect(); resize?.disconnect()
    view.removeEventListener('resize', schedule); view.document.removeEventListener('scroll', schedule, true)
    view.visualViewport?.removeEventListener('resize', schedule); view.visualViewport?.removeEventListener('scroll', schedule)
    for (const element of owned.keys()) restore(element)
    restoreInline()
    candidates.clear(); resizeTargets.clear()
    if (shared[ACTIVE] === dispose) delete shared[ACTIVE]
  }
  shared[ACTIVE] = dispose
  return dispose
}
