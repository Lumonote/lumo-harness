// P1 跨设备记忆同步：桌宠「开发工具」里的同步状态与冲突处理（独立组件）。
// 本地状态、差量计算和网络请求都在 Rust（memory_sync.rs：pet_memory_sync / pet_memory_sync_run），
// 页面不再 fetch 外部地址，令牌也不经过 JS（CSP connect-src 不放行 https:）。先推后拉；离线失败不丢数据——待推送内容就是本地相对同步快照的差，下次重连自动补推。
const call = (invoke, workspaceId, request) => invoke('pet_memory_sync', { workspaceId, request })

export async function syncOnce({ invoke, workspaceId }) {
  return invoke('pet_memory_sync_run', { workspaceId })
}

function preview(payload) {
  if (payload == null || payload === '') return '（已删除）'
  try { const c = JSON.parse(payload); return `${c.title}：${c.body}`.slice(0, 160) } catch { return '（无法读取）' }
}

export function mountMemorySync({ doc, invoke, listen, getWorkspace, onChanged = () => {}, timer = globalThis }) {
  const $ = id => doc.getElementById(id)
  const root = $('dev-sync')
  if (!root) return { refresh: async () => {}, dispose() {} }
  let busy = false, view = null, interval = null
  const status = (text, error = false) => { $('dev-sync-status').textContent = text; $('dev-sync-status').dataset.error = String(error) }
  function render() {
    if (!view) return
    $('dev-sync-enabled').checked = view.enabled
    if (doc.activeElement !== $('dev-sync-server')) $('dev-sync-server').value = view.server
    $('dev-sync-token').placeholder = view.hasToken ? '已保存（留空不修改）' : '访问令牌（可选）'
    $('dev-sync-now').disabled = busy || !view.enabled
    const when = view.lastSyncMs ? new Date(view.lastSyncMs).toLocaleString() : '尚未同步'
    $('dev-sync-summary').textContent = view.enabled ? `待推送 ${view.pending} 条 · 冲突 ${view.conflicts.length} 条 · ${when}${view.skipped ? ` · 跳过 ${view.skipped} 条` : ''}` : '未开启'
    const list = $('dev-sync-conflicts')
    list.replaceChildren(...view.conflicts.map(c => {
      const li = doc.createElement('li')
      const text = doc.createElement('p')
      text.textContent = `本机：${preview(c.local)}\n云端（${c.remote.device.slice(0, 8)}）：${preview(c.remote.deleted ? '' : c.remote.payload)}`
      const keep = doc.createElement('button'); keep.type = 'button'; keep.textContent = '保留本机'
      const take = doc.createElement('button'); take.type = 'button'; take.textContent = '采用云端'
      keep.addEventListener('click', () => resolve(c.id, 'local'))
      take.addEventListener('click', () => resolve(c.id, 'remote'))
      li.append(text, keep, take)
      return li
    }))
    list.hidden = view.conflicts.length === 0
  }
  async function run(request, message) {
    const ws = getWorkspace()
    if (!ws || busy) return
    busy = true; render()
    try { view = await call(invoke, ws, request); if (message) status(message) } catch (e) { status(String(e?.message ?? e), true) } finally { busy = false; render() }
  }
  async function sync() {
    const ws = getWorkspace()
    if (!ws || busy || !view?.enabled) return
    busy = true; render(); status('正在同步…')
    try {
      const before = view.conflicts.length
      view = await syncOnce({ invoke, workspaceId: ws }) ?? view
      status(view.conflicts.length > before ? '有条目在两台设备上都被修改，请在下方选择保留哪一版。' : '已同步。')
      onChanged()
    } catch (e) {
      status(`暂时无法连接同步服务器，修改已在本机排队，重连后自动补同步（${e?.message ?? e}）`, true)
    } finally { busy = false; render() }
  }
  function resolve(id, choice) { void run({ op: 'resolve', id, choice }, choice === 'local' ? '已保留本机版本，下次同步覆盖云端。' : '已采用云端版本。').then(onChanged) }
  listen($('dev-sync-save'), 'click', () => {
    const token = $('dev-sync-token').value
    void run({ op: 'configure', enabled: $('dev-sync-enabled').checked, server: $('dev-sync-server').value, token: token ? token : null }, '同步设置已保存。').then(() => { $('dev-sync-token').value = '' })
  })
  listen($('dev-sync-now'), 'click', () => void sync())
  listen(doc.defaultView ?? globalThis, 'online', () => void sync())
  interval = timer.setInterval?.(() => void sync(), 5 * 60 * 1000)
  return {
    refresh: () => run({ op: 'status' }),
    sync,
    dispose() { if (interval != null) timer.clearInterval?.(interval) },
  }
}
