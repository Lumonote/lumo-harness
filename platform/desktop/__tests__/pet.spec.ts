import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountPet, PET_ATTACHMENT_LIMITS } from '../../desktop-assets/pet.mjs'
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
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    const result = native?.(command, args)
    if (command === 'pet_workspaces' && result === undefined) return { workspaces: [{ id: 'work', label: 'My work' }], selectedWorkspaceId: 'work' }
    return result
  })
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
  const addFiles = (files: File[]) => {
    Object.defineProperty(element('attachment-input'), 'files', { value: files, configurable: true })
    element('attachment-input').dispatchEvent(new view.Event('change', { bubbles: true }))
  }
  return { view, invoke, dispose, element, input, key, pointer, addFiles, frame, rafs, load, image, output, reader }
}

function setField(pet: ReturnType<typeof fixture>, name: string, value: string, event = 'input') {
  pet.element<HTMLInputElement>(name).value = value
  pet.element(name).dispatchEvent(new pet.view.Event(event, { bubbles: true }))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); vi.useRealTimers() })

describe('desktop companion', () => {
  const toolInventory = (status = 'available') => ['vscode', 'vscode-insiders', 'cursor', 'trae-cn', 'zed', 'claude-code', 'codex', 'gemini'].map(id => ({ id, status, detail: status === 'available' ? '已检测到程序；登录由工具处理' : '标准安装目录未找到程序' }))

  it('detects missing tools without disabling memory, then enables newly installed editors on refresh', async () => {
    const session = 'aaaaaaaa-1111-4111-8111-111111111111'
    let inventory = toolInventory('missing')
    const memory = { entries: [{ kind: 'session_link', tool: 'gemini', text: session, at: 1 }] }
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_tools') return inventory
      if (command === 'pet_dev_memory' || command === 'pet_dev_open') return memory
    })
    await settle(); pet.element('view-tools').click(); await settle()
    setField(pet, 'dev-provider', 'gemini', 'change')
    setField(pet, 'dev-session', session, 'change')
    setField(pet, 'dev-goal', '修复启动')
    setField(pet, 'dev-editor', 'zed', 'change')
    expect(pet.element<HTMLButtonElement>('dev-open').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('dev-new-session').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('dev-resume').disabled).toBe(true)
    for (const id of ['dev-save-goal', 'dev-copy', 'dev-transcript', 'dev-pin']) expect(pet.element<HTMLButtonElement>(id).disabled).toBe(false)
    expect(pet.element('dev-editor-status').textContent).toContain('未找到')
    inventory = toolInventory()
    pet.element('dev-detect').click(); await settle()
    expect(pet.element<HTMLButtonElement>('dev-open').disabled).toBe(false)
    pet.element('dev-open').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_open', { workspaceId: 'work', tool: 'zed', goal: '修复启动' })
    setField(pet, 'dev-editor', 'vscode-insiders', 'change')
    setField(pet, 'dev-goal', '检查预览版')
    pet.element('dev-open').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_open', { workspaceId: 'work', tool: 'vscode-insiders', goal: '检查预览版' })
  })

  it('ignores tool detection from a closed panel and keeps unsupported-tool memory usable', async () => {
    const pending = deferred<ReturnType<typeof toolInventory>>()
    let checks = 0
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_memory') return { entries: [] }
      if (command === 'pet_dev_tools') return ++checks === 1 ? pending.promise : toolInventory('unsupported')
    })
    await settle(); pet.element('view-tools').click(); await settle()
    pet.element('dev-back').click(); pet.element('view-tools').click(); await settle()
    pending.resolve(toolInventory()); await settle()
    expect(pet.element('dev-provider').textContent).toContain('此系统未支持')
    expect(pet.element<HTMLButtonElement>('dev-new-session').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('dev-copy').disabled).toBe(false)
  })

  it('launches and resumes Gemini with the linked UUID and keeps the selected transcript in handoffs', async () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111'
    const entries: Array<Record<string, unknown>> = []
    const pet = fixture((command, args) => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_tools') return toolInventory()
      if (command === 'pet_dev_memory') return { entries: [...entries] }
      if (command === 'pet_dev_session') {
        entries.push({ kind: args?.action === 'link' ? 'session_link' : 'session_open', tool: args?.provider, text: args?.action === 'link' ? args?.sessionId : '打开原生终端', at: 1 })
        return { entries: [...entries] }
      }
      if (command === 'pet_dev_transcript') {
        entries.push({ kind: 'transcript', tool: args?.provider, session: args?.sessionId, text: args?.text, at: 2 })
        return { entries: [...entries] }
      }
      if (command === 'pet_dev_handoff') return { text: 'Gemini 的记录', digest: 'a'.repeat(64) }
    })
    await settle(); pet.element('view-tools').click(); await settle()
    setField(pet, 'dev-provider', 'gemini', 'change')
    pet.element('dev-new-session').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_session', { workspaceId: 'work', provider: 'gemini', action: 'new', sessionId: '' })
    expect(pet.element('dev-status').textContent).toContain('/stats')
    setField(pet, 'dev-session-id', id)
    pet.element('dev-link').click(); await settle()
    setField(pet, 'dev-session', id, 'change')
    pet.element('dev-resume').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_session', { workspaceId: 'work', provider: 'gemini', action: 'resume', sessionId: id })
    const bytes = new TextEncoder().encode('Gemini 的记录')
    Object.defineProperty(pet.element('dev-transcript'), 'files', { value: [{ name: 'gemini.md', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }], configurable: true })
    pet.element('dev-transcript').dispatchEvent(new pet.view.Event('change', { bubbles: true })); await settle()
    pet.element('dev-handoff-transcript').click(); pet.element('dev-handoff-preview').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_handoff', { workspaceId: 'work', selection: { goal: false, cards: [], transcript: { provider: 'gemini', session: id } }, expectedDigest: null })
  })

  it('pins, searches, archives and restores sessions without removing imported history', async () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111'
    const newer = 'bbbbbbbb-1111-4111-8111-111111111111'
    const entries = [{ kind: 'session_link', tool: 'codex', text: id, at: 1 }, { kind: 'session_link', tool: 'codex', text: newer, at: 2 }, { kind: 'transcript', tool: 'codex', session: id, text: '保留的完整记忆', at: 3 }]
    let library = { cards: [], aliases: { ['codex:' + id]: '发布任务' }, sessions: {} as Record<string, { pinned: boolean, archived: boolean, revision: number }> }
    const pet = fixture((command, args) => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_memory') return { entries, library }
      if (command === 'pet_dev_library') {
        const edit = args?.edit as { provider: string, session: string, pinned: boolean, archived: boolean, revision: number }
        library = { ...library, sessions: { ...library.sessions, [edit.provider + ':' + edit.session]: { pinned: edit.pinned, archived: edit.archived, revision: edit.revision + 1 } } }
        return { entries, library }
      }
    })
    await settle(); pet.element('view-tools').click(); await settle()
    setField(pet, 'dev-provider', 'codex', 'change')
    setField(pet, 'dev-session', id, 'change')
    pet.element('dev-pin').click(); await settle()
    expect(pet.element<HTMLSelectElement>('dev-session').options[1].value).toBe(id)
    expect(pet.element('dev-session').textContent).toContain('置顶')
    setField(pet, 'dev-session-search', '发布')
    expect(pet.element<HTMLSelectElement>('dev-session').options.length).toBe(2)
    pet.element('dev-archive').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_library', { workspaceId: 'work', edit: { action: 'sessionState', provider: 'codex', session: id, pinned: true, archived: true, revision: 1 } })
    expect(pet.element('dev-session').textContent).toContain('没有匹配')
    expect(pet.element('dev-history').textContent).toContain('保留的完整记忆')
    setField(pet, 'dev-session-filter', 'archived', 'change')
    setField(pet, 'dev-session', id, 'change')
    expect(pet.element<HTMLButtonElement>('dev-resume').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('dev-transcript').disabled).toBe(false)
    expect(pet.element('dev-archive').textContent).toBe('恢复会话')
    pet.element('dev-archive').click(); await settle()
    setField(pet, 'dev-session-filter', 'active', 'change')
    setField(pet, 'dev-session', id, 'change')
    expect(pet.element<HTMLButtonElement>('dev-resume').disabled).toBe(false)
    pet.element('dev-back').click(); pet.element('view-tools').click(); await settle()
    expect(pet.element<HTMLInputElement>('dev-session-search').value).toBe('')
    expect(pet.element('dev-session').textContent).toContain('置顶')
  })

  it('does not change session state when a stale organization edit is rejected', async () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111'
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_memory') return { entries: [{ kind: 'session_link', tool: 'claude-code', text: id, at: 1 }] }
      if (command === 'pet_dev_library') throw Error('会话整理状态已变化，请刷新记录后重试')
    })
    await settle(); pet.element('view-tools').click(); await settle()
    setField(pet, 'dev-session', id, 'change')
    pet.element('dev-archive').click(); await settle()
    expect(pet.element('dev-status').textContent).toContain('会话整理状态已变化')
    expect(pet.element<HTMLSelectElement>('dev-session').value).toBe(id)
    expect(pet.element('dev-archive').textContent).toBe('归档会话')
  })

  it('previews only selected handoff content and invalidates the preview when the selection changes', async () => {
    const card = { id: 'card-a', revision: 3, title: '项目约定', body: '完整记忆', category: 'project' }
    const digest = 'a'.repeat(64)
    const pet = fixture((command, args) => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_memory') return { entries: [{ kind: 'goal', tool: '', text: '当前目标', at: 1 }], library: { cards: [card], aliases: {} } }
      if (command === 'pet_dev_handoff') return { text: '# 项目交接\n完整记忆', digest }
    })
    await settle()
    pet.element('view-tools').click(); await settle()
    expect(pet.element<HTMLButtonElement>('dev-handoff-preview').disabled).toBe(true)
    pet.element('dev-handoff-cards').querySelector<HTMLInputElement>('input')!.click()
    pet.element('dev-handoff-preview').click(); await settle()
    expect(pet.invoke).toHaveBeenLastCalledWith('pet_dev_handoff', { workspaceId: 'work', selection: { goal: false, cards: [{ id: 'card-a', revision: 3 }], transcript: null }, expectedDigest: null })
    expect(pet.element<HTMLTextAreaElement>('dev-handoff-text').value).toBe('# 项目交接\n完整记忆')
    pet.element('dev-handoff-copy').click(); await settle()
    expect(pet.invoke).toHaveBeenLastCalledWith('pet_dev_handoff', { workspaceId: 'work', selection: { goal: false, cards: [{ id: 'card-a', revision: 3 }], transcript: null }, expectedDigest: digest })
    pet.element('dev-handoff-goal').click()
    expect(pet.element('dev-handoff-result').hidden).toBe(true)
    expect(pet.element<HTMLButtonElement>('dev-handoff-copy').disabled).toBe(true)
    pet.element('dev-back').click()
    expect(pet.element<HTMLTextAreaElement>('dev-handoff-text').value).toBe('')
  })

  it('does not copy a stale or changed handoff after its preview is rejected', async () => {
    let changed = false
    const pet = fixture((command, args) => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_dev_memory') return { entries: [{ kind: 'goal', tool: '', text: '当前目标', at: 1 }] }
      if (command === 'pet_dev_handoff') {
        if (changed) throw Error('交接内容已变化，请重新预览后复制')
        return { text: '当前目标', digest: 'b'.repeat(64) }
      }
    })
    await settle(); pet.element('view-tools').click(); await settle()
    pet.element('dev-handoff-goal').click(); pet.element('dev-handoff-preview').click(); await settle()
    changed = true
    pet.element('dev-handoff-copy').click(); await settle()
    expect(pet.element('dev-status').textContent).toContain('交接内容已变化')
    expect(pet.element('dev-handoff-result').hidden).toBe(true)
    expect(pet.element<HTMLButtonElement>('dev-handoff-copy').disabled).toBe(true)
  })

  it('opens an explicitly selected saved cloud origin even when the local runtime is offline', async () => {
    const workbenches = [{ label: '团队', origin: 'https://team.example.org/' }]
    const pet = fixture((command, args) => {
      if (command === 'pet_snapshot') return { ...ready, runtime: 'failed', compact: false, workbenches: [...workbenches] }
      if (command === 'pet_cloud_workbench') {
        if (args?.action === 'remove') workbenches.pop()
        return [...workbenches]
      }
    })
    await settle()
    pet.element('settings').click(); pet.element('cloud-manage').click()
    expect(pet.element('cloud-manager').hidden).toBe(false)
    expect(pet.element<HTMLButtonElement>('cloud-open').disabled).toBe(true)
    setField(pet, 'cloud-list', 'https://team.example.org/', 'change')
    expect(pet.element<HTMLInputElement>('cloud-origin').value).toBe('https://team.example.org/')
    expect(pet.invoke.mock.calls.some(([cmd]) => cmd === 'pet_cloud_workbench')).toBe(false)
    pet.element('cloud-open').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_cloud_workbench', {action:'open', origin:'https://team.example.org/', label:''})
    pet.element('cloud-remove').click(); await settle()
    expect(pet.element<HTMLSelectElement>('cloud-list').options.length).toBe(1)
    expect(pet.invoke.mock.calls.some(([cmd]) => cmd === 'pet_open_workbench')).toBe(false)
  })

  it('keeps a cloud rename receipt when an older background snapshot arrives later', async () => {
    const origin = 'https://team.example.org/'
    const old = { ...ready, compact: false, workbenches: [{ label: '旧名称', origin }] }
    const stale = deferred<typeof old>()
    let reads = 0
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ++reads === 1 ? old : stale.promise
      if (command === 'pet_cloud_workbench') return [{ label: '新名称', origin }]
    })
    await settle()
    pet.element('settings').click(); pet.element('cloud-manage').click()
    setField(pet, 'cloud-list', origin, 'change')
    setField(pet, 'cloud-name', '新名称')
    pet.view.document.dispatchEvent(new pet.view.Event('visibilitychange'))
    await settle()
    pet.element('cloud-save').click(); await settle()
    expect(pet.element('cloud-status').textContent).toBe('服务器已保存。')
    stale.resolve(old); await settle()
    expect(pet.element<HTMLInputElement>('cloud-name').value).toBe('新名称')
    expect(pet.element<HTMLSelectElement>('cloud-list').selectedOptions[0].textContent).toContain('新名称')
    expect(reads).toBe(2)
  })

  it('finds older records by content and session alias while resuming the original UUID', async () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111'
    const entries = [{kind:'session_link', tool:'codex', text:id, at:0}, ...Array.from({length:35}, (_, i) => ({kind:'note', tool:'', text:'记录' + i, at:i+1}))]
    const library = {cards:[], aliases:{['codex:'+id]:'重试安装'}}
    const pet = fixture(cmd => cmd === 'pet_snapshot' ? {...ready,compact:false} : cmd.startsWith('pet_dev_') ? {entries,library} : undefined)
    await settle(); pet.element('view-tools').click(); await settle()
    expect(pet.element('dev-history').children.length).toBe(25)
    pet.element('dev-more').click()
    expect(pet.element('dev-history').children.length).toBe(36)
    setField(pet,'dev-search','重试安装')
    expect(pet.element('dev-history').children.length).toBe(1)
    expect(pet.element('dev-history').textContent).toContain(id)
    setField(pet,'dev-provider','codex','change')
    expect(pet.element('dev-session').textContent).toContain('重试安装')
    setField(pet,'dev-session',id,'change')
    pet.element('dev-resume').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_session',{workspaceId:'work',provider:'codex',action:'resume',sessionId:id})
    setField(pet,'dev-search','不存在')
    expect(pet.element('dev-results').textContent).toContain('0 条')
  })

  it('imports only UTF-8 text for the selected native session and renders its complete contents as text', async () => {
    const session = 'aaaaaaaa-1111-4111-8111-111111111111'
    const entries = [{ kind: 'session_link', tool: 'claude-code', text: session, at: 1 }]
    const pet = fixture((cmd, args) => {
      if (cmd === 'pet_snapshot') return { ...ready, compact: false }
      if (cmd === 'pet_dev_memory') return { entries }
      if (cmd === 'pet_dev_transcript') return { entries: [...entries, { kind: 'transcript', tool: args?.provider, session, text: args?.text, at: 2 }] }
    })
    await settle()
    pet.element('view-tools').click(); await settle()
    setField(pet, 'dev-session', session, 'change')
    const choose = async (name: string, bytes: Uint8Array) => {
      const field = pet.element<HTMLInputElement>('dev-transcript')
      Object.defineProperty(field, 'files', { configurable: true, value: [{ name, size: bytes.length, arrayBuffer: async () => bytes }] })
      field.dispatchEvent(new pet.view.Event('change', { bubbles: true }))
      await settle()
    }
    await choose('bad.txt', Uint8Array.from([255]))
    expect(pet.element('dev-status').textContent).toContain('UTF-8')
    expect(pet.invoke.mock.calls.some(([cmd]) => cmd === 'pet_dev_transcript')).toBe(false)
    const text = '# 原生记录\n<b>保留原文</b>\n' + '复查。'.repeat(500)
    await choose('history.md', new TextEncoder().encode(text))
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_transcript', { workspaceId: 'work', provider: 'claude-code', sessionId: session, text })
    expect(pet.element('dev-history').querySelector('details p')?.textContent).toBe(text)
    expect(pet.element('dev-history').querySelector('b')).toBeNull()
  })

  it('creates native sessions, links by UUID and resumes only a selected session from the matching provider', async () => {
    const claudeID = '11111111-1111-4111-8111-111111111111'
    const codexID = '22222222-2222-4222-8222-222222222222'
    const entry = (tool: string, text: string) => ({ kind: 'session_link', tool, text, at: 1 })
    const memory = { entries: [entry('claude-code', claudeID)] }
    const pet = fixture((cmd, args) => {
      if (cmd === 'pet_snapshot') return { ...ready, compact: false }
      if (cmd === 'pet_dev_memory') return memory
      if (cmd === 'pet_dev_session') {
        if (args?.action === 'link') memory.entries.push(entry('codex', codexID))
        return memory
      }
    })
    await settle()
    pet.element('view-tools').click(); await settle()
    expect(pet.element<HTMLButtonElement>('dev-resume').disabled).toBe(true)
    setField(pet, 'dev-session', claudeID, 'change')
    pet.element('dev-resume').click(); await settle()
    setField(pet, 'dev-provider', 'codex', 'change')
    expect([...pet.element<HTMLSelectElement>('dev-session').options].map(o => o.value)).toEqual([''])
    pet.element('dev-new-session').click(); await settle()
    expect(pet.element('dev-status').textContent).toContain('/status')
    setField(pet, 'dev-session-id', '--last')
    expect(pet.element<HTMLButtonElement>('dev-link').disabled).toBe(true)
    setField(pet, 'dev-session-id', codexID)
    pet.element('dev-link').click(); await settle()
    setField(pet, 'dev-session', codexID, 'change')
    pet.element('dev-resume').click(); await settle()
    expect(pet.invoke.mock.calls.filter(([cmd]) => cmd === 'pet_dev_session')).toEqual([
      ['pet_dev_session', { workspaceId: 'work', action: 'resume', provider: 'claude-code', sessionId: claudeID }],
      ['pet_dev_session', { workspaceId: 'work', action: 'new', provider: 'codex', sessionId: '' }],
      ['pet_dev_session', { workspaceId: 'work', action: 'link', provider: 'codex', sessionId: codexID }],
      ['pet_dev_session', { workspaceId: 'work', action: 'resume', provider: 'codex', sessionId: codexID }],
    ])
    pet.element('dev-copy').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_copy_context', { workspaceId: 'work' })
    expect(pet.element('dev-status').textContent).toContain('项目上下文已复制')
  })
  it('hands a goal to the selected editor once, continues without repeating it and reads editor notes on refresh', async () => {
    const goal = { kind: 'goal', tool: 'cursor', text: '优化搜索', at: 10 }
    const opened = { kind: 'opened', tool: 'cursor', text: '已请求', at: 11 }
    const editorNote = { kind: 'editor', text: '<b>保留原文</b>', at: 12 }
    const note = { kind: 'note', text: '已验证', at: 13 }
    let memory = { entries: [] as Array<{ kind: string; text: string; at: number; tool?: string }> }
    const pending = deferred<typeof memory>()
    const pet = fixture((cmd, args) => {
      if (cmd === 'pet_snapshot') return { ...ready, compact: false }
      if (cmd === 'pet_dev_memory') return memory
      if (cmd === 'pet_dev_open') return args?.goal ? pending.promise : memory
      if (cmd === 'pet_dev_note') return { entries: [...memory.entries, note] }
    })
    await settle()
    pet.element('view-tools').click(); await settle()
    expect(pet.element<HTMLButtonElement>('dev-open').disabled).toBe(true)
    setField(pet, 'dev-editor', 'cursor', 'change')
    setField(pet, 'dev-goal', goal.text)
    pet.element('dev-open').click(); pet.element('dev-open').click(); await settle()
    expect(pet.invoke.mock.calls.filter(([cmd]) => cmd === 'pet_dev_open')).toEqual([
      ['pet_dev_open', { workspaceId: 'work', tool: 'cursor', goal: goal.text }],
    ])
    memory = { entries: [goal, opened] }
    pending.resolve(memory); await settle()
    expect(pet.element<HTMLTextAreaElement>('dev-goal').value).toBe('')
    pet.element('dev-continue').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_open', { workspaceId: 'work', tool: 'cursor', goal: '' })
    memory = { entries: [goal, opened, editorNote] }
    pet.element('dev-refresh').click(); await settle()
    expect(pet.element('dev-history').querySelector('li')?.textContent).toContain('编辑器笔记')
    expect(pet.element('dev-history').querySelector('b')).toBeNull()
    setField(pet, 'dev-note', note.text)
    pet.element('dev-save').click(); await settle()
    expect(pet.invoke).toHaveBeenCalledWith('pet_dev_note', { workspaceId: 'work', text: '已验证' })
    expect(pet.element('dev-history').querySelector('li')?.textContent).toContain('用户补记')
    expect(pet.element('dev-status').textContent).toContain('补记已保存')
    pet.key('dev-note', 'Escape')
    expect(pet.element('dev-tools').hidden).toBe(true)
    expect(pet.view.document.activeElement).toBe(pet.element('view-tools'))
  })

  it('isolates workspace drafts and ignores late history, including failed opens and exact file navigation', async () => {
    const stale = deferred<{ entries: unknown[] }>()
    const failed = { kind: 'failed', tool: 'trae-cn', at: 2, text: '没有找到编辑器' }
    const pet = fixture((cmd, args) => {
      if (cmd === 'pet_snapshot') return { ...ready, compact: false }
      if (cmd === 'pet_workspaces') return { workspaces: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], selectedWorkspaceId: 'a' }
      if (cmd === 'pet_dev_memory') return args?.workspaceId === 'a' ? stale.promise : { entries: [] }
      if (cmd === 'pet_dev_open') return { entries: [{ kind: 'goal', text: args?.goal, tool: args?.tool, at: 1 }, failed] }
      if (cmd === 'pet_dev_locate') return { entries: [{ kind: 'located', text: 'docs/说明.md:42', tool: 'trae-cn', at: 3 }] }
    })
    await settle()
    pet.element('view-tools').click(); await settle()
    setField(pet, 'dev-goal', 'A 的草稿')
    setField(pet, 'workspace', 'b', 'change'); await settle()
    expect(pet.element<HTMLTextAreaElement>('dev-goal').value).toBe('')
    stale.resolve({ entries: [{ kind: 'note', text: 'A 的笔记', at: 1 }] }); await settle()
    expect(pet.element('dev-history').textContent).not.toContain('A 的笔记')
    setField(pet, 'dev-editor', 'trae-cn', 'change')
    setField(pet, 'dev-goal', 'B 的目标')
    pet.element('dev-open').click(); await settle()
    expect(pet.element('dev-status').dataset.error).toBe('true')
    expect(pet.element('dev-history').textContent).toContain('没有找到编辑器')
    setField(pet, 'dev-path', 'docs/说明.md')
    setField(pet, 'dev-line', '10000001'); pet.element('dev-locate').click()
    setField(pet, 'dev-line', '42'); pet.element('dev-locate').click(); await settle()
    expect(pet.invoke.mock.calls.filter(([cmd]) => cmd === 'pet_dev_locate')).toEqual([
      ['pet_dev_locate', { workspaceId: 'b', tool: 'trae-cn', relative: 'docs/说明.md', line: 42 }],
    ])
    expect(pet.element('dev-history').textContent).toContain('已请求定位文件')
    setField(pet, 'workspace', 'a', 'change'); await settle()
    expect(pet.element<HTMLTextAreaElement>('dev-goal').value).toBe('A 的草稿')
    expect(pet.element('dev-history').textContent).toContain('A 的笔记')
  })

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

  it('waits for a valid snapshot and workspace before enabling message submission', async () => {
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

  it('clears a draft only after submission acknowledgment and blocks duplicate sends', async () => {
    const handoff = deferred<{ sessionId: string }>()
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
      ['pet_open_workbench', { target: 'chat', draft, workspaceId: 'work', attachments: [], requestId: expect.any(String) }],
    ])
    expect(pet.element<HTMLTextAreaElement>('draft').readOnly).toBe(true)
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe(draft)
    handoff.resolve({ sessionId: 'session-1' })
    await settle()
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe('')
    expect(pet.element('feedback').textContent).toContain('已发送')
    expect(pet.element('assistant').hidden).toBe(false)
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
    expect(pet.element('feedback').textContent).toContain('草稿和附件已保留')
    expect(pet.element<HTMLTextAreaElement>('draft').readOnly).toBe(false)
  })

  it('retains retry identity until content or workspace changes and rejects an empty success receipt', async () => {
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ready
      if (command === 'pet_workspaces') return { workspaces: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], selectedWorkspaceId: 'a' }
    })
    await settle()
    pet.input('Do the work')
    pet.key('draft', 'Enter', { ctrlKey: true }); await settle()
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe('Do the work')
    pet.key('draft', 'Enter', { ctrlKey: true }); await settle()
    let calls = pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')
    expect(calls[1][1]?.requestId).toBe(calls[0][1]?.requestId)
    pet.element<HTMLSelectElement>('workspace').value = 'b'
    pet.element('workspace').dispatchEvent(new pet.view.Event('change'))
    pet.key('draft', 'Enter', { ctrlKey: true }); await settle()
    calls = pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')
    expect(calls[2][1]?.workspaceId).toBe('b')
    expect(calls[2][1]?.requestId).not.toBe(calls[1][1]?.requestId)
    pet.input('Changed request')
    pet.key('draft', 'Enter', { ctrlKey: true }); await settle()
    calls = pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')
    expect(calls[3][1]?.requestId).not.toBe(calls[2][1]?.requestId)
  })

  it('shows uncertain submission receipts without suggesting that a retry sends another message', async () => {
    const explanation = '发送回执未确认，请在对应对话中核对。为避免重复任务，本次请求不会自动重发。'
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ready
      if (command === 'pet_open_workbench') throw explanation
    })
    await settle()
    pet.input('Need confirmation')
    pet.key('draft', 'Enter', { ctrlKey: true }); await settle()
    expect(pet.element('feedback').textContent).toContain(explanation)
    expect(pet.element('feedback').textContent).not.toContain('请重试')
    expect(pet.element<HTMLTextAreaElement>('draft').value).toBe('Need confirmation')
  })

  it('sends the selected workspace only for chat navigation, never for home or tasks', async () => {
    const pet = fixture(command => command === 'pet_snapshot' ? ready : undefined)
    await settle()
    expect(pet.element<HTMLSelectElement>('workspace').value).toBe('work')
    pet.element('open-home').click(); await settle()
    pet.element('view-tasks').click(); await settle()
    pet.element('new-chat').click(); await settle()
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')).toEqual([
      ['pet_open_workbench', { target: 'home', draft: '' }],
      ['pet_open_workbench', { target: 'tasks', draft: '' }],
      ['pet_open_workbench', { target: 'chat', draft: '', workspaceId: 'work' }],
    ])
  })

  it('blocks unavailable workspaces and recovers through explicit refresh without choosing an unrelated workspace', async () => {
    let result = { workspaces: [{ id: 'a', label: '<b>Workspace A</b>' }, { id: 'b', label: 'Workspace B' }], selectedWorkspaceId: 'a' }
    let fail = true
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return ready
      if (command === 'pet_workspaces') { if (fail) throw Error('offline'); return result }
    })
    await settle()
    pet.input('Work here')
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(true)
    expect(pet.element('workspace-status').textContent).toContain('读取失败')
    fail = false
    pet.element('refresh-workspaces').click(); await settle()
    expect(pet.element<HTMLSelectElement>('workspace').value).toBe('a')
    expect(pet.element('workspace').querySelector('b')).toBeNull()
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(false)
    result = { workspaces: [{ id: 'b', label: 'Workspace B' }], selectedWorkspaceId: 'b' }
    pet.element('refresh-workspaces').click(); await settle()
    expect(pet.element<HTMLSelectElement>('workspace').value).toBe('')
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(true)
    expect(pet.element('workspace-status').textContent).toContain('原工作空间已不可用')
  })

  it('reads attachment bytes, preserves the file on failure and sends an attachment-only message on retry', async () => {
    const pending = deferred<{ sessionId: string }>()
    let attempt = 0
    const pet = fixture(command => {
      if (command === 'pet_snapshot') return { ...ready, compact: false }
      if (command === 'pet_open_workbench') { if (++attempt === 1) throw Error('upload failed'); return pending.promise }
    })
    await settle()
    pet.addFiles([new pet.view.File(['actual bytes'], '<report>.txt', { type: 'text/plain' })])
    expect(pet.element('attachments').textContent).toContain('<report>.txt')
    expect(pet.element('attachments').querySelector('report')).toBeNull()
    pet.element('send-draft').click()
    await vi.advanceTimersByTimeAsync(20)
    await settle()
    expect(pet.element('attachments').children).toHaveLength(1)
    expect(pet.element('feedback').textContent).toContain('草稿和附件已保留')
    const first = pet.invoke.mock.calls.find(([command]) => command === 'pet_open_workbench')![1]!
    expect(first.attachments).toEqual([{ name: '<report>.txt', mimeType: 'text/plain', base64: Buffer.from('actual bytes').toString('base64') }])
    pet.element('send-draft').click()
    await vi.advanceTimersByTimeAsync(20); await settle()
    const calls = pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')
    expect(calls[1][1]?.requestId).toBe(first.requestId)
    expect(pet.element<HTMLSelectElement>('workspace').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('attach-files').disabled).toBe(true)
    expect(pet.element<HTMLButtonElement>('attachments').querySelector('button')?.disabled).toBe(true)
    pending.resolve({ sessionId: 'file-session' }); await settle()
    expect(pet.element('attachments').children).toHaveLength(0)
    expect(pet.element('assistant').hidden).toBe(false)
  })

  it('enforces attachment count and byte limits before reading data and supports removal', async () => {
    const pet = fixture(command => command === 'pet_snapshot' ? ready : undefined)
    await settle()
    const file = (name: string, size = 1) => {
      const item = new pet.view.File(['x'], name)
      Object.defineProperty(item, 'size', { value: size })
      return item
    }
    pet.addFiles([file('keep.txt')])
    pet.addFiles(Array.from({ length: PET_ATTACHMENT_LIMITS.count }, (_, index) => file(`${index}.txt`)))
    expect(pet.element('feedback').textContent).toContain('最多添加 4 个')
    expect(pet.element('attachments').children).toHaveLength(1)
    pet.addFiles([file('big', PET_ATTACHMENT_LIMITS.fileBytes + 1)])
    expect(pet.element('feedback').textContent).toContain('8 MB')
    pet.addFiles([file('a', PET_ATTACHMENT_LIMITS.fileBytes), file('b', PET_ATTACHMENT_LIMITS.fileBytes)])
    expect(pet.element('feedback').textContent).toContain('16 MB')
    expect(pet.element('attachments').children).toHaveLength(1)
    pet.element('attachments').querySelector<HTMLButtonElement>('button')!.click()
    expect(pet.element('attachments').children).toHaveLength(0)
    expect(pet.element<HTMLButtonElement>('send-draft').disabled).toBe(true)
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')).toHaveLength(0)
  })

  it('cancels a pending file read when the pet closes without submitting in the background', async () => {
    const pet = fixture(command => command === 'pet_snapshot' ? ready : undefined)
    await settle()
    let reader: { abort: () => void; onabort?: () => void; readAsDataURL: () => void } | undefined
    const aborted = vi.fn()
    Object.assign(pet.view, { FileReader: function () {
      reader = { readAsDataURL() {}, abort() { aborted(); this.onabort?.() } }
      return reader
    } })
    pet.addFiles([new pet.view.File(['data'], 'report.txt')])
    pet.element('send-draft').click(); await settle()
    pet.dispose(); await settle()
    expect(aborted).toHaveBeenCalledOnce()
    expect(pet.invoke.mock.calls.filter(([command]) => command === 'pet_open_workbench')).toHaveLength(0)
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
