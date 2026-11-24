/**
 * 极简 JSON-RPC 2.0 连接（ACP 与 Codex app-server 都用「每行一条 JSON」的 stdio 帧）。
 *
 * 只做三件事：按行切帧、请求/响应配对（含超时）、把对端发来的请求与通知分发给处理器。
 * 不依赖 @agentclientprotocol/sdk —— dsh 只读、平台插件不额外引入运行时依赖；
 * 协议面很小，手写更容易审计。
 */

export interface JsonRpcError { code: number; message: string; data?: unknown }
export type JsonRpcId = number | string
export interface JsonRpcMessage {
  jsonrpc?: '2.0'
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

/** 双向消息通道：stdio 子进程与进程内桥接共用这一个抽象。 */
export interface MessageTransport {
  send(message: JsonRpcMessage): void
  onMessage(listener: (message: JsonRpcMessage) => void): void
  onClose(listener: (reason: string) => void): void
  close(): void
}

export class RpcRemoteError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message) }
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown
export type NotificationHandler = (params: unknown) => void

export const METHOD_NOT_FOUND = -32601
export const INTERNAL_ERROR = -32603
/** 单帧上限：防止失控子进程把内存打满 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }

export class JsonRpcConnection {
  private nextId = 1
  private closed: string | undefined
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly notificationHandlers = new Map<string, NotificationHandler>()
  private fallbackNotification: ((method: string, params: unknown) => void) | undefined
  private readonly closeListeners = new Set<(reason: string) => void>()

  constructor(private readonly transport: MessageTransport, private readonly defaultTimeoutMs = 120_000) {
    transport.onMessage(message => { void this.dispatch(message) })
    transport.onClose(reason => this.shutdown(reason))
  }

  get isClosed(): boolean { return this.closed !== undefined }

  onRequest(method: string, handler: RequestHandler): void { this.requestHandlers.set(method, handler) }
  onNotification(method: string, handler: NotificationHandler): void { this.notificationHandlers.set(method, handler) }
  onAnyNotification(handler: (method: string, params: unknown) => void): void { this.fallbackNotification = handler }
  onClose(listener: (reason: string) => void): void {
    if (this.closed !== undefined) listener(this.closed)
    else this.closeListeners.add(listener)
  }

  /** timeoutMs=0 表示不超时（session/prompt 一轮可以很长，由 cancel 结束）。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.closed !== undefined) return Promise.reject(new Error(`连接已关闭：${this.closed}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: value => resolve(value as T), reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed !== undefined) return
    this.transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  close(): void { this.transport.close(); this.shutdown('closed by client') }

  private shutdown(reason: string): void {
    if (this.closed !== undefined) return
    this.closed = reason
    for (const [, entry] of this.pending) { if (entry.timer) clearTimeout(entry.timer); entry.reject(new Error(`连接已关闭：${reason}`)) }
    this.pending.clear()
    for (const listener of this.closeListeners) { try { listener(reason) } catch { /* 忽略 */ } }
    this.closeListeners.clear()
  }

  private async dispatch(message: JsonRpcMessage): Promise<void> {
    // 响应
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) entry.reject(new RpcRemoteError(message.error.code, message.error.message, message.error.data))
      else entry.resolve(message.result)
      return
    }
    if (message.method === undefined) return
    // 对端请求
    if (message.id !== undefined && message.id !== null) {
      const handler = this.requestHandlers.get(message.method)
      if (handler === undefined) {
        this.transport.send({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${message.method}` } })
        return
      }
      try {
        const result = await handler(message.params)
        this.transport.send({ jsonrpc: '2.0', id: message.id, result: result ?? null })
      } catch (error) {
        const code = error instanceof RpcRemoteError ? error.code : INTERNAL_ERROR
        this.transport.send({ jsonrpc: '2.0', id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    // 通知
    const handler = this.notificationHandlers.get(message.method)
    try {
      if (handler) handler(message.params)
      else this.fallbackNotification?.(message.method, message.params)
    } catch { /* 通知处理器异常不影响连接 */ }
  }
}

/** 换行分帧解码器：容忍 CRLF 与半包，超限帧丢弃并报告。 */
export class LineDecoder {
  private buffer = ''
  constructor(private readonly onLine: (line: string) => void, private readonly onOversize?: () => void) {}
  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes('\n')) {
      this.buffer = ''
      this.onOversize?.()
      return
    }
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() !== '') this.onLine(line)
    }
  }
}

/** 进程内双工通道：桥接层（如 Codex → ACP）与测试用。 */
export function memoryTransportPair(): [MessageTransport, MessageTransport] {
  const make = () => ({ listeners: new Set<(m: JsonRpcMessage) => void>(), close: new Set<(r: string) => void>(), closed: false })
  const a = make(); const b = make()
  const side = (self: ReturnType<typeof make>, peer: ReturnType<typeof make>): MessageTransport => ({
    send(message) {
      if (self.closed || peer.closed) return
      // 异步投递并做一次 JSON 往返，语义上与真实 stdio 一致（不共享对象引用）
      const copy = JSON.parse(JSON.stringify(message)) as JsonRpcMessage
      queueMicrotask(() => { for (const l of peer.listeners) l(copy) })
    },
    onMessage(listener) { self.listeners.add(listener) },
    onClose(listener) { self.close.add(listener) },
    close() {
      if (self.closed) return
      self.closed = true; peer.closed = true
      for (const l of [...self.close, ...peer.close]) l('transport closed')
    },
  })
  return [side(a, b), side(b, a)]
}
