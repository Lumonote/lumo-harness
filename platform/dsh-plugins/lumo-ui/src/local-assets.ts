/**
 * Local asset store for the single-machine desktop deployment.
 *
 * The cluster deployment keeps skills and agent presets in the governance
 * control plane. `local` mode has no control plane, so this store owns them in
 * a JSON file next to the SkillHub installation receipts and materializes each
 * skill as `<skillhubRoot>/lumo-local-<id>/SKILL.md`, where the runtime's
 * filesystem skill provider rediscovers it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { RequestIdentity } from './identity.ts'

/** Governance-visible skill record returned by the local governance catalog. */
export interface LocalGovernedSkill {
  id: string
  realm: string
  name: string
  description?: string
  kind: 'prompt' | 'workflow' | 'tool' | 'connector'
  visibility: string
  current_version: string
  created_by: string
}

/** Content snapshot for one local skill version. */
export interface LocalSkillVersion {
  realm: string
  skill_id: string
  version: string
  content: string
  digest: string
  created_by: string
  created_at: string
}

/** Local agent preset; mirrors the governance fields the desktop UI reads. */
export interface LocalAgentPreset {
  id: string
  project_id?: string
  name: string
  description?: string
  owner_user_id: string
  status: 'active' | 'disabled'
  version: string
  revision: number
  provider: string
  model_ref: string
  system_prompt_ref?: string
  connector_ids: string[]
  knowledge_space_ids: string[]
  max_concurrency: number
  trust_level?: string
  residency?: string
  max_budget_cents: number
  timeout_seconds: number
  max_delegation_depth: number
}

/** Error carrying the HTTP status the API route should answer with. */
export class LocalAssetError extends Error {
  readonly status: number

  /**
   * @param status - HTTP status code for the failed request.
   * @param message - user-facing failure message.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'LocalAssetError'
    this.status = status
  }
}

interface StoredSkill { meta: LocalGovernedSkill; versions: LocalSkillVersion[] }
interface StoredPreset { realm: string; preset: LocalAgentPreset }
interface LocalAssetState { skills: StoredSkill[]; presets: StoredPreset[] }

const SKILL_KINDS = ['prompt', 'workflow', 'tool', 'connector'] as const
type SkillKind = (typeof SKILL_KINDS)[number]

const MAX_NAME_BYTES = 480
const MAX_DESCRIPTION_BYTES = 2000
const MAX_VERSION_BYTES = 256
const MAX_CONTENT_BYTES = 524288
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * Own the local skills and agent presets for one desktop workspace.
 *
 * Every read reparses the JSON file so a second process or a manual edit is
 * observed, and every write replaces the file atomically through a rename.
 */
export class LocalAssetStore {
  private readonly file: string
  private readonly skillsRoot: string

  /**
   * @param file - absolute JSON path holding the local asset state.
   * @param skillsRoot - absolute directory the runtime scans for SKILL.md files.
   */
  constructor(file: string, skillsRoot: string) {
    this.file = file
    this.skillsRoot = skillsRoot
  }

  /** Return every skill visible in the local realm. */
  listSkills(identity: RequestIdentity): LocalGovernedSkill[] {
    return this.readState().skills
      .filter(entry => entry.meta.realm === identity.realm)
      .map(entry => entry.meta)
  }

