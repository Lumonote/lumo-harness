/**
 * 仓库级契约：**一张表只能有一个建表方；共表的两个建表方必须收敛到同一个结构。**
 *
 * 为什么需要它：本仓库存在大量「两个实现各自 `CREATE TABLE IF NOT EXISTS` 同一张表」的
 * 结构。TS 插件与 Go 控制面服务**同库、同时在线**（compose/helm 里 `LUMO_PG_DSN` 指向
 * 同一个库），谁先启动谁定 schema，后到者的 `CREATE` 是**空操作**——它静默拿到一张
 * 自己没写过的表，此后按自己的假设读写它。
 *
 * 这类分歧在两侧各自的测试里**看不见**：`projects` 与 `governance` 的集成测试各起一个
 * 库（`deploy/test-local-pg.sh` 按模块分库），从来没有哪个用例把两份 DDL 放进同一个库。
 * 于是「测试全绿」与「生产上谁先启动谁赢」可以同时成立。
 *
 * 已经咬过三次：
 *   - `session_control_state` / `session_control_audit`：Go 五态词表 vs TS 四态 + CHECK。
 *     TS 先建表则 Go 写 `awaiting-approval` 报 23514；Go 先建表则插件的闸门把不认识的
 *     状态当「没有指令」**放行**——已暂停或等审批的会话，副作用工具照跑。
 *     修法与取证见 `dsh-plugins/control/__tests__/control-schema-contract.spec.ts`。
 *   - `task_reports`：governance 声明了它（还带 `REFERENCES … ON DELETE CASCADE`）但
 *     **零读写**，读写方只有 projects，且 projects 那份不带 FK。governance 先启动则
 *     projects 的 INSERT 对任何 governance 不认识的 task_id 直接 500。
 *   - `project_spaces`：Go 有 `UNIQUE (project_id, name)`、TS 没有。Go 的 `createSpace`
 *     把 upsert 错误映射成 409「space conflict」——TS 先建表时那条分支**静默失效**。
 *
 * 四条纪律：
 *   1. **判据从源码推导**。表名与 DDL 都现场解析，不手抄；解析到 0 条要断言失败——
 *      「没有规则要查」与「规则全通过」在退出码上完全一样。
 *   2. **结构比较交给数据库**。两份 DDL 各建一遍，再问 PG「实际长什么样」（列 / 唯一
 *      索引 / 外键）。文本比较会被缩进与 `NULL` 之类的无害差异淹没，而语义比较不需要
 *      维护「已知无害差异」清单——那种清单会在写下的那一刻开始腐烂。
 *   3. **迁移与服务 DDL 必须收敛**。没有任何 Compose 文件跑 `deploy/migrate.sh`
 *      （见 `docs/cluster-development-tasks.md`），所以迁移里的每条非建表语句都必须
 *      也出现在**该表每一个非迁移建表方**的 DDL 里。这条约定在 004 的注释里写着，
 *      但 002 与 003 当时都没做到——本文件把它变成判据。
 *   4. **没有断言的地方要写出来**。共表清单里每一张表要么有结构断言，要么有一条
 *      书面理由。说不出来的共表本身就是缺陷。
 *
 * 本机注意（见 `.workbuddy-ai/memory/local-sandbox.md`）：这台机器上 `readFileSync`
 * 每次调用约 150ms（与文件大小无关），619 个文件串行读要 90 秒以上。所以扫描一律走
 * `readText()` 的并发池 + 记忆化，本机约 6 秒、CI 上可忽略。
 */
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { schemaDsn } from '../../dsh-plugins/session-log/__tests__/pg-schema.ts'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '../..')

/**
 * `shared/` 没有**运行期**的 pg 依赖（`shared/subagent-receipts.ts` 只做 type-only
 * import，编译后消失），所以从已经装了 pg 的插件包里解析。选 session-log 是为了与
 * 上面 schemaDsn 的来源保持一致——两个都指向同一个 pg 实例，避免同进程里出现两份
 * 连接池实现。
 */
