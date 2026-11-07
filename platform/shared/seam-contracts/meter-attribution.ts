import type { MeterContext } from './metering.ts'

/** Installed by trusted execution code, never by a prompt or model tool. */
export interface SessionMeterAttribution {
  context: Pick<MeterContext, 'userId' | 'projectId' | 'agentId' | 'componentId' | 'feature'>
  traceId: string
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
    const binding = structuredClone(attribution)
    this.bindings.set(sessionRef, binding)
    return () => { if (this.bindings.get(sessionRef) === binding) this.bindings.delete(sessionRef) }
  }

  resolve(sessionRef: string): SessionMeterAttribution | undefined {
    const binding = this.bindings.get(sessionRef)
    return binding === undefined ? undefined : structuredClone(binding)
  }
}
