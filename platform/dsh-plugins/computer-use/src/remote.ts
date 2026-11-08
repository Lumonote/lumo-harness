import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { RemoteComputerBroker } from './remote-broker.ts'
import { createRemoteComputerAuthority, listenRemoteComputerHost } from './remote-local-bridge.ts'
export const name = 'lumo-remote-computer-use'
export const inject = ['agents', 'agentLoop', 'tools', 'lumoComputerUse']
export interface Config { enabled: boolean; realm: string; nodeId: string; ownerUserId: string; ledgerDir: string; hostFile: string; bridgeFile: string }
export const Config: Schema<Config> = Schema.object({ enabled: Schema.boolean().default(false), realm: Schema.string().required(), nodeId: Schema.string().required(), ownerUserId: Schema.string().required(), ledgerDir: Schema.string().required(), hostFile: Schema.string().required(), bridgeFile: Schema.string().required() })
declare module '@deepseek-ai/cordis' { interface Context { lumoRemoteComputerUse: RemoteComputerService } }
export class RemoteComputerService extends Service {
 constructor(ctx: Context, readonly broker: RemoteComputerBroker) { super(ctx, 'lumoRemoteComputerUse') }
 list() { return this.broker.list() }
 decide(id: string, decision: { digest: string; approve: boolean }) { return this.broker.decide(id, decision) }
 revoke(id: string, digest: string) { return this.broker.revoke(id, digest) }
}
export async function apply(ctx: Context, config: Config): Promise<void> {
 if (config.enabled !== true) return
 const broker = await RemoteComputerBroker.create({ ctx, ...config, authorize: createRemoteComputerAuthority(config) })
 let closing: Promise<void> | undefined
 ctx.on('internal/plugin', fiber => { if (fiber === ctx.fiber && fiber.uid === null) closing ??= broker.dispose() }, { global: true })
 ctx.effect(() => async () => { closing ??= broker.dispose(); await closing }, 'remote computer: join approved Agent and provider')
 const stopHost = await listenRemoteComputerHost({ ...config, broker })
 ctx.effect(() => async () => {
  // Keep the discovery generation and its process lock until all native work
  // is confirmed drained. A failed join intentionally retains this fence.
  closing ??= broker.dispose()
  await closing
  await stopHost()
 }, 'remote computer: private device bridge')
 new RemoteComputerService(ctx, broker)
}
