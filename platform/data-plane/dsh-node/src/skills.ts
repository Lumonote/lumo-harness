import { readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'

export async function waitForSkillSnapshotFile(snapshotFile: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await access(snapshotFile)
      return
    } catch (error: unknown) {
      if (Date.now() >= deadline) {
        throw new TypeError(`LUMO_SKILL_SNAPSHOT_FILE did not appear within ${timeoutMs}ms: ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

export function skillSnapshotSource(rawSnapshot: string | undefined, snapshotFile: string | undefined): string | undefined {
  if (rawSnapshot !== undefined && snapshotFile !== undefined) {
    throw new TypeError('LUMO_SKILL_SNAPSHOT and LUMO_SKILL_SNAPSHOT_FILE cannot both be set')
  }
  if (snapshotFile === undefined) return rawSnapshot
  if (snapshotFile.length === 0) throw new TypeError('LUMO_SKILL_SNAPSHOT_FILE must not be empty')
  try {
    return readFileSync(snapshotFile, 'utf8')
  } catch (error: unknown) {
    throw new TypeError(`LUMO_SKILL_SNAPSHOT_FILE cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Render the opt-in, immutable local-skill snapshot patch for dsh-node. */
export function localSkillSnapshotAssembly(root: string | undefined, rawSnapshot: string | undefined, entry: string): {
  rows: string
  filesystemOverlay: string
} {
  if (root === undefined) return { rows: '', filesystemOverlay: '' }
  if (root.length === 0) throw new TypeError('LUMO_SKILL_SNAPSHOT_ROOT must not be empty')
  let entries: unknown
  try {
    entries = JSON.parse(rawSnapshot ?? '[]')
  } catch (error: unknown) {
    throw new TypeError(`LUMO_SKILL_SNAPSHOT must be JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(entries)) throw new TypeError('LUMO_SKILL_SNAPSHOT must be a JSON array')
  return {
    rows: `    - id: lumo-skill-local
      name: ${JSON.stringify(entry)}
      inject: [skills]
      config:
        root: ${JSON.stringify(root)}
        skills: ${JSON.stringify(entries)}
`,
    // A mixed catalog would let mutable project/user roots shadow the pin.
    filesystemOverlay: `- id: skill-filesystem
  disabled: true
`,
  }
}
