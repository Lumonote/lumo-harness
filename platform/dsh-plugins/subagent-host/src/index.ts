/**
 * @lumo/subagent-host —— 承载节点侧的子代理放置面(行 5 切片 1)。
 *
 * 挂在**承载节点**上:父节点把子代理的传输描述(ChildParentDescriptor)POST 过来,
 * 本插件用 dsh 公开件在本地创建 child、驱动单 turn、读结果、向父侧 callback 回执;
 * 并支持取消(stop)。协议与身份样式对齐 @lumo/seam-host(realm 共享令牌 +
 * SeamError 族错误映射)。
 *
 * 与 in-process driver 的分工:行 5 明示「spawn 本体进程内」—— 产子的 parent 在父
 * 节点,承载节点只有其可传输快照;所以这里不从 dart 的 SubagentProvider.start 走
 * (那需要一个活 parent),而是直接 `ctx.agents.create`(公开件)重建 child。
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { Server } from 'node:http'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

import { createSubagentHost } from './server.ts'
import { runChild, type RunRegistry } from './run.ts'
import { normalizeCallbackOrigins } from './callback-policy.ts'
import { startRuntimeReports, type RuntimeReportConfig } from './runtime-report.ts'
import { PgSubagentReceipts } from '../../../shared/subagent-receipts.ts'
import { persistCallback, startCallbackDelivery } from './callback-outbox.ts'
import { PgGovernedDispatch } from './governed-dispatch.ts'
import { startGovernedDispatch } from './governed-run.ts'
import { assertWorkerBinding } from './worker-binding.ts'
import { HostBootLeaseError, PgDurableStartGuard, PgHostBootLease } from './durable-start-guard.ts'
import { HostLifecycle, type ReplicationHealth } from './lifecycle.ts'
import { startNacosRegistration, type NacosRegistration, type NacosRegistrationOptions } from '../../../shared/nacos-registration.ts'

export interface SubagentHostConfig {
  /** 监听地址。默认回环 —— 对外暴露必须是显式动作 */
  host?: string
  port?: number
  /** 单请求体上限字节(默认 8 MiB) */
  maxBodyBytes?: number
  /** realm → 共享令牌。缺省即无认证,此时只允许绑回环 */
  tokens?: Record<string, string>
  /** 允许接收结果的精确 http(s) origins；请求中的 callbackUrl 必须命中其中之一。 */
  callbackOrigins?: string[]
  /** 显式承认「本端口无认证」。绑非回环地址时该开关无效(见下) */
  allowAnonymous?: boolean
  runtimeReport?: RuntimeReportConfig
  connectionString?: string
  nodeId?: string
  requireSessionLog?: boolean
  discovery?: NacosRegistrationOptions
}

/** Schemastery validation for {@link SubagentHostConfig} */
export const Config: z<SubagentHostConfig> = z.object({
  host: z.string(),
  port: z.number(),
  maxBodyBytes: z.number(),
  tokens: z.dict(z.string()),
  callbackOrigins: z.array(z.string()),
  allowAnonymous: z.boolean(),
  connectionString: z.string(),
  nodeId: z.string(),
  requireSessionLog: z.boolean(),
  discovery: z.object({
    baseUrl: z.string(), serviceName: z.string(), groupName: z.string(),
    nodeId: z.string(), realm: z.string(), clusterId: z.string(), host: z.string(),
    port: z.number(), capacity: z.number(), capabilities: z.array(z.string()), residency: z.string(),
  }),
  runtimeReport: z.object({
    governanceUrl: z.string(), token: z.string(), realm: z.string(), nodeId: z.string(),
    capacity: z.number(),
    binding: z.object({ agentId: z.string(), userId: z.string(), projectId: z.string(),
      presetRevision: z.number(), provider: z.string(), model: z.string() }),
    promptSource: z.object({ ref: z.string(), file: z.string() }),
  }),
})

const DEFAULT_MAX_BODY = 8 * 1024 * 1024

