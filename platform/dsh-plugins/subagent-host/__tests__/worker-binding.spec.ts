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
  { system_prompt_ref: 'prompt' },
])('rejects uninstalled execution identity or unsupported capabilities: %j', patch => {
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, ...patch })).toThrow()
})

// 金额上限与知识空间**已从「一律拒绝」改为接受**——两者的执法面都建好了（前者：计量截面的
// `ScopeCapSeam`；后者：知识插件的会话作用域 + 两个知识工具按会话读），而这条判据的原话是
// 「先有执法再开门」。
//
// 留**正向**断言而不是把两行从上面的列表里删掉：删掉只会得到两个「没人再管」的空洞，
// 而下面这两条会在有人把它们重新塞回拒绝列表时立刻红。
it('accepts a monetary cap now that its enforcement exists', () => {
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, max_budget_cents: 1000 })).not.toThrow()
  // 上限本身仍然要是个合法的非负数——接受不等于不校验。
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, max_budget_cents: -1 })).toThrow()
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, max_budget_cents: 1.5 })).toThrow()
})

it('accepts knowledge spaces now that the session scope exists', () => {
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, knowledge_space_ids: ['private'] })).not.toThrow()
  // 字段本身仍必须是数组——接受不等于不校验（写成字符串会在运行期才炸）。
  expect(() => assertExecutionPreset(binding, 'realm', { ...preset, knowledge_space_ids: 'private' as never })).toThrow()
})
