/** Small projection of public client services, shared with the on-demand computer panel. */
export interface ComputerUseClientServices {
  sessions: { list: {
    getSnapshot(): { phase: string; byId: Readonly<Record<string, { displayTitle?: string; retainedBy?: Readonly<Record<string, number | undefined>> } | undefined>> }
    subscribe(listener: () => void): () => void
  } }
  layout: { selectPanel(id: 'plugins'): void }
}
interface ServiceState { current?: ComputerUseClientServices; listeners: Set<() => void> }
const KEY = Symbol.for('@lumo/computer-use/client-services')
type ComputerWindow = Window & { [KEY]?: ServiceState }
function state(view: Window): ServiceState { return (view as ComputerWindow)[KEY] ??= { listeners: new Set() } }
export function getComputerUseServices(view: Window): ComputerUseClientServices | undefined { return state(view).current }
export function subscribeComputerUseServices(view: Window, listener: () => void): () => void {
  const current = state(view)
  current.listeners.add(listener)
  return () => { current.listeners.delete(listener) }
}
export function installComputerUseServices(view: Window, services: ComputerUseClientServices): () => void {
  const current = state(view)
  current.current = services
  current.listeners.forEach(listener => listener())
  return () => {
    if (current.current !== services) return
    delete current.current
    current.listeners.forEach(listener => listener())
  }
}
