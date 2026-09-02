/**
 * @lumo/seam-host —— seam 网络化的服务端侧（§4.1）。
 *
 * 挂在 **capability 节点**上：把本进程已经挂载的 `ctx.knowledge` /
 * `ctx.knowledgeGraph` 通过通用协议暴露出去，供远端 agent 节点的
 * @lumo/seam-proxy 调用。Provider 代码一行不改 —— 它不知道自己被网络化了。
 *
 * 与 @lumo/seam-proxy 的对称性：proxy 把本地接口翻成网络调用，host 把网络调用
 * 翻回本地接口。中间那层（remote.ts 的信封 + dispatch.ts 的方法表）是两端共享的
 * 唯一契约，所以「让下一个 seam 可远程」= 在 dispatch.ts 加一张表，不是写一遍 RPC。
 *
 * §13.2 形态：Local-lite **不需要**本插件（进程内直连）；Standalone/Cluster 的
 * capability 节点挂它。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isIP } from 'node:net'

import { createSeamHost } from './server.ts'
import {
  assertIdentityAssertionConfig,
  SEAM_IDENTITY_AUDIENCE,
} from '../../../shared/seam-contracts/identity.ts'
import { ReloadingMutualTLSCredentials, type MutualTLSFileConfig } from '../../../shared/seam-contracts/mtls.ts'

export interface SeamHostConfig {
  /** 监听地址。默认回环 —— 对外暴露必须是显式动作 */
  host?: string
  port?: number
  /** 单请求体上限字节（默认 8 MiB；ingest 会很大，但不能无上限） */
  maxBodyBytes?: number
  /** realm → 共享令牌。缺省即无认证，此时只允许绑回环 */
  tokens?: Record<string, string>
  /** 与 seam-proxy 配对的短时身份声明密钥；启用后拒绝普通身份头。 */
  identityAssertionSecret?: string
  /** CA、节点证书和私钥的绝对 PEM 文件路径；启用后 listener 强制校验客户端证书。 */
  tls?: MutualTLSFileConfig
  /** 显式承认「本端口无认证」。绑非回环地址时该开关无效（见下） */
  allowAnonymous?: boolean
}

/** Schemastery validation for {@link SeamHostConfig} */
export const Config: z<SeamHostConfig> = z.object({
  host: z.string(),
  port: z.number(),
  maxBodyBytes: z.number(),
  tokens: z.dict(z.string()),
  identityAssertionSecret: z.string(),
  tls: z.object({
    caFile: z.string().required(),
    certFile: z.string().required(),
    keyFile: z.string().required(),
    serverName: z.string(),
    reloadIntervalMs: z.number(),
  }),
  allowAnonymous: z.boolean(),
})

const DEFAULT_MAX_BODY = 8 * 1024 * 1024

export function apply(ctx: Context, config: SeamHostConfig): void {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 8090
  const tokens = new Map(Object.entries(config.tokens ?? {}))
  const identityAssertionSecret = config.identityAssertionSecret || undefined
  if (identityAssertionSecret !== undefined) {
    assertIdentityAssertionConfig({ audience: SEAM_IDENTITY_AUDIENCE, secret: identityAssertionSecret })
  }
  // 初始化阶段先打开一次，坏的 Secret volume 不能让 listener 以半配置状态启动。
  // 后续更新则由 reloader 保留最后一套可用凭据，直到新的完整 bundle 到位。
  const tlsReloader = config.tls === undefined ? undefined : new ReloadingMutualTLSCredentials(config.tls)

  if (tokens.size === 0 && identityAssertionSecret === undefined) {
    // 无认证 + 非回环 = 把跨租户读取开放给整个网络。这不是「配置不当」，
    // 是一个不该存在的形态，因此在启动期就否掉，而不是留个告警等人忽略。
    if (!isLoopback(host)) {
      throw new Error(
        `seam-host: 未配置 tokens 时只能绑回环地址（当前 host=${host}）。` +
        '要对外暴露请为每个 realm 配置 tokens。',
      )
    }
    if (!config.allowAnonymous) {
      throw new Error(
        'seam-host: 未配置 tokens。回环调试可设 allowAnonymous: true 显式承认，' +
        '生产必须配置 tokens（§12.1 收敛为 mTLS 前的过渡形态）。',
      )
    }
    ctx.logger.warn('seam-host: 无认证模式，仅限回环 %s:%d —— 任何本机进程可以任意 realm 身份调用', host, port)
  }

  const server = createSeamHost({
    host,
    port,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY,
    tokens,
    identityAssertionSecret,
    tls: config.tls,
    // 惰性解析：Provider 可能比 host 晚挂载；缺失时按 capability_unavailable 拒绝，
    // 而不是让 host 起不来 —— 一个只提供图能力的节点也该能正常服务
    resolveKnowledge: () => ctx.get('knowledge'),
    resolveGraph: () => ctx.get('knowledgeGraph'),
    logger: {
      info: (format, ...args) => ctx.logger.info(format, ...args),
      warn: (format, ...args) => ctx.logger.warn(format, ...args),
      error: (format, ...args) => ctx.logger.error(format, ...args),
    },
  })

  ctx.effect(() => {
    const rotationTimer = tlsReloader === undefined ? undefined : setInterval(() => {
      try {
        const credentials = tlsReloader.get()
        if (tlsReloader.lastReloadError !== undefined) {
          ctx.logger.error('seam-host: mTLS Secret 轮换未生效，继续使用上一套证书: %s', tlsReloader.lastReloadError)
          return
        }
        if ('setSecureContext' in server) {
          const { serverName: _serverName, ...context } = credentials
          server.setSecureContext({ ...context, minVersion: 'TLSv1.2' })
        }
      } catch (e) {
        ctx.logger.error('seam-host: mTLS 证书上下文轮换失败，继续使用上一套证书: %s', e)
      }
    }, config.tls?.reloadIntervalMs ?? 30_000)
    server.on('error', (e: unknown) => {
      // 端口占用等致命错误：必须响亮，否则节点看着活着却没有对外能力
      ctx.logger.error('seam-host: 监听 %s:%d 失败: %s', host, port, e)
    })
    server.listen(port, host, () => {
      const authentication = identityAssertionSecret !== undefined
        ? `signed-identity${tokens.size > 0 ? ` + tokens[${[...tokens.keys()].join(',')}]` : ''}`
        : tokens.size > 0 ? `tokens[${[...tokens.keys()].join(',')}]` : 'anonymous'
      ctx.logger.info('seam-host: 监听 %s:%d（认证=%s，传输=%s）', host, port, authentication,
        config.tls === undefined ? 'http-compat' : 'mTLS')
    })
    return () => {
      if (rotationTimer !== undefined) clearInterval(rotationTimer)
      server.closeAllConnections?.()
      server.close()
    }
  })
}

export default apply

/**
 * 回环判定。故意保守：认不出的地址一律**不是**回环。
 * 判错的方向很重要 —— 误判成回环会放行一个无认证的对外端口。
 */
function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  if (isIP(h) === 4) return h.startsWith('127.')
  return false
}
