/**
 * subagent-host 的 HTTP 面:父节点经它把子代理"放置"到承载节点(行 5)。
 *
 * 协议与身份样式照 seam-host(shared/seam-contracts/remote.ts + errors.ts):
 * realm 由**每 realm 一个共享令牌**证明(X-Lumo-Realm + X-Lumo-Seam-Token,
 * timingSafeEqual 常量时间比较;令牌表空 = 匿名,仅回环形态),错误一律走
 * SeamError 族(alike server.ts 的 respose 映射:invalid → 400 / forbidden → 403)。
 *
 * 两个端点:
 *   POST /subagent/start → auth → assertStartChildRequest → realm 与载荷一致
 *       → 运行表登记 → 200 StartChildOk;校验/越权失败 → 对应状态码 + StartChildFail。
 *   POST /subagent/stop  → auth → 运行表取 entry → cancel();幂等:未知 runId 也是
 *       200 { ok: true }(行 6 kill 同款 no-op)。
 *
 * 运行表本文件只读(重复检测/stop 分发),登记与结集由 run.ts 写。
 *
 * 传输选型:当前 JSON over HTTP,回环/内网;换传输只换本文件,run.ts 与契约不变。
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  SeamError,
  forbidden,
  invalid,
  seamErrorCode,
} from '../../../shared/seam-contracts/errors.ts'
import { statusForCode } from '../../../shared/seam-contracts/remote.ts'
import {
  assertStartChildRequest,
  runKeyOf,
  type StartChildRequest,
} from '../../../shared/seam-contracts/subagent-host.ts'
import type { RunRegistry } from './run.ts'
import { assertAllowedCallback } from './callback-policy.ts'

export interface SubagentHostLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

export interface SubagentHostOptions {
  /** 监听地址(实际 bind 由调用方完成 —— 与 seam-host 同款,server 只做请求面)。 */
  host: string
  port: number
  /** 单请求体上限(不能无上限 —— 无上限等于一个 OOM 开关)。 */
  maxBodyBytes: number
  /** realm → 共享令牌。为空表示匿名放行(仅回环形态,启动时已告警)。 */
  tokens: ReadonlyMap<string, string>
  /** 归一化后的回调 origin 白名单；请求载荷不能扩张承载节点的出站面。 */
  callbackOrigins: ReadonlySet<string>
  /** A pinned Worker accepts tasks only through the durable governed inbox. */
  governedOnly?: boolean
  /** Authenticated cancellation of a governed execution (same realm). */
  stopGoverned?: (realm: string, runId: string) => void
  /** 承载侧运行表:`key = runKeyOf(realm, childId)`。host 读,run.ts 写。 */
  runs: RunRegistry
  /**
   * child 会话是否已发布(在 ctx.agents 里)。已发布 + 运行表无键 = 已结集重放 →
   * 契约把 childId 定为幂等键(已存在 → invalid);in-flight(create 未完成)的
   * child 尚未发布,该相位仍由 runs.has 判 invalid,两检查互不重叠。
   */
  sessionExists: (childId: string) => boolean
  /** 启动一个通过校验的子代理 run(后台生命周期,完成/失败经回执送达父侧)。 */
  start: (req: StartChildRequest) => void
  logger: SubagentHostLogger
}

export function createSubagentHost(options: SubagentHostOptions): Server {
  const server = createServer((req, res) => {
    void handle(req, res, options).catch((e: unknown) => {
      // 兜底:handle 内部已把所有可预期错误转成响应,走到这里说明是写响应本身失败
      options.logger.error('subagent-host: 请求处理异常: %s', e)
      if (!res.headersSent) respond(res, 500, { ok: false, code: 'internal', message: '内部错误' })
      else res.end()
    })
  })
  return server
}

