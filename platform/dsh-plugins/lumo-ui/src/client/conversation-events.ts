import { useSyncExternalStore } from 'react'

export const CATALOG_CHANGED = 'lumo:conversation-catalog-changed'
export const refreshConversationCatalog = () => window.dispatchEvent(new Event(CATALOG_CHANGED))
let selected = { identity: '', key: '' }
const listeners = new Set<() => void>()
export function selectCatalogConversation(identity: string, key: string) {
  if (selected.identity === identity && selected.key === key) return
  selected = { identity, key }; listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useCatalogSelection = () => useSyncExternalStore(subscribe, () => selected, () => selected)
