/**
 * 行 5 切片 1 双进程冒烟 —— 父节点驱动（真双进程、真 wire、真回调）。
 *
 * 进程形态:
 *   父进程(本脚本) = testkit 真 cordis 树 + AgentLoop + mock LLM + SubagentRuntime
 *     + @lumo/subagent-remote;一个真 parent Agent(已完结 turn)。
 *   承载进程       = smoke-node.ts 拉起的**真 dsh 进程**(base bundle 自定义 profile),
 *     subagent-host 挂真 HTTP,child 在承载节点真树里跑单 turn,回执经真 HTTP POST 回
 *     父进程内回调 server。
 *   Scheduler      = 真服务,默认本机 `go run ./cmd/scheduler` 直起(独立库 →
 *     选主成立),POST /v1/nodes 登记 N1 → POST /v1/placements 201 → 终态
 *     /v1/tasks/{childId}/result 落账。**为什么不用已运行的 standalone
 *     scheduler**:其容器镜像是 752fccd(放置回执补 task_id/node_id json 标签)之前
 *     构建的,201 应答仍是旧 PascalCase(实测 {"TaskID":...}),父侧消费面拿不到
 *     node_id —— 故默认直起工作区代码的 scheduler;外部已有当前代码的服务可用
 *     LUMO_SMOKE_SCHED_URL 干交(不再 go run)。
 *
 * 判据(任一条失败 → 进程非 0 退出):
 *   01  Scheduler 就绪:go run 直起成功并当上 leader(GET /v1/leader),N1 登记 200。
 *   02  承载进程就绪:真 HTTP 上 POST /subagent/start 有应答(错令牌 403 即活)。
 *   03  child 会话在承载节点 PG 日志(session_log 有行且含 turn/end 与
 *       subagent/descriptor)—— PG 不可用时降级 `[pg-skipped]`(报告须如实注明)。
 *   04  child 会话 header meta 在承载体真持久日志(JSONL 首帧):parentSession =
 *       父会话 id、delegationDepth=1、origin=subagent、cwd=父侧 cwd。
 *   05  回执结集:result.stopReason==='completed' 且 output 非空(内容=承载节点 mock 答复)。
 *   06  Scheduler 放置与终态落账:GET /v1/placements/{childId} → 200 且 task_id/node_id/state=COMPLETED。
 *
 * 用法(platform 根):
 *   ./node_modules/.bin/tsx dsh-plugins/subagent-remote/smoke-parent.ts
 * 环境(可覆盖):
 *   LUMO_SMOKE_SCHED_URL  外部 scheduler base(设置后不直起 go run;服务须为当前
 *     工作区代码 —— 旧镜像的 201 走 PascalCase,判据 06 会如实失败)
 *   LUMO_SMOKE_SCHED_PORT 直起调度器监听端口(默认随机空闲端口)
 *   LUMO_SMOKE_NODE_URL   默认 http://127.0.0.1:8091(承载节点 base)
 *   LUMO_SMOKE_HOST_TOKEN 默认 dev-subagent-token
 *   LUMO_SESSION_LOG         1|0 默认 1;0 = 承载进程不挂 session-log,判据 03 降级
 *   LUMO_SMOKE_PG_DSN     默认 postgres://lumo:lumo@127.0.0.1:15432/lumo
 *   LUMO_SMOKE_PG_DB      调度器独立库名,默认 lumo_scheduler_smoke(免与既有租约打架)
 *   LUMO_SMOKE_KEEP       1 = 失败时保留临时 DSH_HOME(取证)
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { registerSubagentRemote } from './src/index.ts'
import { SMOKE_REPLY_TEXT } from './smoke-adapter.ts'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '..', '..')
const tsxBin = join(platformRoot, 'node_modules/.bin/tsx')

const externalSchedUrl = (process.env['LUMO_SMOKE_SCHED_URL'] ?? '').replace(/\/+$/, '')
const nodeUrl = (process.env['LUMO_SMOKE_NODE_URL'] ?? 'http://127.0.0.1:8091').replace(/\/+$/, '')
const hostToken = process.env['LUMO_SMOKE_HOST_TOKEN'] ?? 'dev-subagent-token'
const pgOn = (process.env['LUMO_SESSION_LOG'] ?? '1') !== '0'
const pgDsn = process.env['LUMO_SMOKE_PG_DSN'] ?? 'postgres://lumo:lumo@127.0.0.1:15432/lumo'
const schedDb = process.env['LUMO_SMOKE_PG_DB'] ?? 'lumo_scheduler_smoke'
const keepOnFailure = (process.env['LUMO_SMOKE_KEEP'] ?? '') === '1'
const realm = 'dev'

// Scheduler base:默认直起 go run(取默认值),给了 LUMO_SMOKE_SCHED_URL 则用外部服务
let schedulerUrl = externalSchedUrl
let ownScheduler: ChildProcess | undefined

const PARENT_ID = 'smoke-parent'

// —— 断言基建(object-store/smoke.ts 同款:✓ 行进日志,失败抛错 → 进程非 0) —— //
function pass(name: string): void {
  console.log(`  ✓ ${name}`)
}

function assert(cond: unknown, name: string): asserts cond {
  if (!cond) throw new Error(`冒烟断言失败:${name}`)
  pass(name)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function retry<T>(label: string, read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      last = error
    }
    await sleep(250)
  }
  throw new Error(
    `等待超时:${label}${last !== undefined ? `(最后错误: ${last instanceof Error ? last.message : String(last)})` : ''}`,
  )
}

// —— 进程内 mock LLM(与 host.spec 的 10 行最小 mock 同款:流式指向定义本后 finish) —— //
function textOnlyAdapter(text: string): LlmAdapter {
  return new (class extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = createNetServer()
    net.listen(0, '127.0.0.1', () => {
      const { port } = net.address() as AddressInfo
      net.close((err) => (err ? reject(err) : resolve(port)))
    })
    net.on('error', reject)
  })
}

// —— Scheduler 面(默认直起 go run,独立库选主;LEADER 就绪前不碰放置) —— //
async function spawnScheduler(home: string): Promise<string> {
  const port = process.env['LUMO_SMOKE_SCHED_PORT'] !== undefined
    ? Number(process.env['LUMO_SMOKE_SCHED_PORT'])
    : await freePort()
  const base = `http://127.0.0.1:${port}`

  // 专用库:与 standalone scheduler 的租约/catalog 互不打架(同 PG 双进程会争租)。
  const admin = new pg.Client({ connectionString: pgDsn })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${schedDb}`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (!msg.includes('already exists') && !msg.includes('exists')) {
      await admin.end()
      throw new Error(
        `调度器专用库不可用(${schedDb}):${msg} —— 请确认 PG 用户有 CREATEDB,`
        + '或先手工建库后设 LUMO_SMOKE_PG_DB',
      )
    }
  }
  await admin.end()
  const schedDsn = pgDsn.replace(/\/[^/?#]*(\?|$)/, `/${JSON.stringify(schedDb).slice(1, -1)}$1`)

  // detached + 进程组:go run 的调度器二进制是孙进程,普通 kill 只到 go run;
  // 组杀(SIGTERM 到 -pid)保证优雅排空。输出走文件不继承管道——防止父进程先走后
  // 孤儿调度器把冒烟输出管道一直攥着(此前踩过:tail 挂 7 分钟等 EOF)。
  const schedLog = join(home, 'scheduler.log')
  const schedLogFd = openSync(schedLog, 'w')
  ownScheduler = spawn('go', ['run', './cmd/scheduler',
    '--pg', schedDsn, '--listen', `127.0.0.1:${port}`, '--instance', `lumo-smoke-${process.pid}`], {
    cwd: join(platformRoot, 'control-plane/scheduler'),
    detached: true,
    stdio: ['ignore', schedLogFd, schedLogFd],
  })
  ownScheduler.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`[scheduler] go run 退出 code=${code ?? 'null'} signal=${signal ?? 'null'}(放置会失败)`)
    }
  })

  // leader 就绪:go 首次编译 + 建库选主,宽限 120s
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/leader`)
      if (res.ok) {
        const body = await res.json() as { holder?: string }
        if (typeof body.holder === 'string') return base
      }
    } catch {
      /* 选主循环未起 */
    }
    await sleep(1000)
  }
  throw new Error('调度器直起超时:go run ./cmd/scheduler 未当上 leader —— 查看上方 Go 编译/运行时输出')
}

