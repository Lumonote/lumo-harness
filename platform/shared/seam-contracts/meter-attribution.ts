import type { MeterContext } from './metering.ts'
import type { SessionModelBillingRoute } from './model-billing.ts'

/** Installed by trusted execution code, never by a prompt or model tool. */
export interface SessionMeterAttribution {
  context: Pick<MeterContext, 'userId' | 'projectId' | 'agentId' | 'componentId' | 'feature'>
  traceId: string
  /** Present only for explicit dynamic model selection; every native call must
   * match a route and acquire its current enabled pricing-registry quote. */
  modelRoutes?: SessionModelBillingRoute[]
}

export interface SessionMeterScope {
  /** Refuses an already-bound session. The returned release owns this binding only. */
  bind(sessionRef: string, attribution: SessionMeterAttribution): () => void
  resolve(sessionRef: string): SessionMeterAttribution | undefined
}

export class SessionMeterRegistry implements SessionMeterScope {
  private readonly bindings = new Map<string, SessionMeterAttribution>()

  bind(sessionRef: string, attribution: SessionMeterAttribution): () => void {
    if (!sessionRef.trim() || !attribution.traceId.trim()
      || Object.values(attribution.context).some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('metering: session attribution requires complete trusted identity and trace')
    }
    if (this.bindings.has(sessionRef)) throw new Error('metering: session attribution is already bound')
    if (attribution.modelRoutes !== undefined && (!Array.isArray(attribution.modelRoutes) || !attribution.modelRoutes.length || attribution.modelRoutes.length > 32
      || attribution.modelRoutes.some(route => Object.values(route).some(value => typeof value !== 'string' || !value.trim()) || !route.provider || !route.model || !route.billingModel))) throw new Error('metering: dynamic model attribution requires approved priced routes')
    const binding = structuredClone(attribution)
    this.bindings.set(sessionRef, binding)
    return () => { if (this.bindings.get(sessionRef) === binding) this.bindings.delete(sessionRef) }
  }

  resolve(sessionRef: string): SessionMeterAttribution | undefined {
    const binding = this.bindings.get(sessionRef)
    return binding === undefined ? undefined : structuredClone(binding)
  }
}
