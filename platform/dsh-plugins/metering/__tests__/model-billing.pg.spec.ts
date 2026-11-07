import { expect, it } from 'vitest'
import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import { quotedModelCost } from '../../../shared/seam-contracts/model-billing.ts'
const dsn = process.env.METERING_TEST_DSN
it.skipIf(!dsn)('quotes exact approved native routes from enabled registry entries and retains the admitted rate for settlement', async () => {
  const meter = new PgMeteringSeam(await schemaDsn(dsn!, 'model_billing_test'))
  try {
    await meter.init()
    await meter.raw(`DROP TABLE IF EXISTS llm_providers; TRUNCATE usage_ledger,usage_event_outbox; CREATE TABLE llm_providers(model TEXT PRIMARY KEY,price_in_per_mtok NUMERIC NOT NULL,price_out_per_mtok NUMERIC NOT NULL,enabled BOOLEAN NOT NULL);
      INSERT INTO llm_providers VALUES('route-one',3,15,true),('route-two',5,20,true),('disabled',0,0,false),('invalid','NaN',3,true),('free',0,0,true)`)
    const route = { provider: 'native-a', model: 'same-model', billingModel: 'route-one' }
    const one = await meter.quoteModel(route)
    const two = await meter.quoteModel({ provider: 'native-b', model: 'same-model', billingModel: 'route-two' })
    expect(quotedModelCost(one, 1000, 100)).toBeCloseTo(0.0045)
    expect(quotedModelCost(two, 1000, 100)).toBeCloseTo(0.007)
    for (const billingModel of ['missing', 'disabled', 'invalid']) await expect(meter.quoteModel({ ...route, billingModel })).rejects.toThrow()
    expect(quotedModelCost(await meter.quoteModel({ ...route, billingModel: 'free' }), 1000, 100)).toBe(0)
    await meter.raw(`UPDATE llm_providers SET price_in_per_mtok=999 WHERE model='route-one'`)
    expect((await meter.quoteModel(route)).inputPerMtok).toBe(999)
    expect(quotedModelCost(one, 1000, 100)).toBeCloseTo(0.0045)
    await meter.commit({ context: { userId: 'owner', deptId: 'd', role: 'viewer', projectId: 'p', agentId: 'a', componentId: 'user-auth', feature: 'session:text', sessionRef: 'session-owned' }, tokens: 1100, inputTokens: 1000, outputTokens: 100, model: route.model, costType: 'llm', costUsd: quotedModelCost(one, 1000, 100), traceId: 'session:session-owned' })
    await meter.drainOnce()
    const rows = await meter.raw<{ user_id: string; project_id: string; cost_usd: string; model: string }>('SELECT user_id,project_id,cost_usd,model FROM usage_ledger')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: 'owner', project_id: 'p', model: 'same-model' })
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0045)
  } finally { await meter.close() }
})
