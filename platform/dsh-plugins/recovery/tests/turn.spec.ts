import { describe, expect, it } from 'vitest'
import type { SessionEventLike } from '../../../shared/seam-contracts/provenance.ts'
import { currentTurn } from '../../provenance/src/taint.ts'
import { idempotencyKey } from '../src/classify.ts'

const turnStart = (turn: number): SessionEventLike => ({ type: 'turn/start', data: { turn } })
const userMsg = (source: string): SessionEventLike =>
  ({ type: 'user/message', data: { source, content: 'x' } })

describe('recovery 的 turn 口径必须与 provenance 一致', () => {
  it('turn 中途的 agent.inject() 不得改变 turn 号', () => {
    // 旧的 countTurns 在这里会算出 2（数了 prompt + inject 两条 user/message），
    // 于是同一 turn 内的同参重放拿到不同幂等键，重放识别失效。
    const before = [turnStart(1), userMsg('prompt')]
    const after = [...before, userMsg('inject')]

    expect(currentTurn(before)).toBe(1)
    expect(currentTurn(after)).toBe(1)
  })

  it('同一 turn 内同参调用产生同一幂等键（inject 前后都一样）', () => {
    const before = [turnStart(1), userMsg('prompt')]
    const after = [...before, userMsg('inject')]

    const keyBefore = idempotencyKey('s1', currentTurn(before), 'connector_post', 'fp')
    const keyAfter = idempotencyKey('s1', currentTurn(after), 'connector_post', 'fp')
    expect(keyAfter).toBe(keyBefore)
  })

  it('新 turn 产生不同幂等键（下一 turn 的同参调用是新意图，应放行）', () => {
    const t1 = [turnStart(1), userMsg('prompt')]
    const t2 = [...t1, { type: 'turn/end', data: { turn: 1, reason: 'done' } }, turnStart(2)]

    const k1 = idempotencyKey('s1', currentTurn(t1), 'connector_post', 'fp')
    const k2 = idempotencyKey('s1', currentTurn(t2), 'connector_post', 'fp')
    expect(k2).not.toBe(k1)
  })
})