  /**
   * Create a skill, its first version, and its runtime SKILL.md.
   *
   * @param identity - request identity owning the new skill.
   * @param body - request body with name, kind, content, and optional fields.
   * @returns the created governance record.
   */
  createSkill(identity: RequestIdentity, body: Record<string, unknown>): LocalGovernedSkill {
    const name = requiredString(body, 'name', MAX_NAME_BYTES)
    const kind = body['kind'] === undefined ? 'prompt' : skillKind(body['kind'])
    const content = requiredString(body, 'content', MAX_CONTENT_BYTES)
    const version = optionalString(body, 'current_version', MAX_VERSION_BYTES) ?? '1.0.0'
    const description = optionalString(body, 'description', MAX_DESCRIPTION_BYTES)
    const visibility = optionalString(body, 'visibility', MAX_NAME_BYTES) ?? 'private'
    const state = this.readState()
    if (state.skills.some(entry => entry.meta.realm === identity.realm && entry.meta.name === name)) {
      throw new LocalAssetError(409, `技能「${name}」已存在。`)
    }
    const id = randomUUID()
    const meta: LocalGovernedSkill = {
      id, realm: identity.realm, name, kind, visibility, current_version: version, created_by: identity.userId,
      ...(description === undefined ? {} : { description }),
    }
    const record: LocalSkillVersion = {
      realm: identity.realm, skill_id: id, version, content, digest: digestOf(content),
      created_by: identity.userId, created_at: new Date().toISOString(),
    }
    state.skills.push({ meta, versions: [record] })
    this.writeState(state)
    this.writeSkillDocument(meta, content)
    return meta
  }

  /**
   * Replace the description and current-version content of a skill.
   *
   * @param identity - request identity.
   * @param skillID - skill id from the request path.
   * @param body - request body with optional description and required-in-practice content.
   * @returns the updated governance record.
   */
  updateSkill(identity: RequestIdentity, skillID: string, body: Record<string, unknown>): LocalGovernedSkill {
    const state = this.readState()
    const stored = findStoredSkill(state, identity, skillID)
    if (stored === undefined) throw new LocalAssetError(404, '找不到该技能。')
    if (body['description'] !== undefined) {
      const description = optionalString(body, 'description', MAX_DESCRIPTION_BYTES)
      if (description === undefined) delete stored.meta.description
      else stored.meta.description = description
    }
    const content = optionalString(body, 'content', MAX_CONTENT_BYTES)
    if (content !== undefined) {
      const current = stored.versions.find(entry => entry.version === stored.meta.current_version)
      if (current === undefined) throw new LocalAssetError(409, '当前版本缺失，无法修改。')
      current.content = content
      current.digest = digestOf(content)
      this.writeSkillDocument(stored.meta, content)
    }
    this.writeState(state)
    return stored.meta
  }

  /**
   * Remove a skill, its versions, and its runtime directory.
   *
   * @param identity - request identity.
   * @param skillID - skill id from the request path.
   */
  deleteSkill(identity: RequestIdentity, skillID: string): void {
    const state = this.readState()
    const index = state.skills.findIndex(entry => entry.meta.realm === identity.realm && entry.meta.id === skillID)
    if (index < 0) throw new LocalAssetError(404, '找不到该技能。')
    state.skills.splice(index, 1)
    this.writeState(state)
    rmSync(this.skillDirectory(skillID), { recursive: true, force: true })
  }

  /**
   * Read one stored skill version.
   *
   * @param identity - request identity.
   * @param skillID - skill id from the request path.
   * @param version - version label from the request path.
   * @returns the stored version content.
   */
  getSkillVersion(identity: RequestIdentity, skillID: string, version: string): LocalSkillVersion {
    const stored = findStoredSkill(this.readState(), identity, skillID)
    if (stored === undefined) throw new LocalAssetError(404, '找不到该技能。')
    const record = stored.versions.find(entry => entry.version === version)
    if (record === undefined) throw new LocalAssetError(404, `找不到技能版本「${version}」。`)
    return record
  }

