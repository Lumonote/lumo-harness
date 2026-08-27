/**
 * subagent-remote 的回调接收面:承载侧 child 结算后 POST `ChildResultBody` 到
 * `POST /subagent/result`(进程内 createServer,插件 `apply` 的 ctx.effect 起停)。
 *
 * 语义:
 * 1. 仅对**已注册 runId** 结集 —— 回执表由 provider.start 登记(childId mint 即登记,
 *    200 前到位,杜绝「host 回执先于注册」竞态);首次回执后立即摘除(单次结集,
 *    重放 → 404)。未注册 → 404 且不反馈细节。
 * 2. 校验用契约 `assertChildResultBody`(失败 400),词表外/坏形状不进结集。
 * 3. 结集后 `reportTerminal` best-effort 终态上报(经 Scheduler API,失败吞掉,
 *    不阻塞回执 200 —— 审计在承载侧会话日志)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { invalid, seamErrorCode } from '../../../shared/seam-contracts/errors.ts'
import { assertChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'
import type { ChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'

/** 一枚已注册回执的终态接驳(provider 决定 resolve 或 reject)。 */
export type ChildResultSettler = (body: ChildResultBody) => void

/** 已注册回执结集后的 best-effort 终态上报钩子。 */
export type ReportTerminal = (body: ChildResultBody) => void

export interface CallbackServerOptions {
  /** runId → 结算器。server 只读查询 + 首次结算后摘除;登记/删除由 provider.start 做。 */
  readonly pending: Map<string, ChildResultSettler>
  /** 已注册回执结集后调用(终态上报;失败吞掉,不阻塞 200)。 */
  readonly reportTerminal: ReportTerminal
}

/** 单请求体上限(不能无上限;回执主体是模型面 JSON,1 MiB 足够宽裕)。 */
const MAX_BODY_BYTES = 1 << 20

export function createCallbackServer(options: CallbackServerOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options).catch((e: unknown) => {
      // 兜底:handle 内部已把可预期错误转成响应,走到这里说明是写响应本身失败
      if (!res.headersSent) respond(res, 500, { ok: false, code: 'internal', message: '内部错误' })
      else res.end()
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, options: CallbackServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://callback.invalid')
  const parts = url.pathname.split('/').filter(Boolean)
  if (req.method !== 'POST' || parts.length !== 2 || parts[0] !== 'subagent' || parts[1] !== 'result') {
    respond(res, 404, { ok: false, code: 'invalid', message: `未知路由 ${req.method} ${url.pathname}` })
    return
  }

  try {
    const body = await readBody(req)
    // 校验在前:坏形状 400,连 runId 都不该被查询(拒绝注入探测)
    assertChildResultBody(body)
    const settler = options.pending.get(body.runId)
    if (!settler) {
      // 未注册/已结集重放:不反馈细节 —— 404 不分「从未注册」与「已结算」两种语义
      respond(res, 404, { ok: false, code: 'invalid', message: '回调不受理' })
      return
    }
    options.pending.delete(body.runId)
    settler(body)
    options.reportTerminal(body)
    respond(res, 200, { ok: true })
  } catch (e) {
    respond(res, seamErrorCode(e) === 'internal' ? 500 : 400, { ok: false, code: seamErrorCode(e), message: e instanceof Error ? e.message : String(e) })
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(invalid(`回调体超过上限 ${MAX_BODY_BYTES} 字节`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        reject(invalid('回调体不是合法 JSON'))
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(invalid('回调体必须是对象'))
        return
      }
      resolve(parsed as Record<string, unknown>)
    })
    req.on('error', (e) => reject(new Error(`读取回调体失败: ${e.message}`)))
  })
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
