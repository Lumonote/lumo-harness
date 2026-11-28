import { describe, expect, it, vi } from 'vitest'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { acpSkills } from '../src/acp-skills.ts'

describe('ACP public Skill registry bridge', () => {
  it('lists user-invocable skills in the actual project and loads the native rendered body and resource base', async () => {
    const skill = { name: 'review', description: 'Review', content: 'Check the implementation.', provider: 'project', source: 'project-agents', invocation: { userInvocable: true, modelInvocable: false }, resourceBase: { kind: 'directory' as const, path: '/project/.agents/skills/review' } }
    const get = vi.fn(async () => skill), snapshot = vi.fn(async () => ({ complete: true, skills: [skill, { ...skill, name: 'private', invocation: { userInvocable: false, modelInvocable: true } }] }))
    const bridge = acpSkills(() => ({ get, snapshot }) as unknown as SkillRegistry), signal = new AbortController().signal
    expect(await bridge.list('/project', signal)).toEqual({ complete: true, skills: [{ name: 'review', description: 'Review', source: 'project-agents', provider: 'project' }] })
    const body = await bridge.load(['review'], '/project', signal)
    expect(snapshot).toHaveBeenCalledWith({ cwd: '/project', signal }); expect(get).toHaveBeenCalledWith('review', { cwd: '/project', signal })
    expect(body).toContain('<skill_content name="review">'); expect(body).toContain('Check the implementation.'); expect(body).toContain('/project/.agents/skills/review')
  })
  it('rejects missing, non-invocable and oversized skills rather than sending an empty marker', async () => {
    const get = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ invocation: { userInvocable: false } }).mockResolvedValueOnce({ name: 'large', provider: 'test', content: 'x'.repeat(200_001), invocation: { userInvocable: true } })
    const bridge = acpSkills(() => ({ get }) as unknown as SkillRegistry)
    await expect(bridge.load(['missing'], '/p')).rejects.toThrow('不存在')
    await expect(bridge.load(['private'], '/p')).rejects.toThrow('不允许')
    await expect(bridge.load(['large'], '/p')).rejects.toThrow('过大')
    await expect(acpSkills(() => undefined).list('/p')).rejects.toThrow('尚未就绪')
  })
})
