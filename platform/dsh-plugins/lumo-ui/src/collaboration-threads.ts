/** 按治理可见任务过滤 Thread 注册表，再批量读取控制态；浏览器不能指定任意会话。 */
export interface FleetTask {
  id: string
  realm?: string
  title?: string
  business_state?: string
  state?: string
  session_ref?: string
  assigned_node_id?: string
  assignee_name?: string
  assignee_user_id?: string
  updated_at?: string
  last_error?: string
}

export interface RegisteredThread {
  id: string
  realm: string
  task_id: string
  session_ref: string
  node_id: string
  state: string
  updated_at: string
}

export interface AgentThreadReader {
  listThreads(query?: { limit?: number; after?: string; taskIds?: string[] }): Promise<RegisteredThread[]>
}

export interface FleetControl {
  session_ref: string
  registered: boolean
  state: string | null
  updated_at?: string
}

interface FleetEntry extends FleetTask {
  task_id: string
  node_id?: string
  assignee?: string
  thread_state?: string
  control_state?: string | null
  control_updated_at?: string
}

export async function collaborationThreads(options: {
  realm: string
  tasks: unknown
  threadAfter?: string
  registry?: AgentThreadReader
  controls?: (refs: string[]) => Promise<{ realm: string; controls: FleetControl[] }>
}) {
  const raw = Array.isArray(options.tasks) ? options.tasks : (options.tasks as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(raw) || raw.some(task => typeof task !== 'object' || task === null || typeof task.id !== 'string')) {
    throw new Error('治理服务未返回任务列表')
  }
  const taskPage = options.tasks as { next_cursor?: unknown } | null
  if (!Array.isArray(options.tasks) && taskPage?.next_cursor !== undefined
    && (typeof taskPage.next_cursor !== 'string' || taskPage.next_cursor.length > 4096)) {
    throw new Error('治理服务返回的任务游标不合法')
  }
  const tasks = (raw as FleetTask[]).filter(task => task.realm === undefined || task.realm === options.realm).slice(0, 200)
  const byId = new Map(tasks.map(task => [task.id, task]))
  const errors: string[] = []
  let registry: RegisteredThread[] = []
  let registryReadable = false
  let nextThreadCursor = ''
  if (options.registry !== undefined) {
    try {
      const rows = tasks.length === 0 ? [] : await options.registry.listThreads({
        limit: 500, taskIds: tasks.map(task => task.id),
        ...options.threadAfter === undefined ? {} : { after: options.threadAfter },
      })
      registry = rows.slice(0, 500).filter(row => row.realm === options.realm && byId.has(row.task_id))
      registryReadable = true
      const scopeMismatch = rows.some(row => row.realm !== options.realm || !byId.has(row.task_id))
      if (scopeMismatch) errors.push('线程注册表返回了授权范围之外的数据，列表可能不完整')
      if (!scopeMismatch && rows.length >= 500) {
        const last = rows[499]
        // PostgreSQL's ID collation owns ordering; JavaScript string ordering
        // can differ. Equality is sufficient to detect a non-advancing cursor.
        if (last !== undefined && last.id !== options.threadAfter) nextThreadCursor = last.id
        else errors.push('线程注册表游标未前进，请检查服务版本后重新读取')
      }
    } catch { errors.push('线程注册表暂时不可读') }
  } else errors.push('线程注册表未装配')
  const seenTasks = new Set(registry.map(row => row.task_id))
  const stateMap: Record<string, string> = { running: 'RUNNING', failed: 'FAILED', stopped: 'CANCELLED', done: 'COMPLETED', idle: 'QUEUED', awaiting: 'WAITING' }
  const threads: FleetEntry[] = registry.map(row => {
    const task = byId.get(row.task_id)!
    return {
      id: `thread:${row.id}`, task_id: task.id, title: `${task.title ?? task.id} · ${row.id}`,
      ...(task.business_state === undefined ? {} : { business_state: task.business_state }),
      state: stateMap[row.state] ?? row.state, thread_state: row.state,
      session_ref: row.session_ref, node_id: row.node_id, updated_at: row.updated_at,
      assignee: task.assignee_name ?? task.assignee_user_id ?? row.node_id,
    }
  })
  for (const task of tasks) {
    const assignee = task.assignee_name ?? task.assignee_user_id
    if (!seenTasks.has(task.id)) threads.push({
      ...task, task_id: task.id, ...assignee === undefined ? {} : { assignee },
      ...(task.assigned_node_id === undefined ? {} : { node_id: task.assigned_node_id }),
    })
  }
  const controlsReadable = options.controls !== undefined
  const refs = [...new Set(threads.flatMap(row => row.session_ref ? [row.session_ref] : []))]
  const controls = new Map<string, FleetControl>()
  if (options.controls !== undefined) {
    for (let offset = 0; offset < refs.length; offset += 100) {
      const batch = refs.slice(offset, offset + 100)
      try {
        const result = await options.controls(batch)
        if (result.realm !== options.realm || !Array.isArray(result.controls)) throw new Error('控制态租户不匹配')
        const validated: FleetControl[] = []
        for (const ref of batch) {
          const control = result.controls.find(row => row.session_ref === ref)
          if (control === undefined || typeof control.registered !== 'boolean'
            || (control.registered ? typeof control.state !== 'string' : control.state !== null)) {
            throw new Error('控制态批次不完整')
          }
          validated.push(control)
        }
        for (const control of validated) controls.set(control.session_ref, control)
      } catch {
        errors.push('部分会话控制态暂时不可读')
      }
    }
  } else errors.push('会话控制态读面未配置')
  for (const thread of threads) {
    const control = thread.session_ref === undefined ? undefined : controls.get(thread.session_ref)
    if (control !== undefined) {
      thread.control_state = control.state
      if (control.updated_at !== undefined) thread.control_updated_at = control.updated_at
    }
  }
  if (raw.length > 200) errors.push('治理服务超过单页 200 条上限，当前页面不完整')
  const nextTaskCursor = typeof taskPage?.next_cursor === 'string' ? taskPage.next_cursor : ''
  if (taskPage?.next_cursor === undefined && raw.length >= 200) errors.push('治理服务未返回分页信息，任务列表可能不完整')
  return {
    threads, capabilities: { threadRegistry: registryReadable, controlState: controlsReadable },
    pagination: { nextTaskCursor, nextThreadCursor, taskCount: tasks.length },
    missingSessionRefs: threads.filter(thread => !thread.session_ref).length,
    errors: [...new Set(errors)],
  }
}
