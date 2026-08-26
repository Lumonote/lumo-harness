import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'

import { seamErrorCode } from '../../../shared/seam-contracts/errors.ts'
import { MinioObjectStore } from '../src/minio-store.ts'
import { MinioSpillStore } from '../src/minio-spill.ts'
import { minioOptions, testEnabled, uniqueRealm } from './minio-helper.ts'

/**
 * MinioSpillStore 对**真 MinIO** 跑（未设端点则整组跳过）。dsh 契约语义逐条兑现：
 * saveText 全文 verbatim、bytes 精确、locator 是对象键且经对象 seam 可取回（跨节点
 * resume 的最小等价验证）、名字派生自 suggestedName 但不等于、真实存储失败 reject。
 */
const enabled = testEnabled()
const t = enabled ? it : it.skip
const suffix = enabled ? '已设置' : '未设置 → 跳过，非通过'

/** 从 SaveTextSpill 派生出的品牌 id 类型——避免直接依赖 dsh-llm/dsh-session 的运行时解析。 */
type SessionId = SaveTextSpill['owner']['sessionId']
type CallId = SaveTextSpill['source']['callId']
const sid = (id: string): SessionId => id as SessionId
const cid = (id: string): CallId => id as CallId

function request(overrides: Partial<SaveTextSpill> = {}): SaveTextSpill {
    return {
        owner: { sessionId: sid('sess-1') },
        source: { toolName: 'web_fetch', callId: cid('call-1'), label: 'result' },
        suggestedName: 'web_fetch.txt',
        content: 'the full body',
        ...overrides,
    }
}

describe(`MinioSpillStore —— 对真 MinIO（需 OBJECT_STORE_TEST_ENDPOINT，当前${suffix}）`, () => {
    t('saveText：locator 是对象键、bytes 精确、内容 verbatim、名字派生、不碰撞、经 objectStore 可取回', async () => {
        const ctx = new Context()
        const realm = uniqueRealm()
        await ctx.plugin(MinioSpillStore, { ...minioOptions(), realm })

        const content = 'héllo\u0000world 中文\nline2'
        const ref = await ctx.spillStore.saveText(request({ content }))

        // bytes = UTF-8 字节长度（不是字符数）
        expect(ref.bytes).toBe(Buffer.byteLength(content, 'utf8'))

        // locator 是完整对象键（realm/spill/<session>/<sanitized>-<hash8>）
        const loc = String(ref.locator)
        expect(loc.startsWith(`${realm}/spill/sess-1/`)).toBe(true)

        // 名字派生自 suggestedName 但不等（防碰撞后缀）
        const leaf = loc.split('/').pop()!
        expect(leaf).toContain('web_fetch.txt')
        expect(leaf).not.toBe('web_fetch.txt')

        // 经**独立** MinioObjectStore 取回（跨节点取回性的最小等价验证）
        const other = new MinioObjectStore(minioOptions())
        const relative = loc.slice(loc.indexOf('/') + 1)
        const got = await other.get(realm, relative)
        expect(got?.body.toString('utf8')).toBe(content)

        // 同 suggestedName 两次保存不碰撞（内容指纹区分）
        const ref2 = await ctx.spillStore.saveText(request({ content: 'other' }))
        expect(String(ref2.locator)).not.toBe(loc)
    })

    t('后端不可达 → saveText 拒绝（capabilityUnavailable，触达 spill policy 的 best-effort）', async () => {
        const ctx = new Context()
        await ctx.plugin(MinioSpillStore, {
            endPoint: '127.0.0.1',
            port: 1,
            useSSL: false,
            accessKey: 'x',
            secretKey: 'y',
            bucket: 'dead-bucket',
            realm: 'r',
        })
        const err = await ctx.spillStore.saveText(request()).catch((e) => e)
        expect(seamErrorCode(err)).toBe('capability_unavailable')
    })
})