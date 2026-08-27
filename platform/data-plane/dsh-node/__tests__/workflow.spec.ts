import { describe, expect, it } from 'vitest'
import { workflowEngineOverlay } from '../src/workflow.ts'

describe('dsh-node FlowEngine assembly', () => {
  it('overrides the stock unary engine only on a parent node, routing fan-out to lumo-remote', () => {
    expect(workflowEngineOverlay('agent')).toBe(`- id: workflow-worker-thread
  config:
    provider: lumo-remote
`)
  })

  it('does not alter the carrier-node workflow route', () => {
    expect(workflowEngineOverlay('node')).toBe('')
  })
})