export async function registerSubagentHost(ctx: Context, config: SubagentHostConfig): Promise<void> {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 8091
  const tokens = new Map(Object.entries(config.tokens ?? {}))
  const callbackOrigins = normalizeCallbackOrigins(config.callbackOrigins ?? ['http://127.0.0.1:8092'])
  if (config.runtimeReport) {
    assertWorkerBinding(config.runtimeReport.binding)
    if (!config.connectionString || !config.runtimeReport.token || !tokens.has(config.runtimeReport.realm)) {
      throw new Error('governed execution requires PostgreSQL and authenticated runtime configuration')
    }
  }

  if (config.connectionString && tokens.size === 0) throw new Error('subagent-host: durable callbacks require configured realm tokens')
  const nodeId = config.nodeId ?? config.runtimeReport?.nodeId
  if (config.connectionString && !nodeId) throw new Error('subagent-host: durable execution requires a stable nodeId')
  if (config.discovery && (config.discovery.nodeId !== nodeId || config.discovery.port !== port)) {
    throw new Error('subagent-host: discovery identity must match the execution host')
  }

  if (tokens.size === 0) {
    // 无认证 + 非回环 = 把跨租户子代理放置开放给整个网络。这不是「配置不当」,
    // 是一个不该存在的形态,因此在启动期就否掉,而不是留个告警等人忽略。
    if (!isLoopback(host)) {
      throw new Error(
        `subagent-host: 未配置 tokens 时只能绑回环地址(当前 host=${host})。` +
        '要对外暴露请为每个 realm 配置 tokens。',
      )
    }
    if (!config.allowAnonymous) {
      throw new Error(
        'subagent-host: 未配置 tokens。回环调试可设 allowAnonymous: true 显式承认,'
        + '生产必须配置 tokens(§12.1 收敛为 mTLS 前的过渡形态)。',
      )
    }
    ctx.logger.warn('subagent-host: 无认证模式,仅限回环 %s:%d —— 任何本机进程可以任意 realm 身份放置子代理', host, port)
  }

  const pool = config.connectionString ? new pg.Pool({ connectionString: config.connectionString,
    max: 4, connectionTimeoutMillis: 5_000, query_timeout: 5_000, statement_timeout: 5_000 }) : undefined
  pool?.on('error', () => ctx.logger.warn('subagent-host: callback database connection lost'))
  const receipts = pool ? new PgSubagentReceipts(pool) : undefined
  const boot = pool ? new PgHostBootLease(pool, nodeId!) : undefined
  const startGuard = pool ? new PgDurableStartGuard(pool, nodeId, boot) : undefined
  try {
    await receipts?.init()
    await startGuard?.init()
    if (boot) {
      const deadline = Date.now() + boot.ttlMs + 5_000
      for (;;) {
        try { await boot.acquire(); break } catch (error) {
          if (!(error instanceof HostBootLeaseError) || Date.now() >= deadline) throw error
          await delay(250)
        }
      }
    }
    await startGuard?.recoverAbandoned([...tokens.keys()], callbackOrigins)
    if (config.runtimeReport && pool) {
      await new PgGovernedDispatch(pool, config.runtimeReport, '').init()
    }
  } catch (error) {
    if (boot?.isOwned()) await boot.release().catch(() => {})
    await pool?.end(); throw error
  }
  const runs: RunRegistry = new Map()
  const executions = new Set<Promise<void>>()
  const persistence = new AbortController()
  let delivery: ReturnType<typeof startCallbackDelivery> | undefined
  let governed: ReturnType<typeof startGovernedDispatch> | undefined
  let discovery: NacosRegistration | undefined
  let bootFailed = false
  const replication = () => (ctx as unknown as { sessionLogReplication?: { health(): ReplicationHealth; flush(): Promise<void> } }).sessionLogReplication
  const lifecycle = new HostLifecycle({
    active: () => executions.size + (governed?.activeCount() ?? 0),
    health: () => {
      const health = replication()?.health() ?? { ready: !config.requireSessionLog, pending: 0,
        ...(config.requireSessionLog ? { lastError: 'session log replication is not mounted' } : {}) }
      return bootFailed || (boot && !boot.isOwned()) ? { ...health, ready: false, lastError: 'execution host process lease was lost' } : health
    },
    check: async () => { await pool?.query('SELECT 1'); await boot?.assertOwned() },
    pause: () => governed?.pause(),
    withdraw: async () => { await discovery?.withdraw() },
    flush: async () => { await replication()?.flush() },
  })
  const server: Server = createSubagentHost({
    host,
    port,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY,
    tokens,
    callbackOrigins,
    governedOnly: !!config.runtimeReport,
    lifecycle,
    admit: request => startGuard?.admit(request) ?? Promise.resolve(),
    persistStop: startGuard ? (realm, childId, attempt, nodeId) => startGuard.stop(realm, childId, attempt, nodeId) : undefined,
    stopGoverned: (realm, runId) => governed?.stop(realm, runId),
    runs,
    // 已发布会话 = 已结集(运行表条目已摘)或他处占用的幂等键:重放闸(见 server.ts)
    sessionExists: (childId) => ctx.agents.get(SessionId(childId)) !== undefined,
    start: (req) => {
      if (bootFailed) throw new HostBootLeaseError()
      const execution = runChild(ctx, req, runs, receipts ? async (request, body) => {
        await persistCallback(startGuard?.callbackStore(request) ?? receipts, request.realm, request.callbackUrl, body, persistence.signal,
          error => ctx.logger.warn('subagent-host: %s', error))
        delivery?.wake()
      } : undefined, startGuard ? () => startGuard.assertMayRun(req) : undefined).catch((e: unknown) => {
        ctx.logger.error('subagent-host: 子代理运行失败: %s', e)
      })
      executions.add(execution)
      void execution.finally(() => executions.delete(execution))
    },
    logger: {
      info: (format, ...args) => ctx.logger.info(format, ...args),
      warn: (format, ...args) => ctx.logger.warn(format, ...args),
      error: (format, ...args) => ctx.logger.error(format, ...args),
    },
  })

  ctx.on('tools/pre-execute', async (_exec, next) => {
    if (bootFailed) throw new HostBootLeaseError()
    await boot?.assertOwned()
    return next()
  })

  ctx.effect(() => {
    let reports: ReturnType<typeof startRuntimeReports> | undefined
    let renewing: Promise<void> | undefined
    let bootTimer: ReturnType<typeof setInterval> | undefined
    let stopping: Promise<void> | undefined
    const stopExecution = (): Promise<void> => {
      if (stopping) return stopping
      // Fence synchronously, including admission requests already waiting on PG
      // and tool calls whose database lease has not expired yet.
      bootFailed = true
      clearInterval(bootTimer)
      governed?.pause()
      for (const run of runs.values()) run.cancel()
      persistence.abort()
      const pendingRenewal = renewing
      const governedClose = governed?.close()
      const reportsClose = reports?.close()
      const discoveryClose = discovery?.close()
      stopping = (async () => {
        // A failed renew invokes this path from its own catch handler. Do not
        // return this cleanup Promise from that handler: it must finish first.
        await pendingRenewal
        const outcomes = await Promise.allSettled([governedClose, reportsClose, discoveryClose, ...executions])
        for (const outcome of outcomes) if (outcome.status === 'rejected') {
          ctx.logger.error('subagent-host: fenced execution cleanup failed: %s', outcome.reason)
        }
        await delivery?.close()
        await boot?.release().catch(error => ctx.logger.warn('subagent-host: process lease release failed: %s', error))
      })()
      return stopping
    }
    bootTimer = boot ? setInterval(() => {
      if (renewing || bootFailed) return
      renewing = boot.renew().catch(error => {
        void stopExecution().catch(error => ctx.logger.error('subagent-host: process lease cleanup failed: %s', error))
        ctx.logger.error('subagent-host: process lease lost; execution admission closed: %s', error)
      }).finally(() => { renewing = undefined })
    }, Math.floor(boot.ttlMs / 3)) : undefined
    bootTimer?.unref()
    server.on('error', (error: unknown) => {
      ctx.logger.error('subagent-host: 监听 %s:%d 失败: %s', host, port, error)
      void stopExecution().catch(error => ctx.logger.error('subagent-host: failed listener cleanup: %s', error))
    })
    server.listen(port, host, () => {
      if (bootFailed || (boot && !boot.isOwned())) return
      if (receipts) {
        delivery = startCallbackDelivery(receipts, [...tokens.keys()], callbackOrigins,
          error => ctx.logger.warn('subagent-host: callback delivery failed: %s', error))
      }
      if (config.runtimeReport) {
        reports = startRuntimeReports(config.runtimeReport, error => ctx.logger.warn('subagent-host: runtime report failed: %s', error))
        governed = startGovernedDispatch(ctx, new PgGovernedDispatch(pool!, config.runtimeReport, reports.instanceId),
          error => ctx.logger.warn('subagent-host: governed execution failed: %s', error))
      }
      lifecycle.start()
      if (config.discovery) discovery = startNacosRegistration(config.discovery, {
        warn: message => ctx.logger.warn('subagent-host: %s', message),
      }, () => lifecycle.ready())
      ctx.logger.info('subagent-host: 监听 %s:%d(认证=%s)', host, port,
        tokens.size > 0 ? `tokens[${[...tokens.keys()].join(',')}]` : 'anonymous')
    })
    return async () => {
      const cleanup = stopExecution()
      server.closeAllConnections?.()
      server.close()
      try { await cleanup } finally { await pool?.end() }
    }
  })
}

/** dsh 函数插件惯例出口:`apply` 即插件入口,`registerSubagentHost` 同义暴露(可直接 ctx.plugin)。 */
export const apply = registerSubagentHost

export default registerSubagentHost

/**
 * 回环判定。故意保守:认不出的地址一律**不是**回环。
 * 判错的方向很重要 —— 误判成回环会放行一个无认证的对外端口。
 */
function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  if (isIP(h) === 4) return h.startsWith('127.')
  return false
}
