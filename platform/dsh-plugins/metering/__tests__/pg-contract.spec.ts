import { describe, expect, it } from 'vitest'

import { PgMeteringSeam, METERING_DDL } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import { assertMeteringContract } from '../../../shared/seam-contracts/metering.ts'

/**
 * 契约对**真 PG** 跑。
 *
 * 为什么必须有这个文件：`assertMeteringContract` 原先只对着 `MemoryMeteringSeam`
 * 跑，而那个 stub 是照着契约写的、PG 实现是另外写的，两者语义不一致而**都「通过」**。
 * 这与制品注册表那处 parser differential 同形：被验证的对象不是被依赖的对象。
 * 契约测试只跑 stub 等于没跑。
 *
 * 无 DSN 时 **skip 且 skip 可见**——静默 return 会让报告显示「通过」，那正是本项要
 * 修的元问题。
 *
 * 走本文件专属的 schema（见 `pg-schema.ts`）：与 `sink.spec.ts` 共用时，两边的
 * TRUNCATE 会互相抹掉对方的夹具，红的原因与被测代码无关。
 */
const DSN = process.env['METERING_TEST_DSN']
const dsn = () => schemaDsn(DSN!, 'metering_contract_test')

describe('metering 契约 —— 对真 PG', () => {
  const t = DSN ? it : it.skip
  t(`并行双树语义（需 METERING_TEST_DSN，当前${DSN ? '已设置' : '未设置 → 跳过，非通过'}）`, async () => {
    const seam = new PgMeteringSeam(await dsn())
    try {
      await seam.init()
      // TRUNCATE 而非 DROP：DROP 会让并行跑的其它用例拿到不存在的表
      await seam.raw(`TRUNCATE usage_ledger, budget_trees`)
      const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
      await assertMeteringContract(seam, assert, async (user, project) => {
        await seam.raw(`TRUNCATE usage_ledger, budget_trees`)
        await seam.setBudget('user', 'u1', user)
        await seam.setBudget('project', 'p1', project)
      })
    } finally {
      await seam.close()
    }
  })

  t('DDL 幂等 —— init 跑两次不报错（既有库上必然发生）', async () => {
    const seam = new PgMeteringSeam(await dsn())
    try {
      await seam.init()
      await seam.init()
      expect(METERING_DDL).toContain('usage_ledger')
    } finally {
      await seam.close()
    }
  })
})
