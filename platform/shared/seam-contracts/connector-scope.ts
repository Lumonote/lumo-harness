/** Names registered by the connector plugin and admitted by a governed run. */
export const CONNECTOR_TOOL_NAMES = ['connector_list', 'connector_invoke'] as const

export interface ConnectorExecutionIdentity {
  realm: string
  userId: string
  projectId: string
  agentId: string
}

/** A missing entry means an ordinary session; an empty entry denies every connector. */
export interface ConnectorSessionScope {
  bind(sessionRef: string, connectorIds: readonly string[], identity: ConnectorExecutionIdentity): Promise<void>
  allowedFor(sessionRef: string): readonly string[] | undefined
  clear(sessionRef: string): void
}
