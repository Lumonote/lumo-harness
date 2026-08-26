import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { parseAttachmentKey } from '../../../shared/seam-contracts/attachment.ts'
import { seamErrorCode } from '../../../shared/seam-contracts/errors.ts'
import { MinioObjectStore } from '../../object-store/src/minio-store.ts'
import { MinioAttachmentStore } from '../src/minio-attachment-store.ts'
import {
  attachmentStore,
  objectStore,
  testEnabled,
  tinyPng,
  uniqueRealm,
} from './minio-helper.ts'

/**
 * MinioAttachmentStore 对**真 MinIO** 跑（`OBJECT_STORE_TEST_ENDPOINT` 未设置则整组跳过）。
 *
 * 契约层已锁引用形态/键规则（shared/seam-contracts/__tests__/attachment.spec.ts）；这里
 * 断言 Provider 的 IO 语义——save→ref 是对象键、同内容同键幂等、读回 digest 校验、
 * realm 隔离、缺对象 NOT_FOUND、篡改 CORRUPT、不可达 fail closed。
 */
const enabled = testEnabled()
const t = enabled ? it : it.skip
const suffix = enabled ? '已设置' : '未设置 → 跳过，非通过'

/** 构造一个引用真实存在的附件对象键的 fake ref（合法对象键但对象不存在）。 */
function missingRef(store: MinioAttachmentStore): ImageAttachmentRef {
  return {
    attachmentId: `${store.realm}/content/${'0'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 0,
    width: 1,
    height: 1,
  }
}

describe(`MinioAttachmentStore —— 对真 MinIO（需 OBJECT_STORE_TEST_ENDPOINT，当前${suffix}）`, () => {
  t('save→ref 是对象键；同内容同键幂等；read 取回并 digest 校验', async () => {
    const store = attachmentStore(uniqueRealm())
    const png = await tinyPng()

    const ref1 = await store.saveImage({ data: png, mediaType: 'image/png' })
    const ref2 = await store.saveImage({ data: png, mediaType: 'image/png' })
    // 引用一律对象键：<realm>/content/<sha256>，自描述
    const parsed = parseAttachmentKey(String(ref1.attachmentId))
    expect(parsed.realm).toBe(store.realm)
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(String(ref1.attachmentId)).toBe(`${store.realm}/content/${parsed.sha256}`)
    // 同内容同键幂等
    expect(String(ref1.attachmentId)).toBe(String(ref2.attachmentId))

    // 读回：digest/byteLength 校验通过，字节与引用一致
    const back = await store.readImage(ref1)
    expect(back.data.byteLength).toBe(ref1.bytes)
    expect(String(back.ref.attachmentId)).toBe(String(ref1.attachmentId))
    expect(back.ref.mediaType).toBe('image/png')
  })

  t('realm 隔离：A 写的键在 A 命名空间，不在 B 命名空间', async () => {
    const storeA = attachmentStore(uniqueRealm())
    const realmB = uniqueRealm()
    const png = await tinyPng()

    const refA = await storeA.saveImage({ data: png, mediaType: 'image/png' })
    const { sha256 } = parseAttachmentKey(String(refA.attachmentId))
    const obj = objectStore()
    // A 命名空间存在；B 命名空间同字节键不存在（引用自描述，A 的可能在 B 名下读不到）
    expect(await obj.get(storeA.realm, `content/${sha256}`)).toBeDefined()
    expect(await obj.get(realmB, `content/${sha256}`)).toBeUndefined()
  })

  t('缺对象 → ATTACHMENT_NOT_FOUND（引用合法但对象从未写入）', async () => {
    const store = attachmentStore(uniqueRealm())
    await expect(store.readImage(missingRef(store))).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    })
  })

  t('对象字节被篡改 → ATTACHMENT_CORRUPT（digest 校验执法）', async () => {
    const store = attachmentStore(uniqueRealm())
    const png = await tinyPng()
    const ref = await store.saveImage({ data: png, mediaType: 'image/png' })
    const { sha256 } = parseAttachmentKey(String(ref.attachmentId))

    // 同对象键覆盖成不同字节——模拟介质上内容被改
    const obj = objectStore()
    await obj.put(store.realm, `content/${sha256}`, 'tampered bytes', 'image/png')
    await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  t('非法引用 → INVALID_ATTACHMENT_REF', async () => {
    const store = attachmentStore(uniqueRealm())
    const bad = {
      attachmentId: 'not-an-object-key',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    } as ImageAttachmentRef
    await expect(store.readImage(bad)).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
  })

  t('validateImage 拒绝字节→声明类型不符（IMAGE_TYPE_MISMATCH，不触存储）', async () => {
    const store = attachmentStore(uniqueRealm())
    await expect(store.validateImage({ data: await tinyPng(), mediaType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
  })

  t('后端不可达 → capabilityUnavailable（fail closed，不降级本地）', async () => {
    const ctx = new Context()
    const dead = new MinioObjectStore({
      endPoint: '127.0.0.1',
      port: 1,
      useSSL: false,
      accessKey: 'x',
      secretKey: 'y',
      bucket: 'dead-bucket',
    })
    ctx.provide('objectStore', dead)
    const store = new MinioAttachmentStore(ctx, { realm: uniqueRealm() })
    const err = await store.readImage(missingRef(store)).catch((e) => e)
    expect(seamErrorCode(err)).toBe('capability_unavailable')
  })
})