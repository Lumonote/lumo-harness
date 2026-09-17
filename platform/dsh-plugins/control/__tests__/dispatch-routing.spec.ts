/**
 * `dispatch` 的**提交面**行为：本插件把控制指令交给控制面，并把结论带回来。
 *
 * 接线之前 `dispatch` 的唯一行为是「有权就抛 ControlCommandRoutingError」——那是个占位符。
 * 这些用例钉的是接好线之后的四件事：
 *
 *   1. **形状**：请求体字段名与路径必须与 Go 侧 `internal/server` 的 `controlRequest`
 *      逐字对齐。跨语言契约没有编译期约束，改一个 json tag，Go 侧照样编译、TS 侧照样
 *      `tsc` 干净，只是运行时控制面读到的全是空值 —— 而空 realm/actor 会被 OPA 的
 *      `incomplete_principal` 判成「主体不完整」，症状是「所有控制指令都失败」。
 *   2. **结论 vs 没结论**：被拒（403/409）是**结论**，必须原样返回；网络不通、响应读不懂
 *      是**没结论**，必须抛错。把后者报成前者，会让「去看 OPA」变成「去找管理员」。
 *   3. **不按 HTTP 状态码判结论**：控制面的 `statusFor` 是多对一的（403 同时是
 *      policy_denied 与 realm_mismatch），所以这里读的是响应体里的 `outcome`。
 *   4. **本地前置拦住的请求不出网**：它的唯一价值就是省掉那次必然被拒的往返。
 *
 * 用假控制面而不是 mock `fetch`：这些断言的宾语是**线上真的会发出去的东西**
 * （路径、方法、头、body），mock 掉 fetch 就等于把待测对象换成自己的期望。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { PgControlSeam } from '../src/pg-control.ts'
import { RbacControlPolicy } from '../src/policy.ts'
import {
  ControlCommandRoutingError,
  ControlPlaneProtocolError,
  ControlPlaneUnreachableError,
  type ControlPolicy,
  type ControlRequest,
} from '../../../shared/seam-contracts/control.ts'

/** 不会被真正使用的 DSN：本套用例只调 `dispatch`，它不碰连接池。 */
const UNUSED_DSN = 'postgres://unused:unused@127.0.0.1:1/unused'

