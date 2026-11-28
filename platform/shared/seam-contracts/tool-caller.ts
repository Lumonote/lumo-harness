/** Host-only identity bindings. Agent IDs and model arguments are not credentials. */
export interface TrustedToolCaller {
  realm: string
  userId: string
  projectId?: string
  agentId?: string
  runId?: string
  depth?: number
}
type Resolve = () => TrustedToolCaller | Promise<TrustedToolCaller>
interface Binding { resolve: Resolve; active: boolean }
const key = Symbol.for('lumo.trustedToolCallers')

// Plugins may bundle this contract independently. Keep one process-wide weak
// registry, matching the lifetime and object identity of the actual Agent.
function bindings(): WeakMap<object, Binding> {
  const root = globalThis as Record<symbol, unknown>
  return (root[key] ??= new WeakMap<object, Binding>()) as WeakMap<object, Binding>
}

export function bindToolCaller(agent: object, resolve: Resolve): () => void {
  const binding = { resolve, active: true }
  bindings().set(agent, binding)
  return () => { binding.active = false }
}

export async function resolveToolCaller(agent: object): Promise<TrustedToolCaller | undefined> {
  const binding = bindings().get(agent)
  if (!binding) return undefined
  const check = () => {
    if (!binding.active || bindings().get(agent) !== binding) throw new Error('Trusted tool caller binding is no longer active')
  }
  check()
  const identity = await binding.resolve()
  check()
  if (!identity || typeof identity.realm !== 'string' || !identity.realm.trim() || typeof identity.userId !== 'string' || !identity.userId.trim()) throw new Error('Trusted tool caller requires an authenticated realm and user')
  return { ...identity }
}
