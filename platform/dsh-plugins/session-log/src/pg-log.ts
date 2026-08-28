/**
 * 复制式 SessionEvent 日志的 PG 实现（真相源）。
 *
 * 三处刻意的设计取舍：
 *
 * **① 时间一律取库端时钟。** 租约到期比较若用各节点本地时钟，时钟偏移会让两个节点
 * 同时认为自己持租。PG 单点时钟消除了这个偏移——注意这只保证「何时允许接管」的判断
 * 一致，「谁的写有效」仍由 fencing token 保证，不依赖时钟正确性。
 *
 * **② 续租不换 token，易主才 +1。** 若续租也 +1，持有者自己在途的写会被自己的新
 * token 判为过期。
 *
 * **③ 重复写按摘要区分良性与分叉。** 至少一次投递会让同一事件重复到达，这是良性的，
 * 幂等吸收；同 seq 上内容不同则是单写者约束被突破，必须响亮失败。
 *
 * **④ payload 存 TEXT 而非 JSONB。** JSONB 解析时拒收 `\u0000` 转义
 * （`unsupported Unicode escape sequence`），而模型上下文里出现 NUL 字节是常事
 * （工作区指令、工具输出都可能带）。用 JSONB 的结果是这类事件整条写不进去，
 * 在日志里留下**静默空洞**——而空洞会让 `seed` 重放出一段与原会话不同的历史，
 * 恰是本日志要杜绝的失败模式。`JSON.stringify` 把 NUL 转义成六个 ASCII 字符，
 * 存进 TEXT 无损，读出 `JSON.parse` 精确还原。
 *
 * 代价是失去 JSONB 的按内容检索。这里不需要：日志按 seq 顺序读来重放，
 * 内容检索是 Doris/OLAP 层的事（§5.1）。保真度优先于查询便利。
 */
import { createHash } from 'node:crypto'
import pg from 'pg'
import {
  FencedOutError,
  LogForkError,
  type AppendResult,
  type LogRecord,
  type SessionLogSeam,
  type WriterLease,
} from '../../../shared/seam-contracts/session-log.ts'

export const SESSION_LOG_DDL = `
CREATE TABLE IF NOT EXISTS session_log (
  session_ref   TEXT   NOT NULL,
  -- dsh 原生的会话内单调序号；与 session_ref 组成主键，主键冲突即分叉信号
  seq           BIGINT NOT NULL,
  -- 写入时持有的隔离令牌，供事后追溯「这条是谁在哪一代租约下写的」
  fencing_token BIGINT NOT NULL,
  event_type    TEXT   NOT NULL,
  -- 序列化后的 JSON 文本，**不是 JSONB**：见 payload 列注释
  payload       TEXT   NOT NULL,
  -- 事件内容摘要：区分良性重投与真分叉，无需比对整个 payload
  digest        TEXT   NOT NULL,
  event_time    BIGINT NOT NULL,
  appended_at   BIGINT NOT NULL,
  PRIMARY KEY (session_ref, seq)
);

CREATE TABLE IF NOT EXISTS session_writer_lease (
  session_ref   TEXT   PRIMARY KEY,
  holder        TEXT   NOT NULL,
  fencing_token BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);

-- 从早期 JSONB 版本迁移：JSONB 会拒收含 \\u0000 的事件（见 payload 列注释），
-- 那会在日志中打出静默空洞。已建库的实例在此就地转换。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_log' AND column_name = 'payload' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE session_log ALTER COLUMN payload TYPE TEXT;
  END IF;
END $$;
`

/** 库端当前时刻（毫秒）。所有租约时间比较都走它，不用节点本地时钟。 */
const NOW_MS = `(EXTRACT(EPOCH FROM now()) * 1000)::bigint`

