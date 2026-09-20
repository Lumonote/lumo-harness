/**
 * 跨语言契约：`project_decisions`（§24.4 决策记忆）由 **Go 控制面**
 * （`control-plane/projects`）建表并写入，由 **TS 插件 `@lumo/project`** 读出后
 * 喂给模型上下文。两侧之间没有编译期约束——改一边的 kind 词表或列名，另一边照样
 * `tsc` 干净，只是运行时读到不认识的值后**静默少几条记忆**。
 *
 * 三条纪律（与 `dsh-plugins/control/__tests__/control-schema-contract.spec.ts` 同源）：
 *
 *   1. **判据从源码推导，不手抄字符串**。kind 闭集与两个行数上限都现场解析 Go 源码；
 *      解析到 0 条要断言失败——「没有规则要查」与「规则全通过」在退出码上一模一样。
 *   2. **TS 只读**。追加与取代必须同一个事务（插新行 + 只回填旧行的 superseded_by +
 *      CAS）；这份事务只允许有一处实现。本文件断言 TS 侧连一条 INSERT/UPDATE 都没有，
 *      并断言 Go 侧那个 CAS 条件确实在。
 *   3. **有界与作用域写在 SQL 里**。跨 realm 得到空集、索引不带 body、LIMIT 必在——
 *      这三条是读面的全部安全性，靠断言 SQL 文本而不是靠注释。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { schemaDsn } from '../../session-log/__tests__/pg-schema.ts'
import {
  DECISION_BODY_SQL,
  DECISION_INDEX_DEFAULT_LIMIT,
  DECISION_INDEX_MAX_LIMIT,
  DECISION_KINDS,
  ProjectService,
  decisionIndexQuery,
  resolveDecisionIndexLimit,
} from '../src/service.ts'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '../../..')

const GO_DOMAIN = resolve(platformRoot, 'control-plane/projects/internal/domain/decisions.go')
const GO_STORE = resolve(platformRoot, 'control-plane/projects/internal/store/store.go')
const GO_STORE_DECISIONS = resolve(platformRoot, 'control-plane/projects/internal/store/decisions.go')

const goSource = (path: string): string => readFileSync(path, 'utf8')

/** kind 闭集：只认 `DecisionKindXxx = "…"` 形状的常量行。 */
function goDecisionKinds(): string[] {
  const found = [...goSource(GO_DOMAIN).matchAll(/^\tDecisionKind\w+\s+=\s+"([^"]+)"/gmu)].map((m) => m[1]!)
  expect(found.length, `${GO_DOMAIN} 里没解析到 kind 常量——是解析器失效了，不是闭集为空`).toBeGreaterThan(0)
  return found
}

function goIntConst(name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'u').exec(goSource(GO_DOMAIN))
  expect(m, `${GO_DOMAIN} 里找不到常量 ${name}`).not.toBeNull()
  return Number(m![1])
}

/** 从 Go 的 `const DDL = \`…\`` 里取建表语句（与 shared/__tests__/ddl-ownership 同一取法）。 */
function goDdl(): string {
  const m = /const DDL = `([\s\S]*?)`/u.exec(goSource(GO_STORE))
  expect(m, `${GO_STORE} 里找不到 const DDL 的模板字面量`).not.toBeNull()
  expect(m![1]!, 'DDL 含插值——静态提取不完整，判据会静默变弱').not.toContain('${')
  expect(m![1]!, 'DDL 里没有 CREATE TABLE').toContain('CREATE TABLE')
  return m![1]!
}

const DSN = process.env['LUMO_TEST_PG_DSN']
const live = DSN ? it : it.skip