type PgClient = {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}
const pg = createRequire(join(platformRoot, 'dsh-plugins/session-log/package.json'))('pg') as {
  Client: new (config: { connectionString: string }) => PgClient
}

const SCAN_ROOTS = ['control-plane', 'dsh-plugins', 'shared', 'data-plane', 'deploy']
const SCAN_EXT = new Set(['.go', '.ts', '.tsx', '.mts', '.sql'])
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'target', '.build', 'lib', '__pycache__', 'generated', 'assets',
])

const MIGRATION_DIR = 'deploy/migrations'

function walk(rel: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(platformRoot, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(child, out)
    } else if (SCAN_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(child)
    }
  }
  return out
}

/** 只扫**生产**文件：测试里自建表是刻意的（夹具要跑真实 DDL），不是建表方。 */
function isTestFile(rel: string): boolean {
  return /(^|\/)(__tests__|testdata)\//u.test(rel)
    || /_test\.go$/u.test(rel)
    || /\.spec\.tsx?$/u.test(rel)
}

const scannedFiles = SCAN_ROOTS
  .flatMap((root) => walk(root))
  .filter((rel) => !isTestFile(rel))
  .sort()

/**
 * 去注释再扫描。
 *
 * 不是为了好看：本仓库的 DDL 常量里大量出现「CREATE TABLE IF NOT EXISTS 对既有库是
 * 空操作…」这类注释，而注释里提到建表语句恰恰是在**解释**为什么不在这里建表。把注释
 * 算作声明会让扫描结果全是噪音。`://` 里的 `//` 不是注释起点，所以要求前一个字符不是
 * 冒号。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
    .replace(/--[^\n]*/gu, '')
}

/**
 * 把 Go 里 `"字面量" + 常量 + "字面量"` 的拼接折成一段文本。
 *
 * 为什么需要：`control-plane/heartbeat/heartbeat.go` 的 DDL 是拼出来的
 * （`` `CREATE TABLE IF NOT EXISTS ` + Table + ` (` ``），不折的话扫描器既看不见它建了
 * 哪张表、也看不见迁移 004 的三条 ALTER 是不是真被抄了过去——而 004 的注释恰恰承诺了
 * 后者。常量值**从源码现场取**（`const X = "..."`），不手抄。
 *
 * 认不出的标识符就原样保留，不猜。因此它只会让「找不到」保持「找不到」（响亮的失败），
 * 不会把缺失伪装成存在。
 */
function foldGoStringConcat(src: string): string {
  const consts = new Map<string, string>()
  // 两种写法都要认：`const X = "…"` 与 `const ( X = "…" )` 块里没有 const 前缀的那种。
  for (const m of src.matchAll(/^\s*(?:const\s+)?([A-Za-z_]\w*)\s*=\s*"([^"\\]*)"\s*$/gmu)) {
    consts.set(m[1]!, m[2]!)
  }
  if (consts.size === 0) return src

  const CONCAT = /(?:`[^`]*`|"[^"\\]*"|[A-Za-z_]\w*)(?:\s*\+\s*(?:`[^`]*`|"[^"\\]*"|[A-Za-z_]\w*))+/gu
  return src.replace(CONCAT, (expr) => {
    let out = ''
    for (const part of expr.split(/\s*\+\s*/u)) {
      if (part.startsWith('`')) { out += part.slice(1, -1); continue }
      if (part.startsWith('"')) { out += part.slice(1, -1); continue }
      const value = consts.get(part)
      if (value === undefined) return expr
      out += value
    }
    return out
  })
}

const READ_CONCURRENCY = 128
const textCache = new Map<string, Promise<string>>()

function readText(rel: string): Promise<string> {
  let p = textCache.get(rel)
  if (p === undefined) {
    p = readFile(join(platformRoot, rel), 'utf8')
      .then(stripComments)
      .then((src) => (rel.endsWith('.go') ? foldGoStringConcat(src) : src))
    textCache.set(rel, p)
  }
  return p
}

