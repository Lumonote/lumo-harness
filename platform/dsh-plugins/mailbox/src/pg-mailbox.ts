/**
 * 持久信箱的 PG 实现（评审 A3）。
 *
 * 设计要点：
 *
 * **① 一切时间取库端时钟。** TTL 判定必须跨节点一致，否则 A 节点认为还没过期、
 * B 节点认为已进死信，同一个等待项出现两种状态。
 *
 * **② 兑现用条件 UPDATE，首次为准。** `WHERE state = 'pending'` 使重复投递自动
 * 变成空更新——至少一次投递下 resolve 会重复到达，第二次不能覆盖第一次的值。
 *
 * **③ 过期判定内置在读路径。** 不依赖 sweep 及时跑到：`wait`/`poll` 读到一条
 * 已过 TTL 的 pending 项时就地判 expired。sweep 是清理与可观测性手段，
 * **不是**正确性依赖——正确性不能建立在「后台任务活着」之上。
 *
 * **④ value 存 JSON 文本而非 JSONB。** 同 session_log 的理由：JSONB 拒收 `\u0000`，
 * 而兑现值常来自工具输出，带 NUL 是常事。用 JSONB 会让这类兑现整条失败，
 * 等待方就永远等下去——正是本模块要消灭的失败模式。
 */
import pg from 'pg'
import type {
  FutureRecord,
  FutureState,
  MailboxSeam,
  SettleOutcome,
  WaitOutcome,
} from '../../../shared/seam-contracts/mailbox.ts'

export const MAILBOX_DDL = `
CREATE TABLE IF NOT EXISTS mailbox_future (
  future_id   TEXT   PRIMARY KEY,
  realm       TEXT   NOT NULL,
  state       TEXT   NOT NULL,
  -- 兑现值的 JSON 文本；NULL 表示未兑现或以错误兑现
  value       TEXT   NULL,
  error       TEXT   NULL,
  created_at  BIGINT NOT NULL,
  -- 强制 TTL：没有「永不过期」的等待项（评审 A3）
  expires_at  BIGINT NOT NULL,
  resolved_at BIGINT NULL
);

-- 对账扫描只关心未决项，部分索引避免全表扫
CREATE INDEX IF NOT EXISTS idx_mailbox_pending
  ON mailbox_future (expires_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_mailbox_dead
  ON mailbox_future (realm, resolved_at) WHERE state = 'expired';
`

/** 库端当前时刻（毫秒）。TTL 判定一律走它，不用各节点本地时钟。 */
const NOW_MS = `(EXTRACT(EPOCH FROM now()) * 1000)::bigint`

/**
 * 「已过 TTL 且仍未决」的库端判定。
 *
 * 必须在 SQL 里算：`expires_at` 本身是库端时钟生成的，拿到 JS 侧跟 `Date.now()` 比，
 * 两台机器的时钟偏移就会让同一个等待项在 A 节点是 pending、在 B 节点是 expired。
 */
const IS_EXPIRED = `(state = 'pending' AND expires_at <= ${NOW_MS})`

interface Row {
  future_id: string
  realm: string
  state: string
  value: string | null
  error: string | null
  created_at: string
  expires_at: string
  resolved_at: string | null
  /** 由**库端时钟**算出的「已过 TTL 且仍未决」——不能在 JS 侧用本地时钟判（设计点 ①） */
  is_expired: boolean
}

export interface PgMailboxOptions {
  connectionString: string
  /** 轮询间隔。通知可能丢失，轮询才是正确性来源（见契约文件说明）。 */
  pollIntervalMs?: number
}

/** 默认轮询 500ms：唤醒延迟与库压力的折中，可按部署形态调。 */
const DEFAULT_POLL_MS = 500

/** 死信原因文案：sweep 写库与读路径就地判定必须给出同一句，否则运维看到两种说法。 */
const TTL_DEAD_LETTER_REASON = 'TTL 到期未兑现（死信）——唤醒可能丢失，等待方应重试'

export class PgMailbox implements MailboxSeam {
  private pool: pg.Pool
  private pollIntervalMs: number