  /**
   * Append a new skill version and materialize it as the current runtime source.
   *
   * @param identity - request identity.
   * @param skillID - skill id from the request path.
   * @param body - request body with version and content.
   * @returns the created version record.
   */
  createSkillVersion(identity: RequestIdentity, skillID: string, body: Record<string, unknown>): LocalSkillVersion {
    const version = requiredString(body, 'version', MAX_VERSION_BYTES)
    const content = requiredString(body, 'content', MAX_CONTENT_BYTES)
    const state = this.readState()
    const stored = findStoredSkill(state, identity, skillID)
    if (stored === undefined) throw new LocalAssetError(404, '找不到该技能。')
    if (stored.versions.some(entry => entry.version === version)) {
      throw new LocalAssetError(409, `版本「${version}」已存在。`)
    }
    const record: LocalSkillVersion = {
      realm: identity.realm, skill_id: skillID, version, content, digest: digestOf(content),
      created_by: identity.userId, created_at: new Date().toISOString(),
    }
    stored.versions.push(record)
    stored.meta.current_version = version
    this.writeState(state)
    this.writeSkillDocument(stored.meta, content)
    return record
  }

  /** Return the agent presets the identity may manage. */
  listAgentPresets(identity: RequestIdentity): LocalAgentPreset[] {
    return this.readState().presets
      .filter(entry => entry.realm === identity.realm && canManagePreset(identity, entry.preset))
      .map(entry => entry.preset)
  }

  /**
   * Create an agent preset for the local realm.
   *
   * @param identity - request identity owning the new preset.
   * @param body - request body with name, provider, and model_ref.
   * @returns the created preset.
   */
  createAgentPreset(identity: RequestIdentity, body: Record<string, unknown>): LocalAgentPreset {
    const name = requiredString(body, 'name', MAX_NAME_BYTES)
    const provider = requiredString(body, 'provider', MAX_NAME_BYTES)
    const modelRef = requiredString(body, 'model_ref', MAX_VERSION_BYTES)
    const description = optionalString(body, 'description', MAX_DESCRIPTION_BYTES)
    const projectID = optionalString(body, 'project_id', MAX_NAME_BYTES)
    const systemPromptRef = optionalString(body, 'system_prompt_ref', MAX_VERSION_BYTES)
    const trustLevel = optionalString(body, 'trust_level', MAX_NAME_BYTES)
    const residency = optionalString(body, 'residency', MAX_NAME_BYTES)
    const version = optionalString(body, 'version', MAX_VERSION_BYTES) ?? '1'
    const ownerOverride = optionalString(body, 'owner_user_id', MAX_NAME_BYTES)
    const status = body['status'] === undefined ? 'active' : presetStatus(body['status'])
    const preset: LocalAgentPreset = {
      id: randomUUID(),
      name,
      owner_user_id: ownerOverride !== undefined && isAdmin(identity) ? ownerOverride : identity.userId,
      status,
      version,
      revision: 1,
      provider,
      model_ref: modelRef,
      connector_ids: stringArray(body, 'connector_ids'),
      knowledge_space_ids: stringArray(body, 'knowledge_space_ids'),
      max_concurrency: numberField(body, 'max_concurrency', 1, 1, 1_000_000),
      max_budget_cents: numberField(body, 'max_budget_cents', 0, 0, Number.MAX_SAFE_INTEGER),
      timeout_seconds: numberField(body, 'timeout_seconds', 3600, 1, 86400),
      max_delegation_depth: numberField(body, 'max_delegation_depth', 0, 0, 16),
      ...(description === undefined ? {} : { description }),
      ...(projectID === undefined ? {} : { project_id: projectID }),
      ...(systemPromptRef === undefined ? {} : { system_prompt_ref: systemPromptRef }),
      ...(trustLevel === undefined ? {} : { trust_level: trustLevel }),
      ...(residency === undefined ? {} : { residency }),
    }
    const state = this.readState()
    state.presets.push({ realm: identity.realm, preset })
    this.writeState(state)
    return preset
  }

