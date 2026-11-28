import { renderSkillContent, type SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { AgentSkills } from '../../acp-engines/src/prompt-context.ts'

/** Public host registry resolves installed and project skills; clients supply names only. */
export function acpSkills(registry: () => Pick<SkillRegistry, 'get' | 'snapshot'> | undefined): AgentSkills {
  return {
    async list(cwd, signal) {
      const source = registry()
      if (!source) throw new Error('Skill 目录尚未就绪')
      const snapshot = await source.snapshot({ cwd, signal })
      return { complete: snapshot.complete, skills: snapshot.skills.filter(s => s.invocation.userInvocable).map(({ name, description, source, provider }) => ({ name, description, source, provider })) }
    },
    async load(names, cwd, signal) {
      const source = registry()
      if (!source) throw new Error('Skill 服务尚未就绪')
      const rendered: string[] = []
      for (const name of names) {
        const skill = await source.get(name, { cwd, signal })
        if (!skill?.invocation.userInvocable) throw new Error(`Skill 不存在或不允许用户调用：${name}`)
        rendered.push(renderSkillContent(skill))
      }
      const text = rendered.join('\n\n')
      if (text.length > 200_000) throw new Error('所选 Skill 内容过大，请减少选择')
      return text
    },
  }
}

/** Human-safe projection of the DSH SkillRegistry; bodies and paths stay host-side. */
export interface SkillRegistryService {
  snapshot(): Promise<{
    complete: boolean
    skills: Array<{
      name: string; description: string; whenToUse?: string
      invocation: { modelInvocable: boolean; userInvocable: boolean }
      source: string; provider: string
      /** 目录型 resourceBase 才有原生示例可扫；路径只在宿主侧使用，永不下发。 */
      resourceBase?: { kind: 'directory'; path: string } | { kind: 'url'; url: string } | { kind: 'opaque'; description: string }
    }>
  }>
}
