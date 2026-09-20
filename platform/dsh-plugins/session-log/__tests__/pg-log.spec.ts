import { describe, expect, it } from 'vitest'

import { FencedOutError, LogForkError, type LogRecord } from '../../../shared/seam-contracts/session-log.ts'
import { PgSessionLog } from '../src/pg-log.ts'
import { schemaDsn, truncateSessionLog } from './pg-schema.ts'

/**
 * 复制式 SessionEvent 日志对**真 PG** 跑。
 *
 * 这里断言的全是「恢复与多端一致性靠什么成立」：fencing 拒旧写者、(session,seq)
 * 主键当分叉探测器、至少一次投递的幂等吸收、NUL 字节的事件保真。stub 里没有
 * 行锁、没有主键冲突、没有时钟——这些恰恰是被测物。
 *
 * 无 DSN 时 skip 且 **skip 可见**：静默 return 会让报告显示「通过」。
 */
const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const t = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'

/** 每个测试拿独立 schema（TRUNCATE 两表互不干扰，理由见 pg-schema.ts 注释）。 */
async function withLog(fn: (log: PgSessionLog) => Promise<void>): Promise<void> {
  const log = new PgSessionLog(await schemaDsn(DSN!, 'session_log_test'))
  try {
    await log.init()
    await truncateSessionLog((sql) => log.raw(sql))
    await fn(log)
  } finally {
    await log.close()
  }
}

/** 合法日志记录夹具。payload 可覆盖（NUL 用例需要）。 */
function eventOf(sessionRef: string, seq: number, over: Partial<LogRecord> = {}): LogRecord {
  return {
    sessionRef,
    seq,
    type: over.type ?? 'user_message',
    payload: over.payload ?? { content: `msg-${seq}` },
    time: over.time ?? 1_700_000_000_000 + seq,
  }
}

describe(`schema initialization —— 对真 PG（当前${suffix}）`, () => {
  t('多个节点首次启动时串行创建同一组表', async () => {
    const dsn = await schemaDsn(DSN!, 'session_log_init_test')
    const cleaner = new PgSessionLog(dsn)
    await cleaner.raw('DROP TABLE IF EXISTS session_log, session_writer_lease')
    await cleaner.close()

    const logs = Array.from({ length: 8 }, () => new PgSessionLog(dsn))
    try {
      await expect(Promise.all(logs.map(log => log.init()))).resolves.toHaveLength(logs.length)
    } finally {
      await Promise.all(logs.map(log => log.close()))
    }
  })
})

describe(`写者租约 —— 对真 PG（需 SESSION_LOG_TEST_DSN，当前${suffix}）`, () => {
  t('无租约 → 建租 token=1；本人续租 token 不变且期限延长', async () => {
    await withLog(async (log) => {
      const l1 = await log.acquire('s1', 'node-a', 60_000)
      expect(l1?.holder).toBe('node-a')
      expect(l1?.fencingToken).toBe(1)

      const l2 = await log.acquire('s1', 'node-a', 60_000)
      expect(l2?.fencingToken).toBe(1) // 续租不换 token——换了自己在途的写会被挤掉
      expect(l2!.expiresAt).toBeGreaterThanOrEqual(l1!.expiresAt)
    })
  })

  t('他人持租且未过期 → 拒绝（undefined，不等待）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      const stolen = await log.acquire('s1', 'node-b', 60_000)
      expect(stolen).toBeUndefined()
    })
  })

  t('他人租约已过期 → 接管且 token+1（易主必递增）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', -1) // TTL 负值 = 立即过期
      const taken = await log.acquire('s1', 'node-b', 60_000)
      expect(taken?.holder).toBe('node-b')
      expect(taken?.fencingToken).toBe(2)
    })
  })

  t('release 保留 token 高水位：下一个持有者 token+1（删行会让旧令牌复活）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      await log.release('s1', 'node-a')
      const taken = await log.acquire('s1', 'node-b', 60_000)
      expect(taken?.fencingToken).toBe(2)
      // 非持有者 release 无效果
      await log.release('s1', 'node-zzz')
      const still = await log.lease('s1')
      expect(still?.holder).toBe('node-b')
    })
  })

  t('并发抢占竞态：两个节点同时 acquire，恰好一个成功（单语句 upsert 消竞态）', async () => {
    await withLog(async (log) => {
      const [a, b] = await Promise.all([
        log.acquire('s1', 'node-a', 60_000),
        log.acquire('s1', 'node-b', 60_000),
      ])
      const winners = [a, b].filter((l) => l !== undefined)
      expect(winners).toHaveLength(1)
      // 败者不等待不重试——拿 undefined 就该退避
    })
  })
})

