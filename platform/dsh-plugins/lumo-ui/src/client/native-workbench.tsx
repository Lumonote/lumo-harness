import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ConversationCatalog } from './conversation-catalog.tsx'
import { installConversationHost, type ConversationHost } from './conversation-host.ts'
import { RoleRoomSurface } from './role-room-surface.tsx'
import { MembersIcon, SettingsIcon } from './chat-icons.tsx'
import { querySurface, registerNativeSurface, setQuerySurface } from './surface-navigation.ts'

/** Public shell slots own layout; engine-specific views occupy only the main column. */
export function installNativeWorkbench(ctx: Context, Navigation: ComponentType<{ wide: boolean }>) {
  ctx.inject(['sessions', 'workspaces', 'uiWorkspace', 'layout'], scope => {
    // The plugin's combined host/client check sees the Host sessions declaration.
    // This file only runs on the Client; validate the public Client face before installing.
    const source = { sessions: scope.get('sessions'), workspaces: scope.get('workspaces') ?? scope.workspaces, uiWorkspace: scope.get('uiWorkspace') ?? (scope as unknown as Pick<ConversationHost, 'uiWorkspace'>).uiWorkspace, layout: scope.get('layout') } as unknown as ConversationHost
    if (Object.values(source).some(value => !value)) return
    if (typeof source.sessions.list?.getSnapshot !== 'function') return
    scope.effect(() => installConversationHost(source), 'lumo: native conversation directory')
    scope.slots.inject('sidebar.workspaces', () => scope.slots.register({ name: 'sidebar.workspaces', priority: -10 }, ConversationCatalog))
    const agentPanel = 'lumo-agents' as MainPanelId
    scope.slots.inject('main', function* () {
      yield scope.slots.register({ name: 'main', key: agentPanel }, () => <div className="lumo-native-agent-panel"><RoleRoomSurface embedded onClose={() => source.layout.selectPanel(null)} /></div>)
      yield scope.slots.register({ name: 'main', key: 'lumo-navigation' as MainPanelId }, () => <Navigation wide />)
      yield registerNativeSurface('agents', () => { setQuerySurface(null); source.layout.selectPanel(agentPanel) })
      if (querySurface() === 'agents') { setQuerySurface(null); source.layout.selectPanel(agentPanel) }
    })
    scope.slots.inject('sidebar.panellist', function* () {
      yield scope.slots.register({ name: 'sidebar.panellist', id: agentPanel, order: 20, label: '对话与群组' }, () => <MembersIcon size={18} />)
      yield scope.slots.register({ name: 'sidebar.panellist', id: 'lumo-navigation', order: 30, label: '工作台' }, () => <SettingsIcon size={18} />)
    })
  })
}