  /**
   * Apply the fields present in the request body and bump the revision.
   *
   * @param identity - request identity.
   * @param presetID - preset id from the request path.
   * @param body - request body; a numeric revision must match the stored one.
   * @returns the updated preset.
   */
  updateAgentPreset(identity: RequestIdentity, presetID: string, body: Record<string, unknown>): LocalAgentPreset {
    const state = this.readState()
    const entry = state.presets.find(item => item.realm === identity.realm && item.preset.id === presetID)
    if (entry === undefined) throw new LocalAssetError(404, '找不到该专家。')
    if (!canManagePreset(identity, entry.preset)) throw new LocalAssetError(403, '无权修改该专家。')
    const revision = body['revision']
    if (typeof revision === 'number' && revision !== entry.preset.revision) {
      throw new LocalAssetError(409, '配置已被其他操作更新，请重新读取。')
    }
    const preset = entry.preset
    if (body['name'] !== undefined) preset.name = requiredString(body, 'name', MAX_NAME_BYTES)
    if (body['provider'] !== undefined) preset.provider = requiredString(body, 'provider', MAX_NAME_BYTES)
    if (body['model_ref'] !== undefined) preset.model_ref = requiredString(body, 'model_ref', MAX_VERSION_BYTES)
    if (body['status'] !== undefined) preset.status = presetStatus(body['status'])
    if (body['version'] !== undefined) preset.version = requiredString(body, 'version', MAX_VERSION_BYTES)
    if (body['max_concurrency'] !== undefined) preset.max_concurrency = numberField(body, 'max_concurrency', preset.max_concurrency, 1, 1_000_000)
    if (body['max_budget_cents'] !== undefined) preset.max_budget_cents = numberField(body, 'max_budget_cents', preset.max_budget_cents, 0, Number.MAX_SAFE_INTEGER)
    if (body['timeout_seconds'] !== undefined) preset.timeout_seconds = numberField(body, 'timeout_seconds', preset.timeout_seconds, 1, 86400)
    if (body['max_delegation_depth'] !== undefined) preset.max_delegation_depth = numberField(body, 'max_delegation_depth', preset.max_delegation_depth, 0, 16)
    if (body['connector_ids'] !== undefined) preset.connector_ids = stringArray(body, 'connector_ids')
    if (body['knowledge_space_ids'] !== undefined) preset.knowledge_space_ids = stringArray(body, 'knowledge_space_ids')
    if (body['description'] !== undefined) {
      const description = optionalString(body, 'description', MAX_DESCRIPTION_BYTES)
      if (description === undefined) delete preset.description
      else preset.description = description
    }
    if (body['project_id'] !== undefined) {
      const projectID = optionalString(body, 'project_id', MAX_NAME_BYTES)
      if (projectID === undefined) delete preset.project_id
      else preset.project_id = projectID
    }
    if (body['system_prompt_ref'] !== undefined) {
      const systemPromptRef = optionalString(body, 'system_prompt_ref', MAX_VERSION_BYTES)
      if (systemPromptRef === undefined) delete preset.system_prompt_ref
      else preset.system_prompt_ref = systemPromptRef
    }
    if (body['trust_level'] !== undefined) {
      const trustLevel = optionalString(body, 'trust_level', MAX_NAME_BYTES)
      if (trustLevel === undefined) delete preset.trust_level
      else preset.trust_level = trustLevel
    }
    if (body['residency'] !== undefined) {
      const residency = optionalString(body, 'residency', MAX_NAME_BYTES)
      if (residency === undefined) delete preset.residency
      else preset.residency = residency
    }
    if (body['owner_user_id'] !== undefined && isAdmin(identity)) {
      const owner = optionalString(body, 'owner_user_id', MAX_NAME_BYTES)
      if (owner !== undefined) preset.owner_user_id = owner
    }
    preset.revision += 1
    this.writeState(state)
    return preset
  }

  /**
   * Remove an agent preset.
   *
   * @param identity - request identity.
   * @param presetID - preset id from the request path.
   */
  deleteAgentPreset(identity: RequestIdentity, presetID: string): void {
    const state = this.readState()
    const index = state.presets.findIndex(item => item.realm === identity.realm && item.preset.id === presetID)
    if (index < 0) throw new LocalAssetError(404, '找不到该专家。')
    if (!canManagePreset(identity, state.presets[index]!.preset)) throw new LocalAssetError(403, '无权删除该专家。')
    state.presets.splice(index, 1)
    this.writeState(state)
  }

