import type { SessionScope } from './session-scope.ts'

export interface SharedToolInventory {
  supplied: boolean
  reason?: string
  tools: Array<{ name: string; title: string; description: string; action: string; risk: 'low' | 'medium' | 'high'; approval: 'never' | 'auto' | 'always' | 'source' }>
}
export type SharedToolsFor = (identity: SessionScope, sessionRef: string) => SharedToolInventory
export interface ConversationTools {
  members: Array<SharedToolInventory & { id: string; name: string; engineId: string }>
}