async function handle(req: IncomingMessage, res: ServerResponse, options: SubagentHostOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://subagent-host.invalid')
  const parts = url.pathname.split('/').filter(Boolean)
  if (req.method !== 'POST' || parts.length !== 2 || parts[0] !== 'subagent'
    || (parts[1] !== 'start' && parts[1] !== 'stop')) {
    respond(res, 404, { ok: false, code: 'invalid', message: `未知路由 ${req.method} ${url.pathname}` })
    return
  }
  const endpoint = parts[1]!

  try {
    // 身份先行:被禁的调用不该先让我们吃掉一兆字节的 body(seam-host 同训)
    const caller = authenticate(req, options)
    if (options.governedOnly && endpoint === 'start') throw forbidden('this Worker accepts only governed dispatch')
    const body = await readBody(req, options.maxBodyBytes)
    const payload = parseObject(body)

    if (endpoint === 'start') {
      assertStartChildRequest(payload)
      if (payload.realm !== caller.realm) {
        throw forbidden(`调用方 realm=${caller.realm} 不得启动 realm=${payload.realm} 的子代理`)
      }
      assertAllowedCallback(payload.callbackUrl, payload.childId, options.callbackOrigins)
      // assert 已闸住 realm/childId 两段,runKeyOf 不会再抛
      // 已结集重放闸:运行表条目已因整体结集摘除,但 child 会话仍发布在 ctx.agents。
      // 放行后 create 会撞注册冲突抛错 → 200 已寄出、父侧只能收 ok:false 结集(run.ts
      // 失败回执),远不如契约把 childId 定为幂等键(已存在 → invalid)的显式拒绝。
      // 放 runs.has 之前:in-flight(child 在 create 内,尚未发布)只由运行表段判,不回退现行为。
      if (options.sessionExists(payload.childId)) {
        throw invalid(`subagent-host: StartChildRequest.childId 会话已存在,禁止重放: ${payload.childId}`)
      }
      const key = runKeyOf(payload.realm, payload.childId)
      if (options.runs.has(key)) {
        throw invalid(`subagent-host: childId ${payload.childId} 已在运行(幂等键冲突)`)
      }
      options.start(payload as StartChildRequest)
      respondOk(res, { ok: true, childId: payload.childId })
      return
    }

    const childId = payload['childId']
    if (typeof childId !== 'string' || childId === '') {
      throw invalid('subagent-host: stop 需要非空字符串 childId')
    }
    // stop 幂等:未知/已结集 run 也是 200 no-op(行 6 kill 同款,取消不是查询)
    // 发布前窗口:child 还在一次本地 create 内,stop 是 no-op——child 照常跑完并
    // 回执 completed;该窗口的取消语义随行 6 控制信号通道(JobControlSeam),本切片不做。
    options.runs.get(runKeyOf(caller.realm, childId))?.cancel()
    options.stopGoverned?.(caller.realm, childId)
    respondOk(res, { ok: true })
  } catch (e) {
    const code = seamErrorCode(e)
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'internal') {
      options.logger.error('subagent-host: %s 失败: %s', endpoint, message)
    } else {
      options.logger.warn('subagent-host: %s 拒绝(%s): %s', endpoint, code, message)
    }
    respond(res, statusForCode(code), { ok: false, code, message })
  }
}

function authenticate(req: IncomingMessage, options: SubagentHostOptions): { realm: string } {
  const realm = header(req, 'x-lumo-realm')
  if (!realm) throw forbidden('缺少 X-Lumo-Realm:调用方身份不可省略')

  if (options.tokens.size === 0) return { realm }

  const expected = options.tokens.get(realm)
  const presented = header(req, 'x-lumo-seam-token')
  // realm 未配置令牌与令牌不匹配返回同一个错误:否则错误码本身就成了 realm 探测器
  if (!expected || !presented || !constantTimeEqual(expected, presented)) {
    throw forbidden(`realm ${realm} 的 seam 令牌校验失败`)
  }
  return { realm }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && value.length > 0 ? value : undefined
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual 要求等长;长度本身不是秘密,先比长度是可接受的
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // 超限即刻断流:继续收完再拒绝等于让调用方决定我们吃多少内存
        req.destroy()
        reject(invalid(`请求体超过上限 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (e) => reject(new SeamError('invalid', `读取请求体失败: ${e.message}`)))
  })
}

function parseObject(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw invalid('请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('请求体必须是对象')
  }
  return parsed as Record<string, unknown>
}

function respondOk(res: ServerResponse, payload: unknown): void {
  respond(res, 200, payload)
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
