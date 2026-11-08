import { BREACH_DURATION, mountWhaleMotion } from './pet-motion.mjs'

export const PET_ATTACHMENT_LIMITS = Object.freeze({ count: 4, fileBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 })

/** Local Tauri surface. Keep pending input until the workbench acknowledges submission. */
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
  let workspaces = []
  let workspaceId = ''
  let workspacesLoaded = false
  let loadingWorkspaces = false
  let files = []
  let sendRequestId
  const fileReaders = new Set()

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
    $('send-draft').disabled ||= !ready || loadingWorkspaces || (!workspacesLoaded || !workspaces.some(item => item.id === workspaceId)) || (!$('draft').value.trim() && !files.length)
    $('new-chat').disabled ||= !ready
    $('view-tasks').disabled ||= !ready
    $('always-on-top').disabled ||= !connected
    $('launch-on-start').disabled ||= !connected
    $('draft').readOnly = busy
    $('collapse').disabled = busy
    $('whale').disabled = busy
    $('settings').disabled = busy
    $('workspace').disabled = busy || loadingWorkspaces || !workspaces.length
    $('refresh-workspaces').disabled = busy || loadingWorkspaces || !ready || !native
    $('attach-files').disabled = busy || !ready || !native
    $('attachment-input').disabled = busy || !ready || !native
    for (const button of $('attachments').querySelectorAll('button')) button.disabled = busy
    $('jump').disabled = busy || playing || dragging
    motion?.pause(busy || dragging)
    root.setAttribute('aria-busy', String(busy))
  }
  const render = () => {
    const runtime = !native ? 'preview' : unavailable ? 'unavailable' : snapshot.runtime
    root.dataset.runtime = runtime
    const labels = {
      starting: ['正在唤醒', '本地工作台正在启动，稍后即可开始。'],
      ready: ['随时待命', '选择工作空间，直接开始对话。'],
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
  const updateDraftCount = () => {
    const length = $('draft').value.length
    $('draft-count').textContent = length > 10000 ? `${length.toLocaleString()} / 12,000 字符` : '⌘ / Ctrl + Enter 发送'
  }
  const renderAttachments = () => {
    $('attachments').replaceChildren()
    $('attachments').hidden = !files.length
    files.forEach((file, index) => {
      const item = doc.createElement('li')
      item.className = 'attachment-item'
      const name = doc.createElement('span')
      name.className = 'attachment-name'
      name.textContent = file.name
      name.title = file.name
      const size = doc.createElement('span')
      size.className = 'attachment-size'
      size.textContent = file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(file.size / 1024))} KB`
      const remove = doc.createElement('button')
      remove.type = 'button'
      remove.className = 'icon-button'
      remove.textContent = '×'
      remove.setAttribute('aria-label', `移除附件 ${file.name}`)
      remove.disabled = busy
      listen(remove, 'click', () => {
        if (busy) return
        files.splice(index, 1)
        sendRequestId = undefined
        renderAttachments()
        controls()
      })
      item.append(name, size, remove)
      $('attachments').append(item)
    })
  }
  async function refreshWorkspaces() {
    if (!native || disposed || busy || loadingWorkspaces || !connected || snapshot.runtime !== 'ready') return
    loadingWorkspaces = true
    controls()
    try {
      const result = await invoke('pet_workspaces')
      if (disposed) return
      if (!result || !Array.isArray(result.workspaces) || result.workspaces.length > 1000
        || result.workspaces.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.label !== 'string' || !item.label)
        || new Set(result.workspaces.map(item => item.id)).size !== result.workspaces.length) throw Error('invalid_workspaces')
      workspaces = result.workspaces
      if (!workspacesLoaded && !workspaceId) {
        workspaceId = workspaces.some(item => item.id === result.selectedWorkspaceId) ? result.selectedWorkspaceId : workspaces.length === 1 ? workspaces[0].id : ''
      }
      workspacesLoaded = true
      const select = $('workspace')
      select.replaceChildren()
      const placeholder = doc.createElement('option')
      placeholder.value = ''
      placeholder.textContent = workspaces.length ? '选择工作空间' : '暂无工作空间'
      select.append(placeholder)
      for (const workspace of workspaces) {
        const option = doc.createElement('option')
        option.value = workspace.id
        option.textContent = workspace.label
        select.append(option)
      }
      if (workspaceId && !workspaces.some(item => item.id === workspaceId)) {
        workspaceId = ''
        sendRequestId = undefined
        $('workspace-status').textContent = '原工作空间已不可用，请重新选择。'
      } else $('workspace-status').textContent = workspaces.length ? '' : '请先在工作台创建工作空间，然后刷新。'
      select.value = workspaceId
      $('workspace-status').hidden = !$('workspace-status').textContent
    } catch {
      if (!disposed) {
        workspacesLoaded = false
        $('workspace-status').textContent = '工作空间读取失败，点击刷新重试。'
        $('workspace-status').hidden = false
      }
    } finally {
      loadingWorkspaces = false
      if (!disposed) controls()
    }
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
      if (result.runtime === 'ready' && !workspacesLoaded) void refreshWorkspaces()
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
      const prepared = typeof args === 'function' ? await args() : args
      if (disposed) return false
      const result = await invoke(command, prepared)
      if (disposed) return false
      complete?.(result)
      return true
    } catch (error) {
      if (!disposed) {
        const detail = typeof error === 'string' ? error : error?.message
        const message = command === 'pet_open_workbench' && typeof args === 'function' && typeof detail === 'string' && /回执|核对|无法确认/u.test(detail)
          ? `${detail.slice(0, 500)}\n草稿和附件已保留。` : failure ?? '操作未完成，请稍后重试。'
        feedback(message, true)
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
  const open = target => action('pet_open_workbench', { target, draft: '', ...(target === 'chat' && workspaceId ? { workspaceId } : {}) }, () => {
    feedback('已打开工作台。')
  }, '工作台未打开，请重试。')
  const encodeFile = file => new Promise((resolve, reject) => {
    const reader = new view.FileReader()
    fileReaders.add(reader)
    reader.onerror = () => { fileReaders.delete(reader); reject(Error('attachment_read_failed')) }
    reader.onabort = () => { fileReaders.delete(reader); reject(Error('attachment_read_cancelled')) }
    reader.onload = () => {
      fileReaders.delete(reader)
      const result = reader.result
      if (typeof result !== 'string' || !result.includes(';base64,')) { reject(Error('invalid_attachment')); return }
      resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', base64: result.slice(result.indexOf(',') + 1) })
    }
    reader.readAsDataURL(file)
  })

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
    sendRequestId = undefined
    updateDraftCount()
    controls()
  })
  listen($('workspace'), 'change', () => {
    if (busy) return
    workspaceId = $('workspace').value
    sendRequestId = undefined
    controls()
  })
  listen($('refresh-workspaces'), 'click', () => { void refreshWorkspaces() })
  listen($('attach-files'), 'click', () => { if (!busy) $('attachment-input').click() })
  listen($('attachment-input'), 'change', () => {
    if (busy) return
    const incoming = [...($('attachment-input').files ?? [])]
    $('attachment-input').value = ''
    if (!incoming.length) return
    if (files.length + incoming.length > PET_ATTACHMENT_LIMITS.count) { feedback(`最多添加 ${PET_ATTACHMENT_LIMITS.count} 个附件。`, true); return }
    if (incoming.some(file => file.size > PET_ATTACHMENT_LIMITS.fileBytes)) { feedback('单个附件不能超过 8 MB。', true); return }
    if ([...files, ...incoming].reduce((sum, file) => sum + file.size, 0) > PET_ATTACHMENT_LIMITS.totalBytes) { feedback('附件总大小不能超过 16 MB。', true); return }
    files.push(...incoming)
    sendRequestId = undefined
    feedback()
    renderAttachments()
    controls()
  })
  const submit = () => {
    const draft = $('draft').value
    if ((!draft.trim() && !files.length) || busy) return
    if (draft.length > 12000) { feedback('草稿最多 12,000 字符，请缩短后再发送。', true); return }
    if (!connected || snapshot.runtime !== 'ready' || !native) {
      feedback('请等待桌面工作台就绪后再发送。', true)
      return
    }
    if (loadingWorkspaces || !workspacesLoaded || !workspaces.some(item => item.id === workspaceId)) { feedback('请选择可用的工作空间后再发送。', true); return }
    sendRequestId ??= view.crypto.randomUUID()
    const requestId = sendRequestId
    const chosenWorkspace = workspaceId
    const pendingFiles = [...files]
    void action('pet_open_workbench', async () => ({ target: 'chat', draft, workspaceId: chosenWorkspace, requestId,
      attachments: await Promise.all(pendingFiles.map(encodeFile)),
    }), result => {
      if (!result || typeof result.sessionId !== 'string' || !result.sessionId) throw Error('missing_submission_receipt')
      $('draft').value = ''
      files = []
      sendRequestId = undefined
      updateDraftCount()
      renderAttachments()
      feedback('已发送，助手正在处理。')
    }, '发送未完成，草稿和附件已保留，请重试。')
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
    for (const reader of fileReaders) reader.abort()
    fileReaders.clear()
    view.clearInterval(poll)
    stopPlay()
    motion?.dispose()
  }
  listen(view, 'pagehide', dispose)
  return dispose
}

if (typeof window !== 'undefined' && document.querySelector('[data-pet-root]')) mountPet(window)