async function teardownScheduler(): Promise<void> {
  if (ownScheduler !== undefined && ownScheduler.exitCode === null) {
    // 组杀:detached 使 go run 成为进程组组长,调度器孙进程也在组内
    try {
      process.kill(-ownScheduler.pid?? 0, 'SIGTERM')
    } catch {
      ownScheduler.kill('SIGTERM')
    }
  }
}

async function schedulerJson<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${schedulerUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', 'x-lumo-realm': realm } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let parsed: T
  try {
    parsed = await res.json() as T
  } catch {
    parsed = undefined as T
  }
  return { status: res.status, body: parsed }
}

// —— 承载进程生命周期 —— //
interface Carrier {
  proc: ChildProcess
  home: string
}

function spawnCarrier(home: string, port: number): Carrier {
  const proc = spawn(tsxBin, ['dsh-plugins/subagent-remote/smoke-node.ts'], {
    cwd: platformRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      LUMO_SMOKE_DSH_HOME: home,
      LUMO_SMOKE_REALM: realm,
      LUMO_SMOKE_HOST_PORT: String(port),
      LUMO_SMOKE_HOST_TOKEN: hostToken,
      LUMO_SESSION_LOG: pgOn ? '1' : '0',
      LUMO_SMOKE_PG_DSN: pgDsn,
    },
  })
  proc.on('exit', (code, signal) => {
    // 承载进程抢跑退出 = 启动失败,主流程以「就绪超时判据」体现
    console.error(`[carrier] smoke-node 退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })
  return { proc, home }
}

async function carrierReady(base: string): Promise<void> {
  const deadline = Date.now() + 120_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/subagent/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lumo-realm': realm, 'x-lumo-seam-token': 'wrong' },
        body: '{}',
      })
      // 目标态:承载体已就绪(错令牌 → 403)
      if (res.status === 403) return
      last = `HTTP ${res.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(500)
  }
  throw new Error(`承载进程就绪超时(${last})`)
}

async function killCarrier(carrier: Carrier | undefined): Promise<void> {
  if (carrier === undefined || carrier.proc.exitCode !== null || carrier.proc.signalCode !== null) return
  carrier.proc.kill('SIGTERM')
  await new Promise<void>((resolveKill) => {
    const timer = setTimeout(() => carrier.proc.kill('SIGKILL'), 5000)
    carrier.proc.once('exit', () => {
      clearTimeout(timer)
      resolveKill()
    })
  })
}

// —— 断言:child 会话 header meta 在承载体真持久日志(JSONL 首帧) —— //
function findSessionHeader(sessionsRoot: string, sessionId: string): Record<string, unknown> | undefined {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (entry.name.endsWith('.jsonl')) out.push(p)
    }
    return out
  }
  if (!existsSync(sessionsRoot)) return undefined
  for (const file of walk(sessionsRoot)) {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0]
    if (first === '') continue
    try {
      const header = JSON.parse(first) as { id?: unknown }
      if (String(header.id) === sessionId) return header as Record<string, unknown>
    } catch {
      /* 非本会话文件 */
    }
  }
  return undefined
}

