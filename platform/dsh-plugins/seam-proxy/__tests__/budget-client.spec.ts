import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { SeamProxyClient } from '../src/client.ts'
import type { BudgetViolation } from '../../../shared/seam-contracts/turn-budget.ts'

/** 永远成功的假 host。计数用来证明「被预算拒掉的调用没有出网」。 */
function fakeHost(): { server: Server; hits: () => number } {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    req.resume()
    req.on('end', () => {
      const body = JSON.stringify({ ok: true, value: { chunks: [], total: 0 } })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
    })
  })
  return { server, hits: () => hits }
}

async function withHost<T>(
  fn: (endpoint: string, hits: () => number) => Promise<T>,
): Promise<T> {
  const { server, hits } = fakeHost()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    return await fn(`http://127.0.0.1:${port}`, hits)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

const BUDGET = 8 // knowledge 的 perTurnCallBudget

describe('闸 C 接进 client —— 预算在 call() 上真的生效', () => {
  it('warn 模式超预算照常成功，但留下结构化告警', async () => {
    await withHost(async (endpoint, hits) => {
      const seen: BudgetViolation[] = []
      const c = new SeamProxyClient({
        endpoints: [endpoint], realm: 'r1',
        budgetMode: 'warn', onBudgetViolation: (v) => { seen.push(v) },
      })
      c.setTurn('turn-1')
      for (let i = 0; i < BUDGET + 3; i++) await c.call('knowledge', 'query', [{}])
      expect(seen.length).toBe(1)
      expect(seen[0]).toEqual({ seam: 'knowledge', turn: 'turn-1', count: BUDGET + 1, budget: BUDGET })
      // warn 不拦：全部调用都出网了
      expect(hits()).toBe(BUDGET + 3)
    })
  })

  it('enforce 模式超预算抛 forbidden，且被拒的调用不出网', async () => {
    await withHost(async (endpoint, hits) => {
      const c = new SeamProxyClient({
        endpoints: [endpoint], realm: 'r1', budgetMode: 'enforce',
      })
      c.setTurn('turn-1')
      for (let i = 0; i < BUDGET; i++) await c.call('knowledge', 'query', [{}])
      expect(hits()).toBe(BUDGET)

      await expect(c.call('knowledge', 'query', [{}])).rejects.toMatchObject({
        name: 'RemoteSeamError',
        code: 'forbidden',
      })
      // 关键断言：预算闸在发请求之前，拒了就是没出网
      expect(hits()).toBe(BUDGET)
    })
  })

  it('forbidden 不可重试、不计入熔断 —— 本地策略拒绝不该把健康 host 判死刑', async () => {
    await withHost(async (endpoint) => {
      const c = new SeamProxyClient({
        endpoints: [endpoint], realm: 'r1', budgetMode: 'enforce',
      })
      c.setTurn('turn-1')
      for (let i = 0; i < BUDGET; i++) await c.call('knowledge', 'query', [{}])
      for (let i = 0; i < 20; i++) {
        await c.call('knowledge', 'query', [{}]).catch(() => undefined)
      }
      // 端点仍然健康：20 次预算拒绝没有累积成熔断
      expect(c.health().every((h) => h.state !== 'open')).toBe(true)
      // 换 turn 后立刻恢复可用
      c.setTurn('turn-2')
      await expect(c.call('knowledge', 'query', [{}])).resolves.toBeDefined()
    })
  })

  it('setTurn 切换后计数归零', async () => {
    await withHost(async (endpoint) => {
      const seen: BudgetViolation[] = []
      const c = new SeamProxyClient({
        endpoints: [endpoint], realm: 'r1',
        budgetMode: 'warn', onBudgetViolation: (v) => { seen.push(v) },
      })
      for (let t = 0; t < 4; t++) {
        c.setTurn(`turn-${t}`)
        for (let i = 0; i < BUDGET; i++) await c.call('knowledge', 'query', [{}])
      }
      expect(seen).toEqual([])
    })
  })

  it('没调 setTurn 时也计数 —— 哨兵 turn 不是绕过预算的办法', async () => {
    await withHost(async (endpoint) => {
      const seen: BudgetViolation[] = []
      const c = new SeamProxyClient({
        endpoints: [endpoint], realm: 'r1',
        budgetMode: 'warn', onBudgetViolation: (v) => { seen.push(v) },
      })
      for (let i = 0; i <= BUDGET; i++) await c.call('knowledge', 'query', [{}])
      expect(seen.length).toBe(1)
      expect(seen[0]!.turn).toBe('no-turn')
    })
  })

  it('setTurn(\'\') 归为哨兵 —— 空串不是一个合法 turn 标识', async () => {
    await withHost(async (endpoint) => {
      const seen: BudgetViolation[] = []
      const c = new SeamProxyClient({
        endpoints: [endpoint], realm: 'r1',
        budgetMode: 'warn', onBudgetViolation: (v) => { seen.push(v) },
      })
      c.setTurn('')
      for (let i = 0; i <= BUDGET; i++) await c.call('knowledge', 'query', [{}])
      expect(seen[0]!.turn).toBe('no-turn')
    })
  })

  it('缺省不配 budgetMode 时是 warn —— 不会让既有部署突然开始失败', async () => {
    await withHost(async (endpoint, hits) => {
      const c = new SeamProxyClient({ endpoints: [endpoint], realm: 'r1' })
      c.setTurn('turn-1')
      for (let i = 0; i < BUDGET + 5; i++) await c.call('knowledge', 'query', [{}])
      expect(hits()).toBe(BUDGET + 5)
    })
  })
})
