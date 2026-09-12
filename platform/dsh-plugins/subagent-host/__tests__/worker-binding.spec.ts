import { expect, it } from 'vitest'
import { assertExecutionPreset, assertWorkerBinding, type WorkerBinding } from '../src/worker-binding.ts'
import { assertWorkerBinding as assertNodeBinding } from '../../../data-plane/dsh-node/src/worker-binding.ts'
import { workerBindingFromEnv } from '../../../data-plane/dsh-node/src/cluster.ts'
import { binding, preset } from './governed-fixtures.ts'

it.each([undefined, { ...binding, agentId: undefined }, { ...binding, userId: 123 },
  { ...binding, projectId: '' }, { ...binding, presetRevision: 0 }, { ...binding, provider: 123 },
])('rejects incomplete identities in both runtime and packaged node: %j', value => {
  for (const assert of [assertWorkerBinding, assertNodeBinding]) {
    expect(() => assert(value as WorkerBinding)).toThrow('worker runtime requires')
  }
})

it('binds exactly one installed Agent and never substitutes another Worker', () => {
  const env = { LUMO_AGENT_PRESET_REVISION: '7', LUMO_AGENT_PROVIDER: 'mock', LUMO_AGENT_MODEL: 'mock' }
  expect(workerBindingFromEnv({}, binding)).toBeUndefined()
  expect(workerBindingFromEnv(env, binding)).toEqual(binding)
  expect(() => workerBindingFromEnv({ ...env, LUMO_AGENT_IDS: 'writer,other' }, binding)).toThrow('only LUMO_AGENT_ID')
  expect(() => workerBindingFromEnv({ ...env, LUMO_AGENT_IDS: 'other' }, binding)).toThrow('only LUMO_AGENT_ID')
})

it.each([{ realm: 'other' }, { project_id: 'other' }, { revision: 8 }, { status: 'disabled' },
  { system_prompt_ref: 'prompt' }, { knowledge_space_ids: ['private'] }, { max_budget_cents: 10 },
])('rejects uninstalled execution identity or unsupported capabilities: %j', patch => {
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, ...patch })).toThrow()
})