  private skillDirectory(id: string): string {
    return join(this.skillsRoot, `lumo-local-${id}`)
  }

  private writeSkillDocument(meta: LocalGovernedSkill, content: string): void {
    const file = join(this.skillDirectory(meta.id), 'SKILL.md')
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${randomUUID()}`
    writeFileSync(temporary, materializeSkillDocument(meta, content), { mode: 0o600 })
    renameSync(temporary, file)
  }

  private readState(): LocalAssetState {
    if (!existsSync(this.file)) return { skills: [], presets: [] }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const record = asRecord(parsed)
      if (record === undefined) return { skills: [], presets: [] }
      return {
        skills: arrayOf(record['skills']).map(normalizeSkill).filter((entry): entry is StoredSkill => entry !== undefined),
        presets: arrayOf(record['presets']).map(normalizePreset).filter((entry): entry is StoredPreset => entry !== undefined),
      }
    } catch {
      // A corrupt or unreadable store degrades to empty rather than breaking
      // every governance request; the next successful write repairs the file.
      return { skills: [], presets: [] }
    }
  }

  private writeState(state: LocalAssetState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${randomUUID()}`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}

function findStoredSkill(state: LocalAssetState, identity: RequestIdentity, skillID: string): StoredSkill | undefined {
  return state.skills.find(entry => entry.meta.realm === identity.realm && entry.meta.id === skillID)
}

function canManagePreset(identity: RequestIdentity, preset: LocalAgentPreset): boolean {
  return isAdmin(identity) || preset.owner_user_id === identity.userId
}

function isAdmin(identity: RequestIdentity): boolean {
  return identity.roles.some(role => role === 'platform_admin' || role === 'realm_admin' || role === 'admin')
}

function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Return content that the runtime's filesystem provider can load. Content with
 * a valid frontmatter name is written as-is; anything else gets a generated
 * kebab-case frontmatter so the saved body still becomes a discoverable skill.
 */
function materializeSkillDocument(meta: LocalGovernedSkill, content: string): string {
  const body = content.trim()
  if (hasUsableFrontmatter(body)) return `${body}\n`
  const description = (meta.description ?? meta.name).replace(/\s+/gu, ' ').trim().slice(0, 500)
  return [
    '---',
    `name: local-${meta.id.toLowerCase()}`,
    `description: ${JSON.stringify(description)}`,
    'user-invocable: true',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function hasUsableFrontmatter(content: string): boolean {
  const match = FRONTMATTER.exec(content)
  if (match === null) return false
  const block = match[1]
  if (block === undefined) return false
  const name = /^name:[ \t]*(.+)$/mu.exec(block)
  if (name === null) return false
  const raw = (name[1] ?? '').trim().replace(/^["']|["']$/gu, '')
  return isSkillName(raw)
}

function requiredString(body: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new LocalAssetError(400, `${key} 必须是长度不超过 ${maxBytes} 字节的非空字符串。`)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string, maxBytes: number): string | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new LocalAssetError(400, `${key} 无效。`)
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function numberField(body: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = body[key]
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new LocalAssetError(400, `${key} 必须是 ${min} 到 ${max} 之间的整数。`)
  }
  return parsed
}

function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new LocalAssetError(400, `${key} 必须是字符串数组。`)
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item !== ''))]
}

function skillKind(value: unknown): SkillKind {
  if (typeof value === 'string' && (SKILL_KINDS as readonly string[]).includes(value)) return value as SkillKind
  throw new LocalAssetError(400, '技能类型无效。')
}

function normalizedKind(value: unknown): SkillKind {
  return typeof value === 'string' && (SKILL_KINDS as readonly string[]).includes(value) ? value as SkillKind : 'prompt'
}

function presetStatus(value: unknown): 'active' | 'disabled' {
  return value === 'disabled' ? 'disabled' : 'active'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeSkill(value: unknown): StoredSkill | undefined {
  const record = asRecord(value)
  const meta = record === undefined ? undefined : asRecord(record['meta'])
  if (record === undefined || meta === undefined) return undefined
  const id = asString(meta['id'])
  const realm = asString(meta['realm'])
  const name = asString(meta['name'])
  const currentVersion = asString(meta['current_version'])
  const createdBy = asString(meta['created_by'])
  if (id === undefined || realm === undefined || name === undefined || currentVersion === undefined || createdBy === undefined) return undefined
  const description = asString(meta['description'])
  const versions = arrayOf(record['versions'])
    .map(normalizeVersion)
    .filter((entry): entry is LocalSkillVersion => entry !== undefined)
  return {
    meta: {
      id, realm, name, kind: normalizedKind(meta['kind']), visibility: asString(meta['visibility']) ?? 'private',
      current_version: currentVersion, created_by: createdBy,
      ...(description === undefined ? {} : { description }),
    },
    versions,
  }
}

function normalizeVersion(value: unknown): LocalSkillVersion | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const realm = asString(record['realm'])
  const skillID = asString(record['skill_id'])
  const version = asString(record['version'])
  const content = typeof record['content'] === 'string' ? record['content'] : undefined
  const digest = asString(record['digest'])
  const createdBy = asString(record['created_by'])
  const createdAt = asString(record['created_at'])
  if (realm === undefined || skillID === undefined || version === undefined || content === undefined
    || digest === undefined || createdBy === undefined || createdAt === undefined) return undefined
  return { realm, skill_id: skillID, version, content, digest, created_by: createdBy, created_at: createdAt }
}

function normalizePreset(value: unknown): StoredPreset | undefined {
  const record = asRecord(value)
  const presetRecord = record === undefined ? undefined : asRecord(record['preset'])
  if (record === undefined || presetRecord === undefined) return undefined
  const realm = asString(record['realm'])
  const id = asString(presetRecord['id'])
  const name = asString(presetRecord['name'])
  const owner = asString(presetRecord['owner_user_id'])
  const provider = asString(presetRecord['provider'])
  const modelRef = asString(presetRecord['model_ref'])
  if (realm === undefined || id === undefined || name === undefined || owner === undefined
    || provider === undefined || modelRef === undefined) return undefined
  const description = asString(presetRecord['description'])
  const projectID = asString(presetRecord['project_id'])
  const systemPromptRef = asString(presetRecord['system_prompt_ref'])
  const trustLevel = asString(presetRecord['trust_level'])
  const residency = asString(presetRecord['residency'])
  return {
    realm,
    preset: {
      id, name, owner_user_id: owner, status: presetStatus(presetRecord['status']),
      version: asString(presetRecord['version']) ?? '1',
      revision: numberOr(presetRecord['revision'], 1),
      provider, model_ref: modelRef,
      connector_ids: arrayOf(presetRecord['connector_ids']).filter((item): item is string => typeof item === 'string'),
      knowledge_space_ids: arrayOf(presetRecord['knowledge_space_ids']).filter((item): item is string => typeof item === 'string'),
      max_concurrency: numberOr(presetRecord['max_concurrency'], 1),
      max_budget_cents: numberOr(presetRecord['max_budget_cents'], 0),
      timeout_seconds: numberOr(presetRecord['timeout_seconds'], 3600),
      max_delegation_depth: numberOr(presetRecord['max_delegation_depth'], 0),
      ...(description === undefined ? {} : { description }),
      ...(projectID === undefined ? {} : { project_id: projectID }),
      ...(systemPromptRef === undefined ? {} : { system_prompt_ref: systemPromptRef }),
      ...(trustLevel === undefined ? {} : { trust_level: trustLevel }),
      ...(residency === undefined ? {} : { residency }),
    },
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}
