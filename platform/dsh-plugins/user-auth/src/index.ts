/** First-party Web authentication backed by the governance user authority. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { GovernanceAuthClient } from './client.ts'
import { closeAuthProxy, createAuthProxy, listenAuthProxy } from './proxy.ts'

export const name = 'lumo-user-auth'
export const inject = ['webServer']

export interface Config {
  host: string
  port: number
  publicBaseUrl?: string
  secureCookie?: boolean
  governanceUrl: string
  controlPlaneToken: string
  realm: string
  projectId?: string
  identityAssertionSecret: string
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(3080),
  publicBaseUrl: z.string(),
  secureCookie: z.boolean().default(false),
  governanceUrl: z.string(),
  controlPlaneToken: z.string(),
  realm: z.string(),
  projectId: z.string(),
  identityAssertionSecret: z.string(),
  timeoutMs: z.number().default(5000),
}) as z<Config>

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('lumo-user-auth: internal DSH WebServer must bind 127.0.0.1')
  }
  if (Buffer.byteLength(config.identityAssertionSecret, 'utf8') < 32) {
    throw new Error('lumo-user-auth: identityAssertionSecret must contain at least 32 bytes')
  }
  if (config.controlPlaneToken === '') {
    throw new Error('lumo-user-auth: controlPlaneToken is required')
  }
  const client = new GovernanceAuthClient(config.governanceUrl, config.controlPlaneToken, config.timeoutMs ?? 5000)
  const server = createAuthProxy({
    host: config.host,
    port: config.port,
    ...(config.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.publicBaseUrl }),
    secureCookie: config.secureCookie ?? false,
    realm: config.realm,
    ...(config.projectId === undefined ? {} : { projectId: config.projectId }),
    identityAssertionSecret: config.identityAssertionSecret,
    upstreamPort: ctx.webServer.port,
    client,
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
