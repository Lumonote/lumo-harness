import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'

export interface LocalAssetIdentity {
  realm: string
  userId: string
}

export interface LocalSkill {
  id: string
  realm: string
  name: string
  description: string
  kind: 'prompt' | 'workflow'
  visibility: 'private'
  current_version: string
  published_version?: string
  published_digest?: string
  published_by?: string
  published_at?: string
  created_by: string
}

export interface LocalSkillVersion {
  realm: string
  skill_id: string
  version: string
  content: string
  digest: string
  created_by: string
  created_at: string
}

export interface LocalAgentPreset {
  id: string
  realm: string
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
  created_at: string
  updated_at: string
}

interface StoredSkill extends LocalSkill { versions: Record<string, LocalSkillVersion> }
interface LocalAssetState { version: 1; skills: StoredSkill[]; agent_presets: LocalAgentPreset[] }

export class LocalAssetError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'LocalAssetError'
  }
}

const EMPTY_STATE: LocalAssetState = { version: 1, skills: [], agent_presets: [] }
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export class LocalAssetStore {
  private readonly stateFile: string
  private readonly skillRoot: string

  constructor(stateFile: string, skillRoot: string) {
    this.stateFile = resolve(stateFile)
    this.skillRoot = resolve(skillRoot)
  }

  listSkills(identity: LocalAssetIdentity): LocalSkill[] {
    return this.read().skills.filter(item => item.realm === identity.realm).map(stripVersions)
  }

  createSkill(identity: LocalAssetIdentity, input: Record<string, unknown>): LocalSkill {
    const name = requiredString(input, 'name', 120)
    if (!isSkillName(name)) throw new LocalAssetError(400, '技能名称必须使用小写 kebab-case，例如 campaign-review。')
    const version = optionalString(input, 'current_version', 64) || '1.0.0'
    validateVersion(version)
    const kind = optionalString(input, 'kind', 32) || 'prompt'
    if (kind !== 'prompt' && kind !== 'workflow') throw new LocalAssetError(400, '本地技能类型只支持 prompt 或 workflow。')
    const description = optionalString(input, 'description', 500) || '自定义本地技能'
    const content = materializeSkill(name, description, requiredString(input, 'content', 131072))
    const state = this.read()
    if (state.skills.some(item => item.realm === identity.realm && item.id === name)) throw new LocalAssetError(409, '同名技能已经存在。')
    const directory = this.skillDirectory(name)
    if (existsSync(directory)) throw new LocalAssetError(409, '技能目录已存在；请换一个名称。')
    const createdAt = new Date().toISOString()
    const skillVersion: LocalSkillVersion = {
      realm: identity.realm, skill_id: name, version, content, digest: digest(content),
      created_by: identity.userId, created_at: createdAt,
    }
    const skill: StoredSkill = {
      id: name, realm: identity.realm, name, description, kind, visibility: 'private',
      current_version: version, published_version: version, published_digest: skillVersion.digest,
      published_by: identity.userId, published_at: createdAt, created_by: identity.userId,
      versions: { [version]: skillVersion },
    }
    this.writeSkillFile(skill, skillVersion)
    state.skills.push(skill)
    this.write(state)
    return stripVersions(skill)
  }

  getSkillVersion(identity: LocalAssetIdentity, skillID: string, version: string): LocalSkillVersion {
    return this.skill(identity, skillID).versions[version] ?? fail(404, '找不到该技能版本。')
  }

  createSkillVersion(identity: LocalAssetIdentity, skillID: string, input: Record<string, unknown>): LocalSkillVersion {
    const state = this.read()
    const skill = this.skill(identity, skillID, state)
    const version = requiredString(input, 'version', 64)
    validateVersion(version)
    if (skill.versions[version] !== undefined) throw new LocalAssetError(409, '该版本已经存在。')
    const content = materializeSkill(skill.name, skill.description, requiredString(input, 'content', 131072))
    const next: LocalSkillVersion = {
      realm: identity.realm, skill_id: skill.id, version, content, digest: digest(content),
      created_by: identity.userId, created_at: new Date().toISOString(),
    }
    skill.versions[version] = next
    skill.current_version = version
    skill.published_version = version
    skill.published_digest = next.digest
    skill.published_by = identity.userId
    skill.published_at = next.created_at
    this.writeSkillFile(skill, next)
    this.write(state)
    return next
  }

  updateSkill(identity: LocalAssetIdentity, skillID: string, input: Record<string, unknown>): LocalSkill {
    const state = this.read()
    const skill = this.skill(identity, skillID, state)
    const description = optionalString(input, 'description', 500)
    if (description !== '') skill.description = description
    const current = skill.versions[skill.current_version]
    if (current === undefined) throw new LocalAssetError(500, '技能当前版本数据已损坏。')
    const rawContent = optionalString(input, 'content', 131072)
    if (rawContent !== '') {
      current.content = materializeSkill(skill.name, skill.description, rawContent)
      current.digest = digest(current.content)
      current.created_at = new Date().toISOString()
      current.created_by = identity.userId
      skill.published_digest = current.digest
      skill.published_at = current.created_at
      skill.published_by = identity.userId
    }
    this.writeSkillFile(skill, current)
    this.write(state)
    return stripVersions(skill)
  }

  deleteSkill(identity: LocalAssetIdentity, skillID: string): void {
    const state = this.read()
    const index = state.skills.findIndex(item => item.realm === identity.realm && item.id === skillID)
    if (index < 0) throw new LocalAssetError(404, '找不到该技能。')
    const [skill] = state.skills.splice(index, 1)
    if (skill !== undefined) rmSync(this.skillDirectory(skill.name), { recursive: true, force: true })
    this.write(state)
  }

  listAgentPresets(identity: LocalAssetIdentity): LocalAgentPreset[] {
    return this.read().agent_presets.filter(item => item.realm === identity.realm && item.owner_user_id === identity.userId)
  }

  createAgentPreset(identity: LocalAssetIdentity, input: Record<string, unknown>): LocalAgentPreset {
    const now = new Date().toISOString()
    const preset: LocalAgentPreset = {
      id: `agent-${randomUUID()}`, realm: identity.realm,
      ...optionalField(input, 'project_id', 128),
      name: requiredString(input, 'name', 160),
      ...optionalField(input, 'description', 500),
      owner_user_id: identity.userId,
      status: normalizeStatus(input['status']), version: optionalString(input, 'version', 64) || '1.0.0', revision: 1,
      provider: requiredString(input, 'provider', 128), model_ref: requiredString(input, 'model_ref', 256),
      ...optionalField(input, 'system_prompt_ref', 256),
      connector_ids: stringArray(input['connector_ids']), knowledge_space_ids: stringArray(input['knowledge_space_ids']),
      max_concurrency: positiveInteger(input['max_concurrency'], 1, 1000),
      max_budget_cents: nonNegativeInteger(input['max_budget_cents'], 0),
      timeout_seconds: positiveInteger(input['timeout_seconds'], 3600, 86400),
      max_delegation_depth: nonNegativeInteger(input['max_delegation_depth'], 0, 16),
      created_at: now, updated_at: now,
    }
    const state = this.read()
    state.agent_presets.push(preset)
    this.write(state)
    return preset
  }

  updateAgentPreset(identity: LocalAssetIdentity, presetID: string, input: Record<string, unknown>): LocalAgentPreset {
    const state = this.read()
    const preset = state.agent_presets.find(item => item.realm === identity.realm && item.id === presetID && item.owner_user_id === identity.userId)
    if (preset === undefined) throw new LocalAssetError(404, '找不到该专家。')
    const revision = nonNegativeInteger(input['revision'], 0)
    if (revision !== preset.revision) throw new LocalAssetError(409, '专家已被其他操作修改，请刷新后重试。')
    for (const key of ['name', 'description', 'project_id', 'provider', 'model_ref', 'system_prompt_ref'] as const) {
      if (input[key] !== undefined) (preset as unknown as Record<string, unknown>)[key] = optionalString(input, key, key === 'name' ? 160 : key === 'description' ? 500 : 256)
    }
    if (input['status'] !== undefined) preset.status = normalizeStatus(input['status'])
    if (input['max_concurrency'] !== undefined) preset.max_concurrency = positiveInteger(input['max_concurrency'], 1, 1000)
    preset.revision += 1
    preset.updated_at = new Date().toISOString()
    this.write(state)
    return preset
  }

  deleteAgentPreset(identity: LocalAssetIdentity, presetID: string): void {
    const state = this.read()
    const index = state.agent_presets.findIndex(item => item.realm === identity.realm && item.id === presetID && item.owner_user_id === identity.userId)
    if (index < 0) throw new LocalAssetError(404, '找不到该专家。')
    state.agent_presets.splice(index, 1)
    this.write(state)
  }

  private skill(identity: LocalAssetIdentity, skillID: string, state = this.read()): StoredSkill {
    return state.skills.find(item => item.realm === identity.realm && item.id === skillID) ?? fail(404, '找不到该技能。')
  }

  private skillDirectory(name: string): string {
    const target = resolve(this.skillRoot, name)
    if (relative(this.skillRoot, target).startsWith('..')) throw new LocalAssetError(400, '非法技能路径。')
    return target
  }

  private writeSkillFile(skill: StoredSkill, version: LocalSkillVersion): void {
    const directory = this.skillDirectory(skill.name)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'SKILL.md'), version.content, { encoding: 'utf8', mode: 0o600 })
  }

  private read(): LocalAssetState {
    if (!existsSync(this.stateFile)) return structuredClone(EMPTY_STATE)
    try {
      const value = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<LocalAssetState>
      if (value.version !== 1 || !Array.isArray(value.skills) || !Array.isArray(value.agent_presets)) throw new Error('invalid shape')
      return value as LocalAssetState
    } catch (error) {
      throw new LocalAssetError(500, `本地资产文件无法读取：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private write(state: LocalAssetState): void {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.stateFile)
  }
}

function stripVersions(skill: StoredSkill): LocalSkill {
  const { versions: _versions, ...result } = skill
  return result
}

function materializeSkill(name: string, description: string, raw: string): string {
  const trimmed = raw.trim()
  const closing = trimmed.startsWith('---\n') ? trimmed.indexOf('\n---\n', 4) : -1
  const body = closing >= 0 ? trimmed.slice(closing + 5).replace(/^\n/u, '') : trimmed
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function requiredString(input: Record<string, unknown>, key: string, max: number): string {
  const value = optionalString(input, key, max)
  if (value === '') throw new LocalAssetError(400, `${key} 为必填项。`)
  return value
}

function optionalString(input: Record<string, unknown>, key: string, max: number): string {
  const raw = input[key]
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new LocalAssetError(400, `${key} 必须是字符串。`)
  const value = raw.trim()
  if ([...value].length > max) throw new LocalAssetError(400, `${key} 超过长度限制。`)
  return value
}

function optionalField(input: Record<string, unknown>, key: string, max: number): Record<string, string> {
  const value = optionalString(input, key, max)
  return value === '' ? {} : { [key]: value }
}

function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new LocalAssetError(400, '版本号格式无效。')
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new LocalAssetError(400, '资源引用必须是字符串数组。')
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}

function normalizeStatus(value: unknown): 'active' | 'disabled' {
  const status = value === undefined || value === '' ? 'active' : value
  if (status !== 'active' && status !== 'disabled') throw new LocalAssetError(400, '专家状态无效。')
  return status
}

function nonNegativeInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = value === undefined ? fallback : value
  if (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > max) throw new LocalAssetError(400, '数值参数无效。')
  return number as number
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const number = value === undefined || value === 0 ? fallback : value
  if (!Number.isSafeInteger(number) || (number as number) < 1 || (number as number) > max) throw new LocalAssetError(400, '数值参数无效。')
  return number as number
}

function fail(status: number, message: string): never {
  throw new LocalAssetError(status, message)
}
