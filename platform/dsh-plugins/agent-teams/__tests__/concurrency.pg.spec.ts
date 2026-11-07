import { afterEach, describe, expect, it, vi } from 'vitest'
import { PgStorageBackend } from '../../storage/src/index.ts'
import { freshSchemaDsn } from '../../storage/__tests__/pg-schema.ts'
import { MemoryCourier } from '../src/courier.ts'
import { AgentTeamsService } from '../src/service.ts'
import { StorageHubTeamStore } from '../src/store.ts'

const DSN = process.env['LUMO_TEST_PG_DSN'] ?? process.env['STORAGE_TEST_DSN']
const pgTest = DSN ? it : it.skip
const input = { id: 'shared', name: '并发团队', topology: 'pipeline' as const, subjects: ['seed'], captainSessionId: 'captain' }

describe('跨实例团队事务（真实 PG）', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })

  async function instances(realms = ['tenant-a', 'tenant-a']) {
    const dsn = await freshSchemaDsn(DSN!, 'team_concurrency')
    const stores = realms.map(realm => {
      const backend = new PgStorageBackend(dsn)
      closers.push(() => backend.close())
      return new StorageHubTeamStore(backend as never, { realm, requireAtomic: true })
    })
    await Promise.all(stores.map(store => store.init()))
    const services = stores.map((store, index) => new AgentTeamsService({
      realm: realms[index], ownerUserId: 'owner',
      resolveStore: () => ({ store, durable: true }),
      resolveCourier: () => new MemoryCourier(),
      resolveSeam: () => ({
        provider: { provider: 'spawn', kind: 'in-process', reason: 'test' },
        seam: { list: () => ['spawn'], start: async () => { throw new Error('本用例不执行 LLM') } },
      }),
    }))
    return { a: services[0]!, b: services[1]!, stores }
  }

  pgTest('两个节点同时创建只成功一次，所有者和租户可重载', async () => {
    const { a, b } = await instances()
    const created = await Promise.allSettled([a.create(input), b.create(input)])
    expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(created.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'DUPLICATE_TEAM' } })
    expect(await b.get(input.id)).toMatchObject({ realm: 'tenant-a', ownerUserId: 'owner', captainSessionId: 'captain' })
  })

  pgTest('24 次并发追加不丢任务、不复用任务序号；抢同一任务只有一个胜者', async () => {
    const { a, b } = await instances()
    await a.create(input)
    await a.addMember(input.id, { name: 'alice' })
    await b.addMember(input.id, { name: 'bob' })
    await a.claim(input.id, 't1', 'alice')
    await a.complete(input.id, 't1', 'alice', 'seed', 1)
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      (index % 2 === 0 ? a : b).addTasks(input.id, [{ subject: `job-${index}` }])))
    const team = await b.get(input.id)
    expect(team.taskSeq).toBe(25)
    expect(new Set(team.tasks.map(task => task.subject)).size).toBe(25)
    expect(new Set(team.tasks.map(task => task.id)).size).toBe(25)
    const claims = await Promise.allSettled([a.claim(input.id, 't2', 'alice'), b.claim(input.id, 't2', 'bob')])
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const winner = (await a.get(input.id)).tasks[1]!
    expect(winner.attempt).toBe(1)
    await a.claim(input.id, 't3', winner.assignee === 'alice' ? 'bob' : 'alice')
    const second = (await b.get(input.id)).tasks[2]!
    await Promise.all([
      a.complete(input.id, 't2', winner.assignee!, 'result-1', winner.attempt),
      b.complete(input.id, 't3', second.assignee!, 'result-2', second.attempt),
    ])
    expect((await a.get(input.id)).tasks.slice(1, 3).map(task => task.output)).toEqual(['result-1', 'result-2'])
  })

  pgTest('删除挡住已经读到旧快照的写入；进程重开也不能复活或复用 id', async () => {
    const { a, b, stores } = await instances()
    await a.create(input)
    let reached!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const store = stores[0]!
    const commit = store.compareAndSet.bind(store)
    const spy = vi.spyOn(store, 'compareAndSet').mockImplementationOnce(async (...args) => {
      reached()
      await gate
      return commit(...args)
    })
    const pending = a.addTasks(input.id, [{ subject: '迟到写入' }])
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await ready
    await b.remove(input.id)
    release()
    await rejected
    spy.mockRestore()
    expect(await a.list()).toEqual([])
    await store.close()
    await store.init()
    await expect(a.create(input)).rejects.toMatchObject({ code: 'DUPLICATE_TEAM' })
  })

  pgTest('不同租户可使用同 id，同一存储中的列表与信任身份隔离', async () => {
    const { a, b, stores } = await instances(['tenant-a', 'tenant-b'])
    await Promise.all([a.create(input), b.create({ ...input, name: '租户 B' })])
    expect((await a.list()).map(team => team.name)).toEqual(['并发团队'])
    expect((await b.list()).map(team => team.name)).toEqual(['租户 B'])
    const otherOwner = new AgentTeamsService({
      realm: 'tenant-a', ownerUserId: 'intruder',
      resolveStore: () => ({ store: stores[0]!, durable: true }),
      resolveCourier: () => new MemoryCourier(),
    })
    expect(await otherOwner.list()).toEqual([])
    await expect(otherOwner.get(input.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(otherOwner.remove(input.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await a.remove(input.id)
    expect((await b.get(input.id)).name).toBe('租户 B')
  })
})
