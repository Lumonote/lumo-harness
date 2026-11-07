import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import { SessionId } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import Metering from '../src/index.ts'
import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import type { SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'

const base = process.env.METERING_TEST_DSN
it.skipIf(!base)('refuses missing, disabled and foreign routes before the real provider stream and settles the admitted quote to its trusted owner', async () => {
  const dsn = await schemaDsn(base!, 'model_billing_stream_test'), meter = new PgMeteringSeam(dsn), ctx = new Context()
  try {
    await meter.init()
    await meter.raw(`DROP TABLE IF EXISTS llm_providers; TRUNCATE usage_ledger,usage_event_outbox,budget_trees;
      CREATE TABLE llm_providers(model TEXT PRIMARY KEY,price_in_per_mtok NUMERIC NOT NULL,price_out_per_mtok NUMERIC NOT NULL,enabled BOOLEAN NOT NULL);
      INSERT INTO llm_providers VALUES('priced',3,15,false)`)
    await mountAgentLoopTestDependencies(ctx)
    let providerCalls = 0
    ctx.llm.registerAdapter(['approved', 'foreign'], new (class extends LlmAdapter {
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        providerCalls++
        // Change the live registry after admission: settlement must retain the
        // quote that authorized this exact request.
        await meter.raw(`UPDATE llm_providers SET price_in_per_mtok=999 WHERE model='priced'`)
        yield { type: 'text-delta', index: 0, text: 'accounted' }
        yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })())
    // Seed the same trusted owner/project that the session binding below uses.
    // The provider admission must be tested independently from a missing budget;
    // missing/disabled/foreign routes are rejected before reserve, while the
    // admitted route needs a real budget row to reach the provider and settle.
    await ctx.plugin(Metering, { connectionString: dsn, userId: 'carrier', deptId: 'd', role: 'viewer', projectId: 'carrier-project', agentId: 'a', componentId: 'c', feature: 'session:text', defaultBudget: 1000000, ledgerTransport: 'rmq' })
    const scope = ctx.get('meteringScope') as SessionMeterScope
    const binding = (session: string, billingModel: string) => scope.bind(session, { context: { userId: 'alice', projectId: 'project-a', agentId: 'owned', componentId: 'user-auth', feature: 'session:text' }, traceId: `session:${session}`, modelRoutes: [{ provider: 'approved', model: 'native-model', billingModel }] })
    binding('session-missing', 'absent'); binding('session-disabled', 'priced'); binding('session-priced', 'priced')
    const stream = async (session: string, provider = 'approved') => { for await (const _chunk of ctx.llm.stream({ provider, model: 'native-model', messages: [], sessionId: SessionId(session) })) {} }
    await expect(stream('session-missing')).rejects.toThrow()
    await expect(stream('session-disabled')).rejects.toThrow()
    await expect(stream('session-priced', 'foreign')).rejects.toThrow()
    expect(providerCalls).toBe(0)
    await meter.raw(`UPDATE llm_providers SET enabled=true,price_in_per_mtok=3 WHERE model='priced'`)
    // A verified route is still denied before any provider call when the
    // trusted owner/project budget has not been provisioned. This prevents a
    // missing budget from becoming an implicit free route.
    await expect(stream('session-priced')).rejects.toThrow(/预算拒绝|budget/i)
    expect(providerCalls).toBe(0)
    await meter.raw(`INSERT INTO budget_trees(kind,id,budget) VALUES ('user','alice',1000000),('project','project-a',1000000)`)
    await stream('session-priced')
    expect(providerCalls).toBe(1)
    await meter.drainOnce()
    const rows = await meter.raw<{ user_id: string; project_id: string; cost_usd: string }>('SELECT user_id,project_id,cost_usd FROM usage_ledger')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: 'alice', project_id: 'project-a' })
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0045)
  } finally { await ctx.fiber.dispose(); await meter.close() }
})