async function readAll(rels: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let next = 0
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, rels.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= rels.length) return
      const rel = rels[i]!
      out.set(rel, await readText(rel))
    }
  })
  await Promise.all(workers)
  return out
}

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]*)/giu

interface Site {
  file: string
  /** 字面量表名；名字由拼接/插值产生时为 null。 */
  table: string | null
  token: string
}

let siteCache: Promise<Site[]> | undefined

function createTableSites(): Promise<Site[]> {
  siteCache ??= (async () => {
    const texts = await readAll(scannedFiles)
    const sites: Site[] = []
    for (const file of scannedFiles) {
      for (const m of texts.get(file)!.matchAll(CREATE_TABLE)) {
        const token = m[1] ?? ''
        sites.push({
          file,
          table: /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token) ? token : null,
          token,
        })
      }
    }
    return sites
  })()
  return siteCache
}

/**
 * 扫描器**看不见**的建表点：表名由插值产生（Go 的字符串拼接已经由
 * `foldGoStringConcat` 折掉，所以这里只剩真正的运行期生成）。每一处都必须在这里
 * 认领，否则新增一处就没人再问了。`table` 填 null 表示这一族表名运行时才生成。
 */
const DYNAMIC_DECLARATIONS: Array<{ file: string; table: string | null; reason: string }> = [
  {
    file: 'dsh-plugins/storage/src/index.ts',
    table: null,
    reason:
      '表名按 KV unit 描述符运行时生成：u_<unit>_<table>（见 src/schema.ts 的 recordTableName）。' +
      'u_ 前缀族与全仓其它字面量表名无一重合，不与其他服务共表。',
  },
]

/** 表名 → 建表方（生产文件；动态点按上面的认领并入）。 */
let declarationCache: Promise<Map<string, Set<string>>> | undefined

function declarations(): Promise<Map<string, Set<string>>> {
  declarationCache ??= (async () => {
    const map = new Map<string, Set<string>>()
    const add = (table: string, file: string) => {
      const set = map.get(table) ?? new Set<string>()
      set.add(file)
      map.set(table, set)
    }
    for (const site of await createTableSites()) {
      if (site.table !== null) add(site.table, site.file)
    }
    for (const d of DYNAMIC_DECLARATIONS) {
      if (d.table !== null) add(d.table, d.file)
    }
    return map
  })()
  return declarationCache
}

interface DdlSource {
  /** 整段取用（迁移 .sql）或从这些文件里提取 constName 的模板字面量。 */
  files: string[]
  constName?: string
}

const ddlCache = new Map<string, Promise<string>>()

function ddlOf(src: DdlSource): Promise<string> {
  const key = `${src.files.join(',')}#${src.constName ?? ''}`
  let p = ddlCache.get(key)
  if (p === undefined) {
    p = (async () => {
      const texts = await Promise.all(src.files.map(readText))
      if (src.constName === undefined) return texts.join(';\n')

      const match = new RegExp(`const ${src.constName}\\s*=\\s*\`([\\s\\S]*?)\``, 'u').exec(texts.join('\n'))
      expect(match, `${src.files.join(', ')} 里找不到 const ${src.constName} 的模板字面量`).not.toBeNull()
      const body = match![1]!
      expect(
        body,
        `${src.files.join(', ')} 的 ${src.constName} 含插值——静态提取不完整，判据会静默变弱`,
      ).not.toContain('${')
      // 解析器自证：取到的必须是真 DDL，不是某个同名的短字符串。
      expect(body, `${src.constName} 里没有 CREATE TABLE`).toContain('CREATE TABLE')
      return body
    })()
    ddlCache.set(key, p)
  }
  return p
}

function tablesIn(ddl: string): string[] {
  return [...ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/giu)]
    .map((m) => m[1]!)
    .sort()
}

/**
 * 共表对：两份 DDL 各建一遍，比较**实际结构**。
 * 比较的表 = 两份 DDL 都建的表的交集（不手抄清单：手抄的那份会与 DDL 脱节）。
 */