describe('决策记忆：Go ↔ TS 契约（常跑，不依赖 DSN）', () => {
  it('kind 闭集与两个上限与 Go 侧逐字一致', () => {
    expect([...DECISION_KINDS].sort()).toEqual(goDecisionKinds().sort())
    expect(DECISION_INDEX_DEFAULT_LIMIT).toBe(goIntConst('DecisionIndexDefaultLimit'))
    expect(DECISION_INDEX_MAX_LIMIT).toBe(goIntConst('DecisionIndexMaxLimit'))
    expect(DECISION_INDEX_DEFAULT_LIMIT).toBeLessThan(DECISION_INDEX_MAX_LIMIT)
  })

  it('索引查询：realm 过滤 + 只认 live + 无 body + LIMIT 必在', () => {
    for (const sql of [decisionIndexQuery(), decisionIndexQuery('trap')]) {
      expect(sql).toContain('realm = $1')
      expect(sql).toContain('project_id = $2')
      expect(sql).toContain('superseded_by IS NULL')
      expect(sql).toContain('ORDER BY created_at DESC')
      expect(sql).toMatch(/LIMIT \$\d/u)
      // 索引层不许出现 body：那一列一进来，索引就从命中表变成正文的第二份拷贝
      expect(sql.replace(/\$\d/gu, ''), '索引查询带了 body').not.toMatch(/\bbody\b/u)
    }
    // kind 过滤是可选的：传了才拼条件（拼成 `($3='' OR kind=$3)` 会让部分索引用不上）
    expect(decisionIndexQuery()).not.toContain('kind =')
    expect(decisionIndexQuery('trap')).toContain('kind = $3')
  })

  it('正文查询：按 id 取，且**不过滤** superseded_by（考古层要读得到）', () => {
    expect(DECISION_BODY_SQL).toContain('body')
    expect(DECISION_BODY_SQL).toContain('realm = $1')
    expect(DECISION_BODY_SQL).toContain('project_id = $2')
    expect(DECISION_BODY_SQL).toContain('id = $3')
    expect(DECISION_BODY_SQL).not.toContain('superseded_by IS NULL')
  })

  it('TS 侧只读：没有 INSERT/UPDATE/DELETE，也不建表', () => {
    const stripped = readFileSync(resolve(here, '../src/service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|[^:])\/\/[^\n]*/gmu, '$1')
    for (const verb of ['INSERT INTO project_decisions', 'UPDATE project_decisions', 'DELETE FROM project_decisions']) {
      expect(stripped, `TS 侧出现了写入（${verb}）——取代事务只允许有一处实现`).not.toContain(verb)
    }
    expect(stripped, 'TS 侧不得建 project_decisions（一张表一个建表方：Go store.go）').not.toMatch(
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?project_decisions/u,
    )
    // 而 Go 侧的 CAS 条件必须真的在（它是「不重复取代」的唯一实现）
    expect(goSource(GO_STORE_DECISIONS)).toContain('AND superseded_by IS NULL')
  })

  it('limit 收敛到 [1, 上限]（与 Go 侧同判序）', () => {
    expect(resolveDecisionIndexLimit()).toBe(DECISION_INDEX_DEFAULT_LIMIT)
    expect(resolveDecisionIndexLimit(0)).toBe(DECISION_INDEX_DEFAULT_LIMIT)
    expect(resolveDecisionIndexLimit(-5)).toBe(DECISION_INDEX_DEFAULT_LIMIT)
    expect(resolveDecisionIndexLimit(Number.NaN)).toBe(DECISION_INDEX_DEFAULT_LIMIT)
    expect(resolveDecisionIndexLimit(1)).toBe(1)
    expect(resolveDecisionIndexLimit(DECISION_INDEX_MAX_LIMIT + 1)).toBe(DECISION_INDEX_MAX_LIMIT)
    expect(resolveDecisionIndexLimit(1 << 20)).toBe(DECISION_INDEX_MAX_LIMIT)
  })
})

describe('决策记忆：真库（Go 的 DDL + Go 的写入形状 → TS 读回）', () => {
  live('索引只回 live 行、跨 realm 为空集、正文按需读、闭集外 kind 抛错', async () => {
    const dsn = await schemaDsn(DSN!, 'project_decisions_e2e')
    const client = new pg.Client({ connectionString: dsn })
    await client.connect()
    try {
      await client.query(goDdl())
      // schema 是复用的（pg-schema.ts 的理由：DROP/CREATE 会与并行文件抢锁），
      // 所以每轮先把本表清空——否则第二次跑会撞主键，变成「第一次绿之后永远红」。
      await client.query('TRUNCATE project_decisions')
      // 按 Go 侧的写入形状造数据：新行 insert + 只回填旧行的 superseded_by
      await client.query(`
        INSERT INTO project_decisions (id, realm, project_id, kind, summary, body, supersedes, evidence)
        VALUES ('dec_old','raft','proj_a','decision','发布日期改到周五','旧正文',NULL,'[{"session_ref":"s1","seq":3}]'::jsonb),
               ('dec_new','raft','proj_a','decision','发布日期改到下周三','新正文','dec_old',NULL)`)
      await client.query(
        `UPDATE project_decisions SET superseded_by = 'dec_new' WHERE id = 'dec_old'`)

      const service = new ProjectService(dsn, 'raft')
      try {
        const index = await service.decisionIndex('proj_a')
        expect(index).toHaveLength(1)
        expect(index[0]!.id).toBe('dec_new')
        expect(index[0]!.supersedes).toBe('dec_old')
        // 索引层没有 body 这个字段——类型与查询同证「常驻的那层只有一行摘要」
        expect(Object.keys(index[0]!)).not.toContain('body')

        // 作用域：别的 realm 读同一个 project_id 必须是空集，**不是错误**
        const otherRealm = new ProjectService(dsn, 'other')
        await expect(otherRealm.decisionIndex('proj_a')).resolves.toEqual([])
        await expect(otherRealm.decisionBody('proj_a', 'dec_new')).resolves.toBeUndefined()
        await otherRealm.close()

        // 正文层：被取代的行照样读得到，且证据坐标原样
        const body = await service.decisionBody('proj_a', 'dec_old')
        expect(body?.body).toBe('旧正文')
        expect(body?.supersededBy).toBe('dec_new')
        expect(body?.evidence).toEqual([{ session_ref: 's1', seq: 3 }])

        // 闭集外 kind：抛错而不是「查不到就返回空」
        await expect(service.decisionIndex('proj_a', { kind: 'note' as never })).rejects.toThrow(/未知决策 kind/u)
        // 有界：limit 超上限被夹住（这里只有 1 行 live，但调用不得越界）
        await expect(service.decisionIndex('proj_a', { limit: 10_000 })).resolves.toHaveLength(1)
      } finally {
        await service.close()
      }
    } finally {
      await client.end()
    }
  })
})
