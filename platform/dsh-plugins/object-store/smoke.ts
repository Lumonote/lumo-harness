/**
 * compose 冒烟 —— 对真实 MinIO（standalone 拓扑 19000）跑 put/get/spill 取回全链。
 *
 * 走插件真实装配面 `apply()`（不是直接 new Provider），验证 ctx.objectStore / ctx.spillStore
 * 注册与跨节点取回。任一步失败即抛错、进程以非零码退出（headless「正常退出」= 全绿日志）。
 *
 * 用法（platform 根）：
 *   OBJECT_STORE_TEST_ENDPOINT=127.0.0.1:19000 OBJECT_STORE_TEST_CREDS=lumo:lumo-minio-123 \
 *   ./node_modules/.bin/tsx dsh-plugins/object-store/smoke.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'

import { apply } from './src/index.ts'
import { MinioObjectStore } from './src/minio-store.ts'

/** 品牌 id 的轻量构造（不用运行时解析 dsh-llm/dsh-session）。 */
type SessionId = SaveTextSpill['owner']['sessionId']
type CallId = SaveTextSpill['source']['callId']
const sid = (id: string): SessionId => id as SessionId
const cid = (id: string): CallId => id as CallId

function config() {
  const endpoint = process.env['OBJECT_STORE_TEST_ENDPOINT'] ?? '127.0.0.1:19000'
  const creds = process.env['OBJECT_STORE_TEST_CREDS'] ?? 'lumo:lumo-minio-123'
  const [accessKey, secretKey] = creds.split(':')
  const [endPoint, portStr] = endpoint.split(':')
  return {
    endPoint,
    port: portStr ? Number(portStr) : 9000,
    useSSL: false,
    accessKey,
    secretKey,
    bucket: 'lumo-objects',
    realm: `smoke-${randomBytes(4).toString('hex')}`,
  }
}

function pass(name: string): void {
  console.log(`  ✓ ${name}`)
}

function assert(cond: unknown, name: string): asserts cond {
  if (!cond) throw new Error(`冒烟断言失败：${name}`)
  pass(name)
}

async function main(): Promise<void> {
  const cfg = config()
  console.log(`对象存储 compose 冒烟 → ${cfg.endPoint}:${cfg.port}（bucket=${cfg.bucket}, realm=${cfg.realm}）`)

  const ctx = new Context()
  apply(ctx, cfg)
  const realm = cfg.realm

  // 1. 命名对象读写往返（含非 ASCII + contentType 保留）
  await ctx.objectStore.put(realm, 'doc/hello.txt', 'hello 世界', 'text/plain; charset=utf-8')
  const got = await ctx.objectStore.get(realm, 'doc/hello.txt')
  assert(got?.body.toString('utf8') === 'hello 世界', 'put/get 往返：文本 + contentType')
  assert(got?.contentType === 'text/plain; charset=utf-8', 'contentType 保留')

  // 2. 二进制往返
  const bin = Buffer.from([0x00, 0x01, 0xff, 0x00, 0x7f])
  await ctx.objectStore.put(realm, 'blob', bin, 'application/octet-stream')
  assert((await ctx.objectStore.get(realm, 'blob'))?.body.equals(bin) === true, 'put/get 往返：二进制')

  // 3. 内容寻址：同内容同键幂等
  const k1 = await ctx.objectStore.putContent(realm, 'hello')
  const k2 = await ctx.objectStore.putContent(realm, 'hello')
  assert(k1 === k2, 'putContent 同内容同键（幂等）')

  // 4. realm 隔离：realm-b 读不到 realm-a 的键
  await ctx.objectStore.put(realm, 'k', 'data-a')
  assert(await ctx.objectStore.get('smoke-other', 'k') === undefined, 'realm 隔离（跨 realm 读不到）')

  // 5. 缺对象 undefined（get/stat）
  assert(await ctx.objectStore.stat(realm, 'never') === undefined, 'stat 缺对象 undefined')

  // 6. spill 收敛：saveText → locator 是对象键；经独立 MinioObjectStore 取回（跨节点最小等价）
  const content = 'héllo\u0000world 中文\nline2'
  const ref = await ctx.spillStore.saveText({
    owner: { sessionId: sid('sess-1') },
    source: { toolName: 'web_fetch', callId: cid('call-1'), label: 'result' },
    suggestedName: 'web_fetch.txt',
    content,
  })
  assert(ref.bytes === Buffer.byteLength(content, 'utf8'), 'spill bytes = UTF-8 字节长度')
  const loc = String(ref.locator)
  assert(loc.startsWith(`${realm}/spill/sess-1/`), 'spill locator 是对象键')

  const other = new MinioObjectStore(cfg)
  const idx = loc.indexOf('/')
  const back = await other.get(loc.slice(0, idx), loc.slice(idx + 1))
  assert(back?.body.toString('utf8') === content, 'spill 内容经独立对象存储取回（跨节点 resume）')

  console.log('对象存储 compose 冒烟全绿：put/get/spill 取回 全链通过')
}

main().catch((e) => {
  console.error('对象存储 compose 冒烟失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})