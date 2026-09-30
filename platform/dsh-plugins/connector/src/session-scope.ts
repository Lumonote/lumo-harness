import type { ConnectorExecutionIdentity, ConnectorSessionScope } from '../../../shared/seam-contracts/connector-scope.ts'
import type { ConnectorClient, ConnectorClientConfig } from './client.ts'

/** Bind a governed run to the identity installed in this process and to visible connectors. */
export function createConnectorSessionScope(client: ConnectorClient, config: ConnectorClientConfig): ConnectorSessionScope {
  const bySession = new Map<string, { allowed: readonly string[] }>()
  return {
    async bind(sessionRef: string, connectorIds: readonly string[], identity: ConnectorExecutionIdentity) {
      if (!sessionRef || bySession.has(sessionRef)) throw new Error('connector: invalid or already bound session')
      if (identity.realm !== config.realm || identity.userId !== config.userId ||
          identity.projectId !== config.projectId || identity.agentId !== config.agentId) {
        throw new Error('connector: governed execution identity does not match gateway identity')
      }
      if (!Array.isArray(connectorIds) || connectorIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(id)) ||
          new Set(connectorIds).size !== connectorIds.length) {
        throw new Error('connector: invalid governed connector allow-list')
      }
      const entry = { allowed: [] as readonly string[] }
      bySession.set(sessionRef, entry)
      try {
        if (connectorIds.length > 0) {
          const visible = new Set((await client.list()).map(connector => connector.id))
          for (const id of connectorIds) {
            if (!visible.has(id)) throw new Error(`connector: configured connector is not available to this identity: ${id}`)
          }
        }
        if (bySession.get(sessionRef) !== entry) throw new Error('connector: session binding was cleared before validation completed')
        entry.allowed = [...connectorIds]
      } catch (error) {
        if (bySession.get(sessionRef) === entry) bySession.delete(sessionRef)
        throw error
      }
    },
    allowedFor(sessionRef) { return bySession.get(sessionRef)?.allowed },
    clear(sessionRef) { bySession.delete(sessionRef) },
  }
}