export class PgSessionLog implements SessionLogSeam {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // PostgreSQL's CREATE TABLE IF NOT EXISTS can still race while creating
      // the table's implicit composite type. Serialize only this schema unit;
      // the transaction-scoped lock is released on commit or rollback.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lumo.session-log.schema.v1'))")
      await client.query(SESSION_LOG_DDL)
      await client.query('COMMIT')
    } catch (error: unknown) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * 测试专用逃生口（TRUNCATE / 断言用查询 / 租约时钟拨弄）。
   *
   * 显式给一个窄口，而不是让测试去碰私有 `pool`：碰私有字段的测试会在下一次重构
   * 时坏掉，而坏掉的方式是「测试自己报错」而非「被测行为变了」，很难判断。
   * （同 pg-meter.ts 的 raw——两处同一理由，同一形状。）
   */
  async raw<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const r = await this.pool.query<T>(sql, params)
    return r.rows
  }

  async acquire(sessionRef: string, holder: string, ttlMs: number): Promise<WriterLease | undefined> {
    // 建租 / 续租 / 接管三种情形一条语句完成：分开写会在两条语句之间留出竞态窗口，
    // 让两个节点都判定「无人持租」而各自建租。
    const res = await this.pool.query<{ holder: string; fencing_token: string; expires_at: string }>(
      `INSERT INTO session_writer_lease (session_ref, holder, fencing_token, expires_at)
       VALUES ($1, $2, 1, ${NOW_MS} + $3)
       ON CONFLICT (session_ref) DO UPDATE
         SET holder = EXCLUDED.holder,
             fencing_token = CASE
               WHEN session_writer_lease.holder = EXCLUDED.holder
                 THEN session_writer_lease.fencing_token          -- 续租：令牌不变
               ELSE session_writer_lease.fencing_token + 1        -- 易主：令牌 +1
             END,
             expires_at = EXCLUDED.expires_at
         WHERE session_writer_lease.holder = EXCLUDED.holder      -- 本人续租
            OR session_writer_lease.expires_at < ${NOW_MS}        -- 或他人租约已过期
       RETURNING holder, fencing_token, expires_at`,
      [sessionRef, holder, ttlMs],
    )
    const row = res.rows[0]
    // 无返回行 = 他人持有未过期租约。不等待、不重试：等待会让调用方误以为拿到了写权。
    if (!row) return undefined
    return {
      sessionRef,
      holder: row.holder,
      fencingToken: Number(row.fencing_token),
      expiresAt: Number(row.expires_at),
    }
  }

  async release(sessionRef: string, holder: string): Promise<void> {
    // 令 expires_at 立即过期而非删行：保留 fencing_token 的历史高水位，
    // 删行会让下一个持有者从 1 重新开始，旧持有者的过期令牌反而变得「有效」。
    await this.pool.query(
      `UPDATE session_writer_lease SET expires_at = 0
       WHERE session_ref = $1 AND holder = $2`,
      [sessionRef, holder],
    )
  }

  async append(record: LogRecord, fencingToken: number): Promise<AppendResult> {
    const digest = digestOf(record)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // 锁租约行：既做 fencing 校验，又把同一会话的并发 append 串行化。
      const leaseRes = await client.query<{ fencing_token: string; expires_at: string }>(
        `SELECT fencing_token, expires_at FROM session_writer_lease
         WHERE session_ref = $1 FOR UPDATE`,
        [record.sessionRef],
      )
      const lease = leaseRes.rows[0]
      const current = lease ? Number(lease.fencing_token) : undefined
      // 只有当前代租约的令牌可写。`>` 不可能自然出现（令牌只由库端发放），
      // 一旦出现说明调用方伪造或串了会话，同样拒绝。
      if (current === undefined || current !== fencingToken) {
        await client.query('ROLLBACK')
        throw new FencedOutError(record.sessionRef, fencingToken, current)
      }
      // 租约过期即使令牌相同也拒写：此刻任何人都可接管，本节点已无排他性。
      if (Number(lease!.expires_at) < Date.now() - CLOCK_SKEW_ALLOWANCE_MS) {
        await client.query('ROLLBACK')
        throw new FencedOutError(record.sessionRef, fencingToken, current)
      }

      const ins = await client.query(
        `INSERT INTO session_log
           (session_ref, seq, fencing_token, event_type, payload, digest, event_time, appended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, ${NOW_MS})
         ON CONFLICT (session_ref, seq) DO NOTHING`,
        [record.sessionRef, record.seq, fencingToken, record.type,
         JSON.stringify(record.payload), digest, record.time],
      )

      if ((ins.rowCount ?? 0) > 0) {
        await client.query('COMMIT')
        return { status: 'appended', seq: record.seq }
      }

      // 主键冲突：同 seq 已有记录。摘要相同 = 良性重投；不同 = 分叉事故。
      const prior = await client.query<{ digest: string }>(
        'SELECT digest FROM session_log WHERE session_ref = $1 AND seq = $2',
        [record.sessionRef, record.seq],
      )
      const existing = prior.rows[0]?.digest ?? ''
      await client.query('COMMIT')
      if (existing === digest) return { status: 'duplicate', seq: record.seq }
      throw new LogForkError(record.sessionRef, record.seq, existing, digest)
    } catch (error) {
      // ROLLBACK 已在各拒绝分支显式执行；这里兜住 INSERT 本身的失败。
      await client.query('ROLLBACK').catch(() => {
        // 连接已断时 ROLLBACK 必然失败，事务由服务端自动回滚，无需处理。
      })
      throw error
    } finally {
      client.release()
    }
  }

  async read(sessionRef: string, fromSeq = 0): Promise<LogRecord[]> {
    const res = await this.pool.query<{
      seq: string; event_type: string; payload: string; event_time: string
    }>(
      `SELECT seq, event_type, payload, event_time FROM session_log
       WHERE session_ref = $1 AND seq >= $2 ORDER BY seq`,
      [sessionRef, fromSeq],
    )
    return res.rows.map((r) => ({
      sessionRef,
      seq: Number(r.seq),
      type: r.event_type,
      // payload 以 JSON 文本存储（见文件头 ④），读出时还原成事件对象
      payload: JSON.parse(r.payload) as unknown,
      time: Number(r.event_time),
    }))
  }

  async lease(sessionRef: string): Promise<WriterLease | undefined> {
    const res = await this.pool.query<{ holder: string; fencing_token: string; expires_at: string }>(
      'SELECT holder, fencing_token, expires_at FROM session_writer_lease WHERE session_ref = $1',
      [sessionRef],
    )
    const row = res.rows[0]
    if (!row) return undefined
    return {
      sessionRef,
      holder: row.holder,
      fencingToken: Number(row.fencing_token),
      expiresAt: Number(row.expires_at),
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/**
 * 节点本地时钟与库端时钟的容差。
 *
 * 只用在「令牌正确但租约刚过期」这一道附加检查上——放宽它最坏是多放行一次写，
 * 而该写仍受令牌保护（真被接管了令牌就已经变了）。收紧它则会在正常时钟抖动下
 * 误拒合法写入。
 */
const CLOCK_SKEW_ALLOWANCE_MS = 5_000

/**
 * 事件内容摘要。
 *
 * 只覆盖 (type, time, payload)——不含 fencing_token，否则同一事件经不同代租约重投
 * 会被判成分叉。
 */
function digestOf(record: LogRecord): string {
  return createHash('sha256')
    .update(JSON.stringify([record.type, record.time, stableStringify(record.payload)]))
    .digest('hex')
    .slice(0, 32)
}

/** 键排序序列化：JSON 往返后对象键顺序可能变化，不归一化会把重投误判成分叉。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