const SHAPE_CHECKS: Array<{ label: string; a: DdlSource; b: DdlSource }> = [
  {
    label: 'projects 一族（TS @lumo/project ↔ Go control-plane/projects）',
    a: { files: ['dsh-plugins/project/src/service.ts'], constName: 'PROJECT_DDL' },
    b: { files: ['control-plane/projects/internal/store/store.go'], constName: 'DDL' },
  },
  {
    label: 'collab_space_grants（Go collaborator ↔ 迁移 002）',
    a: { files: [`${MIGRATION_DIR}/002_collaborator_realm_grants.sql`] },
    b: { files: ['control-plane/collaborator/internal/store/store.go'], constName: 'DDL' },
  },
]

const sharedCache = new Map<string, Promise<string[]>>()

function sharedTablesOf(check: (typeof SHAPE_CHECKS)[number]): Promise<string[]> {
  let p = sharedCache.get(check.label)
  if (p === undefined) {
    p = (async () => {
      const inA = new Set(tablesIn(await ddlOf(check.a)))
      const shared = tablesIn(await ddlOf(check.b)).filter((t) => inA.has(t))
      expect(shared, `${check.label}：两份 DDL 没有共同建的表——这对共表是不是已经拆开了？`).not.toEqual([])
      return shared
    })()
    sharedCache.set(check.label, p)
  }
  return p
}

let sharedTablesCache: Promise<string[]> | undefined

function sharedTables(): Promise<string[]> {
  sharedTablesCache ??= Promise.all(SHAPE_CHECKS.map(sharedTablesOf)).then((lists) => lists.flat())
  return sharedTablesCache
}

/**
 * 共表但没有结构断言的，理由必须写出来。写不出理由的共表本身就是缺陷。
 */
const SHARED_WITHOUT_SHAPE_CHECK: Record<string, string> = {
  usage_ledger:
    '两侧都不是手写列清单：TS 直接 import shared/manifests/usage-ledger.schema.json，' +
    'Go 在 control-plane/usage-ledger/internal/manifest 里 embed 同一份的副本。' +
    '漂移由两道既有锁看守——Go 的 manifest_test.go 与原件逐字节双向比对，' +
    'TS 的 dsh-plugins/metering/__tests__/outbox.spec.ts 锁 19 列基线。' +
    '这里不加结构断言的原因是 Go 侧 DDL 由清单在**运行期**生成（manifest.LedgerDDL），' +
    '静态取不到；而在 TS 里把 Go 的生成规则重写一遍，等于用手抄的判据去测另一份手抄的判据。',
  lumo_service_heartbeats:
    '服务侧 DDL 由 Go 常量拼装而成（SchemaSQL = CreateTableSQL + ";" + UpgradeSQL），' +
    '折掉字符串拼接后能看见「建了哪张表」和「抄了哪几条 ALTER」，但取不到一段可直接执行' +
    '的完整 DDL——CreateTableSQL 与 UpgradeSQL 本身是非字符串常量，折不动。' +
    '收敛性有断言（迁移 004 的三条 ALTER 必须在 heartbeat.go 里逐条出现），' +
    '缺的只是「建完再内省一遍」这一步。',
}

const DSN = process.env['LUMO_TEST_PG_DSN']
const live = DSN ? it : it.skip
const dsnState = DSN ? '已设置' : '未设置 → 跳过，非通过'

/**
 * 先把 619 个文件读进来。本机一次扫描约 5 秒（见文件头），正好卡在 vitest 默认的
 * 5 秒超时上——于是同一条用例会「有时红有时绿」。预热一次并给足预算，各用例本身
 * 就都只剩毫秒级。
 */
beforeAll(async () => {
  await declarations()
}, 120_000)

