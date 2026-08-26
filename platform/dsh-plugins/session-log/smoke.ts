/**
 * compose 冒烟 —— 会话日志冷层+热层全链，对真实 PG + MinIO + Redis
 * （standalone 拓扑 15432/19000/16379）。
 *
 * 判据 8：真 MinIO + 真 PG 全链（写入→归档→读回首验→过期清理）；
 * 判据 9：真 Redis + 真 PG 热链（事件线写→透传镜像→热读命中→head→短 TTL 过期回退 PG）。
 *
 * 走插件真实装配面 `apply()`（object-store → session-log 的 coldLog + hotCache），验证：
 *   - ctx.coldLog / ctx.sessionLog / ctx.sessionLogHot 经装配注册（接同一切片的 objectStore）；
 *   - `append` 写进 PG 真源 → `coldLog.archive` 段归档进 MinIO →
 *     `coldLog.fetch` 读回首验 `.info` 完整性 → `coldLog.sweep` 过期清理；
 *   - `session/event` 事件线 → PG append → 热层镜像 → `sessionLogHot.read` 命中 →
 *     `sessionLogHot.head` 水位 → 短 TTL 过期后读路径回退 PG（fail-open）。
 *
 * 任一步失败即抛错、进程非零码退出（headless「正常退出」= 全绿日志）。
 *
 * 用法（platform 根）：
 *   SESSION_LOG_TEST_DSN='postgres://lumo:lumo@127.0.0.1:15432/lumo' \
 *   OBJECT_STORE_TEST_ENDPOINT=127.0.0.1:19000 OBJECT_STORE_TEST_CREDS=lumo:lumo-minio-123 \
 *   SESSION_LOG_TEST_REDIS='redis://127.0.0.1:16379' \
 *   ./node_modules/.bin/tsx dsh-plugins/session-log/smoke.ts
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import type { LogRecord } from '../../shared/seam-contracts/session-log.ts'

import { apply as applyObjectStore } from '../object-store/src/index.ts'
import { apply as applySessionLog } from './src/index.ts'

/** dsh-node 真实的 tools 是完整服务；冒烟不 drive 事件线，只需一个能占住 inject 槽的桩。 */
class ToolsStub extends Service {
  constructor(ctx: Context) {
    super(ctx)
  }
}

function config() {
  const dsn = process.env['SESSION_LOG_TEST_DSN'] ?? 'postgres://lumo:lumo@127.0.0.1:15432/lumo'
  const redis = process.env['SESSION_LOG_TEST_REDIS'] ?? 'redis://127.0.0.1:16379'
  const endpoint = process.env['OBJECT_STORE_TEST_ENDPOINT'] ?? '127.0.0.1:19000'
  const creds = process.env['OBJECT_STORE_TEST_CREDS'] ?? 'lumo:lumo-minio-123'
  const [accessKey, secretKey] = creds.split(':')
  const [endPoint, portStr] = endpoint.split(':')
  return {
    dsn,
    redis,
    objectStore: {
      endPoint,
      port: portStr ? Number(portStr) : 9000,
      useSSL: false,
      accessKey,
      secretKey,
      bucket: 'lumo-objects',
      realm: `smoke-${randomBytes(4).toString('hex')}`,
    },
  }
}

function pass(name: string): void {
  console.log(`  ✓ ${name}`)
}

function assert(cond: unknown, name: string): asserts cond {
  if (!cond) throw new Error(`冒烟断言失败：${name}`)
  pass(name)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 就绪探测：等 PG 两表（session_log / session_log_archive）建好再开始，避免与 void init 竞态。 */
async function waitReady(probe: () => Promise<unknown>, desc: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await probe()
      return
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // 未就绪期间容忍「关系不存在」；其它错误照抛
      if (!msg.includes('does not exist') && !msg.includes('relation')) throw error
      await sleep(100)
    }
  }
  throw new Error(`冒烟就绪超时：${desc}`)
}

function recordOf(sessionRef: string, seq: number): LogRecord {
  return {
    sessionRef,
    seq,
    type: 'user_message',
    payload: { content: `msg-${seq}` },
    time: 1_700_000_000_000 + seq,
  }
}

