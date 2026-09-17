/**
 * 跨语言契约：`session_control_state` / `session_control_audit` 这一对表由
 * **Go 控制面**（`platform/control-plane/session-control`）裁决并写入，由
 * **TS 插件 `@lumo/control`** 读出后作用于 agent（`tools/pre-execute` 闸门）。
 * 两侧之间**没有编译期约束**：改一边的词表或列名，另一边照样编译、照样 `tsc` 干净，
 * 只是运行时读到不认识的值后按「没有指令」放行——而放行的代价是执行了不该执行的写操作。
 *
 * 本文件就是那道缺失的约束。三条纪律：
 *
 *   1. **判据从源码推导，不手抄字符串**。状态词表与列名都从 Go 侧源码现场解析——
 *      写死字符串的契约测试在改名当天会静默失效，而「没有规则要查」与「规则全通过」
 *      在退出码上完全一样。
 *   2. **唯一写入方**。同 §八/§九 的结论：一张表只允许一个写入方。控制面的状态与
 *      审计归 Go 服务所有，TS 侧只读。
 *   3. **真 PG 走一遍**。契约一致不等于链路通——最后一条用例在真库上让 Go 的 DDL
 *      建表、Go 的形状写行、TS 的 seam 读回来。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { CONTROL_DDL, PgControlSeam } from '../src/pg-control.ts'
import { controlGate } from '../src/gate.ts'
import { SESSION_CONTROL_STATES } from '../../../shared/seam-contracts/control.ts'
import { schemaDsn } from '../../session-log/__tests__/pg-schema.ts'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '../../..')

const GO_STATE_SRC = resolve(platformRoot, 'control-plane/session-control/internal/state/state.go')
const GO_STORE_SRC = resolve(platformRoot, 'control-plane/session-control/internal/store/store.go')

/** 从 Go 源码推导 `State` 词表：只认 `const (...)` 块里形如 `StateXxx State = "..."` 的行。 */
function goStates(): string[] {
  const src = readFileSync(GO_STATE_SRC, 'utf8')
  const found = [...src.matchAll(/^\tState\w+\s+State\s*=\s*"([^"]+)"/gmu)].map((m) => m[1]!)
  expect(
    found.length,
    `${GO_STATE_SRC} 里没解析到任何 State 常量——是解析器失效了，不是词表为空`,
  ).toBeGreaterThan(0)
  return found
}

