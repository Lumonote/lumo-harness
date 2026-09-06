import type { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillCandidate, SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { setTimeout as delay } from 'node:timers/promises'

export interface InstalledSkill {
  name: string
  path: string
  userInvocable: boolean
}

export interface SkillHubRuntime {
  refresh(): Promise<InstalledSkill[]>
}

/** A desktop-owned root, visible to existing sessions and rediscovered after restart. */
export function registerSkillHubRuntime(ctx: Context, root: string): SkillHubRuntime {
  let provider!: FileSystemSkillProvider
  let invalidate = () => {}
  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    provider = new FileSystemSkillProvider(ctx, control, {
      providerName: 'lumo-skillhub',
      includeDefaultRoots: false,
      customSkillDirs: [root],
    })
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'lumo-skillhub: filesystem provider')
  return {
    async refresh() {
      // Invalidate synchronously: the next prompt must see the installation,
      // even when Chokidar has not delivered its debounced notification yet.
      invalidate()
      // An incomplete observation means the watcher has not finished a first
      // ingest: its cached candidate list would miss a just-installed skill and
      // the installer would mis-report it as unloadable. Poll to convergence.
      let observation = await provider.list({})
      for (let attempt = 0; !Array.isArray(observation) && !observation.complete && attempt < 8; attempt += 1) {
        await delay(250)
        observation = await provider.list({})
      }
      const candidates: readonly SkillCandidate[] = Array.isArray(observation) ? observation : (observation as SkillProviderObservation).candidates
      const loaded: InstalledSkill[] = []
      for (const candidate of candidates) {
        const skill = await provider.get(candidate, {})
        if (skill?.path !== undefined) loaded.push({
          name: skill.name, path: skill.path, userInvocable: skill.invocation.userInvocable,
        })
      }
      return loaded
    },
  }
}
