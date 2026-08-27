import { describe, expect, it } from 'vitest'
import { localSkillSnapshotAssembly } from '../src/skills.ts'
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

  it('mounts a pinned local-skill provider and disables mutable filesystem discovery', () => {
    expect(localSkillSnapshotAssembly('/var/lib/lumo/skills', '[{"name":"repo-audit"}]', '/plugin.ts')).toEqual({
      rows: `    - id: lumo-skill-local
      name: "/plugin.ts"
      inject: [skills]
      config:
        root: "/var/lib/lumo/skills"
        skills: [{"name":"repo-audit"}]
`,
      filesystemOverlay: `- id: skill-filesystem
  disabled: true
`,
    })
  })

  it('rejects malformed local-skill snapshot configuration before boot', () => {
    expect(() => localSkillSnapshotAssembly('/skills', '{}', '/plugin.ts')).toThrow('JSON array')
  })
})
