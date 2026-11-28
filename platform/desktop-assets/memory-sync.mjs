// Sync transport and credentials stay in Rust. The shared project ID is a pairing label,
// not a credential: the server also isolates all content by the verified cloud account.
const call = (invoke, workspaceId, request) => invoke('pet_memory_sync', { workspaceId, request })
export async function syncOnce({ invoke, workspaceId, full = false }) { return invoke('pet_memory_sync_run', { workspaceId, full }) }

function preview(payload) {
  if (payload == null || payload === '') return '（已删除）'
  try { const c = JSON.parse(payload); return `${c.title}：${c.body}`.slice(0, 160) } catch { return '（无法读取）' }
}

export function mountMemorySync({ doc, invoke, listen, getWorkspace, onChanged = () => {}, timer = globalThis }) {
  const $ = id => doc.getElementById(id)
  if (!$('dev-sync')) return { refresh: async () => {}, sync: async () => {}, dispose() {} }
  let busy = false, view = null, interval = null, workspace = '', generation = 0, disposed = false
  const status = (text, error = false) => { $('dev-sync-status').textContent = text; $('dev-sync-status').dataset.error = String(error) }
  function select() {
    const next = getWorkspace() || ''
    if (next !== workspace) {
      workspace = next; generation++; busy = false; view = null
      for (const id of ['dev-sync-server', 'dev-sync-project', 'dev-sync-token']) $(id).value = ''
      status(''); render()
    }
    return workspace
  }
  const current = (ticket, ws) => !disposed && generation === ticket && workspace === ws && getWorkspace() === ws
  function render(preserveFields = false) {
    const disabled = busy || !workspace || !view
    for (const id of ['dev-sync-save', 'dev-sync-enabled', 'dev-sync-server', 'dev-sync-project', 'dev-sync-token']) $(id).disabled = disabled
    $('dev-sync-now').disabled = disabled || !view?.enabled
    $('dev-sync-full').disabled = disabled || !view?.enabled
    $('dev-sync-conflicts').replaceChildren()
    $('dev-sync-conflicts').hidden = !view?.conflicts.length
    if (!view) {
      $('dev-sync-enabled').checked = false
      $('dev-sync-summary').textContent = workspace ? '正在读取…' : '请先选择工作空间'
      $('dev-sync-account').textContent = ''
      $('dev-sync-full-status').textContent = ''
      return
    }
    if (!preserveFields) $('dev-sync-enabled').checked = view.enabled
    if (!preserveFields && doc.activeElement !== $('dev-sync-server')) $('dev-sync-server').value = view.server
    if (!preserveFields && doc.activeElement !== $('dev-sync-project')) $('dev-sync-project').value = view.projectId
    $('dev-sync-token').placeholder = view.hasToken ? '已保存（留空不修改）' : '云端账户访问令牌'
    $('dev-sync-account').textContent = view.identity ? `已验证账户：${view.identity.realm} / ${view.identity.userId}` : '下次同步将先验证云端账户。'
    const when = view.lastSyncMs ? new Date(view.lastSyncMs).toLocaleString() : '尚未同步'
    $('dev-sync-summary').textContent = view.enabled ? `待推送 ${view.pending} 条 · 待接收 ${view.deferred ?? 0} 条 · 冲突 ${view.conflicts.length} 条 · ${when}` : '未开启'
    $('dev-sync-full-status').textContent = `上次完整对齐：${view.lastFullSyncMs ? new Date(view.lastFullSyncMs).toLocaleString() : '尚未完成'}`
    const list = $('dev-sync-conflicts')
    for (const c of view.conflicts) {
      const li = doc.createElement('li'), text = doc.createElement('p')
      text.textContent = `本机：${preview(c.local)}\n当前云端${c.remoteMissing ? '（记录缺失）' : `（${c.remote.device.slice(0, 8)}）`}：${preview(c.remote.deleted ? '' : c.remote.payload)}`
      const scope = view.scope
      const keep = doc.createElement('button'); keep.type = 'button'; keep.textContent = '保留本机'; keep.disabled = busy
      const take = doc.createElement('button'); take.type = 'button'; take.textContent = '采用云端'; take.disabled = busy
      keep.addEventListener('click', () => resolve(c.id, 'local', scope))
      take.addEventListener('click', () => resolve(c.id, 'remote', scope))
      li.append(text, keep, take)
      for (const [index, item] of (c.alternatives ?? []).entries()) {
        const saved = doc.createElement('p'), choose = doc.createElement('button')
        saved.textContent = `已保留版本 ${index + 1}：${preview(item.deleted ? '' : item.payload)}`
        choose.type = 'button'; choose.textContent = `采用已保留版本 ${index + 1}`; choose.disabled = busy
        choose.addEventListener('click', () => resolve(c.id, `saved:${index}`, scope))
        li.append(saved, choose)
      }
      list.append(li)
    }
  }
  async function run(request, message) {
    const ws = select()
    if (disposed || !ws || busy) return false
    const ticket = generation
    let accepted = false
    busy = true; render(request.op === 'configure')
    try {
      const result = await call(invoke, ws, request)
      if (!current(ticket, ws)) return false
      view = result; accepted = true
      if (message) status(message)
      return true
    } catch (e) {
      if (current(ticket, ws)) status(String(e?.message ?? e), true)
      return false
    } finally { if (current(ticket, ws)) { busy = false; render(!accepted && request.op === 'configure') } }
  }
  async function sync(full = false) {
    const ws = select()
    if (disposed || !ws || busy || !view?.enabled) return
    const ticket = generation
    busy = true; render(); status(full ? '正在验证账户并完整对齐…' : '正在验证账户并同步…')
    try {
      const result = await syncOnce({ invoke, workspaceId: ws, full })
      if (!current(ticket, ws)) return
      view = result ?? view
      status(view.conflicts.length ? '存在同步冲突，请选择保留哪一版。' : view.deferred ? `还有 ${view.deferred} 条待接收内容；释放记忆容量后会自动重试。` : '已同步。')
      onChanged()
    } catch (e) {
      if (current(ticket, ws)) status(`同步未完成，本机修改和待接收内容均已保留（${e?.message ?? e}）`, true)
    } finally { if (current(ticket, ws)) { busy = false; render() } }
  }
  function resolve(id, choice, scope) {
    void run({ op: 'resolve', id, choice, scope }, choice === 'local' ? '已保留本机版本，下次同步提交。' : choice.startsWith('saved:') ? '已采用保留版本，下次同步提交。' : '已采用当前云端版本。').then(ok => { if (ok) onChanged() })
  }
  listen($('dev-sync-save'), 'click', () => {
    const ws = select(), ticket = generation, token = $('dev-sync-token').value
    void run({ op: 'configure', enabled: $('dev-sync-enabled').checked, server: $('dev-sync-server').value, projectId: $('dev-sync-project').value, token: token || null }, '同步设置已保存。下次同步会验证账户，并合并当前项目的长期记忆。')
      .then(ok => { if (ok && current(ticket, ws)) $('dev-sync-token').value = '' })
  })
  listen($('dev-sync-now'), 'click', () => void sync())
  listen($('dev-sync-full'), 'click', () => void sync(true))
  listen(doc.defaultView ?? globalThis, 'online', () => void sync())
  interval = timer.setInterval?.(() => void sync(), 5 * 60 * 1000)
  render()
  return {
    refresh: () => run({ op: 'status' }), sync,
    dispose() { disposed = true; generation++; if (interval != null) timer.clearInterval?.(interval) },
  }
}