async function main(): Promise<void> {
  const cfg = config()
  const realm = cfg.objectStore.realm
  const session = `sess-${randomBytes(4).toString('hex')}`
  console.log(
    `会话日志冷层+热层 compose 冒烟 → PG@${cfg.dsn} / MinIO@${cfg.objectStore.endPoint}:${cfg.objectStore.port}`
    + ` / Redis@${cfg.redis}（bucket=${cfg.objectStore.bucket}, realm=${realm}）`,
  )

  const ctx = new Context()
  // 装配顺序：先占住 inject 的 tools 槽，再 apply object-store（提供 ctx.objectStore）
  // 最后 apply session-log（inject 消费 tools + objectStore）；与 object-store/smoke.ts 同法。
  ctx.provide('tools', new ToolsStub(ctx))
  applyObjectStore(ctx, cfg.objectStore)
  applySessionLog(ctx, {
    connectionString: cfg.dsn,
    holder: 'smoke-node',
    leaseTtlMs: 30_000,
    coldLog: { realm, maxItems: 2 },
    // 热层：短 TTL（3s）专为冒烟——先命中再过期回退，一条链走完两种路径
    hotCache: { url: cfg.redis, realm, ttlMs: 3_000, maxLen: 10 },
  })

  // 就绪：两表都需可用。session_log 用 append 前的 acquire 探测；归档表用 list 探测。
  await waitReady(() => ctx.sessionLog.acquire('sess-probe', 'probe', -1), 'session_log 表')
  await waitReady(() => ctx.coldLog.list(), 'session_log_archive 表')
  assert(ctx.coldLog !== undefined, 'ctx.coldLog 已装配（接同一 objectStore）')

  // 1. 写入真源（取租约 → append 5 条）。冒烟直接用暴露的写路径，不经事件线。
  const token = await ctx.sessionLog.acquire(session, 'smoke-node', 30_000)
  assert(token !== undefined, '取到写者租约')
  for (const seq of [1, 2, 3, 4, 5]) {
    await ctx.sessionLog.append(recordOf(session, seq), token!.fencingToken)
  }
  await ctx.sessionLog.release(session, 'smoke-node') // 冷层不占租约，先让掉

  // 2. 归档：maxItems=2 → 段 [1-2],[3-4],[5-5]
  const segs = await ctx.coldLog.archive(session)
  assert(segs.length === 3, '归档出 3 段（maxItems=2）')
  assert(segs.every((s) => s.objectKey.startsWith(`${realm}/session-log/${session}/`)), '段对象键带 realm 前缀')

  // 3. 幂等：重跑不新增段
  const again = await ctx.coldLog.archive(session)
  assert(again.length === 0, '归档幂等：重跑无新段')

  // 4. 读回首验（对拍 .info 侧车；含序与 payload 保真）
  const back = await ctx.coldLog.fetch(session, { startSeq: 1, endSeq: 2 })
  assert(back.length === 2 && back[0]!.seq === 1 && back[1]!.seq === 2, 'fetch 读回顺序一致')
  assert((back[0]!.payload as { content?: string })?.content === 'msg-1', 'fetch payload 保真')

  // 5. 过期清理：把**本会话**归档行的 archived_at 拨到 24h 前 → 保留 1h 内必过期；
  //    删对象 + 清 PG 行。（sweep 是全局 seam，只断言本会话行被清——避免被别的会话残留影响）
  //    拨 archived_at 是测试驾驶手法，不经 seam；冷层未暴露改时接口。
  const sbadm = new pg.Client({ connectionString: cfg.dsn })
  await sbadm.connect()
  await sbadm.query('UPDATE session_log_archive SET archived_at = archived_at - $1 WHERE session_ref = $2',
    [24 * 3600 * 1000, session])
  await sbadm.end()
  await ctx.coldLog.sweep(Date.now(), 3600 * 1000)
  assert((await ctx.coldLog.list(session)).length === 0, '本会话过期段清理（对象删 + PG 行进清）')

  // 6. 未过期不动：再写一条并归档，保留期内 sweep 应保留
  const token2 = await ctx.sessionLog.acquire(session, 'smoke-node', 30_000)
  await ctx.sessionLog.append(recordOf(session, 6), token2!.fencingToken)
  await ctx.sessionLog.release(session, 'smoke-node')
  await ctx.coldLog.archive(session)
  const kept = await ctx.coldLog.sweep(Date.now(), 3600 * 1000)
  assert(kept.length === 0, '保留期内段不清理')

  // —— 热层段（§4.2 热 Redis 窗口）：事件线写 → 透传镜像 → 热读命中 → head → 短 TTL 过期回退 ——
  const hot = ctx.sessionLogHot
  assert(hot !== undefined, 'ctx.sessionLogHot 已装配（hotCache 接线）')
  await waitReady(() => hot.head('sess-probe-hot'), '热层连接')

  const hotSession = `sess-hot-${randomBytes(4).toString('hex')}`
  const eventOf = (seq: number) => ({ seq, type: 'user_message', time: 1_700_000_000_000 + seq })
  // 走真实事件线：session/event → PG append（真相源）→ 写后透传 mirror
  for (const seq of [1, 2, 3]) {
    ctx.emit('session/event', { id: hotSession }, eventOf(seq))
  }
  // mirror 是 fire-and-forget：轮询热层窗口直到 3 条全命中
  let hotRecs: LogRecord[] | undefined
  for (let i = 0; i < 100; i++) {
    hotRecs = await hot.read(hotSession, 1)
    if (hotRecs && hotRecs.length === 3) break
    await sleep(50)
  }
  assert(hotRecs !== undefined && hotRecs.map((r) => r.seq).join(',') === '1,2,3', '热层 read 命中窗口（seq 连续升序）')
  assert(JSON.stringify(hotRecs[0].payload) === JSON.stringify(eventOf(1)), '热层记录 payload 保真')
  const head = await hot.head(hotSession)
  assert(head?.seq === 3 && head.time === eventOf(3).time, 'head watermark = 最新一条')
  // 热读命中 3 条 ⇒ 3 条 append 已全部 resolve、队列排空，可以安全让租约
  await ctx.sessionLog.release(hotSession, 'smoke-node')

  // 短 TTL 过期：热窗口失效 → read 回退 PG 真相源（fail-open，读路径透明）
  await sleep(3_500) // ttlMs=3000，超过即逻辑过期
  assert(await hot.read(hotSession, 1) === undefined, 'TTL 过期后热层 read 回退（undefined）')
  assert(await hot.head(hotSession) === undefined, 'TTL 过期后 head 无缓存')
  const fallback = await ctx.sessionLog.read(hotSession, 1)
  assert(fallback.map((r) => r.seq).join(',') === '1,2,3', 'adapter read 回退 PG 拿全量（真相源兜底）')

  console.log('会话日志冷层+热层 compose 冒烟全绿：冷链（写入→归档→读回→过期清理）+ 热链（写入→镜像→命中→head→过期回退）全链通过')

  // headless 语义「exit 0 ≈ 全绿」。此处必须显式退出：session-log 持续租 setInterval，
  // 进程在无状态 main 结束后会悬住不退出（object-store 冒烟无定时器故自然收尾）。
  process.exit(0)
}

main().catch((e) => {
  console.error('会话日志冷层 compose 冒烟失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})