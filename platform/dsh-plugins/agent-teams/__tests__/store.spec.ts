import { describe, expect, it, vi } from 'vitest'

import { addMember, addTasks, createTeam, seedTasks, TeamError, type TeamState } from '../src/model.ts'
import {
  assertTeamId,
  createTeamStore,
  MemoryTeamStore,
  parseTeamState,
  StorageHubTeamStore,
  TEAM_TABLE,
  TEAM_UNIT_NAME,
  TEAM_UNIT_VERSION,
  TeamRecordError,
  type KvUnitLike,
  type StorageFacetLike,
} from '../src/store.ts'

const NOW = 1_700_000_000_000

function sampleTeam(id = 'demo'): TeamState {
  let team = createTeam({ id, name: '演示团队', topology: 'pipeline', captainSessionId: 's-1', now: NOW })
  team = addMember(team, { name: 'alice', provider: 'spawn' }, NOW)
  return addTasks(team, seedTasks('pipeline', ['取数', '清洗']), NOW).team
}

/** 内存介质 + 调用记账的假 KvUnit，模拟 storage 后端。 */
function fakeStorage(): { storage: StorageFacetLike; descriptor: unknown; records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  const state = { descriptor: undefined as unknown }
  const unit: KvUnitLike = {
    loadAll: async () => ({ tables: { [TEAM_TABLE]: Object.fromEntries(records) }, global: null }),
    putRecord: async (table, key, value) => {
      expect(table).toBe(TEAM_TABLE)
      records.set(key, value)
    },
    deleteRecord: async (_table, key) => { records.delete(key) },
    close: async () => {},
  }
  const storage: StorageFacetLike = {
    kv: {
      open: async (descriptor) => {
        state.descriptor = descriptor
        return unit
      },
    },
  }
  return { storage, descriptor: state.descriptor, records }
}

describe('团队 id 守卫', () => {
  it('接受安全 id，拒绝会破坏路径段的字符', () => {
    expect(() => assertTeamId('team-1_ok')).not.toThrow()
    for (const bad of ['team/1', 'team 1', '团队', '', 'team.1']) {
      expect(() => assertTeamId(bad)).toThrow(TeamError)
    }
  })
})

describe('记录校验', () => {
  it('往返一致', () => {
    const team = sampleTeam()
    expect(parseTeamState(team, team.id)).toEqual(team)
  })

  it('拒绝非对象', () => {
    for (const bad of [null, [], 'x', 42]) {
      expect(() => parseTeamState(bad, 'demo')).toThrow(TeamRecordError)
    }
  })

  it('拒绝闭集外的枚举值', () => {
    const team = sampleTeam() as unknown as Record<string, unknown>
    expect(() => parseTeamState({ ...team, topology: 'swarm' }, 'demo')).toThrow(/topology 不在闭集内/)
    const tasks = (team['tasks'] as Record<string, unknown>[]).map((t, i) => (i === 0 ? { ...t, status: 'nope' } : t))
    expect(() => parseTeamState({ ...team, tasks }, 'demo')).toThrow(/status 非法/)
  })

  it('拒绝缺失必需字段', () => {
    const team = sampleTeam() as unknown as Record<string, unknown>
    expect(() => parseTeamState({ ...team, captainSessionId: '' }, 'demo')).toThrow(/captainSessionId/)
    // 成员缺 status/provider 时按声明顺序先命中 status。
    expect(() => parseTeamState({ ...team, members: [{ name: 'x' }] }, 'demo'))
      .toThrow(/members\[0\]\.status/)
    expect(() => parseTeamState({ ...team, members: [{ name: 'x', status: 'idle' }] }, 'demo'))
      .toThrow(/members\[0\]\.provider/)
  })

  it('过滤掉非字符串依赖而不是整条拒绝', () => {
    const team = sampleTeam() as unknown as Record<string, unknown>
    const tasks = (team['tasks'] as Record<string, unknown>[]).map((t, i) => (i === 1 ? { ...t, dependencies: ['t1', 7, null] } : t))
    const parsed = parseTeamState({ ...team, tasks }, 'demo')
    expect(parsed.tasks[1]!.dependencies).toEqual(['t1'])
  })
})

describe('内存存储', () => {
  it('保存、读取、列出、删除', async () => {
    const store = new MemoryTeamStore()
    await store.init()
    expect(await store.load('demo')).toBeUndefined()
    await store.save(sampleTeam())
    expect((await store.load('demo'))?.name).toBe('演示团队')
    expect((await store.list()).map(t => t.id)).toEqual(['demo'])
    await store.remove('demo')
    expect(await store.load('demo')).toBeUndefined()
    await store.remove('demo')   // 幂等
  })

  it('拒绝非法 id', async () => {
    const store = new MemoryTeamStore()
    await expect(store.save({ ...sampleTeam(), id: 'a/b' })).rejects.toThrow(TeamError)
  })
})

