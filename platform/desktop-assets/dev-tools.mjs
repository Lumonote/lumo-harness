const tools = { vscode: 'VS Code', 'vscode-insiders': 'VS Code Insiders', cursor: 'Cursor', 'trae-cn': 'Trae CN', zed: 'Zed', 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
const kinds = { goal: '项目目标', note: '用户补记', editor: '编辑器笔记', opened: '已请求打开项目', located: '已请求定位文件', failed: '打开失败', session_link: '已关联会话', session_open: '已请求打开会话', session_failed: '会话操作失败', transcript: '用户导入的会话记录' }
const draftFields = ['dev-goal', 'dev-note', 'dev-editor', 'dev-path', 'dev-line', 'dev-provider', 'dev-session-id']
const sessionID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const isFailure = entry => entry?.kind === 'failed' || entry?.kind === 'session_failed'

export function mountDevTools({ doc, invoke, listen, getWorkspace }) {
  const $ = id => doc.getElementById(id)
  const panel = $('dev-tools')
  const drafts = new Map()
  const writing = new Set()
  let workspace = ''
  let generation = 0
  let loading = false
  let available = false
  let loaded = false
  let entries = []
  let cards = [], aliases = {}, editing = null, removing = false, pageSize = 25
  let aliasKey = ''
  let handoff = null
  let sessions = {}
  let toolStates = new Map(), detecting = false, detectionGeneration = 0

  function selectedSessionState() {
    return sessions[$('dev-provider').value + ':' + $('dev-session').value.toLowerCase()] ?? { pinned: false, archived: false, revision: 0 }
  }
  function canLaunch(tool) {
    return !detecting && (!toolStates.has(tool) || toolStates.get(tool).status === 'available')
  }
  function toolDetails() {
    for (const [select, detail] of [['dev-provider', 'dev-provider-status'], ['dev-editor', 'dev-editor-status']]) {
      const menu = $(select)
      for (const option of menu.options) {
        const state = toolStates.get(option.value)?.status
        option.textContent = tools[option.value] + (state ? ' · ' + ({ available: '已检测到', missing: '未找到', unsupported: '此系统未支持' }[state]) : '')
      }
      $(detail).textContent = toolStates.get(menu.value)?.detail ?? ''
    }
  }
  async function detectTools() {
    const version = ++detectionGeneration
    detecting = true
    toolStates = new Map()
    $('dev-detection').textContent = '正在检查标准安装目录…'
    controls()
    try {
      const result = await invoke('pet_dev_tools')
      if (version !== detectionGeneration || panel.hidden) return
      if (!Array.isArray(result) || result.length !== Object.keys(tools).length || new Set(result.map(item => item?.id)).size !== result.length || result.some(item => !Object.hasOwn(tools, item?.id) || !['available', 'missing', 'unsupported'].includes(item.status) || typeof item.detail !== 'string')) throw Error('工具检测结果不可用')
      toolStates = new Map(result.map(item => [item.id, item]))
      $('dev-detection').textContent = '检测完成。安装或更新工具后可重新检测。'
    } catch {
      if (version === detectionGeneration && !panel.hidden) $('dev-detection').textContent = '检测暂不可用，可重新检测；打开时仍会检查工具。'
    } finally {
      if (version === detectionGeneration) { detecting = false; controls() }
    }
  }

  function clearHandoff() {
    handoff = null
    $('dev-handoff-result').hidden = true
    $('dev-handoff-text').value = ''
  }
  function handoffSelection() {
    return {
      goal: $('dev-handoff-goal').checked,
      cards: [...$('dev-handoff-cards').querySelectorAll('input:checked')].map(field => ({ id: field.value, revision: Number(field.dataset.revision) })),
      transcript: $('dev-handoff-transcript').checked ? { provider: $('dev-provider').value, session: $('dev-session').value } : null,
    }
  }
  function handoffCards() {
    const selected = new Set(handoffSelection().cards.map(card => JSON.stringify(card)))
    clearHandoff()
    const list = $('dev-handoff-cards')
    list.replaceChildren()
    for (const card of cards) {
      const label = doc.createElement('label')
      label.className = 'dev-check'
      const field = doc.createElement('input')
      field.type = 'checkbox'; field.value = card.id; field.dataset.revision = String(card.revision)
      field.checked = selected.has(JSON.stringify({ id: card.id, revision: card.revision }))
      label.append(field, doc.createTextNode(card.title))
      list.append(label)
    }
  }

  function cardFields(id = '') {
    editing = cards.find(c => c.id === id) ?? null
    removing = false
    $('dev-card').value = editing?.id ?? ''
    $('dev-category').value = editing?.category ?? 'project'
    $('dev-card-title').value = editing?.title ?? ''
    $('dev-card-body').value = editing?.body ?? ''
    $('dev-card-remove').textContent = '移除记忆'
  }
  function syncAlias(force = false) {
    const key = $('dev-provider').value + ':' + $('dev-session').value.toLowerCase()
    if (force || key !== aliasKey) $('dev-alias').value = aliases[key] ?? ''
    aliasKey = key
  }

  function status(text, error = false) {
    $('dev-status').textContent = text
    $('dev-status').dataset.error = String(error)
  }
  function controls() {
    const locked = !available || loading || writing.has(workspace)
    const ready = !locked && loaded
    const line = $('dev-line').valueAsNumber
    const editorReady = ready && canLaunch($('dev-editor').value)
    const agentReady = ready && canLaunch($('dev-provider').value)
    const sessionReady = ready && !!$('dev-session').value
    const state = selectedSessionState()
    $('dev-detect').disabled = detecting
    toolDetails()
    $('dev-open').disabled = !editorReady || !$('dev-goal').value.trim()
    $('dev-save-goal').disabled = !ready || !$('dev-goal').value.trim()
    $('dev-save').disabled = !ready || !$('dev-note').value.trim()
    $('dev-continue').hidden = !entries.some(entry => entry.kind === 'goal')
    $('dev-continue').disabled = !editorReady || !!$('dev-goal').value.trim()
    $('dev-locate').disabled = !editorReady || !$('dev-path').value.trim() || !Number.isInteger(line) || line < 1 || line > 10000000
    $('dev-refresh').disabled = locked
    $('dev-new-session').disabled = !agentReady
    $('dev-copy').disabled = !ready
    $('dev-link').disabled = !ready || !sessionID.test($('dev-session-id').value.trim())
    $('dev-resume').disabled = !sessionReady || !agentReady || state.archived
    $('dev-pin').disabled = !sessionReady
    $('dev-archive').disabled = !sessionReady
    $('dev-pin').textContent = state.pinned ? '取消置顶' : '置顶会话'
    $('dev-archive').textContent = state.archived ? '恢复会话' : '归档会话'
    $('dev-transcript').disabled = !sessionReady
    $('dev-save-alias').disabled = !sessionReady || $('dev-alias').value.trim() === (aliases[aliasKey] ?? '')
    $('dev-alias').disabled = !sessionReady
    $('dev-card-save').disabled = !ready || !$('dev-card-title').value.trim() || !$('dev-card-body').value.trim()
    $('dev-card-remove').hidden = !editing
    $('dev-card-remove').disabled = !ready
    const hasGoal = entries.some(entry => entry.kind === 'goal')
    const hasTranscript = entries.some(entry => entry.kind === 'transcript' && entry.tool === $('dev-provider').value && entry.session === $('dev-session').value)
    $('dev-handoff-goal').disabled = !ready || !hasGoal
    $('dev-handoff-transcript').disabled = !ready || !hasTranscript
    if (!hasGoal) $('dev-handoff-goal').checked = false
    if (!hasTranscript) $('dev-handoff-transcript').checked = false
    for (const field of $('dev-handoff-cards').querySelectorAll('input')) field.disabled = !ready
    const selected = handoffSelection()
    $('dev-handoff-preview').disabled = !ready || (!selected.goal && !selected.cards.length && !selected.transcript)
    $('dev-handoff-copy').disabled = !ready || !handoff
    for (const id of ['dev-card', 'dev-category', 'dev-card-title', 'dev-card-body']) $(id).disabled = !ready
    for (const id of ['dev-goal', 'dev-note', 'dev-path', 'dev-line', 'dev-session-id']) $(id).readOnly = writing.has(workspace)
    for (const id of ['dev-editor', 'dev-provider', 'dev-session', 'dev-session-filter', 'dev-session-search']) $(id).disabled = writing.has(workspace)
  }
  function sessionOptions() {
    const menu = $('dev-session')
    const previous = menu.value
    const provider = $('dev-provider').value
    const linked = new Map()
    for (const entry of entries.slice().reverse()) {
      if (entry.kind === 'session_link' && entry.tool === provider && sessionID.test(entry.text) && !linked.has(entry.text.toLowerCase())) linked.set(entry.text.toLowerCase(), entry.at)
    }
    const filter = $('dev-session-filter').value
    const query = $('dev-session-search').value.trim().toLowerCase()
    const state = id => sessions[provider + ':' + id] ?? {}
    const matches = [...linked].filter(([id]) => {
      const archived = !!state(id).archived
      return (filter === 'all' || (filter === 'archived' ? archived : !archived)) &&
        (!query || [id, aliases[provider + ':' + id]].some(value => value?.toLowerCase().includes(query)))
    }).sort(([a, at], [b, bt]) => Number(!!state(b).pinned) - Number(!!state(a).pinned) || bt - at)
    menu.replaceChildren(new doc.defaultView.Option(matches.length ? '选择要继续的会话' : linked.size ? '此范围没有匹配会话' : '暂无已关联会话', ''))
    for (const [id, at] of matches) {
      const date = new Date(at).toLocaleDateString('zh-CN')
      const alias = aliases[provider + ':' + id.toLowerCase()]
      menu.add(new doc.defaultView.Option([state(id).pinned && '置顶', state(id).archived && '已归档', alias, date, id].filter(Boolean).join(' · '), id))
    }
    if (matches.some(([id]) => id === previous)) menu.value = previous
    if (menu.value !== previous) { clearHandoff(); $('dev-handoff-transcript').checked = false }
    syncAlias()
  }
  function render(memory) {
    if (!Array.isArray(memory?.entries) || memory.entries.some(e => !e || !Object.hasOwn(kinds, e.kind) || typeof e.text !== 'string' || !Number.isFinite(e.at))) {
      throw Error('项目记忆数据无效，请刷新重试。')
    }
    entries = memory.entries
    cards = memory.library?.cards ?? []
    aliases = memory.library?.aliases ?? {}
    sessions = memory.library?.sessions ?? {}
    handoffCards()
    $('dev-card-count').textContent = '(' + cards.length + ')'
    const menu = $('dev-card')
    menu.replaceChildren(new doc.defaultView.Option('新建记忆', ''))
    for (const card of cards) menu.add(new doc.defaultView.Option(card.title, card.id))
    menu.value = editing?.id ?? ''
    loaded = true
    sessionOptions()
    renderHistory()
  }
  function renderHistory() {
    const fragment = doc.createDocumentFragment()
    const query = $('dev-search').value.trim().toLowerCase()
    const matches = entries.slice().reverse().filter(e => {
      if (!query) return true
      const id = e.session || (e.kind === 'session_link' ? e.text : e.kind === 'session_open' || e.kind === 'session_failed' ? e.text.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu)?.[0] : '')
      return [kinds[e.kind], tools[e.tool], e.text, id, id && aliases[e.tool + ':' + id.toLowerCase()]].some(value => value && value.toLowerCase().includes(query))
    })
    $('dev-more').hidden = matches.length <= pageSize
    $('dev-results').hidden = !query
    $('dev-results').textContent = query ? '找到 ' + matches.length + ' 条记录' : ''
    for (const entry of matches.slice(0, pageSize)) {
      const item = doc.createElement('li')
      const heading = doc.createElement('strong')
      const time = doc.createElement('time')
      const body = doc.createElement('p')
      heading.textContent = [kinds[entry.kind], tools[entry.tool]].filter(Boolean).join(' · ')
      const date = new Date(entry.at)
      time.dateTime = date.toISOString()
      time.textContent = date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
      body.textContent = entry.text
      item.append(heading, time)
      if (entry.kind === 'transcript') {
        const details = doc.createElement('details')
        const summary = doc.createElement('summary')
        summary.textContent = '查看全文 · ' + entry.session
        details.append(summary, body)
        item.append(details)
      } else item.append(body)
      fragment.append(item)
    }
    $('dev-history').replaceChildren(fragment)
  }
  function retainDraft() {
    if (workspace) drafts.set(workspace, draftFields.map(id => $(id).value))
  }
  function switchWorkspace(id) {
    retainDraft()
    workspace = id
    generation++
    loading = false
    loaded = false
    entries = []
    cards = []; aliases = {}; sessions = {}; pageSize = 25
    $('dev-session-filter').value = 'active'; $('dev-session-search').value = ''
    clearHandoff(); $('dev-handoff').open = false; $('dev-handoff-cards').replaceChildren()
    $('dev-handoff-goal').checked = false; $('dev-handoff-transcript').checked = false
    $('dev-card').replaceChildren(new doc.defaultView.Option('新建记忆', ''))
    cardFields(); $('dev-card-count').textContent = ''; $('dev-search').value = ''
    $('dev-library').open = false
    $('dev-more').hidden = true; $('dev-results').hidden = true
    $('dev-session').value = ''; syncAlias(true)
    $('dev-history').replaceChildren()
    const values = drafts.get(id) ?? ['', '', 'vscode', '', '1', 'claude-code', '']
    draftFields.forEach((field, i) => { $(field).value = values[i] })
    sessionOptions()
    status(id ? '' : '请选择工作空间。')
  }
  async function load() {
    if (panel.hidden || !available || loading || writing.has(workspace)) return
    const version = ++generation
    loading = true
    status('正在读取项目记忆…')
    controls()
    try {
      const memory = await invoke('pet_dev_memory', { workspaceId: workspace })
      if (version !== generation) return
      render(memory)
      const last = entries.at(-1)
      status(isFailure(last) ? last.text : entries.length ? '' : '还没有项目记忆。', isFailure(last))
    } catch (error) {
      if (version === generation) {
        loaded = false
        status(String(error?.message ?? error ?? '项目记忆读取失败，请刷新重试。'), true)
      }
    } finally {
      if (version === generation) { loading = false; controls() }
    }
  }
  function update(canUse) {
    const reconnected = canUse && !available
    available = canUse
    $('view-tools').disabled = !available
    if (panel.hidden) return
    const id = getWorkspace()
    if (id !== workspace) {
      switchWorkspace(id)
      void load()
    } else if (reconnected && !loaded) void load()
    controls()
  }
  async function write(command, input, clear, notice, done) {
    if (panel.hidden || !available || !loaded || loading || writing.has(workspace)) return
    const id = workspace
    const version = ++generation
    writing.add(id)
    status('正在处理…')
    controls()
    try {
      const args = typeof input === 'function' ? await input() : input
      if (version !== generation) return
      const memory = await invoke(command, { workspaceId: id, ...args })
      if (version !== generation) {
        if (clear && drafts.has(id)) {
          drafts.get(id)[draftFields.indexOf(clear)] = ''
          if (id === workspace) $(clear).value = ''
        }
        return
      }
      if (command !== 'pet_dev_copy_context' && command !== 'pet_dev_handoff') render(memory)
      done?.(memory)
      const last = entries.at(-1)
      const attemptedLaunch = command === 'pet_dev_open' || command === 'pet_dev_locate' || (command === 'pet_dev_session' && args.action !== 'link')
      const failed = attemptedLaunch && isFailure(last)
      if (clear && (!failed || (clear === 'dev-goal' && entries.some(e => e.kind === 'goal' && e.text === args.goal)))) $(clear).value = ''
      status(failed ? `${kinds[last.kind]}：${last.text}` : notice, failed)
    } catch (error) {
      if (version === generation) {
        if (command === 'pet_dev_handoff') clearHandoff()
        status(String(error?.message ?? error ?? '操作失败，请刷新记录。'), true)
      }
    } finally {
      writing.delete(id)
      if (version !== generation && id === workspace && !panel.hidden) void load()
      controls()
    }
  }
  function close(restoreFocus = true) {
    if (panel.hidden) return
    switchWorkspace('')
    ++detectionGeneration; detecting = false
    panel.hidden = true
    $('view-tools').setAttribute('aria-expanded', 'false')
    delete $('assistant').dataset.devTools
    if (restoreFocus) $('view-tools').focus()
  }
  listen($('view-tools'), 'click', () => {
    if (!available || !panel.hidden) return
    panel.hidden = false
    $('assistant').dataset.devTools = 'true'
    $('view-tools').setAttribute('aria-expanded', 'true')
    switchWorkspace(getWorkspace())
    $('dev-provider').focus()
    void load()
    void detectTools()
    controls()
  })
  listen($('dev-back'), 'click', () => close())
  listen($('dev-refresh'), 'click', async () => {
    const id = workspace
    await load()
    if (id === workspace && loaded && !writing.has(id)) { cardFields(editing?.id); syncAlias(true); controls() }
  })
  listen(panel, 'input', controls)
  listen($('dev-detect'), 'click', () => { void detectTools() })
  listen($('dev-editor'), 'change', controls)
  for (const [id, event] of [['dev-session-filter', 'change'], ['dev-session-search', 'input']]) {
    listen($(id), event, () => { sessionOptions(); controls() })
  }
  for (const [id, field] of [['dev-pin', 'pinned'], ['dev-archive', 'archived']]) {
    listen($(id), 'click', () => {
      if (!$('dev-session').value) return
      const state = selectedSessionState()
      const edit = { action: 'sessionState', provider: $('dev-provider').value, session: $('dev-session').value, ...state, [field]: !state[field] }
      void write('pet_dev_library', { edit }, '', field === 'pinned' ? '会话置顶状态已保存。' : state.archived ? '会话已恢复，可在未归档列表继续。' : '会话已归档，可在已归档列表恢复。')
    })
  }
  listen($('dev-provider'), 'change', () => {
    clearHandoff(); $('dev-handoff-transcript').checked = false
    $('dev-session-id').value = ''
    $('dev-session').value = ''
    sessionOptions()
    controls()
  })
  listen($('dev-session'), 'change', () => { clearHandoff(); $('dev-handoff-transcript').checked = false; syncAlias(); controls() })
  listen($('dev-handoff'), 'change', () => { clearHandoff(); controls() })
  listen($('dev-handoff-preview'), 'click', () => {
    const selection = handoffSelection()
    void write('pet_dev_handoff', { selection, expectedDigest: null }, '', '交接预览已生成，请核对后复制。', packet => {
      if (typeof packet?.text !== 'string' || !/^[a-f0-9]{64}$/u.test(packet.digest)) throw Error('交接预览响应无效，请重试。')
      handoff = { ...packet, selection }
      $('dev-handoff-text').value = packet.text; $('dev-handoff-result').hidden = false
    })
  })
  listen($('dev-handoff-copy'), 'click', () => {
    if (handoff) void write('pet_dev_handoff', { selection: handoff.selection, expectedDigest: handoff.digest }, '', '所选交接内容已复制。')
  })
  listen($('dev-card'), 'change', () => { cardFields($('dev-card').value); controls() })
  listen($('dev-card-save'), 'click', () => {
    const edit = { ...(editing ? { action: 'update', id: editing.id, revision: editing.revision } : { action: 'create' }),
      category: $('dev-category').value, title: $('dev-card-title').value.trim(), body: $('dev-card-body').value.trim() }
    void write('pet_dev_library', { edit }, '', '长期记忆已保存。', () => cardFields(edit.id ?? cards.at(-1)?.id))
  })
  listen($('dev-card-remove'), 'click', () => {
    if (!editing) return
    if (!removing) { removing = true; $('dev-card-remove').textContent = '确认移除'; return }
    void write('pet_dev_library', { edit: { action: 'remove', id: editing.id, revision: editing.revision } }, '', '长期记忆已移除。', () => cardFields())
  })
  listen($('dev-save-alias'), 'click', () => {
    void write('pet_dev_library', { edit: { action: 'alias', provider: $('dev-provider').value, session: $('dev-session').value, title: $('dev-alias').value.trim() } }, '', '会话备注名已保存。', () => syncAlias(true))
  })
  listen($('dev-search'), 'input', () => { pageSize = 25; renderHistory() })
  listen($('dev-more'), 'click', () => { pageSize += 25; renderHistory() })
  listen($('dev-new-session'), 'click', () => {
    const provider = $('dev-provider').value
    const detail = provider === 'codex' ? '请在 Codex 输入消息，用 /status 查看会话 ID 后可关联到项目。' : provider === 'gemini' ? '请在 Gemini CLI 输入消息，用 /stats 查看完整会话 ID 后关联到项目。' : '请在 Claude Code 中输入第一条消息。'
    void write('pet_dev_session', { provider, action: 'new', sessionId: '' }, '', `已请求打开原生终端。${detail}`)
  })
  listen($('dev-link'), 'click', () => {
    const provider = $('dev-provider').value
    const id = $('dev-session-id').value.trim()
    if (sessionID.test(id)) void write('pet_dev_session', { provider, action: 'link', sessionId: id }, 'dev-session-id', '会话已关联，可从列表中继续。')
  })
  listen($('dev-resume'), 'click', () => {
    const provider = $('dev-provider').value
    const id = $('dev-session').value
    if (entries.some(e => e.kind === 'session_link' && e.tool === provider && e.text === id)) {
      void write('pet_dev_session', { provider, action: 'resume', sessionId: id }, '', '已请求在原生终端继续所选会话。')
    }
  })
  listen($('dev-copy'), 'click', () => {
    void write('pet_dev_copy_context', {}, '', '项目上下文已复制。')
  })
  listen($('dev-transcript'), 'change', () => {
    const field = $('dev-transcript')
    const file = field.files?.[0]
    field.value = ''
    const provider = $('dev-provider').value
    const id = $('dev-session').value
    if (!file || !entries.some(e => e.kind === 'session_link' && e.tool === provider && e.text === id)) return
    void write('pet_dev_transcript', async () => {
      const limit = 256 * 1024
      if (!/\.(md|txt)$/iu.test(file.name)) throw Error('请选择 Markdown (.md) 或文本 (.txt) 文件。')
      if (!file.size || file.size > limit) throw Error('请选择 1 字节至 256 KiB 的会话记录。')
      const bytes = await file.arrayBuffer()
      if (!bytes.byteLength || bytes.byteLength > limit) throw Error('会话记录大小无效。')
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw Error('会话记录需要使用 UTF-8 编码。') }
      if (!text.trim() || text.includes('\u0000')) throw Error('请选择含有正文的 UTF-8 文本文件。')
      return { provider, sessionId: id, text }
    }, '', '会话记录已存入项目记忆。')
  })
  listen($('dev-save-goal'), 'click', () => {
    const text = $('dev-goal').value.trim()
    if (text) void write('pet_dev_goal', { text }, 'dev-goal', '项目目标已保存。')
  })
  listen($('dev-open'), 'click', () => {
    const goal = $('dev-goal').value.trim()
    if (goal) void write('pet_dev_open', { tool: $('dev-editor').value, goal }, 'dev-goal', '已请求编辑器打开项目和交接文件。')
  })
  listen($('dev-continue'), 'click', () => {
    if (!entries.some(e => e.kind === 'goal') || $('dev-goal').value.trim()) return
    void write('pet_dev_open', { tool: $('dev-editor').value, goal: '' }, '', '已请求编辑器打开已有交接。')
  })
  listen($('dev-locate'), 'click', () => {
    const relative = $('dev-path').value.trim()
    const line = $('dev-line').valueAsNumber
    if (relative && Number.isInteger(line) && line >= 1 && line <= 10000000) void write('pet_dev_locate', { tool: $('dev-editor').value, relative, line }, '', '已请求编辑器定位文件。')
  })
  listen($('dev-save'), 'click', () => {
    const text = $('dev-note').value.trim()
    if (text) void write('pet_dev_note', { text }, 'dev-note', '补记已保存。')
  })
  return { update, close, refresh: () => { if (!panel.hidden) void load() }, isOpen: () => !panel.hidden }
}
