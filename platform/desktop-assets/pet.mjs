import { BREACH_DURATION, mountWhaleMotion } from './pet-motion.mjs'

/** Local Tauri surface. A successful handoff carries a draft, never submits it. */
export function mountPet(view) {
  const doc = view.document
  const root = doc.querySelector('[data-pet-root]')
  if (!root) return () => {}
  const $ = id => doc.getElementById(id)
  const events = new view.AbortController()
  const bridge = view.__TAURI__?.core?.invoke ?? view.__TAURI_INTERNALS__?.invoke
  const native = typeof bridge === 'function'
  let snapshot = { runtime: 'starting', always_on_top: true, launch_on_start: true, compact: true }
  let connected = false
  let unavailable = false
  let busy = false
  let expanded = false
  let disposed = false
  let refreshing = false
  let requestVersion = 0
  let feedbackSource = ''
  let dragOrigin
  let dragged = false
  let playing = false
  let playTimer
  let dragging = false
  let motion

  const invoke = (command, args) => native
    ? Promise.resolve().then(() => bridge(command, args))
    : Promise.reject(Error('desktop_unavailable'))
  const listen = (target, event, handler) => target.addEventListener(event, handler, { signal: events.signal })
  const feedback = (message = '', error = false, source = 'action') => {
    $('feedback').textContent = message
    $('feedback').dataset.error = String(error)
    feedbackSource = source
  }
  const closeSettings = () => {
    $('preferences').hidden = true
    $('settings').setAttribute('aria-expanded', 'false')
  }
  const layout = next => {
    const restoreFocus = !next && $('assistant').contains(doc.activeElement)
    expanded = next
    root.dataset.expanded = String(next)
    $('assistant').hidden = !next
    $('whale').setAttribute('aria-expanded', String(next))
    if (!next) closeSettings()
    if (restoreFocus) $('whale').focus()
  }
  const controls = () => {
    const ready = connected && snapshot.runtime === 'ready'
    for (const id of ['send-draft', 'new-chat', 'view-tasks', 'open-home', 'always-on-top', 'launch-on-start', 'hide', 'open-log']) {
      $(id).disabled = busy || !native
    }
    $('send-draft').disabled ||= !ready || !$('draft').value.trim()
    $('new-chat').disabled ||= !ready
    $('view-tasks').disabled ||= !ready
    $('always-on-top').disabled ||= !connected
    $('launch-on-start').disabled ||= !connected
    $('draft').readOnly = busy
    $('collapse').disabled = busy
    $('whale').disabled = busy
    $('settings').disabled = busy
    $('jump').disabled = busy || playing || dragging
    motion?.pause(busy || dragging)
    root.setAttribute('aria-busy', String(busy))
  }
  const render = () => {
    const runtime = !native ? 'preview' : unavailable ? 'unavailable' : snapshot.runtime
    root.dataset.runtime = runtime
    const labels = {
      starting: ['正在唤醒', '本地工作台正在启动，稍后即可开始。'],
      ready: ['随时待命', '想法在这里落笔，接着去工作台完成。'],
      failed: ['需要看看', '本地工作台未启动，可打开主窗口查看原因。'],
      unavailable: ['连接中断', '暂时无法读取桌面状态，正在重新连接。'],
      preview: ['外观预览', '请在桌面应用中使用快捷入口。'],
    }
    const [label, detail] = labels[runtime] ?? labels.starting
    $('runtime-label').textContent = label
    $('runtime-detail').textContent = detail
    $('always-on-top').checked = snapshot.always_on_top
    $('launch-on-start').checked = snapshot.launch_on_start
    $('open-log').hidden = runtime !== 'failed'
    controls()
  }
  async function refresh() {
    if (!native || disposed || busy || refreshing) return
    const version = ++requestVersion
    refreshing = true
    try {
      const result = await invoke('pet_snapshot')
      if (disposed || version !== requestVersion) return
      if (!result || !['starting', 'ready', 'failed'].includes(result.runtime)
        || typeof result.always_on_top !== 'boolean' || typeof result.launch_on_start !== 'boolean'
        || typeof result.compact !== 'boolean') throw Error('invalid_snapshot')
      snapshot = result
      connected = true
      unavailable = false
      layout(!result.compact)
      if (feedbackSource === 'status') feedback()
      render()
    } catch {
      if (disposed || version !== requestVersion) return
      connected = false
      unavailable = true
      feedback('桌面状态读取失败，正在重试。', true, 'status')
      render()
    } finally {
      refreshing = false
    }
  }
  async function action(command, args, complete, failure) {
    if (busy || disposed) return false
    busy = true
    requestVersion++
    stopPlay()
    feedback()
    controls()
    try {
      await invoke(command, args)
      if (disposed) return false
      complete?.()
      return true
    } catch {
      if (!disposed) {
        feedback(failure ?? '操作未完成，请稍后重试。', true)
        render()
      }
      return false
    } finally {
      if (!disposed) {
        busy = false
        controls()
      }
    }
  }
  const expand = next => {
    if (!native) {
      layout(next)
      if (next) $('draft').focus()
      return Promise.resolve(true)
    }
    return action('pet_set_expanded', { expanded: next }, () => {
      snapshot = { ...snapshot, compact: !next }
      layout(next)
      if (next) $('draft').focus()
    }, '桌面助手未能展开或收起，请重试。')
  }
  const open = (target, draft = '') => action('pet_open_workbench', { target, draft }, () => {
    if (draft) {
      $('draft').value = ''
      $('draft-count').textContent = '草稿会带入工作台，由你确认发送'
    }
    feedback(draft ? '草稿已带入新对话，请在工作台确认发送。' : '已打开工作台。')
  }, draft ? '未能带入新对话，草稿已保留，请重试。' : '工作台未打开，请重试。')

  const stopPlay = () => {
    if (playTimer !== undefined) view.clearTimeout(playTimer)
    playTimer = undefined
    playing = false
    delete root.dataset.action
    motion?.stop()
    $('play-feedback').textContent = ''
  }
  const play = (automatic = false) => {
    if (disposed || busy || playing || dragging || dragOrigin) return
    playing = true
    root.dataset.action = 'breach'
    motion?.play()
    if (!automatic) $('play-feedback').textContent = '巨鲸潜入海中，甩尾破水跃起。'
    controls()
    const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    playTimer = view.setTimeout(() => {
      if (disposed) return
      stopPlay()
      if (!automatic) $('play-feedback').textContent = '巨鲸落入海中，溅起水花。'
      controls()
    }, reduced ? 1400 : BREACH_DURATION)
  }
  motion = mountWhaleMotion(view, { onIdle: () => { if (!expanded) play(true) } })
  listen($('jump'), 'click', event => { event.stopPropagation(); play() })
  listen($('whale'), 'pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || busy) return
    stopPlay()
    controls()
    dragOrigin = { x: event.screenX, y: event.screenY, id: event.pointerId }
    dragged = false
    if (native) {
      try { $('whale').setPointerCapture(event.pointerId) } catch { /* Unsupported by older WebViews. */ }
    }
  })
  listen(doc, 'pointermove', event => {
    if (!native || !dragOrigin || dragOrigin.id !== event.pointerId || dragged || busy) return
    if (Math.hypot(event.screenX - dragOrigin.x, event.screenY - dragOrigin.y) < 6) return
    dragged = true
    dragging = true
    dragOrigin = undefined
    controls()
    void invoke('pet_start_drag')
      .catch(() => { if (!disposed) feedback('桌宠位置未改变，请重新拖动。', true) })
      .finally(() => { dragging = false; if (!disposed) controls() })
  })
  listen(doc, 'pointerup', () => { dragOrigin = undefined })
  // Native drag may cancel the pointer stream; its trailing click must stay suppressed.
  listen(doc, 'pointercancel', () => { dragOrigin = undefined })
  listen($('whale'), 'click', event => {
    if (dragged && event.detail !== 0) { dragged = false; return }
    dragged = false
    void expand(!expanded)
  })
  listen($('whale'), 'contextmenu', async event => {
    event.preventDefault()
    if (busy || disposed) return
    if (!expanded && !await expand(true)) return
    if (disposed) return
    $('preferences').hidden = false
    $('settings').setAttribute('aria-expanded', 'true')
    $('always-on-top').focus()
  })
  listen($('collapse'), 'click', () => { void expand(false) })
  listen(doc, 'keydown', event => {
    if (event.key !== 'Escape' || !expanded || event.isComposing || busy) return
    event.preventDefault()
    if (!$('preferences').hidden) {
      closeSettings()
      $('settings').focus()
    } else void expand(false)
  })
  listen(doc, 'pointerdown', event => {
    if (!$('preferences').hidden && !$('preferences').contains(event.target) && !$('settings').contains(event.target)) closeSettings()
  })
  listen($('draft'), 'input', () => {
    const length = $('draft').value.length
    $('draft-count').textContent = length > 10000
      ? `${length.toLocaleString()} / 12,000 字符 · 仅带入草稿`
      : '草稿会带入工作台，由你确认发送'
    controls()
  })
  const submit = () => {
    const draft = $('draft').value
    if (!draft.trim() || busy) return
    if (draft.length > 12000) { feedback('草稿最多 12,000 字符，请缩短后再带入。', true); return }
    if (!connected || snapshot.runtime !== 'ready' || !native) {
      feedback('请等待桌面工作台就绪后再带入草稿。', true)
      return
    }
    void open('chat', draft)
  }
  listen($('quick-prompt'), 'submit', event => { event.preventDefault(); submit() })
  listen($('draft'), 'keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  })
  listen($('new-chat'), 'click', () => { void open('chat') })
  listen($('view-tasks'), 'click', () => { void open('tasks') })
  listen($('open-home'), 'click', () => { void open('home') })
  listen($('hide'), 'click', () => { void action('pet_hide', undefined, undefined, '桌宠未能隐藏，可从托盘管理桌宠。') })
  listen($('open-log'), 'click', () => { void action('open_runtime_log', undefined, () => feedback('已定位运行时日志。')) })
  listen($('settings'), 'click', () => {
    const next = $('preferences').hidden
    $('preferences').hidden = !next
    $('settings').setAttribute('aria-expanded', String(next))
  })
  const savePreferences = () => {
    const args = { alwaysOnTop: $('always-on-top').checked, launchOnStart: $('launch-on-start').checked }
    void action('pet_set_preferences', args, () => {
      snapshot = { ...snapshot, always_on_top: args.alwaysOnTop, launch_on_start: args.launchOnStart }
      render()
      feedback('桌宠设置已保存。')
    }, '设置未保存，已恢复原来的设置。')
  }
  listen($('always-on-top'), 'change', savePreferences)
  listen($('launch-on-start'), 'change', savePreferences)
  listen(doc, 'visibilitychange', () => {
    if (doc.hidden) { stopPlay(); controls() }
    else void refresh()
  })
  if (!native) doc.body.dataset.preview = 'true'
  render()
  void refresh()
  const poll = view.setInterval(() => { if (!doc.hidden) void refresh() }, 2500)
  const dispose = () => {
    if (disposed) return
    disposed = true
    requestVersion++
    events.abort()
    view.clearInterval(poll)
    stopPlay()
    motion?.dispose()
  }
  listen(view, 'pagehide', dispose)
  return dispose
}

if (typeof window !== 'undefined' && document.querySelector('[data-pet-root]')) mountPet(window)