describe('建表方归属（常跑，不依赖 DSN）', () => {
  it('扫描器自证：至少扫到几十张表，不是解析器坏了', async () => {
    const sites = await createTableSites()
    expect(
      sites.filter((s) => s.table !== null).length,
      '一个字面量表名都没扫到——是解析器失效了，不是仓库里没有 DDL',
    ).toBeGreaterThan(50)
  })

  it('同一张表不得有两个建表方，除非它在共表清单里', async () => {
    const allowed = new Set([...await sharedTables(), ...Object.keys(SHARED_WITHOUT_SHAPE_CHECK)])
    const offenders = [...await declarations()]
      .filter(([table, files]) => files.size > 1 && !allowed.has(table))
      .map(([table, files]) => `${table} ← ${[...files].sort().join(' + ')}`)
    expect(
      offenders,
      '同一张表被两个实现各自 CREATE TABLE IF NOT EXISTS：先到先得，后到者静默拿到一张' +
        '自己不认识的表。要么把它并进共表清单（并在 SHAPE_CHECKS 或 ' +
        'SHARED_WITHOUT_SHAPE_CHECK 里表态），要么让唯一写入方独占建表。',
    ).toEqual([])
  })

  it('共表清单不得过期：每个名字都得真的被两个建表方声明', async () => {
    const decls = await declarations()
    const allowed = [...await sharedTables(), ...Object.keys(SHARED_WITHOUT_SHAPE_CHECK)]
    const stale = allowed.filter((table) => (decls.get(table)?.size ?? 0) < 2)
    expect(
      stale,
      '这些表已经不再被两个建表方声明了，却还留在共表清单里——清单在撒谎。' +
        '把它们从 SHAPE_CHECKS / SHARED_WITHOUT_SHAPE_CHECK 里删掉。',
    ).toEqual([])
  })

  it('同一张表不得既有结构断言、又写着「不检查」的理由', async () => {
    const checked = new Set(await sharedTables())
    const overlap = Object.keys(SHARED_WITHOUT_SHAPE_CHECK).filter((t) => checked.has(t))
    expect(overlap, '两处会各自漂移，只留一处').toEqual([])
  })

  it('动态建表点必须逐个认领，且认领的表名确实在源文件里', async () => {
    const found = (await createTableSites()).filter((s) => s.table === null).map((s) => s.file)
    expect(
      [...new Set(found)].sort(),
      '扫描器看不见的建表点变了。新增一处要在这里认领（并想清楚它是否与别处共表），' +
        '删掉一处要把对应条目删掉。',
    ).toEqual([...DYNAMIC_DECLARATIONS.map((d) => d.file)].sort())

    for (const d of DYNAMIC_DECLARATIONS) {
      if (d.table === null) continue
      expect(
        await readText(d.file),
        `${d.file} 里已经没有 ${d.table} 了——认领条目过期，归属检查会漏掉这张表`,
      ).toContain(d.table)
    }
  })
})

function migrationFiles(): string[] {
  return readdirSync(join(platformRoot, MIGRATION_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `${MIGRATION_DIR}/${f}`)
}

function statementsOf(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.replace(/\s+/gu, ' ').trim())
    .filter((s) => s !== '')
}

function targetTable(stmt: string): string | null {
  const alter = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/iu.exec(stmt)
  if (alter) return alter[1]!
  const on = /\bON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/iu.exec(stmt)
  return on ? on[1]! : null
}

const flatCache = new Map<string, Promise<string>>()

function flattenedSource(rel: string): Promise<string> {
  let p = flatCache.get(rel)
  if (p === undefined) {
    p = readText(rel).then((s) => s.replace(/\s+/gu, ' '))
    flatCache.set(rel, p)
  }
  return p
}

