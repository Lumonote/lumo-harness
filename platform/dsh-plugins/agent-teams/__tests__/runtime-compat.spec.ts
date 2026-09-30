import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { MockAdapter, textResponse } from '../../../../deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import SubagentService from '../../../../deepseek-harness/packages/subagent/subagent/lib/index.js'
import TeamService from '../../../../deepseek-harness/packages/experimental/agent-team/lib/index.js'
import * as nativeTeamTools from '../../../../deepseek-harness/packages/experimental/tool-agent-team/lib/index.js'
import JsonlSessionPersistence from '../../../../deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../deepseek-harness/packages/session-query/session-query/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import * as lumoTeams from '../src/index.ts'
import type { AgentTeamsService } from '../src/service.ts'

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is outside this regression'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is outside this regression'))
  }
}

describe('平台团队与原生会话兼容', () => {
  it.each(['lumo-first', 'native-first'] as const)('%s：完成对话后可连续新建会话', async order => {
    const ctx = new Context()
    const root = mkdtempSync(join(tmpdir(), 'lumo-team-compat-'))
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root })
      await ctx.plugin(TestSessionQuery)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentService)
      if (order === 'lumo-first') await ctx.plugin(lumoTeams)
      await ctx.plugin(TeamService)
      await ctx.plugin(nativeTeamTools)
      if (order === 'native-first') await ctx.plugin(lumoTeams)

      const native = ctx.agentTeams
      const platform = ctx.get('lumoAgentTeams') as AgentTeamsService
      expect(native instanceof TeamService).toBe(true)
      expect(platform === native).toBe(false)
      await expect(platform.list()).resolves.toEqual([])

      const adapter = new MockAdapter([textResponse('first reply'), textResponse('second reply')])
      ctx.llm.registerAdapter(['mock'], adapter)
      for (const id of ['first', 'second']) {
        // agentLoop.create publishes agent/created, where the native tool
        // plugin calls agentTeams.tryMembership. The collision used to throw
        // before the new session could finish creating.
        const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
        expect(native.tryMembership(agent)?.role).toBe('lead')
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      expect(adapter.requests).toHaveLength(2)
      await expect(ctx.agentLoop.create(SessionId('third'), { provider: 'mock', model: 'mock' })).resolves.toBeDefined()
      expect(ctx.agentTeams instanceof TeamService).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