interface Captured {
  method: string
  url: string
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

interface FakePlane {
  baseUrl: string
  captured: Captured[]
  close(): Promise<void>
}

/** 起一个只回固定应答的假控制面。handler 可以按请求决定状态码与响应体。 */
async function startFakePlane(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
): Promise<FakePlane> {
  const captured: Captured[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 应答一个控制面结论。字段名与 Go 侧 `control.Result` 的 json tag 对齐。 */
function answerOutcome(res: ServerResponse, status: number, result: Record<string, unknown>): void {
  const payload = JSON.stringify(result)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

const allowAll: ControlPolicy = { evaluate: () => ({ allowed: true }) }
const denyAll: ControlPolicy = { evaluate: () => ({ allowed: false, reason: 'not-authorized' }) }

const REQUEST: ControlRequest = {
  command: 'pause',
  sessionRef: 'sess-1',
  actor: 'alice',
  role: 'operator',
  realm: 'dev',
  reason: '临时停线',
  correlationId: 'ctl-test-1',
}

const planes: FakePlane[] = []
async function fakePlane(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
): Promise<FakePlane> {
  const plane = await startFakePlane(handler)
  planes.push(plane)
  return plane
}

afterEach(async () => {
  while (planes.length > 0) await planes.pop()!.close()
})

describe('dispatch → 控制面（提交面）', () => {
  it('把控制面确立的结论带回来（applied）', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 200, {
        session_ref: 'sess-1', command: 'pause', outcome: 'applied',
        to_state: 'paused', revision: 3, correlation_id: 'ctl-abc', effectuation: 'recorded',
      })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch(REQUEST)

    expect(decision.allowed).toBe(true)
    expect(decision.outcome).toBe('applied')
    expect(decision.toState).toBe('paused')
    expect(decision.revision).toBe(3)
    expect(decision.correlationId).toBe('ctl-abc')
    // 本地拒因与 outcome 互斥：有 outcome 就说明请求真的到了控制面。
    expect(decision.reason).toBeUndefined()
  })

  it('请求形状与 Go 侧 controlRequest 逐字对齐', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 200, { outcome: 'noop' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl, token: 'tok-1' })

    await seam.dispatch(REQUEST)

    expect(plane.captured).toHaveLength(1)
    const [seen] = plane.captured
    expect(seen!.method).toBe('POST')
    expect(seen!.url).toBe('/v1/sessions/sess-1/control')
    expect(seen!.contentType).toBe('application/json')
    expect(seen!.authorization).toBe('Bearer tok-1')
    // 六个键一个不多一个不少。多一个键本身无害，但它意味着这边以为对面有那个字段；
    // 少一个键会让 Go 侧读到空串，而空的 realm/actor 会被 OPA 判成「主体不完整」。
    expect(seen!.body).toEqual({
      command: 'pause',
      realm: 'dev',
      role: 'operator',
      actor: 'alice',
      reason: '临时停线',
      correlation_id: 'ctl-test-1',
    })
  })

  it('会话 id 里的斜杠与空格被转义，不会走出路径', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 200, { outcome: 'applied' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    await seam.dispatch({ ...REQUEST, sessionRef: 'a/b c' })

    // 不转义时 '/v1/sessions/a/b c/control' 会被控制面的前缀匹配当成别的路径，
    // 结果是 404「未知路径」——而调用方会以为是会话不存在。
    expect(plane.captured[0]!.url).toBe('/v1/sessions/a%2Fb%20c/control')
  })

  it('控制面拒绝是**结论**，不是错误（403 + policy_denied 原样返回）', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 403, { outcome: 'policy_denied', reason: '角色未被授予该指令' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch(REQUEST)

    // 抛错会让「求权限」与「服务挂了」变成同一种处置——这正是控制面把 403/503
    // 分成两种 code 要避免的事，插件侧不能又合回去。
    expect(decision.allowed).toBe(false)
    expect(decision.outcome).toBe('policy_denied')
    expect(decision.detail).toBe('角色未被授予该指令')
    expect(decision.reason, 'reason 是本层拒因，不能用来承载控制面的结论').toBeUndefined()
  })

  it('realm 不匹配与策略拒绝靠 outcome 区分，状态码区分不了', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 403, { outcome: 'realm_mismatch', reason: '该会话的控制权已由 realm "other" 确立' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch(REQUEST)

    // 两者都是 403。若这里按状态码判，realm_mismatch 会被报成 policy_denied，
    // 而它们的处置相反：一个要弄清楚会话归属哪个 realm，一个要找管理员要权限。
    expect(decision.outcome).toBe('realm_mismatch')
  })

  it('noop 也算生效（指令到了控制面，只是没有副作用）', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 200, { outcome: 'noop', to_state: 'paused' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch(REQUEST)

    expect(decision.allowed, '重复点按钮不该报错').toBe(true)
    expect(decision.outcome).toBe('noop')
  })

  it('未知 outcome 抛协议错 —— 不猜一个结论', async () => {
    const plane = await fakePlane((_req, res) => {
      // 控制面版本比本插件新：多了一种 outcome。
      answerOutcome(res, 200, { outcome: 'quarantined' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    await expect(seam.dispatch(REQUEST)).rejects.toBeInstanceOf(ControlPlaneProtocolError)
  })

  it('认证中间件的响应不是控制面结论，抛协议错', async () => {
    const plane = await fakePlane((_req, res) => {
      // observability.RequireControlPlaneToken 的形状：{"error","message"}，没有 outcome。
      answerOutcome(res, 401, { error: 'control_plane_auth', message: 'invalid control-plane credential' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl, token: 'wrong' })

    // 若把它读成「控制面拒绝了这条指令」，运维会去查权限，而真实原因是令牌不匹配。
    await expect(seam.dispatch(REQUEST)).rejects.toBeInstanceOf(ControlPlaneProtocolError)
  })

  it('网关的 HTML 错误页不是结论，抛协议错且带上原文片段', async () => {
    const plane = await fakePlane((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' })
      res.end('<html><body>502 Bad Gateway</body></html>')
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    await expect(seam.dispatch(REQUEST)).rejects.toThrow(/502 Bad Gateway/u)
  })

  it('控制面不可达抛不可达错（没有结论 ≠ 被拒）', async () => {
    // 端口 1 上不会有人监听。
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: 'http://127.0.0.1:1' })

    await expect(seam.dispatch(REQUEST)).rejects.toBeInstanceOf(ControlPlaneUnreachableError)
  })

  it('超时算不可达，且不把「可能已生效」报成成功或拒绝', async () => {
    const plane = await fakePlane((_req, res) => {
      // 控制面自己的队列等待上限是 5s；这里模拟「比客户端超时更慢」。
      setTimeout(() => answerOutcome(res, 200, { outcome: 'applied' }), 400)
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl, timeoutMs: 50 })

    await expect(seam.dispatch(REQUEST)).rejects.toBeInstanceOf(ControlPlaneUnreachableError)
  })

  it('本地前置拒掉的请求**不出网**', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 200, { outcome: 'applied' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, denyAll, { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch(REQUEST)

    expect(decision).toEqual({ allowed: false, reason: 'not-authorized' })
    // 本地前置的全部价值就是省掉这次往返。若它开始出网，本地 RBAC 就从「省一次
    // 必然被拒的调用」变成了「给控制面多发一次请求」——而它并不是权威。
    expect(plane.captured, '本地拒必须发生在网络之前').toHaveLength(0)
  })

  it('未配置控制面地址时抛路由错误，而不是假装生效或去连本机', async () => {
    const seam = new PgControlSeam(UNUSED_DSN, allowAll)

    // local 形态没有 session-control 这个服务。回落成 {allowed:true} 会让调用方以为
    // 指令执行了；回落成连 localhost:8092 会把它伪装成网络故障。
    await expect(seam.dispatch(REQUEST)).rejects.toBeInstanceOf(ControlCommandRoutingError)
  })

  it('未配置控制面地址时，本地拒绝仍然照常给出原因', async () => {
    const seam = new PgControlSeam(UNUSED_DSN, denyAll)

    // 顺序：先本地判，再判有没有控制面。反过来会让「没接线」这个部署问题
    // 盖掉「这个用户没权限」这条业务结论。
    expect(await seam.dispatch(REQUEST)).toEqual({ allowed: false, reason: 'not-authorized' })
  })

  it('RbacControlPolicy 与 seam 组合：viewer 的指令被本地拦下', async () => {
    const plane = await fakePlane((_req, res) => {
      answerOutcome(res, 200, { outcome: 'applied' })
    })
    const seam = new PgControlSeam(UNUSED_DSN, new RbacControlPolicy(), { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch({ ...REQUEST, role: 'viewer' })

    expect(decision).toEqual({ allowed: false, reason: 'not-authorized' })
    expect(plane.captured).toHaveLength(0)
  })

  it('to_state 是词表外的值时当作「没给」，不塞进类型', async () => {
    const plane = await fakePlane((_req, res) => {
      // 另一侧遗留的状态名（历史上插件自己写过 stopping）。
      answerOutcome(res, 200, { outcome: 'applied', to_state: 'stopping', revision: 4 })
    })
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: plane.baseUrl })

    const decision = await seam.dispatch(REQUEST)

    expect(decision.outcome).toBe('applied')
    expect(decision.toState).toBeUndefined()
    expect(decision.revision, '同一个响应里的合法字段照常读').toBe(4)
  })

  it('构造期就拒绝非法的控制面地址', () => {
    // 每条指令都在 fetch 里才发现地址错了，等于把配置错误推迟到第一次控制指令。
    expect(() => new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: 'ftp://control' }))
      .toThrow(/invalid control plane URL/u)
  })

  it('空白的控制面地址等同于未配置', async () => {
    const seam = new PgControlSeam(UNUSED_DSN, allowAll, { baseUrl: '   ' })
    await expect(seam.dispatch(REQUEST)).rejects.toBeInstanceOf(ControlCommandRoutingError)
  })
})
