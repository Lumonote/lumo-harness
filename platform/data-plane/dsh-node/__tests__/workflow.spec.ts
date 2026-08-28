import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localSkillSnapshotAssembly, skillSnapshotSource, waitForSkillSnapshotFile } from '../src/skills.ts'
import { profileLifetimeOverlay, profileStorageRows, workflowEngineOverlay } from '../src/workflow.ts'

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

  it('turns an argument-free headless profile into a persistent plugin host', () => {
    expect(profileLifetimeOverlay('headless', false)).toBe(`- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
`)
    expect(profileLifetimeOverlay('headless', true)).toBe('')
    expect(profileLifetimeOverlay('web', false)).toBe('')
  })

  it('mounts the storage hub only for headless profiles that do not already include it', () => {
    expect(profileStorageRows('headless')).toBe(`    - id: storage
      name: '@deepseek-ai/dsh-storage'
`)
    expect(profileStorageRows('web')).toBe('')
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

  it('loads a provisioned skill snapshot from a file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumo-snapshot-'))
    const path = join(directory, 'skill-snapshot.json')
    try {
      writeFileSync(path, '[{"name":"repo-audit"}]')
      await expect(waitForSkillSnapshotFile(path, 0)).resolves.toBeUndefined()
      expect(skillSnapshotSource(undefined, path)).toBe('[{"name":"repo-audit"}]')
      expect(skillSnapshotSource(undefined, undefined)).toBeUndefined()
      expect(() => skillSnapshotSource('[]', path)).toThrow('cannot both be set')
      await expect(waitForSkillSnapshotFile(join(directory, 'missing.json'), 0)).rejects.toThrow('did not appear')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