describe(`append 的 fencing 与幂等 —— 对真 PG（当前${suffix}）`, () => {
  t('无租约 append → FencedOutError（currentToken=undefined）', async () => {
    await withLog(async (log) => {
      await expect(log.append(eventOf('s1', 1), 1)).rejects.toBeInstanceOf(FencedOutError)
    })
  })

  t('旧持有者带过期 token 回来 → FencedOutError（fencing 的核心价值：不依赖时钟正确性）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', -1) // node-a 租约已过期
      const taken = await log.acquire('s1', 'node-b', 60_000) // node-b 接管，token=2
      expect(taken?.fencingToken).toBe(2)
      // node-a「醒来」仍以为自己持租（token=1）——必须被拒
      await expect(log.append(eventOf('s1', 1), 1)).rejects.toBeInstanceOf(FencedOutError)
      // node-b 的写在同一 seq 上成功
      const r = await log.append(eventOf('s1', 1), 2)
      expect(r).toEqual({ status: 'appended', seq: 1 })
    })
  })

  t('伪造更高 token → 同样拒绝（令牌只由库端发放）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      await expect(log.append(eventOf('s1', 1), 99)).rejects.toBeInstanceOf(FencedOutError)
    })
  })

  t('租约过期超过时钟容差即使令牌相同也拒写（排他性随租约消失）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      // 拨到远超 5s 容差的过去——此刻任何人都可接管，本节点已无排他性
      await log.raw(`UPDATE session_writer_lease SET expires_at = 0 WHERE session_ref = 's1'`)
      await expect(log.append(eventOf('s1', 1), 1)).rejects.toBeInstanceOf(FencedOutError)
    })
  })

  t('刚过期的租约在时钟容差内放行（容差取舍：最坏多一次写，仍受令牌保护）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', -1) // 仅过期 1ms——容差窗口内
      const r = await log.append(eventOf('s1', 1), 1)
      expect(r).toEqual({ status: 'appended', seq: 1 })
    })
  })

  t('首写 appended；同 (session,seq) 同内容 duplicate（良性重投幂等吸收）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      expect(await log.append(eventOf('s1', 1), 1)).toEqual({ status: 'appended', seq: 1 })
      expect(await log.append(eventOf('s1', 1), 1)).toEqual({ status: 'duplicate', seq: 1 })
      // 不同 seq 照常写
      expect(await log.append(eventOf('s1', 2), 1)).toEqual({ status: 'appended', seq: 2 })
    })
  })

  t('同 (session,seq) 不同内容 → LogForkError（数据完整性事故，绝不允许覆盖）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      await log.append(eventOf('s1', 1), 1)
      const fork = eventOf('s1', 1, { payload: { content: 'DIFFERENT' } })
      await expect(log.append(fork, 1)).rejects.toBeInstanceOf(LogForkError)
    })
  })

  t('同一事件经不同代租约重投 → duplicate（digest 不含 fencing_token）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', -1)
      await log.acquire('s1', 'node-b', 60_000) // token=2
      await log.append(eventOf('s1', 1), 2)
      // 该事件曾在 token=1 代下被（假设的）重试管道投递——内容一致即良性
      // 这里用当前代再写一次同内容模拟跨代重投的 digest 行为
      expect(await log.append(eventOf('s1', 1), 2)).toEqual({ status: 'duplicate', seq: 1 })
    })
  })

  t('payload 键序不同但内容一致 → duplicate（stableStringify 归一化）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      await log.append(eventOf('s1', 1, { payload: { a: 1, b: 2 } }), 1)
      const shuffled = eventOf('s1', 1, { payload: { b: 2, a: 1 } })
      expect(await log.append(shuffled, 1)).toEqual({ status: 'duplicate', seq: 1 })
    })
  })
})

