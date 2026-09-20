/**
 * Thread 注册表的客户端（`control-plane/collaborator` 的 `/threads`）。
 *
 * ## 为什么是「读 + 请求状态变更」，而不是插件自己写库
 *
 * `threads` 表在 Go 侧有唯一建表方与唯一写入方（`internal/store/threads.go`），而插件
 * **没有** `pg` 依赖（本切片不引新依赖）。更重要的理由是判据：承载节点亲和这条不变量
 * 需要一个单点判定——两个实现各写一遍，迟早有一边把 `node_id` 一起写进 UPDATE，于是
 * 「节点丢失」变成「换台机器接着跑」。所以插件这一侧只做两件事：**读**行，以及**请求**
 * 一次状态变更（由服务端判定合法性）。
 *
 * ## 授权口径
 *
 * 生产形态下 `X-Lumo-User` / `X-Lumo-Realm` 由**边缘网关**在认证之后注入（见
 * `cmd/collaborator/main.go` 的 `headerAuth`），协作服务不自行签发凭证。插件直连时
 * （单集群内网、mTLS 由网关层覆盖）用配置里的身份；**realm 不由请求体携带** ——
 * 一个能自报 realm 的写入口等于没有租户边界。
 *
 * ## 与 `roster.ts` 同训：结构类型 + 可注入 fetch
 *
 * 这里不 import 任何 HTTP 库：`fetch` 是 Node 22 的内建，测试注入一个假实现即可覆盖
 * 全部路径（超时、错误码、脏返回体），不必起一个协作服务。
 */

import { parseNodeLossNotice, parseThreadRow, type NodeLossNotice, type ThreadRow, type ThreadState } from './thread.ts'

/** 建线程的输入（字段名与 `threads` 表的列名一致；`realm` 不进请求体）。 */
export interface CreateThreadInput {
  id: string
  project_id: string
  task_id: string
  coordinator_session_ref: string
  session_ref: string
  node_id: string
  /** 省略时由服务端按 `thread/<id>/` 派生（唯一合法值，见 §24.3.2）。 */
  workspace?: string
}

/** 线程注册表门面（故意只声明本插件真正用到的五个动作）。 */
export interface ThreadRegistryLike {
  create(input: CreateThreadInput): Promise<ThreadRow>
  /** 不存在返回 `undefined`（跨 realm 读在服务端就是「不存在」，两者在这里同形）。 */
  get(threadId: string): Promise<ThreadRow | undefined>
  list(query?: { project_id?: string; state?: ThreadState; limit?: number }): Promise<ThreadRow[]>
  transition(threadId: string, to: ThreadState): Promise<ThreadRow>
  /** 上报承载节点丢失（服务端按 node_id 拦：拿别的节点名关不掉这条线程）。 */
  nodeLoss(threadId: string, nodeId: string): Promise<ThreadRow>
  /**
   * 读**节点失联通知**的增量（§24.2.3(4) 的「通知协调者」腿）。
   *
   * `since` 是游标（上一次读到的最大 `seq`），不是时间戳 —— 同一个节点掉线时，它上面的
   * 多条线程会在同一毫秒里各产生一条通知，时间戳游标会把同毫秒的其余几条**永久跳过**，
   * 而那些线程已经 failed、协调者却永远收不到通知。
   */
  nodeLossNotices(query?: { since?: number; limit?: number }): Promise<NodeLossNotice[]>
}

/** 注册表调用失败（协议层：非 2xx、超时、返回体不合法）。 */
export class ThreadRegistryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ThreadRegistryError'
  }
}

export interface HttpThreadRegistryOptions {
  /** 协作服务基址（例如 `http://collaborator:8081`）。 */
  baseUrl: string
  /** 调用者身份（生产由网关注入；直连时用配置）。 */
  userId: string
  /** realm：**只经请求头**，不进请求体。 */
  realm: string
  /** 注入点（测试用）。 */
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

/** 默认超时 5 秒：线程面是控制面调用，卡住比失败更贵（会把唤醒路径一起拖住）。 */
const DEFAULT_TIMEOUT_MS = 5_000

/** 把 `{"error": "..."}` 里的服务端原文取出来（取不到就给整段文本，不吞）。 */
function describeFailure(status: number, body: string): string {
  if (body.trim() === '') return `HTTP ${status}`
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') {
      return `HTTP ${status}：${(parsed as { error: string }).error}`
    }
  } catch {
    // 不是 JSON 就原样带出去：服务端的错误原文比「未知错误」有用得多。
  }
  return `HTTP ${status}：${body.slice(0, 200)}`
}