/** 父进程真树:testkit 依赖 + AgentLoop + mock + SubagentRuntime(与 Task 3 harness 同款)。 */
async function mountParentTree(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], textOnlyAdapter('parent-turn-mgr'))
  await ctx.plugin(SubagentRuntime)
  return ctx
}

async function main(): Promise<void> {
  console.log(`跨节点子代理委派双进程冒烟 → 父(cordis ctx) / 承载(${nodeUrl}) / Scheduler(${schedulerUrl || '(直起中…)'})`)
  const carrierPort = new URL(nodeUrl).port !== '' ? Number(new URL(nodeUrl).port) : 80
  const home = join(tmpdir(), `lumo-smoke-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`)
  mkdirSync(home, { recursive: true })
  let carrier: Carrier | undefined
  let ctx: Context | undefined
  try {
    // 判据 01:Scheduler 就绪(默认直起 go run;外部服务经 LUMO_SMOKE_SCHED_URL) + N1 登记
    if (schedulerUrl === '') {
      schedulerUrl = await spawnScheduler(home)
      console.log(`  Scheduler 直起:${schedulerUrl}(库=${schedDb})`)
    }
    const leader = await schedulerJson<{ holder?: string }>('GET', '/v1/leader')
    assert(leader.status === 200 && typeof leader.body?.holder === 'string',
      `Scheduler 领导者存在(GET /v1/leader, holder=${leader.body?.holder})`)
    const upsert = await schedulerJson<{ node_id?: string }>('POST', '/v1/nodes', {
      node_id: 'N1', cluster_id: 'lumo-smoke', capacity: 4, capabilities: [],
    })
    assert(upsert.status === 200 && upsert.body?.node_id === 'N1',
      `节点 N1 登记(POST /v1/nodes) -> ${JSON.stringify(upsert.body)}`)

    // 判据 02:承载进程(真 dsh)就绪 —— 独立临时 DSH_HOME,与真实 ~/.dsh 互不干扰
    carrier = spawnCarrier(home, carrierPort)
    await carrierReady(nodeUrl)
    pass(`承载进程就绪:${nodeUrl} 上 POST /subagent/start 应答 403(错令牌)`)
    assert(carrier.proc.exitCode === null, '承载进程存活')

    // 父进程树 + 真 parent Agent(先补一轮已完结 turn)
    ctx = await mountParentTree()
    const parent = ctx.agentLoop.create(
      SessionId(PARENT_ID), { provider: 'mock', model: 'mock', maxTokens: 4096 }, { cwd: process.cwd() },
    )
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent turn' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert(parent.session.header.cwd === process.cwd(), 'parent header 有 cwd')
    assert(parent.session.events.some((e) => e.type === 'turn/end'), 'parent 已有完结 turn(turn/end)')
    assert(parent.session.header.delegationDepth === undefined
      || parent.session.header.delegationDepth === 0, 'parent 深度=根(0/缺省)')

    const callbackPort = await freePort()
    registerSubagentRemote(ctx, {
      schedulerUrl,
      nodeUrls: { ['N1']: nodeUrl },
      hostTokens: { ['N1']: hostToken },
      realm,
      callbackPort,
      callbackHost: '127.0.0.1',
    })

    // 判据 05:委派 → 回执结集
    const run = await ctx.subagents.start('lumo-remote', {
      label: 'smoke child',
      prompt: [{ type: 'text', text: 'child 冒烟任务' }],
      parent,
      signal: new AbortController().signal,
    })
    const childId = String(run.id)
    console.log(`  child 会话 = ${childId}`)
    const result = await Promise.race([
      run.result,
      sleep(40_000).then(() => { throw new Error('子代理回执 40s 未结集(承载回调未达)') }),
    ])
    assert(result.stopReason === 'completed', `result.stopReason === 'completed'(实收 ${result.stopReason})`)
    const outputText = (result.output ?? [])
      .map((b) => ((b as { text?: string })?.text ?? ''))
      .join('')
    assert(outputText.includes(SMOKE_REPLY_TEXT),
      `result.output 非空且含承载体答复(${JSON.stringify(outputText.slice(0, 48))})`)

    // 判据 06:Scheduler 放置与终态落账
    await retry('Scheduler 终态落账(COMPLETED)', async () => {
      const { status, body } = await schedulerJson<{ state?: string }>(
        'GET', `/v1/placements/${encodeURIComponent(childId)}`)
      if (status !== 200 || body.state !== 'COMPLETED') return undefined
      return body
    }, 15_000)
    const placement = await schedulerJson<{ task_id?: string; node_id?: string; state?: string }>(
      'GET', `/v1/placements/${encodeURIComponent(childId)}`)
    assert(placement.body?.task_id === childId, 'Scheduler 放置落账(task_id=childId)')
    assert(placement.body?.node_id === 'N1', 'Scheduler 放置到 N1')
    assert(placement.body?.state === 'COMPLETED', 'Scheduler 终态 COMPLETED(经 /v1/tasks/{id}/result 上报)')

    // 判据 03:child 会话在承载节点 PG 日志(PG 可用时;否则降级 [pg-skipped])
    if (pgOn) {
      const client = new pg.Client({ connectionString: pgDsn })
      await client.connect()
      try {
        // session-log 的复制是 fire-and-forget 队列尾:回调到达 ≠ 日志落完,
        // 轮询直到 turn/end 落库(举证:基线跑时 13/20 行半途快照)。
        const types = await retry('session_log 落账(turn/end)', async () => {
          const rows = (await client.query(
            'SELECT event_type FROM session_log WHERE session_ref = $1 ORDER BY seq', [childId],
          )).rows as Array<{ event_type: string }>
          if (rows.length === 0) return undefined
          const seen = new Set(rows.map((r) => r.event_type))
          if (!seen.has('turn/end')) return undefined
          return seen
        }, 10_000)
        assert(types.size > 0, 'session_log 有行(child 会话已复制)')
        assert(types.has('turn/end'), 'child 事件流含 turn/end')
        assert(types.has('subagent/descriptor'), 'child 事件流含 subagent/descriptor')
      } finally {
        await client.end()
      }
    } else {
      console.log('  [pg-skipped] LUMO_SESSION_LOG=0:session_log 断言降级(详见报告)')
    }

    // 判据 04:child header meta 在承载体真持久日志(JSONL 首帧)
    const sessionsRoot = join(home, 'sessions')
    const header = await retry('承载 JSONL 首帧(header)', () => Promise.resolve(findSessionHeader(sessionsRoot, childId)), 15_000)
    assert(String(header['parentSession']) === PARENT_ID,
      `meta.parentSession=${PARENT_ID}(实收 ${JSON.stringify(header['parentSession'])})`)
    assert(header['delegationDepth'] === 1,
      `meta.delegationDepth=1(实收 ${JSON.stringify(header['delegationDepth'])})`)
    assert(header['origin'] === 'subagent', `meta.origin='subagent'(实收 ${JSON.stringify(header['origin'])})`)
    assert(header['cwd'] === process.cwd(), 'meta.cwd=父侧 cwd')

    console.log('跨节点子代理委派双进程冒烟全绿:真双进程 wire 全链(放置→承载→回调→带跑落地)通过')

    // 收尾:显式退出(树内监听/续租会挂住进程)
    await ctx.fiber.dispose()
    await killCarrier(carrier)
    await teardownScheduler()
    rmSync(home, { recursive: true, force: true })
    process.exit(0)
  } catch (error) {
    console.error('跨节点子代理委派双进程冒烟失败:', error instanceof Error ? error.stack : error)
    // 承载进程可能仍在跑:清掉;失败取证按 LUMO_SMOKE_KEEP——1=保留 DSH_HOME,默认删除
    // (与头部注释语义一致:早期版本的 KEEP 分支曾反相,KEEP=1 反而删除,已在评审修正)
    await killCarrier(carrier)
    await teardownScheduler()
    if (keepOnFailure) {
      // LUMO_SMOKE_KEEP=1:保留临时 DSH_HOME 供失败取证(进程已清,tmp 目录存证据)
      console.log(`  [取证] 承载 DSH_HOME 保留在 ${home}(判据失败原因在上一行)`)
    } else {
      rmSync(home, { recursive: true, force: true })
    }
    process.exit(1)
  }
}

main().catch(async (error) => {
  console.error('冒烟进程异常:', error instanceof Error ? error.message : error)
  process.exit(1)
})
