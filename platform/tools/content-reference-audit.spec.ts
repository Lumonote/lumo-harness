import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { auditContentReferences, contentObjectKey, sessionContentReferences } from './content-reference-audit.mjs'
import { runContentAudit } from './audit-content-references.mjs'

const key = (char: string, realm = 'realm-a') => `${realm}/content/${char.repeat(64)}`
const execute = promisify(execFile)
function rowsClient(rows: object[]) {
  let offset = 0
  return { query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (!sql.startsWith('SELECT')) return { rows: [] }
    const size = params[params.length - 1] as number
    const page = rows.slice(offset, offset + size)
    offset += page.length
    return { rows: page }
  }) }
}

describe('共享 content 正向引用审计', () => {
  it('合并跨表正向引用，未发现引用的库存对象始终保护，其他 realm 不混入', async () => {
    const clients = {
      knowledge: rowsClient([{ doc_id: 'file-a', object_key: key('a') }]),
      governance: rowsClient([{ id: 'artifact-a', storage_key: `content/${'a'.repeat(64)}` }]),
      sessionLog: rowsClient([{ session_ref: 's1', seq: '1', payload: JSON.stringify({ message: { images: [{ attachmentId: key('a') }, { attachmentId: key('a') }, { attachmentId: key('b') }, { attachmentId: key('c', 'realm-b') }] } }) }]),
    }
    const report = await auditContentReferences({ realm: 'realm-a', clients, inventory: [key('a'), key('b'), { key: key('c'), size: 42 }, key('c', 'realm-b')], pageSize: 1 })
    expect(report).toMatchObject({ deletionAllowed: false, historyCoverage: 'partial', summary: { reportedObjects: 3, referencedObjects: 2, protectedObjects: 1 } })
    expect(report.objects.find((item: { key: string }) => item.key === key('a'))).toMatchObject({ knownReferences: 3, state: 'referenced', inventorySeen: true, deletionAllowed: false })
    expect(report.objects.find((item: { key: string }) => item.key === key('b'))).toMatchObject({ knownReferences: 1 })
    expect(report.objects.find((item: { key: string }) => item.key === key('c'))).toMatchObject({ knownReferences: 0, state: 'protected', reason: 'reference-history-incomplete', bytes: 42, deletionAllowed: false })
    for (const client of Object.values(clients)) {
      expect(client.query.mock.calls[0]![0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      expect(client.query.mock.calls.at(-1)![0]).toBe('COMMIT')
      expect(client.query.mock.calls.every(([sql]) => /^(BEGIN|SELECT|COMMIT)$/u.test(sql.split(' ')[0]!))).toBe(true)
    }
    const governanceRead = clients.governance.query.mock.calls.find(([sql]) => sql.startsWith('SELECT'))!
    expect(governanceRead[1]).toEqual(['realm-a', 1])
    expect(report.inventory.ignoredObjects).toBe(1)
  })

  it('分页上限、损坏和过大的会话记录明确留缺口，不能成为回收候选', async () => {
    const knowledge = rowsClient([{ doc_id: 'one', object_key: key('a') }, { doc_id: 'two', object_key: key('b') }, { doc_id: 'three', object_key: key('c') }])
    const sessionLog = rowsClient([{ session_ref: 's', seq: '1', payload: '{malformed' }, { session_ref: 's', seq: '2', payload: null }])
    const report = await auditContentReferences({ realm: 'realm-a', clients: { knowledge, sessionLog }, inventory: [key('a'), key('c'), key('d')], maxRows: 2, pageSize: 1 })
    expect(report.sources.knowledge).toMatchObject({ status: 'truncated', scannedRows: 2 })
    expect(report.sources.sessionLog).toMatchObject({ status: 'partial', malformedPayloads: 1, oversizedPayloads: 1 })
    expect(report.sources.governance.status).toBe('not_configured')
    expect(report.objects.every((item: { deletionAllowed: boolean }) => item.deletionAllowed === false)).toBe(true)
    expect(report.objects.find((item: { key: string }) => item.key === key('c')).state).toBe('protected')
  })

  it('表缺失或查询失败保留已发现引用，回滚事务且不泄露驱动内容', async () => {
    let reads = 0
    const knowledge = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT') && ++reads > 1) throw Object.assign(new Error('postgres://secret:password@host/database payload secret'), { code: '42P01' })
      return { rows: sql.startsWith('SELECT') ? [{ doc_id: 'one', object_key: key('a') }] : [] }
    }) }
    const report = await auditContentReferences({ realm: 'realm-a', clients: { knowledge }, inventory: [key('a'), key('b')], pageSize: 1 })
    expect(report.sources.knowledge).toMatchObject({ status: 'failed', error: '42P01', scannedRows: 1 })
    expect(knowledge.query.mock.calls.at(-1)![0]).toBe('ROLLBACK')
    expect(JSON.stringify(report)).not.toContain('password')
    expect(report.objects[0]).toMatchObject({ state: 'referenced', knownReferences: 1, deletionAllowed: false })
    expect(report.objects[1]).toMatchObject({ state: 'protected', deletionAllowed: false })
  })

  it('库存流失败与结果容量限制均被标记，任何未报告对象也不推断可删', async () => {
    async function* inventory() { yield key('a'); throw new Error('private inventory failure') }
    const failed = await auditContentReferences({ realm: 'realm-a', inventory: inventory() })
    expect(failed.inventory).toMatchObject({ status: 'failed', error: 'unavailable', scannedObjects: 1 })
    expect(failed.objects[0]).toMatchObject({ state: 'protected', deletionAllowed: false })
    const truncated = await auditContentReferences({ realm: 'realm-a', inventory: [key('a'), key('b')], maxObjects: 1 })
    expect(truncated.inventory.status).toBe('truncated')
    expect(truncated.summary.reportedObjects).toBe(1)
    expect(truncated.deletionAllowed).toBe(false)
  })

  it('会话只识别当前 realm 的完整键，歧义相对键、哈希、相似前缀不算权威引用', () => {
    const parsed = sessionContentReferences(JSON.stringify([key('a'), key('b', 'other-realm'), `other-${key('c')}`, `content/${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`, { attachmentId: key('f') }]), 'realm-a')
    expect(parsed.keys.sort()).toEqual([key('a'), key('f')])
    expect(contentObjectKey(`content/${'a'.repeat(64)}`, 'realm-a', true)).toBe(key('a'))
    expect(contentObjectKey(key('a', 'realm-b'), 'realm-a', true)).toBeUndefined()
    expect(contentObjectKey('realm-a/content/../../private', 'realm-a')).toBeUndefined()
    expect(sessionContentReferences(JSON.stringify(Array.from({ length: 20 }, () => key('a'))), 'realm-a', 5).truncated).toBe(true)
  })

  it('离线 JSONL 命令实际产出只读报告；缺失文件回报受保护缺口', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumo-content-audit-'))
    const entry = new URL('./audit-content-references.mjs', import.meta.url).pathname
    try {
      const inventory = join(dir, 'objects.jsonl')
      await writeFile(inventory, `${JSON.stringify(key('a'))}\n${JSON.stringify({ key: key('b'), size: 21 })}\n`)
      const { stdout } = await execute(process.execPath, [entry, '--realm', 'realm-a', '--inventory', inventory], { env: {} })
      const report = JSON.parse(stdout)
      expect(report.summary).toMatchObject({ reportedObjects: 2, referencedObjects: 0, protectedObjects: 2 })
      expect(report.objects.every((item: { deletionAllowed: boolean }) => item.deletionAllowed === false)).toBe(true)
      try { await execute(process.execPath, [entry, '--realm', 'realm-a', '--inventory', join(dir, 'missing.jsonl')], { env: {} }); throw new Error('must fail') }
      catch (error) {
        expect((error as { code: number }).code).toBe(2)
        const failed = JSON.parse((error as { stdout: string }).stdout)
        expect(failed.inventory).toMatchObject({ status: 'failed' })
        expect(failed.deletionAllowed).toBe(false)
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

const DSN = process.env.LUMO_TEST_PG_DSN
describe('content reference audit SQL (real PostgreSQL)', () => {
  ;(DSN ? it : it.skip)('scans real production-shaped tables using read-only transactions and preserves unknown history', async () => {
    const { Client } = createRequire(new URL('../dsh-plugins/knowledge/package.json', import.meta.url))('pg')
    const client = new Client({ connectionString: DSN })
    await client.connect()
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS content_reference_audit_test')
      await client.query('SET search_path TO content_reference_audit_test')
      await client.query(`CREATE TABLE IF NOT EXISTS knowledge_library_files(doc_id TEXT PRIMARY KEY,realm TEXT NOT NULL,object_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS governance_task_artifacts(id TEXT PRIMARY KEY,realm TEXT NOT NULL,storage_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_log(session_ref TEXT NOT NULL,seq BIGINT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_ref,seq));
        TRUNCATE knowledge_library_files,governance_task_artifacts,session_log;`)
      await client.query('INSERT INTO knowledge_library_files VALUES($1,$2,$3),($4,$5,$6)', ["file'quoted", 'realm-a', key('a'), 'other', 'realm-b', key('a', 'realm-b')])
      await client.query('INSERT INTO governance_task_artifacts VALUES($1,$2,$3)', ['artifact-a', 'realm-a', `content/${'a'.repeat(64)}`])
      await client.query('INSERT INTO session_log VALUES($1,1,$2),($1,2,$3),($1,10,$4)', ['session-a', JSON.stringify({ images: [{ attachmentId: key('b') }, { attachmentId: key('b') }] }), 'malformed payload', JSON.stringify({ image: { attachmentId: key('a') } })])
      const reader = { query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT')) expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
        return client.query(sql, params)
      } }
      const report = await auditContentReferences({ realm: 'realm-a', clients: { knowledge: reader, governance: reader, sessionLog: reader }, inventory: [key('a'), key('b'), key('c')], pageSize: 1 })
      expect(report.sources.knowledge).toMatchObject({ status: 'scanned', scannedRows: 1 })
      expect(report.sources.governance).toMatchObject({ status: 'scanned', scannedRows: 1 })
      expect(report.sources.sessionLog).toMatchObject({ status: 'partial', scannedRows: 3, malformedPayloads: 1 })
      expect(report.objects.find((item: { key: string }) => item.key === key('a'))).toMatchObject({ knownReferences: 3, deletionAllowed: false })
      expect(report.objects.find((item: { key: string }) => item.key === key('b'))).toMatchObject({ knownReferences: 1, deletionAllowed: false })
      expect(report.objects.find((item: { key: string }) => item.key === key('c'))).toMatchObject({ knownReferences: 0, state: 'protected', deletionAllowed: false })
      expect((await client.query('SELECT count(*)::int AS count FROM session_log')).rows[0].count).toBe(3)
      const scoped = new URL(DSN!)
      scoped.searchParams.set('options', '-c search_path=content_reference_audit_test')
      const cliReport = await runContentAudit(['--realm', 'realm-a', '--page-size', '1'], { LUMO_CONTENT_AUDIT_PG_DSN: scoped.toString() })
      expect(cliReport.sources.knowledge).toMatchObject({ status: 'scanned', scannedRows: 1 })
      expect(cliReport.sources.sessionLog).toMatchObject({ status: 'partial', scannedRows: 3 })
      expect(cliReport.deletionAllowed).toBe(false)
    } finally { await client.end() }
  })
})
