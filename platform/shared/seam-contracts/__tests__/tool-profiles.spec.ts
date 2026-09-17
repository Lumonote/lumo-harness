/**
 * 内置工具能力档案的等价性与完整性锁。
 *
 * 这个用例做三件事：
 * 1. **等价性**：把合并前分散在两个插件里的三张表的历史取值逐条钉住。合并只是搬位置，
 *    任何一个档位被顺手改动都会红 —— 这三列是安全默认，静默漂移的代价是「数据外发」。
 * 2. **完整性**：半声明的行（只写了部分列）必须落在显式白名单里。此前
 *    `knowledge_publish` 只声明副作用、另两列靠兜底，而这个事实在代码里看不出来。
 * 3. **单一副本**：两个插件导出的必须是同一份对象，不是各自复制了一份。
 */
import { describe, expect, it } from 'vitest'
import type { Provenance } from '../provenance.ts'
import type { Idempotency } from '../recovery.ts'
import {
  BUILTIN_EFFECT,
  BUILTIN_IDEMPOTENCY,
  BUILTIN_PROVENANCE,
  BUILTIN_TOOL_PROFILES,
} from '../tool-profiles.ts'
import {
  BUILTIN_EFFECT as PLUGIN_EFFECT,
  BUILTIN_PROVENANCE as PLUGIN_PROVENANCE,
  ProvenanceClassifier,
} from '../../../dsh-plugins/provenance/src/classify.ts'
import {
  BUILTIN_IDEMPOTENCY as PLUGIN_IDEMPOTENCY,
  IdempotencyClassifier,
} from '../../../dsh-plugins/recovery/src/classify.ts'

/**
 * 合并前（2026-09-14 之前）`provenance/src/classify.ts` 与 `recovery/src/classify.ts`
 * 里三张 map 的取值，逐条抄自改造前的原件。改动任何一条都必须是有意的。
 */
const HISTORICAL_PROVENANCE: Readonly<Record<string, Provenance>> = {
  read: 'external', glob: 'external', grep: 'external', ls: 'external',
  todo_write: 'internal', write: 'internal', edit: 'internal',
  multi_edit: 'internal', notebook_edit: 'internal',
  knowledge_query: 'external', web_search: 'external', web_fetch: 'external',
  bash: 'external', pwsh: 'external', subprocess: 'external',
}

const HISTORICAL_EFFECT: Readonly<Record<string, string>> = {
  read: 'read', glob: 'read', grep: 'read', ls: 'read',
  knowledge_query: 'read', web_search: 'read', web_fetch: 'read',
  write: 'write-local', edit: 'write-local', multi_edit: 'write-local',
  notebook_edit: 'write-local', todo_write: 'write-local', knowledge_publish: 'write-local',
  bash: 'write-external', pwsh: 'write-external', subprocess: 'write-external',
}

const HISTORICAL_IDEMPOTENCY: Readonly<Record<string, Idempotency>> = {
  read: 'idempotent', glob: 'idempotent', grep: 'idempotent', ls: 'idempotent',
  web_search: 'idempotent', web_fetch: 'idempotent', knowledge_query: 'idempotent',
  write: 'idempotent', todo_write: 'idempotent',
  edit: 'non-idempotent', multi_edit: 'non-idempotent', notebook_edit: 'non-idempotent',
  bash: 'unknown', pwsh: 'unknown', subprocess: 'unknown',
}

/**
 * 已知「只声明了部分列」的行。加进来之前请先想清楚：缺列 = 走 fail closed 兜底，
 * 而这可能正是想要的效果（保守）—— 但也可能只是忘了写。见 tool-profiles.ts 表尾注释。
 */
const HALF_DECLARED_ROWS = ['knowledge_publish']

describe('内置工具能力档案 —— 与合并前的历史取值逐条等价', () => {
  it('来源档位列不变', () => {
    expect({ ...BUILTIN_PROVENANCE }).toEqual(HISTORICAL_PROVENANCE)
  })

  it('副作用等级列不变', () => {
    expect({ ...BUILTIN_EFFECT }).toEqual(HISTORICAL_EFFECT)
  })

  it('幂等性列不变', () => {
    expect({ ...BUILTIN_IDEMPOTENCY }).toEqual(HISTORICAL_IDEMPOTENCY)
  })
})

describe('内置工具能力档案 —— 表体自身的完整性', () => {
  it('工具名非空且唯一', () => {
    const names = BUILTIN_TOOL_PROFILES.map(profile => profile.name)
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0)
    expect(new Set(names).size).toBe(names.length)
  })

  it('副作用列覆盖表里每一行 —— 它是必填列，不该有遗漏', () => {
    expect(Object.keys(BUILTIN_EFFECT).sort()).toEqual(BUILTIN_TOOL_PROFILES.map(p => p.name).sort())
  })

  it('半声明的行必须落在显式白名单里', () => {
    const incomplete = BUILTIN_TOOL_PROFILES
      .filter(profile => profile.provenance === undefined || profile.idempotency === undefined)
      .map(profile => profile.name)
      .sort()
    expect(incomplete).toEqual([...HALF_DECLARED_ROWS].sort())
  })

  it('半声明行缺的列，兜底值就是文档里写的保守值', () => {
    const provenance = new ProvenanceClassifier()
    const recovery = new IdempotencyClassifier()
    for (const name of HALF_DECLARED_ROWS) {
      const profile = BUILTIN_TOOL_PROFILES.find(p => p.name === name)
      expect(profile).toBeDefined()
      if (profile?.provenance === undefined) expect(provenance.provenanceOf(name)).toBe('external')
      if (profile?.idempotency === undefined) expect(recovery.classify(name)).toBe('unknown')
    }
  })
})

describe('内置工具能力档案 —— 只有一份副本', () => {
  it('两个插件导出的是同一个对象，不是各自复制的表', () => {
    expect(PLUGIN_PROVENANCE).toBe(BUILTIN_PROVENANCE)
    expect(PLUGIN_EFFECT).toBe(BUILTIN_EFFECT)
    expect(PLUGIN_IDEMPOTENCY).toBe(BUILTIN_IDEMPOTENCY)
  })

  it('装配层的 override 仍然优先于本表（外置没有削弱可配置性）', () => {
    const provenance = new ProvenanceClassifier({ overrides: { read: 'internal' } })
    expect(provenance.provenanceOf('read')).toBe('internal')
    const recovery = new IdempotencyClassifier({ overrides: { bash: 'idempotent' } })
    expect(recovery.classify('bash')).toBe('idempotent')
  })
})
