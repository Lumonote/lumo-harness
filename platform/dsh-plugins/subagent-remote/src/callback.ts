/**
 * subagent-remote 的回调接收面:承载侧 child 结算后 POST `ChildResultBody` 到
 * `POST /subagent/result/{childId}/{secret}`(进程内 createServer,插件 `apply` 的
 * ctx.effect 起停)。`{childId}/{secret}` 是 per-run 鉴权能力段:secret 由父侧
 * provider.start 每次 mint、随 callbackUrl 下达,承载节点原样 POST 即落地 ——
 * 节点可达后回调接口对网络开放且无调用方认证(生产仍经边缘网关 mTLS,§6.3),
 * 能力段就是非回环部署前评审确认的**最小鉴权**。
 *
 * 语义:
 * 1. 仅对**已注册 runId** 结集 —— 回执表由 provider.start 登记(childId mint 即登记,
 *    200 前到位,杜绝「host 回执先于注册」竞态);首次回执后立即摘除(单次结集,
 *    重放 → 404)。path 能力段任一失败(未注册 / secret 不符)→ 404 不反馈细节,
 *    不分 401/403,与「未注册也 404」同态;失败**不摘表**(错 secret 不销毁
 *    注册条目,否则攻击者可 DoS 挂起中的 run)。
 * 2. 校验用契约 `assertChildResultBody`(失败 400),词表外/坏形状不进结集;
 *    body.runId 须与 path childId 同核 —— 能过 secret 校验的必是持证 host,
 *    不一致视为非本次注册回调,404(诚实 host 两者恒同)。
 * 3. 结集后 `reportTerminal` best-effort 终态上报(经 Scheduler API,失败吞掉,
 *    不阻塞回执 200 —— 审计在承载侧会话日志)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { invalid, seamErrorCode } from '../../../shared/seam-contracts/errors.ts'
import { assertChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'
import type { ChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'

/** 一枚已注册回执的终态接驳(provider 决定 resolve 或 reject)。 */
export type ChildResultSettler = (body: ChildResultBody) => void

/**
 * 回执表条目:per-run secret(鉴权面)+ 终态接驳。secret 为 `randomUUID()` 的
 * 随机 122bit,直接字符串比较即可 —— 攻击面是 2^122 猜测,比较时间差分可提取
 * 的信息量忽略不计,无需 timingSafeEqual(常量时间在「猜不中」面前无增益)。
 */
export interface PendingEntry {
	readonly secret: string
	readonly settler: ChildResultSettler
	attempt?: number
}

/** 已注册回执结集后的 best-effort 终态上报钩子。 */
export type ReportTerminal = (body: ChildResultBody, attempt?: number) => void

export interface CallbackServerOptions {
  /** runId → 条目。server 只读查询 + 首次结算后摘除;登记/删除由 provider.start 做。 */
  readonly pending: Map<string, PendingEntry>
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
  // 路由:`/subagent/result/{childId}/{secret}` —— childId+secret 均为能力段
  if (req.method !== 'POST' || parts.length !== 4 || parts[0] !== 'subagent' || parts[1] !== 'result') {
    respond(res, 404, { ok: false, code: 'invalid', message: `未知路由 ${req.method} ${url.pathname}` })
    return
  }
  const childId = parts[2]
  const secret = parts[3]

  try {
    const body = await readBody(req)
    // 校验在前:坏形状 400,连 runId 都不该被查询(拒绝注入探测)
    assertChildResultBody(body)
    // 鉴权面:注册表有该 childId 且条目 secret 与 path 段一致。secret 随机 122bit,
    // 直接字符串比较即可(timingSafeEqual 无增益,见 PendingEntry 注释);
    // 任一失败 → 404,不反馈细节、不分 401/403(未注册也 404 同态);失败不摘表,
    // 错 secret 的重放不得销毁待结集条目(否则攻击者可 DoS 挂起中的 run)。
    const entry = options.pending.get(childId)
    if (!entry || entry.secret !== secret) {
      respond(res, 404, { ok: false, code: 'invalid', message: '回调不受理' })
      return
    }
    if (body.runId !== childId) {
      // path 与 body 的 runId 必须同核:契约要求回执带 runId,持证 host 两者恒同;
      // 不一致视为非本次注册回调,404(同一路径能力段,不反馈细节)
      respond(res, 404, { ok: false, code: 'invalid', message: '回调不受理' })
      return
    }
    options.pending.delete(childId)
    entry.settler(body)
		options.reportTerminal(body, entry.attempt)
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