describe('storage hub 存储', () => {
  it('用 per-record 布局打开约定单元，并原样往返', async () => {
    const { storage, records } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    await store.save(sampleTeam())
    expect(records.get('demo')).toBeDefined()
    expect((await store.load('demo'))?.id).toBe('demo')
    expect((await store.list()).map(t => t.id)).toEqual(['demo'])
    await store.remove('demo')
    expect(await store.load('demo')).toBeUndefined()
  })

  // 声明 → 写入 → 持久化 → 重载，四段必须一起走完。这里的解析是**逐字段**的，所以新字段
  // 只要漏在解析里，就会被写进介质、又在读回来那一刻被无声丢掉——症状是「重启后智能体
  // 全变成未绑定」，而写入侧看起来完全正常。这条用例钉的就是那一段。
  it('把成员的 ownerUserId 原样往返', async () => {
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    const team = sampleTeam()
    team.members[0]!.ownerUserId = 'employee-1'
    await store.save(team)
    expect((await store.load('demo'))?.members[0]?.ownerUserId).toBe('employee-1')
  })

  it('没有绑定的成员读回来不会多出一个空绑定', async () => {
    // 「未绑定」必须是**缺省**，而不是空串：视图靠 `undefined` 把它放进「未绑定」区，
    // 而空串会让它看起来像是绑定到了一个空 id 上——两种写法在数据上分不开，但读起来
    // 是完全不同的两句话。
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    await store.save(sampleTeam())
    const member = (await store.load('demo'))?.members[0]
    expect(member?.ownerUserId).toBeUndefined()
    expect(member !== undefined && 'ownerUserId' in member).toBe(false)
  })

  // 同一条教训的另一半：字段漏在逐字段解析里，症状是「重启后所有任务都变成没有验收
  // 条件」——任务板看起来完全正常，而协调者随后的验收会全线 fail-closed。
  // 写入侧一切正常，所以只能靠这一段读回来的往返把它钉住。
  it('把任务的 acceptance 原样往返', async () => {
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    const team = sampleTeam()
    team.tasks[0]!.acceptance = '三条基准数据，误差 <1%'
    await store.save(team)

    expect((await store.load('demo'))?.tasks[0]?.acceptance).toBe('三条基准数据，误差 <1%')
    expect(parseTeamState(team, team.id).tasks[0]?.acceptance).toBe('三条基准数据，误差 <1%')
  })

  // 证据与 acceptance 是同一族风险，且证据这一侧更隐蔽：漏解析之后验收判据会判
  // `no-evidence`，于是**每一条交付都被人审**。方向是 fail-closed 的，所以没人会觉得
  // 出了事故——只会觉得大家突然都要看一眼，而真正的问题在读侧。
  it('把结论的证据原样往返', async () => {
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    const team = sampleTeam()
    team.tasks[0]!.evidence = ['run:child-7', 'run:child-8']
    await store.save(team)

    expect((await store.load('demo'))?.tasks[0]?.evidence).toEqual(['run:child-7', 'run:child-8'])
    expect(parseTeamState(team, team.id).tasks[0]?.evidence).toEqual(['run:child-7', 'run:child-8'])
  })

  it('没有证据的任务读回来不会多出一个空数组', async () => {
    // 「没有证据」必须是缺省而不是 `[]`：判据里两者同义，但存两种形状会让每次读都要
    // 同时处理它们（与 RunID 空串归一成 NULL 同一条纪律）。
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    await store.save(sampleTeam())
    const task = (await store.load('demo'))?.tasks[0]
    expect(task !== undefined && 'evidence' in task).toBe(false)
  })

  it('证据里的空白条目读回来时被丢弃（脏数据不该让整行读不出来）', async () => {
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    const team = sampleTeam()
    team.tasks[0]!.evidence = ['run:a', '   ', 'run:b']
    await store.save(team)
    // 空白条目落库后读回被丢，剩下的非空条目照常保留、顺序不变。
    expect((await store.load('demo'))?.tasks[0]?.evidence).toEqual(['run:a', 'run:b'])
  })

  it('没有验收条件的任务读回来不会多出一个空串', async () => {
    // 「无验收条件」必须是**缺省**而不是空串：判据靠空白判定它，而空串会让两种含义
    // 相同的写法在数据上分不开 —— 两种写法读起来是完全不同的两句话。
    const { storage } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    await store.save(sampleTeam())
    const task = (await store.load('demo'))?.tasks[0]
    expect(task !== undefined && 'acceptance' in task).toBe(false)
  })

  it('打开单元时声明的名字/版本/布局是契约的一部分', async () => {
    const { storage } = fakeStorage()
    const opened: unknown[] = []
    const wrapped: StorageFacetLike = {
      kv: { open: async (descriptor) => { opened.push(descriptor); return (await storage.kv.open(descriptor)) } },
    }
    await new StorageHubTeamStore(wrapped).init()
    expect(opened[0]).toEqual({
      name: TEAM_UNIT_NAME,
      version: TEAM_UNIT_VERSION,
      tables: [TEAM_TABLE],
      hasGlobal: false,
      layout: 'per-record',
    })
  })

  it('脏记录在读取时响亮失败，而不是喂进任务板', async () => {
    const { storage, records } = fakeStorage()
    const store = new StorageHubTeamStore(storage)
    await store.init()
    records.set('broken', { id: 'broken', topology: 'nope' })
    await expect(store.load('broken')).rejects.toThrow(TeamRecordError)
    await expect(store.list()).rejects.toThrow(TeamRecordError)
  })

  it('close 幂等且释放单元', async () => {
    const { storage } = fakeStorage()
    const close = vi.fn(async () => {})
    const wrapped: StorageFacetLike = {
      kv: { open: async (d) => ({ ...(await storage.kv.open(d)), close }) },
    }
    const store = new StorageHubTeamStore(wrapped)
    await store.init()
    await store.close()
    await store.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('存储选择', () => {
  it('有 storage 时用持久实现', () => {
    const { storage } = fakeStorage()
    const chosen = createTeamStore(storage)
    expect(chosen.durable).toBe(true)
    expect(chosen.store).toBeInstanceOf(StorageHubTeamStore)
  })

  it('没有 storage 时显式回落内存，并告知调用方不持久', () => {
    const chosen = createTeamStore(undefined)
    expect(chosen.durable).toBe(false)
    expect(chosen.store).toBeInstanceOf(MemoryTeamStore)
  })
})
