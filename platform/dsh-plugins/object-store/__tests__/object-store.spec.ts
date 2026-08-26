import { describe, expect, it } from 'vitest'

import { seamErrorCode } from '../../../shared/seam-contracts/errors.ts'
import { contentKeyOf } from '../../../shared/seam-contracts/object-store.ts'
import { MinioObjectStore } from '../src/minio-store.ts'
import { minioOptions, testEnabled, uniqueRealm } from './minio-helper.ts'

/**
 * MinioObjectStore 对**真 MinIO** 跑（`OBJECT_STORE_TEST_ENDPOINT` 未设置则整组跳过）。
 *
 * 契约层已锁键规则（`shared/seam-contracts/__tests__/object-store.spec.ts`）；这里断言的
 * 是 Provider 的 IO 语义——realm 前缀隔离在真实桶上的表现、内容寻址写后的可读性、
 * 缺失对象 undefined、以及能力缺失显式拒绝（stub 里没有桶、没有连接拒绝）。
 */
const enabled = testEnabled()
const t = enabled ? it : it.skip
const suffix = enabled ? '已设置' : '未设置 → 跳过，非通过'

function store(realm: string): MinioObjectStore {
  return new MinioObjectStore(minioOptions())
}

/** 把 putContent 返回的完整键（`<realm>/content/<sha256>`）拆回相对键。 */
function relativeKey(fullKey: string): string {
  return fullKey.slice(fullKey.indexOf('/') + 1)
}

describe(`MinioObjectStore —— 对真 MinIO（需 OBJECT_STORE_TEST_ENDPOINT，当前${suffix}）`, () => {
  t('put/get 往返：文本与二进制；contentType 保留', async () => {
    const s = store(uniqueRealm())
    const realm = uniqueRealm()

    await s.put(realm, 'doc/hello.txt', 'hello 世界', 'text/plain; charset=utf-8')
    const text = await s.get(realm, 'doc/hello.txt')
    expect(text?.body.toString('utf8')).toBe('hello 世界')
    expect(text?.contentType).toBe('text/plain; charset=utf-8')

    const bin = Buffer.from([0x00, 0x01, 0xff, 0x00, 0x7f])
    await s.put(realm, 'blob', bin, 'application/octet-stream')
    const got = await s.get(realm, 'blob')
    expect(got?.body.equals(bin)).toBe(true)
  })

  t('realm 隔离：realm-a 写的键，realm-b 读不到（undefined）', async () => {
    const s = store(uniqueRealm())
    const a = uniqueRealm()
    const b = uniqueRealm()

    await s.put(a, 'k', 'data-a')
    expect((await s.get(a, 'k'))?.body.toString('utf8')).toBe('data-a')
    expect(await s.get(b, 'k')).toBeUndefined()
    expect(await s.stat(b, 'k')).toBeUndefined()
  })

  t('putContent：同内容同键幂等；键 = content/<sha256>；写后可读', async () => {
    const s = store(uniqueRealm())
    const realm = uniqueRealm()

    const k1 = await s.putContent(realm, 'hello')
    const k2 = await s.putContent(realm, 'hello')
    expect(k1).toBe(k2)
    expect(k1).toBe(`${realm}/${contentKeyOf('hello')}`)

    const got = await s.get(realm, relativeKey(k1))
    expect(got?.body.toString('utf8')).toBe('hello')
  })

  t('delete 幂等；get/stat 缺对象 undefined', async () => {
    const s = store(uniqueRealm())
    const realm = uniqueRealm()

    await s.put(realm, 'tmp/x', 'v')
    expect(await s.get(realm, 'tmp/x')).toBeDefined()
    await s.delete(realm, 'tmp/x')
    expect(await s.get(realm, 'tmp/x')).toBeUndefined()
    // 幂等：重复删除不抛
    await expect(s.delete(realm, 'tmp/x')).resolves.toBeUndefined()
    // 从未存在过
    expect(await s.get(realm, 'never-existed')).toBeUndefined()
    expect(await s.stat(realm, 'never-existed')).toBeUndefined()
  })

  t('键含越狱段被拒（SeamError invalid）', async () => {
    const s = store(uniqueRealm())
    const realm = uniqueRealm()

    await expect(s.put(realm, '../evil', 'x')).rejects.toMatchObject({ code: 'invalid' })
    await expect(s.put(realm, '/abs', 'x')).rejects.toMatchObject({ code: 'invalid' })
    await expect(s.get(realm, 'a/../../secret')).rejects.toMatchObject({ code: 'invalid' })
  })

  t('后端不可达 → capabilityUnavailable（fail closed，不降级本地）', async () => {
    const dead = new MinioObjectStore({
      endPoint: '127.0.0.1',
      port: 1,
      useSSL: false,
      accessKey: 'x',
      secretKey: 'y',
      bucket: 'dead-bucket',
    })
    const err = await dead.put('r', 'k', 'x').catch((e) => e)
    expect(seamErrorCode(err)).toBe('capability_unavailable')
  })
})