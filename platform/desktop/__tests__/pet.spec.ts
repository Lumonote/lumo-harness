import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountPet } from '../../desktop-assets/pet.mjs'
import { BREACH_DURATION, paintWhaleFrame, WHALE_ATLAS } from '../../desktop-assets/pet-motion.mjs'

const html = readFileSync(new URL('../../desktop-assets/pet.html', import.meta.url), 'utf8')
const ready = { runtime: 'ready', always_on_top: true, launch_on_start: true, compact: true }
const cleanups: Array<() => void> = []
const pixels = new Uint8ClampedArray(2304 * 1296 * 4)
for (let index = 0; index < WHALE_ATLAS.frames; index++) {
  const offset = ((Math.floor(index / 12) * 108 + 54) * 2304 + index % 12 * 192 + 96) * 4
  pixels[offset] = 128
  pixels[offset + 1] = 200
}
function drawing() {
  return { clearRect: vi.fn(), drawImage: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels })), globalAlpha: 1, fillStyle: '' }
}
type NativeCall = (command: string, args?: Record<string, unknown>) => unknown

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve() }
function fixture(native?: NativeCall, options: { reduced?: boolean } = {}) {
  const dom = new JSDOM(html, { url: 'http://tauri.localhost/pet.html', pretendToBeVisual: true })
  const view = dom.window
  const output = drawing()
  const reader = drawing()
  Object.defineProperty(view.HTMLCanvasElement.prototype, 'getContext', {
    value(this: HTMLCanvasElement) { return this.id === 'whale-canvas' ? output : reader },
  })
  const image = view.document.createElement('img')
  Object.defineProperties(image, { naturalWidth: { value: 2304, configurable: true }, naturalHeight: { value: 1296 } })
  Object.assign(view, { Image: function () { return image } })
  const load = () => image.dispatchEvent(new view.Event('load'))
  let clock = 0
  let rafID = 0
  const rafs = new Map<number, FrameRequestCallback>()
  Object.defineProperty(view.performance, 'now', { value: () => clock })
  view.requestAnimationFrame = callback => { rafs.set(++rafID, callback); return rafID }
  view.cancelAnimationFrame = id => { rafs.delete(id) }
  const frame = (time: number) => {
    clock = time
    const callbacks = [...rafs.values()]
    rafs.clear()
    callbacks.forEach(callback => callback(time))
  }
  if (options.reduced) Object.assign(view, { matchMedia: () => ({ matches: true }) })
  const invoke = vi.fn(native ?? (() => undefined))
  if (native) Object.assign(view, { __TAURI__: { core: { invoke } } })
  const dispose = mountPet(view)
  cleanups.push(() => { dispose(); dom.window.close() })
  const element = <T extends HTMLElement = HTMLElement>(id: string) => view.document.getElementById(id) as T
  const input = (value: string) => {
    element<HTMLTextAreaElement>('draft').value = value
    element('draft').dispatchEvent(new view.Event('input', { bubbles: true }))
  }
  const key = (id: string, key: string, extra: KeyboardEventInit = {}) => element(id).dispatchEvent(new view.KeyboardEvent('keydown', { key, bubbles: true, ...extra }))
  const pointer = (event: string, x: number, target = element('whale')) => {
    const value = new view.MouseEvent(event, { button: 0, screenX: x, screenY: 10, bubbles: true })
    Object.defineProperty(value, 'pointerId', { value: 7 })
    target.dispatchEvent(value)
  }
  return { view, invoke, dispose, element, input, key, pointer, frame, rafs, load, image, output, reader }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); vi.useRealTimers() })

