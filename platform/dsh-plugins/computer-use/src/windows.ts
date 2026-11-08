/** Optional Windows provider using the public SDK inside an owned process tree. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { WindowsCuaRuntime } from './windows-runtime.ts'

export const name = 'lumo-computer-use-windows'
export const inject = ['computerUse', 'tools', 'systemPrompt', 'lumoComputerUse']
declare module '@deepseek-ai/cordis' { interface Context { lumoWindowsComputerUse: WindowsComputerUseService } }
export class WindowsComputerUseService extends Service {
  ready = false
  constructor(ctx: Context, private readonly runtime: WindowsCuaRuntime) { super(ctx, 'lumoWindowsComputerUse') }
  get available(): boolean { return this.ready && !this.runtime.quarantined }
  async drain(): Promise<void> { await this.runtime.drain() }
}
export async function apply(ctx: Context): Promise<void> {
  if (process.platform !== 'win32') throw Error('WINDOWS_CUA_PLATFORM_REQUIRED')
  await mountWindowsProvider(ctx, new WindowsCuaRuntime())
}
/** The provider composition is shared with process-only integration fixtures. */
export async function mountWindowsProvider(ctx: Context, runtime: WindowsCuaRuntime): Promise<void> {
  const service = new WindowsComputerUseService(ctx, runtime)
  const lifetime = new AbortController()
  lifetime.signal.addEventListener('abort', () => { service.ready = false }, { once: true })
  const pending = new Set<Promise<unknown>>()
  ctx.on('internal/plugin', fiber => { if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort() }, { global: true })
  const dispose = ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('lumo-cua-windows'))
    yield ctx.lumoComputerUse.bindWindowsCleanup(() => runtime.drain())
    yield async () => { lifetime.abort(); await runtime.dispose(); await Promise.allSettled(pending) }
  }, 'lumo-computer-use-windows: isolated native runtime')
  try {
    const catalog = await runtime.catalog()
    for (const tool of catalog.tools) {
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: `lumo_cua_windows__${tool.name}`, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        async call(args, execution) {
          const signal = AbortSignal.any([execution.signal, lifetime.signal])
          return await runtime.call(tool.name, args, signal, String(execution.agent?.session.id ?? ''))
        },
      }))
    }
    ctx.on('tools/execute', async (execution, next) => {
      if (!execution.name.startsWith('lumo_cua_windows__')) return next()
      const previous = execution.signal
      execution.signal = AbortSignal.any([previous, lifetime.signal])
      const operation = Promise.resolve().then(next)
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation); execution.signal = previous }
    })
    ctx.systemPrompt.section({ name: 'computer-use:lumo-windows', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: 'Windows computer-use tools operate this interactive desktop. Discover the exact application and window, then obtain a fresh window snapshot before acting. Use its element tokens or screenshot coordinates and verify the result from fresh state. Prefer background delivery; a refusal does not authorize a foreground retry. Windows secure desktop, UAC prompts and higher-integrity applications are outside the granted scope; do not elevate or bypass them. Stopping terminates the isolated driver tree and invalidates all prior element tokens. Input already delivered cannot be undone. After cancellation, obtain fresh state before another action. Permission checks must use prompt:false. Any operating-system permission grant must be performed directly by the human in Windows.' })
    service.ready = true
  } catch (error) { await dispose(); throw error }
}