describe('迁移 ↔ 服务 DDL 收敛（常跑，不依赖 DSN）', () => {
  /**
   * 004 的注释承诺「服务侧 DDL 执行同样的语句，从不跑 migrate.sh 的 Compose 部署
   * 收敛到同一形状」。这条用例就是那个承诺的判据。
   *
   * 候选建表方**排除迁移文件自己**——否则「迁移里有这条语句」会让断言自证成立。
   * 要求是**该表每一个非迁移建表方**都有，因为共表的每个写入方都得自己收敛。
   */
  it('迁移里的每条非建表语句，都必须出现在该表每一个非迁移建表方的 DDL 里', async () => {
    const decls = await declarations()
    const checked: string[] = []
    const missing: string[] = []

    for (const file of migrationFiles()) {
      for (const stmt of statementsOf(await readText(file))) {
        if (/^CREATE\s+TABLE/iu.test(stmt)) continue

        const table = targetTable(stmt)
        if (table === null) {
          missing.push(`${file}: 认不出目标表 → ${stmt}`)
          continue
        }
        const declarers = [...(decls.get(table) ?? [])].filter((f) => !f.startsWith(`${MIGRATION_DIR}/`))
        if (declarers.length === 0) {
          missing.push(`${file}: ${table} 没有任何非迁移建表方 → ${stmt}`)
          continue
        }
        checked.push(`${file} → ${table}`)
        for (const declarer of declarers) {
          if (!(await flattenedSource(declarer)).includes(stmt)) {
            missing.push(`${file}: ${declarer} 里找不到 → ${stmt}`)
          }
        }
      }
    }

    expect(
      checked.length,
      '一条非建表语句都没查到——是解析器失效了，不是迁移里没有 ALTER',
    ).toBeGreaterThan(0)
    expect(
      missing,
      '没有任何 Compose 文件跑 deploy/migrate.sh，所以只走服务自带 DDL 的部署**永远**' +
        '看不到这些语句。要么把语句逐字抄进服务 DDL，要么把它从迁移里删掉。',
    ).toEqual([])
  })

  it('扫描到的迁移文件数 == 磁盘上的 .sql 数（防漏读）', () => {
    const onDisk = readdirSync(join(platformRoot, MIGRATION_DIR)).filter((f) => f.endsWith('.sql'))
    expect(migrationFiles()).toHaveLength(onDisk.length)
    expect(migrationFiles().length).toBeGreaterThan(0)
  })
})

interface Shape {
  columns: unknown[]
  unique: unknown[]
  foreignKeys: unknown[]
}

async function shapeOf(client: PgClient, table: string): Promise<Shape> {
  const columns = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  )
  expect(columns.rows.length, `${table} 没被建出来——结构比较会空过`).toBeGreaterThan(0)

  const unique = await client.query(
    `SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attname) AS columns
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
      WHERE n.nspname = current_schema() AND t.relname = $1 AND x.indisunique
      GROUP BY c.relname
      ORDER BY c.relname`,
    [table],
  )
  const foreignKeys = await client.query(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relname = $1 AND c.contype = 'f'
      ORDER BY c.conname`,
    [table],
  )
  return { columns: columns.rows, unique: unique.rows, foreignKeys: foreignKeys.rows }
}

async function shapeUnderDdl(ddl: string, tables: string[], schema: string): Promise<Record<string, Shape>> {
  const client = new pg.Client({ connectionString: await schemaDsn(DSN!, schema) })
  await client.connect()
  try {
    // 上一次运行留下的表要先清掉：schemaDsn 按设计不 DROP schema。
    await client.query(`DROP TABLE IF EXISTS ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`)
    await client.query(ddl)
    const out: Record<string, Shape> = {}
    for (const table of tables) out[table] = await shapeOf(client, table)
    return out
  } finally {
    await client.end()
  }
}

describe(`共表结构一致（需 LUMO_TEST_PG_DSN，当前${dsnState}）`, () => {
  for (const [index, check] of SHAPE_CHECKS.entries()) {
    live(`${check.label}：两份 DDL 建出的结构逐项相同`, async () => {
      const tables = await sharedTablesOf(check)
      const a = await shapeUnderDdl(await ddlOf(check.a), tables, `ddlshape_a_${index}`)
      const b = await shapeUnderDdl(await ddlOf(check.b), tables, `ddlshape_b_${index}`)
      for (const table of tables) {
        expect(
          a[table],
          `${table}：${check.a.files.join(', ')} 与 ${check.b.files.join(', ')} 建出的结构不同。` +
            `两者同库、同时在线，谁先启动谁赢——差异会静默生效。`,
        ).toEqual(b[table])
      }
    })
  }
})
