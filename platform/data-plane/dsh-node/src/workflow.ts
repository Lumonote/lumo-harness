/**
 * The stock dsh profile mounts one worker-thread workflow engine whose default
 * child route is `spawn`. A parent (agent-role) Lumo node must override that
 * existing row instead of inserting a second engine: `workflowEngine` is a
 * unary service and duplicate engines would make route selection timing-based.
 */
export function workflowEngineOverlay(role: 'node' | 'agent'): string {
  if (role !== 'agent') return ''
  return `- id: workflow-worker-thread
  config:
    provider: lumo-remote
`
}
