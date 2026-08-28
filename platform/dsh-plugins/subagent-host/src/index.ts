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

import { createSubagentHost } from './server.ts'
import { runChild, type RunRegistry } from './run.ts'
import { normalizeCallbackOrigins } from './callback-policy.ts'

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
}

/** Schemastery validation for {@link SubagentHostConfig} */
export const Config: z<SubagentHostConfig> = z.object({
  host: z.string(),
  port: z.number(),
  maxBodyBytes: z.number(),
  tokens: z.dict(z.string()),
  callbackOrigins: z.array(z.string()),
  allowAnonymous: z.boolean(),
})

const DEFAULT_MAX_BODY = 8 * 1024 * 1024

export function registerSubagentHost(ctx: Context, config: SubagentHostConfig): void {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 8091
  const tokens = new Map(Object.entries(config.tokens ?? {}))
  const callbackOrigins = normalizeCallbackOrigins(config.callbackOrigins ?? ['http://127.0.0.1:8092'])

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

  const runs: RunRegistry = new Map()
  const server: Server = createSubagentHost({
    host,
    port,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY,
    tokens,
    callbackOrigins,
    runs,
    // 已发布会话 = 已结集(运行表条目已摘)或他处占用的幂等键:重放闸(见 server.ts)
    sessionExists: (childId) => ctx.agents.get(SessionId(childId)) !== undefined,
    start: (req) => {
      void runChild(ctx, req, runs).catch((e: unknown) => {
        ctx.logger.error('subagent-host: 子代理运行失败: %s', e)
      })
    },
    logger: {
      info: (format, ...args) => ctx.logger.info(format, ...args),
      warn: (format, ...args) => ctx.logger.warn(format, ...args),
      error: (format, ...args) => ctx.logger.error(format, ...args),
    },
  })

  ctx.effect(() => {
    server.on('error', (e: unknown) => {
      // 端口占用等致命错误:必须响亮,否则节点看着活着却没有子代理放置能力
      ctx.logger.error('subagent-host: 监听 %s:%d 失败: %s', host, port, e)
    })
    server.listen(port, host, () => {
      ctx.logger.info('subagent-host: 监听 %s:%d(认证=%s)', host, port,
        tokens.size > 0 ? `tokens[${[...tokens.keys()].join(',')}]` : 'anonymous')
    })
    return () => {
      server.closeAllConnections?.()
      server.close()
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
