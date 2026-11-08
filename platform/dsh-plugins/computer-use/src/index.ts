import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { ComputerUseCoordinator, isComputerUseTool, type ComputerUseConfig, type ComputerUseSnapshot } from './coordinator.ts'

export { ComputerUseCoordinator, isComputerUseTool, defaultDesktopLockFile } from './coordinator.ts'
export type { ComputerUseConfig, ComputerUseEvent, ComputerUseSnapshot } from './coordinator.ts'

export const name = 'lumo-computer-use'
export const inject = ['tools']
export const Config: Schema<ComputerUseConfig> = Schema.object({
  idleLeaseMs: Schema.number().default(120_000),
  lockFile: Schema.string(),
})

declare module '@deepseek-ai/cordis' { interface Context { lumoComputerUse: LumoComputerUseService } }

/** Human-facing runtime controls. Enabling never grants OS permissions or application consent. */
export class LumoComputerUseService extends Service {
  private revision = 0
  constructor(ctx: Context, readonly coordinator: ComputerUseCoordinator) { super(ctx, 'lumoComputerUse') }
  get controlRevision(): number { return this.revision }
  snapshot(): ComputerUseSnapshot { return this.coordinator.snapshot() }
  enable(sessionId: string): ComputerUseSnapshot { const snapshot = this.coordinator.enable(sessionId); this.revision++; return snapshot }
  stop(): ComputerUseSnapshot { const snapshot = this.coordinator.stop(); this.revision++; return snapshot }
  bindWindowsCleanup(cleanup: () => Promise<void>): () => void { return this.coordinator.bindWindowsCleanup(cleanup) }
}

export function apply(ctx: Context, config: ComputerUseConfig): void {
  const coordinator = new ComputerUseCoordinator(config, { supportsIsolatedWindowsTool: name =>
    /^lumo_cua_windows__[A-Za-z0-9_-]+$/u.test(name)
    && (ctx.get('computerUse') as { providerName?: string } | undefined)?.providerName === 'lumo-cua-windows'
    && (ctx.get('lumoWindowsComputerUse') as { available?: boolean } | undefined)?.available === true })
  new LumoComputerUseService(ctx, coordinator)
  ctx.effect(function* () {
    yield ctx.tools.guard(execution => coordinator.guard(execution))
    yield ctx.on('tools/execute', async (execution, next) => {
      if (!isComputerUseTool(execution.name)) return next()
      const previous = execution.signal
      return coordinator.execute(execution, async signal => {
        execution.signal = signal
        try { return await next() }
        finally { execution.signal = previous }
      })
    })
    yield ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start' || event.type === 'turn/end') coordinator.observeTurn(session, event.type, event.data.turn)
    })
    yield ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') void coordinator.releaseOwner(agent) })
    yield ctx.on('agent/disposed', ({ agent }) => { void coordinator.releaseOwner(agent) })
    // Runs first on unload: stop admission and join provider work before withdrawing the guard.
    yield () => coordinator.dispose()
  }, 'lumo-computer-use: desktop workflow lease')
}

export default apply