/**
 * 建一个走 HTTP 的注册表。
 *
 * 三条从严的判法：
 *
 * 1. **404 是 `undefined` 而不是异常**（只对 `get`）。「这条线程不在本 realm」是一个
 *    正常答案，把它抛成异常会逼出「先 try 再 catch 当判断」的写法——那种写法分不清
 *    「不存在」与「协作服务挂了」，而两者的处置完全相反（前者重启一轮，后者别动）。
 * 2. **返回体一律过 `parseThreadRow`**。脏行（未知状态、串号的 id）进了唤醒路径，
 *    症状是「这条线程永远不醒」，而日志上看不出任何异常。
 * 3. **超时带 `AbortSignal.timeout`**：不设超时的 fetch 会把唤醒路径挂在一个不响应的
 *    服务上——那正是 §8.1 要消灭的「静默挂起」形状（不崩、不报错、只是不动了）。
 */
export function createHttpThreadRegistry(options: HttpThreadRegistryOptions): ThreadRegistryLike {
  const base = options.baseUrl.trim().replace(/\/+$/u, '')
  if (base === '') throw new ThreadRegistryError('协作服务基址为空：没有它就没有线程注册表')
  if (options.realm.trim() === '') throw new ThreadRegistryError('realm 为空：线程注册表按 realm 隔离')
  if (options.userId.trim() === '') throw new ThreadRegistryError('调用者身份为空：协作服务按网关注入的头解析身份')
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    // 身份与 realm 走请求头：服务端**不接受**请求体里的 realm（防越权）。
    'x-lumo-user': options.userId,
    'x-lumo-realm': options.realm,
  })

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: headers(),
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: response.status, text: await response.text() }
  }

  function parse(raw: string, threadId?: string): ThreadRow {
    try {
      return parseThreadRow(JSON.parse(raw), threadId)
    } catch (error: unknown) {
      throw new ThreadRegistryError(
        `线程行不合法：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 非期望状态码即抛，错误原文来自服务端（不吞成「未知错误」）。 */
  function assertStatus(result: { status: number; text: string }, expected: number, what: string): void {
    if (result.status !== expected) {
      throw new ThreadRegistryError(`${what}：${describeFailure(result.status, result.text)}`, result.status)
    }
  }

  return {
    async create(input: CreateThreadInput): Promise<ThreadRow> {
      const result = await call('POST', '/threads', input)
      assertStatus(result, 201, '新建线程失败')
      return parse(result.text, input.id)
    },

    async get(threadId: string): Promise<ThreadRow | undefined> {
      const result = await call('GET', `/threads/${encodeURIComponent(threadId)}`)
      if (result.status === 404) return undefined
      assertStatus(result, 200, '读线程失败')
      return parse(result.text, threadId)
    },

    async list(query): Promise<ThreadRow[]> {
      const params = new URLSearchParams()
      if (query?.project_id !== undefined) params.set('project_id', query.project_id)
      if (query?.state !== undefined) params.set('state', query.state)
      if (query?.limit !== undefined) params.set('limit', String(query.limit))
      const suffix = params.size === 0 ? '' : `?${params.toString()}`
      const result = await call('GET', `/threads${suffix}`)
      assertStatus(result, 200, '列线程失败')
      const parsed: unknown = JSON.parse(result.text)
      if (!Array.isArray(parsed)) {
        throw new ThreadRegistryError(`列线程返回的不是数组：${result.text.slice(0, 120)}`)
      }
      return parsed.map(entry => parse(JSON.stringify(entry)))
    },

    async transition(threadId: string, to: ThreadState): Promise<ThreadRow> {
      const result = await call('POST', `/threads/${encodeURIComponent(threadId)}/state`, { to })
      assertStatus(result, 200, '线程状态变更失败')
      return parse(result.text, threadId)
    },

    async nodeLoss(threadId: string, nodeId: string): Promise<ThreadRow> {
      const result = await call('POST', `/threads/${encodeURIComponent(threadId)}/node-loss`, { node_id: nodeId })
      assertStatus(result, 200, '上报节点丢失失败')
      return parse(result.text, threadId)
    },

    async nodeLossNotices(query): Promise<NodeLossNotice[]> {
      const params = new URLSearchParams()
      if (query?.since !== undefined) params.set('since', String(query.since))
      if (query?.limit !== undefined) params.set('limit', String(query.limit))
      const suffix = params.size === 0 ? '' : `?${params.toString()}`
      const result = await call('GET', `/threads/node-loss-notices${suffix}`)
      assertStatus(result, 200, '读节点失联通知失败')
      const parsed: unknown = JSON.parse(result.text)
      if (!Array.isArray(parsed)) {
        throw new ThreadRegistryError(`节点失联通知返回的不是数组：${result.text.slice(0, 120)}`)
      }
      // 每一条都过 `parseNodeLossNotice`：一条脏通知（缺协调者 ref、线程 id 含分隔符）
      // 进了唤醒路径，症状是「这条线程永远不醒」或「唤醒了错的线程」，而日志上看不出异常。
      return parsed.map(entry => parseNodeLossNotice(entry))
    },
  }
}