  constructor(options: PgMailboxOptions) {
    this.pool = new pg.Pool({ connectionString: options.connectionString })
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? DEFAULT_POLL_MS, 50)
  }

  async init(): Promise<void> {
    await this.pool.query(MAILBOX_DDL)
  }

  async create(futureId: string, realm: string, ttlMs: number): Promise<FutureRecord> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      // 响亮失败：TTL 是本模块的立身之本，缺了它就退回「可能永久挂起」。
      throw new Error(`mailbox: ttlMs 必须为正数（收到 ${String(ttlMs)}）——不提供永不过期的等待项`)
    }
    // 重复 create 幂等：至少一次投递下同一个 id 会被创建多次，不能因此报错，
    // 更不能重置 TTL（那会让一个反复重投的创建请求把等待项无限续命）。
    const res = await this.pool.query<Row>(
      `INSERT INTO mailbox_future (future_id, realm, state, created_at, expires_at)
       VALUES ($1, $2, 'pending', ${NOW_MS}, ${NOW_MS} + $3)
       ON CONFLICT (future_id) DO UPDATE SET realm = mailbox_future.realm
       RETURNING *, ${IS_EXPIRED} AS is_expired`,
      [futureId, realm, ttlMs],
    )
    return toRecord(res.rows[0]!)
  }

  async resolve(futureId: string, value: unknown): Promise<SettleOutcome> {
    return this.settle(futureId, 'resolved', JSON.stringify(value ?? null), null)
  }

  async reject(futureId: string, error: string): Promise<SettleOutcome> {
    return this.settle(futureId, 'rejected', null, error)
  }

  private async settle(
    futureId: string,
    state: 'resolved' | 'rejected',
    value: string | null,
    error: string | null,
  ): Promise<SettleOutcome> {
    // 条件 UPDATE：只有 pending 且未过 TTL 才可兑现。过了 TTL 的项即使 sweep
    // 还没跑到也不接受兑现——否则等待方已按 expired 重试过，这里再兑现就成了两次执行。
    const res = await this.pool.query(
      `UPDATE mailbox_future
       SET state = $2, value = $3, error = $4, resolved_at = ${NOW_MS}
       WHERE future_id = $1 AND state = 'pending' AND expires_at > ${NOW_MS}`,
      [futureId, state, value, error],
    )
    if ((res.rowCount ?? 0) > 0) return { status: 'settled' }

    const prior = await this.pool.query<Row>(
      `SELECT *, ${IS_EXPIRED} AS is_expired FROM mailbox_future WHERE future_id = $1`, [futureId])
    const row = prior.rows[0]
    if (!row) return { status: 'unknown' }
    return { status: 'already-settled', state: effectiveState(row) }
  }

  async poll(futureId: string): Promise<FutureRecord | undefined> {
    const res = await this.pool.query<Row>(
      `SELECT *, ${IS_EXPIRED} AS is_expired FROM mailbox_future WHERE future_id = $1`, [futureId])
    const row = res.rows[0]
    return row ? toRecord(row) : undefined
  }

  async wait(futureId: string, timeoutMs?: number): Promise<WaitOutcome> {
    // 起手先读一次：覆盖「resolve 先于 wait」的竞态（契约文件详述）。
    // 纯信号机制在这里必然漏掉已发生的兑现。
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined
    for (;;) {
      const record = await this.poll(futureId)
      if (!record) {
        return { state: 'expired', error: `mailbox: 等待项 ${futureId} 不存在（未创建或已清理）` }
      }
      if (record.state !== 'pending') return outcomeOf(record)

      // 调用方自己的等待上限先到：不改变该项状态，只是本次不再等。
      if (deadline !== undefined && Date.now() >= deadline) {
        return { state: 'expired', error: `mailbox: 本次等待超时（${String(timeoutMs)}ms），等待项仍未决` }
      }
      await sleep(this.pollIntervalMs)
    }
  }

  async sweep(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE mailbox_future
       SET state = 'expired', resolved_at = ${NOW_MS},
           error = $1
       WHERE state = 'pending' AND expires_at <= ${NOW_MS}`,
      [TTL_DEAD_LETTER_REASON],
    )
    return res.rowCount ?? 0
  }

  async deadLetters(realm: string, limit = 100): Promise<FutureRecord[]> {
    const res = await this.pool.query<Row>(
      `SELECT *, ${IS_EXPIRED} AS is_expired FROM mailbox_future
       WHERE realm = $1 AND state = 'expired'
       ORDER BY resolved_at DESC NULLS LAST LIMIT $2`,
      [realm, limit],
    )
    return res.rows.map(toRecord)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/**
 * 行的**有效**状态：pending 但已过 TTL 的按 expired 算。
 *
 * 读路径就地判定，不等 sweep——正确性不能依赖后台任务是否活着。
 * 过期与否取库端算好的 `is_expired`，不在这里比时间（设计点 ①）。
 */
function effectiveState(row: Row): FutureState {
  if (row.is_expired) return 'expired'
  return row.state as FutureState
}

function toRecord(row: Row): FutureRecord {
  const state = effectiveState(row)
  return {
    futureId: row.future_id,
    realm: row.realm,
    state,
    ...(row.value !== null ? { value: JSON.parse(row.value) as unknown } : {}),
    ...(row.error !== null
      ? { error: row.error }
      : row.is_expired
        ? { error: TTL_DEAD_LETTER_REASON }
        : {}),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    ...(row.resolved_at !== null ? { resolvedAt: Number(row.resolved_at) } : {}),
  }
}

function outcomeOf(record: FutureRecord): WaitOutcome {
  if (record.state === 'resolved') return { state: 'resolved', value: record.value }
  if (record.state === 'rejected') return { state: 'rejected', error: record.error ?? '' }
  return { state: 'expired', error: record.error ?? 'TTL 到期未兑现' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 等待中的 future 不应拖住进程退出：停机时按未决处理，由 TTL/对账收尾。
    timer.unref?.()
  })
}