describe('desktop companion', () => {
  it('previews appearance and keyboard navigation without claiming native actions succeeded', async () => {
    const pet = fixture()
    pet.element('whale').click()
    expect(pet.element('assistant').hidden).toBe(false)
    expect(pet.view.document.activeElement).toBe(pet.element('draft'))
    expect(pet.element<HTMLButtonElement>('open-home').disabled).toBe(true)
    pet.input('a local idea')
    pet.key('draft', 'Enter', { ctrlKey: true })
    await settle()
    expect(pet.invoke).not.toHaveBeenCalled()
    expect(pet.element('feedback').textContent).toContain('请等待桌面工作台就绪')
    pet.element('settings').click()
    pet.key('settings', 'Escape')
    expect(pet.element('preferences').hidden).toBe(true)
    expect(pet.view.document.activeElement).toBe(pet.element('settings'))
    pet.key('settings', 'Escape')
    expect(pet.element('assistant').hidden).toBe(true)
    expect(pet.view.document.activeElement).toBe(pet.element('whale'))
    expect(pet.element('runtime-label').textContent).toBe('外观预览')
  })

  it('waits for a valid snapshot before enabling preferences and a draft handoff', async () => {
    const state = deferred<typeof ready>()
    const pet = fixture(command => command === 'pet_snapshot' ? state.promise : undefined)
    pet.input('hello')
    expect(pet.element<HTMLInputElement>('always-on-top').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(true)
    state.resolve({ ...ready, always_on_top: false })
    await settle()
    expect(pet.element<HTMLInputElement>('always-on-top').disabled).toBe(false)
    expect(pet.element<HTMLInputElement>('always-on-top').checked).toBe(false)
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(false)
  })

  it('clears a draft only after native acknowledgment and blocks duplicate handoffs', async () => {
    const handoff = deferred<void>()
    const pet = fixture(command => command === 'pet_snapshot' ? ready : command === 'pet_open_workbench' ? handoff.promise : undefined)
    await settle()
    pet.element('whale').click()
    await settle()
    const draft = '保留原文 <script>literal</script>\n第二行'
    pet.input(draft)
    pet.key('draft', 'Enter', { metaKey: true })
    pet.key('draft', 'Enter', { ctrlKey: true })
    await settle()
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')).toEqual([
      ['pet_open_workbench', { target: 'chat', draft }],
    ])
    expect(pet.element<HTMLTextAreaElement>('draft').readOnly).toBe(true)
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe(draft)
    handoff.resolve()
    await settle()
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe('')
    expect(pet.element('feedback').textContent).toContain('请在工作台确认发送')
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(true)
  })

  it('retains failed drafts and ignores an IME confirmation keystroke', async () => {
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ready
      if (command === 'pet_open_workbench') throw Error('workbench unavailable')
    })
    await settle()
    pet.input('需要保留的想法')
    pet.key('draft', 'Enter', { ctrlKey: true, isComposing: true })
    await settle()
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')).toHaveLength(0)
    pet.key('draft', 'Enter', { ctrlKey: true })
    await settle()
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe('需要保留的想法')
    expect(pet.element('feedback').textContent).toContain('草稿已保留')
    expect(pet.element<HTMLTextAreaElement>('draft').readOnly).toBe(false)
  })

  it('does not let an older poll collapse a newly expanded companion', async () => {
    const stale = deferred<typeof ready>()
    let reads = 0
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ++reads === 1 ? ready : stale.promise
    })
    await settle()
    await vi.advanceTimersByTimeAsync(2500)
    pet.element('whale').click()
    await settle()
    expect(pet.element('assistant').hidden).toBe(false)
    stale.resolve(ready)
    await settle()
    expect(pet.element('assistant').hidden).toBe(false)
    expect(pet.element('whale').getAttribute('aria-expanded')).toBe('true')
  })

  it('disables stale ready actions on disconnect and recovers after a valid poll', async () => {
    let offline = false
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return offline ? { ...ready, compact: 'invalid' } : ready
    })
    await settle()
    pet.input('idea')
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(false)
    offline = true
    await vi.advanceTimersByTimeAsync(2500)
    expect(pet.element('runtime-label').textContent).toBe('连接中断')
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(true)
    expect(pet.element<HTMLInputElement>('always-on-top').disabled).toBe(true)
    offline = false
    await vi.advanceTimersByTimeAsync(2500)
    expect(pet.element('runtime-label').textContent).toBe('随时待命')
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(false)
    expect(pet.element('feedback').textContent).toBe('')
  })

  it('rolls back a failed preference save without losing the draft', async () => {
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ready
      if (command === 'pet_set_preferences') throw Error('disk full')
    })
    await settle()
    pet.input('keep me')
    const toggle = pet.element<HTMLInputElement>('always-on-top')
    toggle.checked = false
    toggle.dispatchEvent(new pet.view.Event('change', { bubbles: true }))
    await settle()
    expect(toggle.checked).toBe(true)
    expect(pet.element('feedback').textContent).toContain('已恢复原来的设置')
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe('keep me')
    expect(pet.invoke).toHaveBeenCalledWith('pet_set_preferences', { alwaysOnTop: false, launchOnStart: true })
  })

  it('suppresses the click after native drag cancellation and allows keyboard activation', async () => {
    const pet = fixture(command => command === 'pet_snapshot' ? ready : undefined)
    await settle()
    pet.pointer('pointerdown', 10)
    pet.pointer('pointermove', 20)
    pet.pointer('pointercancel', 20)
    pet.element('whale').dispatchEvent(new pet.view.MouseEvent('click', { detail: 1, bubbles: true }))
    await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_start_drag', undefined)
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_set_expanded')).toHaveLength(0)
    pet.element('whale').click()
    await settle()
    expect(pet.element('assistant').hidden).toBe(false)
  })

  it('opens settings with a right click and releases listeners and polling on disposal', async () => {
    const pet = fixture(command => command === 'pet_snapshot' ? ready : undefined)
    await settle()
    pet.element('whale').dispatchEvent(new pet.view.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    expect(pet.element('assistant').hidden).toBe(false)
    expect(pet.element('preferences').hidden).toBe(false)
    expect(pet.element('settings').getAttribute('aria-expanded')).toBe('true')
    pet.dispose()
    const count = pet.invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    pet.element('view-tasks').click()
    await settle()
    expect(pet.invoke.mock.calls).toHaveLength(count)
  })

  it('rejects oversized drafts even when entered programmatically', async () => {
    const pet = fixture(command => command === 'pet_snapshot' ? ready : undefined)
    await settle()
    pet.input('x'.repeat(12001))
    pet.key('draft', 'Enter', { ctrlKey: true })
    await settle()
    expect(pet.element('feedback').textContent).toContain('最多 12,000 字符')
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')).toHaveLength(0)
  })

  it('plays a compact breach once, then allows another breach after landing', async () => {
    const pet = fixture()
    pet.element('jump').click()
    expect(pet.element('assistant').hidden).toBe(true)
    expect(pet.view.document.querySelector('[data-pet-root]')?.getAttribute('data-action')).toBe('breach')
    expect(pet.element<HTMLButtonElement>('jump').disabled).toBe(true)
    pet.element('jump').click()
    await vi.advanceTimersByTimeAsync(BREACH_DURATION - 1)
    expect(pet.view.document.querySelector('[data-pet-root]')?.getAttribute('data-action')).toBe('breach')
    await vi.advanceTimersByTimeAsync(1)
    expect(pet.element('play-feedback').textContent).toBe('巨鲸落入海中，溅起水花。')
    expect(pet.element<HTMLButtonElement>('jump').disabled).toBe(false)
    pet.element('jump').click()
    expect(pet.element('play-feedback').textContent).toContain('甩尾破水跃起')
    expect(pet.invoke).not.toHaveBeenCalled()
  })

  it('cancels a breach for dragging, prevents another during drag, and cleans the timer', async () => {
    const drag = deferred<void>()
    const pet = fixture(command => command === 'pet_snapshot' ? ready : command === 'pet_start_drag' ? drag.promise : undefined)
    await settle()
    pet.element('jump').click()
    pet.pointer('pointerdown', 10)
    pet.pointer('pointermove', 22)
    await settle()
    expect(pet.view.document.querySelector('[data-pet-root]')?.hasAttribute('data-action')).toBe(false)
    expect(pet.element<HTMLButtonElement>('jump').disabled).toBe(true)
    pet.element('jump').click()
    expect(pet.view.document.querySelector('[data-pet-root]')?.hasAttribute('data-action')).toBe(false)
    drag.resolve()
    await settle()
    pet.element('jump').click()
    expect(pet.view.document.querySelector('[data-pet-root]')?.getAttribute('data-action')).toBe('breach')
    pet.dispose()
    await vi.advanceTimersByTimeAsync(BREACH_DURATION + 100)
    expect(pet.view.document.querySelector('[data-pet-root]')?.hasAttribute('data-action')).toBe(false)
    expect(pet.element('play-feedback').textContent).toBe('')
  })

  it('uses a short static celebration for reduced motion', async () => {
    const pet = fixture(undefined, { reduced: true })
    pet.element('jump').click()
    await vi.advanceTimersByTimeAsync(1400)
    expect(pet.view.document.querySelector('[data-pet-root]')?.hasAttribute('data-action')).toBe(false)
    expect(pet.element('play-feedback').textContent).toBe('巨鲸落入海中，溅起水花。')
  })


  it('ships the exact official atlas instead of a redrawn whale', () => {
    const atlas = readFileSync(new URL('../../desktop-assets/pet-breach-atlas.webp', import.meta.url))
    expect(createHash('sha256').update(atlas).digest('hex')).toBe('6ab7c778b7085b0248525bd5640933eee2891c836ba33129a1bd6bbae80eaf63')
    expect(html).not.toContain('whale-body')
    expect(html).not.toContain('dragon-gate')
    const pet = fixture()
    expect(pet.element('jump').textContent?.trim()).toBe('')
    expect(pet.element('compact-status').classList.contains('sr-only')).toBe(true)
    expect(pet.image.src).toContain('pet-breach-atlas.webp')
    expect(pet.element('whale-canvas').dataset.ready).toBeUndefined()
    pet.load()
    expect(pet.element('whale-canvas').dataset.ready).toBe('true')
    expect(pet.reader.drawImage).toHaveBeenCalled()
    expect(pet.output.arc).toHaveBeenCalled()
  })

  it('preserves official cell positions while making the silhouette solid and retaining water attenuation', () => {
    const context = drawing()
    const paintedAlpha: number[] = []
    context.fill.mockImplementation(() => { paintedAlpha.push(context.globalAlpha) })
    paintWhaleFrame(context, pixels, 136, 320, 280, '#405ce8')
    const cell = 320 / 192 * .98
    expect(context.arc).toHaveBeenCalledTimes(1)
    expect(context.arc).toHaveBeenCalledWith((320 - 192 * cell) / 2 + 96.5 * cell,
      (280 - 108 * cell) / 2 + 54.5 * cell, Math.min(128 / 255 * 1.6, .64) * cell, 0, Math.PI * 2)
    expect(context.fillStyle).toBe('#405ce8')
    expect(paintedAlpha).toEqual([1])
    const water = new Uint8ClampedArray(pixels.length)
    const offset = ((Math.floor(136 / 12) * 108 + 54) * 2304 + 136 % 12 * 192 + 96) * 4
    water[offset] = 40
    water[offset + 1] = 8
    const spray = drawing()
    let sprayAlpha = 0
    spray.fill.mockImplementation(() => { sprayAlpha = spray.globalAlpha })
    paintWhaleFrame(spray, water, 136, 320, 280, '#405ce8')
    expect(sprayAlpha).toBeCloseTo(Math.sqrt(8 / 255) * 1.6)
    expect(sprayAlpha).toBeLessThan(.3)
    expect(spray.arc.mock.calls[0]?.[2]).toBeCloseTo(40 / 255 * 1.6 * cell)
    expect(context.globalAlpha).toBe(1)
    expect(BREACH_DURATION).toBe(5700)
  })

  it('autonomously plays the official frames, stops while hidden, and releases canvas memory', async () => {
    const pet = fixture()
    pet.load()
    await vi.advanceTimersByTimeAsync(600)
    expect(pet.view.document.querySelector('[data-pet-root]')?.getAttribute('data-action')).toBe('breach')
    expect(pet.element('play-feedback').textContent).toBe('')
    pet.frame(1500)
    expect(pet.output.arc).toHaveBeenCalled()
    expect(pet.rafs.size).toBe(1)
    Object.defineProperty(pet.view.document, 'hidden', { value: true, configurable: true })
    pet.view.document.dispatchEvent(new pet.view.Event('visibilitychange'))
    expect(pet.rafs.size).toBe(0)
    expect(pet.view.document.querySelector('[data-pet-root]')?.hasAttribute('data-action')).toBe(false)
    Object.defineProperty(pet.view.document, 'hidden', { value: false, configurable: true })
    pet.view.document.dispatchEvent(new pet.view.Event('visibilitychange'))
    pet.dispose()
    expect(pet.rafs.size).toBe(0)
    expect(pet.element<HTMLCanvasElement>('whale-canvas').width).toBe(0)
    expect(pet.image.hasAttribute('src')).toBe(false)
  })

  it('holds a real official frame without scheduling animation for reduced motion', async () => {
    const pet = fixture(undefined, { reduced: true })
    pet.load()
    expect(pet.output.arc).toHaveBeenCalled()
    expect(pet.rafs.size).toBe(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(pet.view.document.querySelector('[data-pet-root]')?.hasAttribute('data-action')).toBe(false)
    pet.element('jump').click()
    expect(pet.rafs.size).toBe(0)
  })

  it('retains the official logo fallback if the frame asset cannot be decoded', () => {
    const pet = fixture()
    Object.defineProperty(pet.image, 'naturalWidth', { value: 1 })
    pet.load()
    expect(pet.element('whale-canvas').dataset.failed).toBe('true')
    expect(pet.element('whale-canvas').dataset.ready).toBeUndefined()
    expect(pet.view.document.querySelector('.whale-fallback')?.getAttribute('src')).toBe('pet-whale.svg')
    expect(pet.rafs.size).toBe(0)
    pet.element('whale').click()
    expect(pet.element('assistant').hidden).toBe(false)
  })
})
