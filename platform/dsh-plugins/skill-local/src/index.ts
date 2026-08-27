/**
 * Immutable local skill snapshot provider.
 *
 * A distributed registry may decide *which* skill revision belongs on a node,
 * but an Agent must only read the already-materialized local bytes.  This
 * plugin verifies that materialization at boot, then registers the verified
 * bodies in `ctx.skills`; it never fetches or reloads remote content at
 * invocation time.  Reconcile/download belongs to the future Provisioner.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

export interface SkillSnapshotEntry {
  /** Directory name and frontmatter `name`; kebab case only. */
  name: string
  /** SHA-256 of the exact UTF-8 SKILL.md bytes (`sha256:<hex>`). */
  sha256: string
  /** Catalog text is part of the pinned manifest, not parsed from mutable disk metadata. */
  description: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
}

export interface Config {
  /** Absolute, Provisioner-owned directory containing `<skill>/SKILL.md`. */
  root: string
  /** Complete allow-list for this snapshot. An unlisted root entry is a boot failure. */
  skills: SkillSnapshotEntry[]
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  skills: z.array(z.object({
    name: z.string().required(),
    sha256: z.string().required(),
    description: z.string().required(),
    whenToUse: z.string(),
    modelInvocable: z.boolean(),
    userInvocable: z.boolean(),
  })).required(),
})

/** The registry must exist before this provider can publish its local snapshot. */
export const inject = ['skills']

interface LoadedSkill extends SkillSnapshotEntry {
  readonly directory: string
  readonly content: string
}

const SHA256 = /^sha256:[0-9a-f]{64}$/

/** Verify and load one complete local snapshot before making any skill visible. */
export async function loadLocalSkillSnapshot(config: Config): Promise<readonly LoadedSkill[]> {
  if (!isAbsolute(config.root)) throw new Error('skill-local: root must be an absolute local path')
  const root = resolve(config.root)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`skill-local: root is not a real directory: ${root}`)
  }

  const expected = new Map<string, SkillSnapshotEntry>()
  for (const entry of config.skills) {
    if (!isSkillName(entry.name)) throw new Error(`skill-local: invalid skill name ${JSON.stringify(entry.name)}`)
    if (!SHA256.test(entry.sha256)) throw new Error(`skill-local: invalid sha256 for ${entry.name}`)
    if (entry.description.length === 0) throw new Error(`skill-local: description is required for ${entry.name}`)
    if (expected.has(entry.name)) throw new Error(`skill-local: duplicate manifest entry ${entry.name}`)
    expected.set(entry.name, entry)
  }

  // No unpinned sibling can silently become model-visible through this root.
  const names = await readdir(root)
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!expected.has(name)) throw new Error(`skill-local: unpinned entry in snapshot root: ${name}`)
  }

  const loaded: LoadedSkill[] = []
  for (const [name, entry] of expected) {
    const directory = resolve(root, name)
    if (relative(root, directory).startsWith('..')) throw new Error(`skill-local: skill escapes root: ${name}`)
    const dirInfo = await lstat(directory)
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error(`skill-local: ${name} is not a real directory`)
    const skillFile = join(directory, 'SKILL.md')
    const fileInfo = await lstat(skillFile)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`skill-local: ${name}/SKILL.md is not a real file`)
    const bytes = await readFile(skillFile)
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (digest !== entry.sha256) throw new Error(`skill-local: digest mismatch for ${name}`)
    const text = bytes.toString('utf8')
    const parsed = parseSkillMarkdown(text, name)
    loaded.push({ ...entry, directory, content: parsed })
  }
  return loaded
}

/** Strip and verify the minimal SKILL.md frontmatter that dsh's local provider also expects. */
function parseSkillMarkdown(markdown: string, expectedName: string): string {
  if (!markdown.startsWith('---\n')) throw new Error(`skill-local: ${expectedName}/SKILL.md lacks frontmatter`)
  const closing = markdown.indexOf('\n---\n', 4)
  if (closing === -1) throw new Error(`skill-local: ${expectedName}/SKILL.md has unterminated frontmatter`)
  const header = markdown.slice(4, closing)
  const name = header.match(/^name:\s*([^\n]+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (name !== expectedName) throw new Error(`skill-local: frontmatter name does not match directory for ${expectedName}`)
  return markdown.slice(closing + '\n---\n'.length).replace(/^\n/, '')
}

/** Publish verified bytes as immutable runtime registrations. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const loaded = await loadLocalSkillSnapshot(config)
  // `ctx.get()` keeps programmatic mounting usable too: Cordis only applies
  // module-level `inject` metadata through the Loader, while focused tests and
  // embedders may call `ctx.plugin(apply, config)` directly.
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('skill-local: ctx.skills is unavailable')
  for (const skill of loaded) {
    skills.register({
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
      source: 'custom',
      provider: 'lumo-local-snapshot',
      resourceBase: { kind: 'directory', path: skill.directory },
      path: join(skill.directory, 'SKILL.md'),
      content: skill.content,
      invocation: {
        modelInvocable: skill.modelInvocable ?? true,
        userInvocable: skill.userInvocable ?? true,
      },
    })
  }
}

export default apply
