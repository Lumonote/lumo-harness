import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'

import { createSeamHost, type SeamHostOptions } from '../src/server.ts'
import { METHOD_TABLE } from '../src/dispatch.ts'
import { SEAM_GRADES } from '../../../shared/seam-contracts/remotability.ts'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'

/** 记录 Provider 是否被触碰过 —— 判据 4 的「不触碰 Provider」需要可断言的证据。 */
interface Probe {
  knowledgeResolved: number
  graphResolved: number
  calls: string[]
}

function makeHost(): { options: SeamHostOptions; probe: Probe } {
  const probe: Probe = { knowledgeResolved: 0, graphResolved: 0, calls: [] }

  const knowledge = {
    async query(q: unknown) {
      probe.calls.push('knowledge.query')
      void q
      return { chunks: [], total: 0 }
    },
    async ingest() { probe.calls.push('knowledge.ingest'); return { docId: 'd', chunks: 0 } },
    async remove() { probe.calls.push('knowledge.remove') },
    async rebuild() { probe.calls.push('knowledge.rebuild'); return { docs: 0 } },
  } as unknown as KnowledgeSeam

  const graph = {
    async neighborhood() { probe.calls.push('graph.neighborhood'); return { nodes: [], edges: [] } },
    async upsertNodes() { probe.calls.push('graph.upsertNodes') },
    async upsertEdges() { probe.calls.push('graph.upsertEdges') },
    async removeNode() { probe.calls.push('graph.removeNode') },
  } as unknown as GraphSeam

  return {
    probe,
    options: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1 << 20,
      tokens: new Map(),
      resolveKnowledge: () => { probe.knowledgeResolved++; return knowledge },
      resolveGraph: () => { probe.graphResolved++; return graph },
      logger: { info() {}, warn() {}, error() {} },
    },
  }
}

interface Reply { status: number; body: { ok: boolean; code?: string; message?: string } }

async function post(seam: string, method: string, args: unknown[]): Promise<{ reply: Reply; probe: Probe }> {
  const { options, probe } = makeHost()
  const server = createSeamHost(options)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/seam/${encodeURIComponent(seam)}/${encodeURIComponent(method)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lumo-realm': 'r1' },
        body: JSON.stringify({ seam, method, args }),
      },
    )
    return { reply: { status: res.status, body: await res.json() as Reply['body'] }, probe }
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

describe('闸 B —— 服务端可远程化闸', () => {
  it('never 类 seam 名 → forbidden，且完全不触碰 Provider', async () => {
    const { reply, probe } = await post('ctx.terminals', 'write', ['hi'])
    expect(reply.status).toBe(403)
    expect(reply.body.code).toBe('forbidden')
    expect(reply.body.message).toContain('never')
    expect(probe.calls).toEqual([])
    // 连解析 Provider 都不该发生：闸 B 插在触碰任何 Provider 之前
    expect(probe.knowledgeResolved).toBe(0)
    expect(probe.graphResolved).toBe(0)
  })

  it('needs-design 类 → forbidden，且错误信息给出正确归属', async () => {
    const { reply, probe } = await post('ctx.llm', 'stream', [{}])
    expect(reply.status).toBe(403)
    expect(reply.body.message).toContain('needs-design')
    expect(reply.body.message).toContain('LLM 网关')
    expect(probe.calls).toEqual([])
  })

  it('未定级 seam 名 → forbidden 而不是 invalid —— 准入策略不是参数错误', async () => {
    const { reply, probe } = await post('made-up-seam', 'query', [{}])
    expect(reply.status).toBe(403)
    expect(reply.body.code).toBe('forbidden')
    expect(reply.body.message).toContain('未定级')
    expect(probe.calls).toEqual([])
  })

  it('remotable 且在 METHOD_TABLE 里 → 放行到 Provider', async () => {
    const { reply, probe } = await post('knowledge', 'query', [
      { realm: 'r1', roles: ['user'], text: 'q', topK: 3, scope: 'published' },
    ])
    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    expect(probe.calls).toEqual(['knowledge.query'])
  })

  it('remotable 但 realm 与身份不符仍然拒 —— 闸 B 不取代越权闸门', async () => {
    const { reply, probe } = await post('knowledge', 'query', [
      { realm: 'other', roles: ['user'], text: 'q', topK: 3, scope: 'published' },
    ])
    expect(reply.status).toBe(403)
    expect(probe.calls).toEqual([])
  })

  it('remotable seam 的未注册方法仍是 invalid —— 名字合法、方法不存在是参数问题', async () => {
    const { reply, probe } = await post('knowledge', 'constructor', [{}])
    expect(reply.status).toBe(400)
    expect(reply.body.code).toBe('invalid')
    expect(probe.calls).toEqual([])
  })
})

/**
 * 跨包契约：分级表的 remotable 集合必须与 host 的 METHOD_TABLE 键集合相等。
 *
 * 放在这里而不是 `remotability.contract.spec.ts`（计划原定位置）：那样会让
 * `shared/seam-contracts` 的测试 import 一个插件包，把依赖方向倒过来。真实方向是
 * 插件依赖 shared，断言就该住在插件侧。
 */
describe('定级与实现一致 —— 两边不等就是漂移', () => {
  const remotable = Object.entries(SEAM_GRADES)
    .filter(([, g]) => g.class === 'remotable')
    .map(([k]) => k)
    .sort()

  it('remotable 集合 == METHOD_TABLE 键集合', () => {
    expect(Object.keys(METHOD_TABLE).sort()).toEqual(remotable)
  })

  it('逐 seam 的方法集合也相等 —— 只比 seam 名会漏掉加方法时的漂移', () => {
    for (const seam of remotable) {
      const graded = Object.keys(SEAM_GRADES[seam]!.methods!).sort()
      const implemented = Object.keys(METHOD_TABLE[seam as keyof typeof METHOD_TABLE]).sort()
      expect(implemented, `seam ${seam}`).toEqual(graded)
    }
  })
})
