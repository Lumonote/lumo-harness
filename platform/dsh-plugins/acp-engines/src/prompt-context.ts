export interface PromptContext { skills?: string[]; files?: string[] }
export interface AgentSkill { name: string; description: string; source?: string; provider?: string; version?: string }
export interface AgentSkills {
  list(cwd: string, signal?: AbortSignal): Promise<{ skills: AgentSkill[]; complete: boolean }>
  load(names: string[], cwd: string, signal?: AbortSignal): Promise<string>
}
export function promptContext(value: PromptContext): PromptContext {
  const { skills, files } = value
  if (skills !== undefined && (!Array.isArray(skills) || skills.length > 4 || skills.some(s => typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(s)) || new Set(skills).size !== skills.length)) throw new Error('每条消息最多选择 4 个有效 Skill')
  if (files !== undefined && (!Array.isArray(files) || files.length > 8 || files.some(f => typeof f !== 'string' || !f || f.length > 4096 || /[\x00-\x1f]/u.test(f)) || new Set(files).size !== files.length)) throw new Error('每条消息最多引用 8 个项目文件')
  return { ...(skills?.length ? { skills } : {}), ...(files?.length ? { files } : {}) }
}
