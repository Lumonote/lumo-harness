// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { nativeRenderer } from './fixtures/native-renderer.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeWorkbench } from '../src/client/native-workbench.tsx'
import { conversationHost } from '../src/client/conversation-host.ts'
import { hasNativeSurface, openSurface } from '../src/client/surface-navigation.ts'

let ctx: Context
const { SlotRegistry } = nativeRenderer()
const Empty = () => null
afterEach(async () => { await ctx?.fiber.dispose(); history.replaceState({}, '', '/') })

describe('actual Cordis and native SlotRegistry assembly', () => {
  it.each(['provided', 'service'])('assembles %s services, waits for main declaration and disposes cleanly', async mode => {
    ctx = new Context(); await ctx.plugin(SlotRegistry)
    const selectPanel = vi.fn((id: string) => { expect(ctx.slots.entries('main').some(entry => entry.options.key === id)).toBe(true) })
    ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [], byId: {} }) } } as never)
    if (mode === 'service') {
      await ctx.plugin(class extends Service { constructor(scope: Context) { super(scope, 'workspaces') } })
      await ctx.plugin(class extends Service { constructor(scope: Context) { super(scope, 'uiWorkspace') } })
    } else {
      ctx.provide('workspaces', {} as never); ctx.provide('uiWorkspace', {} as never)
    }
    ctx.provide('layout', { selectPanel } as never)
    history.replaceState({}, '', '/?lumo=agents')
    const extension = ctx.plugin({ inject: ['slots'], apply: scope => installNativeWorkbench(scope, Empty) })
    await extension
    expect(selectPanel).not.toHaveBeenCalled()
    const releaseShell = ctx.slots.register({ name: 'root', children: {
      main: { kind: 'keyed', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    } } as never, Empty)
    ctx.slots.register({ name: 'sidebar.workspaces', priority: 0 }, Empty)
    await vi.waitFor(() => expect(selectPanel).toHaveBeenCalledWith('lumo-agents'))
    expect(ctx.slots.entries('sidebar.workspaces').map(entry => entry.options.priority)).toEqual([-10, 0])
    expect(ctx.slots.spec('sidebar.navigation' as never)).toBeUndefined()
    expect(conversationHost()).toBeDefined(); expect(hasNativeSurface('agents')).toBe(true)
    openSurface('agents'); expect(selectPanel).toHaveBeenCalledTimes(2)
    await extension.dispose()
    expect(ctx.slots.entries('sidebar.workspaces').map(entry => entry.options.priority)).toEqual([0])
    expect(ctx.slots.entries('main')).toHaveLength(0); expect(conversationHost()).toBeUndefined(); expect(hasNativeSurface('agents')).toBe(false)
    releaseShell()
  })
})