/** 从 Go 源码的 DDL 常量里取出某张表的列名。 */
function goTableColumns(table: string): string[] {
  const block = new RegExp(
    `CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'u',
  ).exec(goDdl())
  expect(block, `${GO_STORE_SRC} 里找不到 ${table} 的建表语句`).not.toBeNull()
  return block![1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))
    .map((line) => line.split(/\s+/u)[0]!)
    .filter((name) => !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/iu.test(name))
}

/** Go 侧真实的建表语句（`const DDL = ` 后面那个反引号字面量），逐字取用。 */
function goDdl(): string {
  const src = readFileSync(GO_STORE_SRC, 'utf8')
  const match = /const DDL = `([\s\S]*?)`/u.exec(src)
  expect(match, `${GO_STORE_SRC} 里找不到 const DDL 常量`).not.toBeNull()
  return match![1]!
}

/** TS 侧 DDL 里出现过的建表语句表名。 */
function tsCreatedTables(): string[] {
  return [...CONTROL_DDL.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gu)].map((m) => m[1]!)
}

const sorted = (xs: readonly string[]) => [...xs].sort()
const SHARED = ['session_control_state', 'session_control_audit']

describe('§8.4 跨语言 schema 契约（Go 控制面 ↔ @lumo/control 插件）', () => {
  it('状态词表两侧相等', () => {
    const go = sorted(goStates())
    const ts = sorted(SESSION_CONTROL_STATES)
    expect(
      ts,
      `Go 控制面认 ${go.join('/')}，TS 生效面认 ${ts.join('/')}。` +
        `两侧不一致时，Go 写出的状态在插件侧会落进「不认识」分支——按「没有指令」处理。`,
    ).toEqual(go)
  })

  it('TS 侧 DDL 的状态 CHECK 约束接纳 Go 的每一个状态', () => {
    const check = /state\s+TEXT\s+NOT NULL\s+CHECK\s*\(state\s+IN\s*\(([^)]*)\)\)/u.exec(CONTROL_DDL)
    if (check === null) return // 没有 CHECK 就没有可违背的约束
    const allowed = [...check[1]!.matchAll(/'([^']+)'/gu)].map((m) => m[1]!)
    const rejected = goStates().filter((s) => !allowed.includes(s))
    expect(
      rejected,
      `TS 侧 CHECK 只允许 ${allowed.join('/')}，会**拒收** Go 的 ${rejected.join('/')}——` +
        `若 TS 先建表，Go 的 UPDATE 直接报 23514。`,
    ).toEqual([])
  })

  it('共用表只有 Go 一个写入方（TS 侧不再建这两张表）', () => {
    expect(
      tsCreatedTables().filter((t) => SHARED.includes(t)),
      `TS 插件仍在建 ${SHARED.join(' / ')}。两侧都用 CREATE TABLE IF NOT EXISTS，` +
        `先到先得，后到者静默拿到一张自己不认识的表。`,
    ).toEqual([])
  })

  it('TS 插件读的列都存在于 Go 的 DDL', () => {
    const columns = goTableColumns('session_control_state')
    for (const column of ['session_ref', 'state']) {
      expect(columns, `Go 的 session_control_state 缺列 ${column}`).toContain(column)
    }
  })

  it('TS 插件读的审计列都存在于 Go 的 DDL', () => {
    const columns = goTableColumns('session_control_audit')
    for (const column of ['id', 'actor_role', 'outcome', 'from_state', 'to_state', 'revision', 'created_at']) {
      expect(columns, `Go 的 session_control_audit 缺列 ${column}`).toContain(column)
    }
  })
})

describe('执行闸门（controlGate）', () => {
  it('五个状态各有档位，且只有 running 放行', () => {
    expect(controlGate('running')).toBe('allow')
    expect(controlGate('paused')).toBe('read-only')
    expect(controlGate('awaiting-approval')).toBe('read-only')
    expect(controlGate('stopped')).toBe('read-only')
    expect(controlGate('aborted')).toBe('deny')
  })

  it('词表外的状态一律 deny —— 放行等于留一个后门', () => {
    // `stopping` 是插件侧历史上的幽灵状态（Go 从不写它）：它会走到这里。
    for (const unknown of ['stopping', 'RUNNING', '', 'paused ']) {
      expect(controlGate(unknown), `状态 ${JSON.stringify(unknown)} 必须 fail-closed`).toBe('deny')
    }
  })
})

const DSN = process.env['LUMO_TEST_PG_DSN']
const live = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'

describe(`§8.4 下发链路对真 PG（需 LUMO_TEST_PG_DSN，当前${suffix}）`, () => {
  live('Go 建表并写状态 → TS seam 读回同一个状态；TS 的 init 不覆盖 Go 的 schema', async () => {
    const dsn = await schemaDsn(DSN!, 'control_seam_e2e')
    const admin = new pg.Client({ connectionString: dsn })
    await admin.connect()
    const seam = new PgControlSeam(dsn, { evaluate: () => ({ allowed: true }) })
    try {
      // 1. 用 Go 侧真实的 DDL 建表 —— 这是控制面启动时做的事。
      await admin.query(goDdl())
      await admin.query('TRUNCATE session_control_state, session_control_audit')

      // 2. TS 插件的 init 不得改动这两张表（它只建自己那张）。
      await seam.init()
      const after = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'session_control_state'
          ORDER BY ordinal_position`,
      )
      const columns = after.rows.map((r) => r.column_name)
      expect(columns, 'TS 的 init 动了 Go 的表结构').toEqual(goTableColumns('session_control_state'))

      // 3. 用 Go 的列形状写一行 paused（store.go 的 INSERT）。
      await admin.query(
        `INSERT INTO session_control_state (session_ref, realm, state, revision, last_command)
         VALUES ($1,$2,$3,$4,$5)`,
        ['e2e-1', 'dev', 'paused', 1, 'pause'],
      )

      // 4. 插件的生效面必须读到 paused —— 这一条就是「下发」的全部内容。
      expect(await seam.state('e2e-1')).toBe('paused')
      expect(controlGate(await seam.state('e2e-1'))).toBe('read-only')

      // 5. Go 写 awaiting-approval 时，插件侧必须也认（旧 CHECK 会拒收这个值）。
      await admin.query(
        `UPDATE session_control_state SET state = $1, revision = revision + 1 WHERE session_ref = $2`,
        ['awaiting-approval', 'e2e-1'],
      )
      expect(await seam.state('e2e-1')).toBe('awaiting-approval')
      expect(controlGate(await seam.state('e2e-1'))).toBe('read-only')

      // 6. 陌生会话默认 running：默认挂起会让每个新会话一上来就拒副作用工具。
      expect(await seam.state('never-seen')).toBe('running')

      // 7. 审计读面用的是 Go 的列名，且含被拒尝试。
      await admin.query(
        `INSERT INTO session_control_audit
           (session_ref, realm, command, outcome, from_state, to_state, actor, actor_role, reason, correlation_id, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        ['e2e-1', 'dev', 'pause', 'applied', 'running', 'paused', 'alice', 'operator', '临时停线', 'c-1', 1],
      )
      await admin.query(
        `INSERT INTO session_control_audit
           (session_ref, realm, command, outcome, from_state, to_state, actor, actor_role, reason, correlation_id, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        ['e2e-1', 'dev', 'abort', 'policy_denied', 'paused', 'paused', 'bob', 'viewer', '', 'c-2', 1],
      )
      const log = await seam.audit('e2e-1')
      expect(log.map((e) => e.outcome)).toEqual(['applied', 'policy_denied'])
      expect(log[1]).toMatchObject({ actor: 'bob', actorRole: 'viewer', reason: '' })
    } finally {
      await admin.query('TRUNCATE session_control_state, session_control_audit')
      await admin.end()
      await seam.close()
    }
  })
})