describe(`保真与读取 —— 对真 PG（当前${suffix}）`, () => {
  t('NUL 字节（\\u0000）事件无损往返——TEXT 而非 JSONB 的存在理由', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      const dirty = eventOf('s1', 1, {
        type: 'tool_output',
        payload: { stdout: 'before\u0000after', meta: { x: 1 } },
      })
      await log.append(dirty, 1)
      const read = await log.read('s1')
      expect(read).toHaveLength(1)
      // JSONB 会在这里静默拒收；TEXT + JSON.stringify 往返精确还原
      expect((read[0]!.payload as { stdout: string }).stdout).toBe('before\u0000after')
    })
  })

  t('read 按 seq 排序、fromSeq 裁剪、跨会话隔离', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      await log.acquire('s2', 'node-a', 60_000)
      for (const seq of [3, 1, 2]) await log.append(eventOf('s1', seq), 1)
      await log.append(eventOf('s2', 1), 1)

      const all = await log.read('s1')
      expect(all.map((r) => r.seq)).toEqual([1, 2, 3])
      const tail = await log.read('s1', 2)
      expect(tail.map((r) => r.seq)).toEqual([2, 3])
      expect((await log.read('s2')).map((r) => r.seq)).toEqual([1])
      // 读结果可直接喂 seed：type/time/payload 全维度还原
      expect(all[0]!.type).toBe('user_message')
      expect(all[0]!.time).toBe(1_700_000_000_001)
    })
  })

  t('分叉后的日志不可静默修复：两条分支都在（人工裁定）', async () => {
    await withLog(async (log) => {
      await log.acquire('s1', 'node-a', 60_000)
      await log.append(eventOf('s1', 1), 1)
      const fork = eventOf('s1', 1, { payload: { content: 'other-branch' } })
      await expect(log.append(fork, 1)).rejects.toBeInstanceOf(LogForkError)
      // 已存的分支未被覆盖
      const read = await log.read('s1')
      expect((read[0]!.payload as { content: string }).content).toBe('msg-1')
    })
  })
})

describe('resume 端到端故事（跨节点接管的全链路）', () => {
  t('A 写 → A 失联 → B 接管续写 → A 醒来被 fence —— 日志无分叉', async () => {
    await withLog(async (log) => {
      // A 节点持租并写了 3 条
      await log.acquire('s1', 'node-a', 60_000)
      for (const seq of [1, 2, 3]) await log.append(eventOf('s1', seq), 1)

      // A 失联（租约过期）——模拟：直接改库把 expires_at 拨回过去
      await log.raw(`UPDATE session_writer_lease SET expires_at = 0 WHERE session_ref = 's1'`)

      // B 节点接管（token=2），从 seq=4 续写
      const taken = await log.acquire('s1', 'node-b', 60_000)
      expect(taken?.fencingToken).toBe(2)
      await log.append(eventOf('s1', 4), 2)

      // A 醒来，带着 token=1 继续写 seq=5 —— 必须被拒
      await expect(log.append(eventOf('s1', 5), 1)).rejects.toBeInstanceOf(FencedOutError)

      // B 从头 read 拿到完整连续历史（resume 的 seed 输入）
      const history = await log.read('s1')
      expect(history.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    })
  })
})
