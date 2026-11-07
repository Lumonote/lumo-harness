/** First-party Web authentication backed by the governance user authority. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { createSessionTransport, type SessionTransportConfig } from './session-transport.ts'
import { validateSessionAttachments } from './session-attachments.ts'
import { validateSessionConnectors } from './session-connectors.ts'
import { validateSessionKnowledge } from './session-knowledge.ts'
import { routeSessionTransport, trustedSessionRoutes } from './session-routing.ts'
import { SessionModelPolicy } from './session-model-policy.ts'
import { CarrierSession } from './carrier-session.ts'
import { GovernanceAuthClient } from './client.ts'
import { ConnectorOAuthClient } from './connector-oauth.ts'
import { closeAuthProxy, createAuthProxy, listenAuthProxy } from './proxy.ts'

export const name = 'lumo-user-auth'
export const inject = ['webServer']

/** `connection` 服务里本插件用到的那一个方法（结构类型，不引入跨包依赖）。 */
interface ConnectionLike {
  authenticatedUrl(baseUrl: string): string
}

export interface Config {
  host: string
  port: number
  publicBaseUrl?: string
  secureCookie?: boolean
  clusterMode?: boolean
  clusterReady?: boolean
  governanceUrl: string
  connectorUrl?: string
  controlPlaneToken: string
  realm: string
  projectId?: string
  identityAssertionSecret: string
  sessionTransport?: SessionTransportConfig
  /** Must equal this process's session-log writer identity. Injected by the launcher. */
  sessionWriterHolder?: string
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(3080),
  publicBaseUrl: z.string(),
  secureCookie: z.boolean().default(false),
  clusterMode: z.boolean().default(false),
  clusterReady: z.boolean().default(false),
  governanceUrl: z.string(),
  connectorUrl: z.string(),
  controlPlaneToken: z.string(),
  realm: z.string(),
  projectId: z.string(),
  identityAssertionSecret: z.string(),
  sessionTransport: z.any(),
  sessionWriterHolder: z.string(),
  timeoutMs: z.number().default(5000),
}) as z<Config>

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('lumo-user-auth: internal DSH WebServer must bind 127.0.0.1')
  }
  const upstreamPort = ctx.webServer.port
  if (upstreamPort === undefined) {
    throw new Error('lumo-user-auth: internal DSH WebServer has not bound a listening port')
  }
  if (Buffer.byteLength(config.identityAssertionSecret, 'utf8') < 32) {
    throw new Error('lumo-user-auth: identityAssertionSecret must contain at least 32 bytes')
  }
  if (config.controlPlaneToken === '') {
    throw new Error('lumo-user-auth: controlPlaneToken is required')
  }
  const client = new GovernanceAuthClient(config.governanceUrl, config.controlPlaneToken, config.timeoutMs ?? 5000)
  // carrier 的会话交接（见 carrier-session.ts）。`connection` 用 `ctx.get` 取而不是写进
  // `inject`：它是**可选能力**——没有 carrier 的装配里插件仍应正常认证浏览器，只是转发时
  // 不带 carrier cookie（写进 inject 会让插件在那里整块不挂载，那是一次静默的鉴权消失）。
  const carrier = new CarrierSession({
    authenticatedUrl: () => {
      const connection = ctx.get('connection') as ConnectionLike | undefined
      if (connection === undefined) return undefined
      return connection.authenticatedUrl(`http://127.0.0.1:${String(upstreamPort)}`)
    },
    logger: { warn: (format, ...args) => ctx.logger.warn(format, ...args) },
  })
  if (config.sessionTransport && config.sessionTransport.projectId !== config.projectId) throw new Error('Dynamic Session project must match the authenticated deployment project')
  validateSessionKnowledge(config.sessionTransport?.knowledge, config.realm)
  validateSessionAttachments(config.sessionTransport?.attachments, config.realm)
  validateSessionConnectors(config.sessionTransport?.connectors, config.realm)
  let sessionTransport
  if(config.sessionTransport){
    new SessionModelPolicy(config.sessionTransport)
    if(!config.sessionWriterHolder?.trim())throw new Error('Dynamic Session execution requires its process session-log writer identity')
    const routes=trustedSessionRoutes(config.sessionTransport)
    const authorize=(principal: import('./client.ts').Principal)=>client.authorizeSessionProject(principal,config.sessionTransport!.projectId)
    const local=createSessionTransport(ctx,config.sessionTransport,config.controlPlaneToken,authorize,undefined,{realm:config.realm,writerHolder:config.sessionWriterHolder,endpoint:routes.get(config.sessionTransport.nodeId)??''})
    await local.runtime!.start()
    sessionTransport=routeSessionTransport(local,config.sessionTransport,config.realm,config.controlPlaneToken,authorize)
  }
  const server = createAuthProxy({
    ...(sessionTransport ? { sessionTransport } : {}),
    serverRuntimeToken: config.controlPlaneToken,
    host: config.host,
    port: config.port,
    ...(config.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.publicBaseUrl }),
    secureCookie: config.secureCookie ?? false,
    clusterMode: config.clusterMode ?? false,
    realm: config.realm,
    ...(config.projectId === undefined ? {} : { projectId: config.projectId }),
    identityAssertionSecret: config.identityAssertionSecret,
    upstreamPort,
    carrierCookie: () => carrier.cookieHeader(),
    carrierRejected: () => carrier.invalidate(),
    client,
    ...(config.clusterMode && config.clusterReady && config.connectorUrl ? { connectorOAuth: new ConnectorOAuthClient(config.connectorUrl, config.controlPlaneToken) } : {}),
    logger: {
      info: (format, ...args) => ctx.logger.info(format, ...args),
      warn: (format, ...args) => ctx.logger.warn(format, ...args),
      error: (format, ...args) => ctx.logger.error(format, ...args),
    },
  })
  const port = await listenAuthProxy(server, config.host, config.port)
  console.log(`lumo auth: ${config.publicBaseUrl ?? `http://127.0.0.1:${String(port)}`}`)
  ctx.effect(() => async () => {
    await closeAuthProxy(server)
  }, 'lumo-user-auth: public listener')
}

export default apply
export { GovernanceApiError, GovernanceAuthClient } from './client.ts'
export { closeAuthProxy, createAuthProxy, listenAuthProxy } from './proxy.ts'
export { loginPage, loginScript } from './html.ts'
