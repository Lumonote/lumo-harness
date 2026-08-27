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
