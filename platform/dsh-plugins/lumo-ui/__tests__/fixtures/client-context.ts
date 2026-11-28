import type { ComponentType } from 'react'
export interface Registered {
  id: string
  name: string
  Component: ComponentType<Record<string, unknown>>
}

interface SlashClaim { token: string; hint?: string; submit(args: string): Promise<{ kind: string }> }
export interface SlashSource {
  trigger: string
  name: string
  candidates(session: unknown, req: { query: string }): Promise<ReadonlyArray<{ name: string; description?: string }>>
  onPick(pick: { candidate: { name: string } }): { claim: SlashClaim } | undefined
  matchEnter(session: unknown, line: string): Promise<{ claim: SlashClaim } | undefined>
}

/** Native slot/theme fixture; effects execute as in Cordis. */
export function createLumoContext(preloadedThemes: string[] = []): { context: unknown; registered: Registered[]; sources: SlashSource[] } {
  const registered: Registered[] = []
  const sources: SlashSource[] = []
  const slots = {
    inject: (_name: string, mount: () => unknown) => { const result = mount(); if (result && typeof (result as Iterable<unknown>)[Symbol.iterator] === 'function') [...result as Iterable<unknown>] },
    register: (meta: { id?: string; key?: string; name: string }, Component: ComponentType<Record<string, unknown>>) => {
      registered.push({ ...meta, id: meta.id ?? meta.key ?? meta.name, Component })
      return () => {}
    },
  }
  const themeIDs = new Set(preloadedThemes)
  const theme = {
    getTheme: () => ({ active: { id: [...themeIDs][0] ?? 'default' }, themes: [...themeIDs].map(id => ({ id, tokens: {} })) }),
    register: (definition: { id: string }) => {
      if (themeIDs.has(definition.id)) throw new Error(`theme "${definition.id}" is already registered`)
      themeIDs.add(definition.id)
      return () => { themeIDs.delete(definition.id) }
    },
    setTheme: () => {},
  }
  // inputTriggers 是上游 ui-input-trigger 的公开服务；替身只记录登记的 `/` 源。
  const inputTriggers = { registerSource: (source: SlashSource) => { sources.push(source); return () => { sources.splice(sources.indexOf(source), 1) } } }
  const context: Record<string, unknown> = { [Symbol.for('cordis.root')]: {}, slots, theme, effect: (body: () => unknown) => { body() }, on: () => () => {} }
  Object.defineProperty(context, 'root', { get() { throw Error('cannot get property "root" without inject') } })
  const services: Record<string, unknown> = { inputTriggers, sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} } }, workspaces: {}, uiWorkspace: {}, layout: { selectPanel() {} } }
  context['get'] = (name: string) => services[name]
  context['inject'] = (_deps: string[], body: (ctx: unknown) => void) => { body(context) }
  return { context, registered, sources }
}
