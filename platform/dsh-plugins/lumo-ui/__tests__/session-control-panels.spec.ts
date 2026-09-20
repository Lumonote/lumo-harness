import { describe, expect, it } from 'vitest'

import { controlButtonState, controlStateLabel } from '../src/client/cluster-panels.tsx'

// 控制台面板的呈现判断。这两条都**不做授权判断**——能否执行由控制面的 `available`
// 与 `Apply` 决定（同一个判据，因此按钮与提交结果不可能漂移）。这里钉的是另一半：
// 拿到事实之后，怎么显示才不骗人。
describe('controlStateLabel', () => {
  // 未登记的会话必须显示成「未登记」，不能顺口说成「运行中」。控制面没有会话注册表，
  // 那个 running 是编出来的，而面板的措辞是一句确定的话——操作者不会怀疑它是一个猜测。
  it('never invents a state for a session the control plane has not seen', () => {
    expect(controlStateLabel(null)).toBe('未登记')
    expect(controlStateLabel(null)).not.toContain('运行')
  })

  it('localizes the known states and passes unknown ones through', () => {
    expect(controlStateLabel('paused')).toBe('已暂停')
    expect(controlStateLabel('awaiting-approval')).toBe('等待审批')
    // 词表外的值原样显示，不回落成某个默认状态：控制面新增状态时，这里显示的是
    // 「一个我们不认识的名字」，而不是一个看起来正常的旧状态。
    expect(controlStateLabel('quarantined')).toBe('quarantined')
  })
})

describe('controlButtonState', () => {
  it('keeps a no-op command clickable and says so in the label', () => {
    // 控制面的注释：「NoOp 为 true 时该指令可用但没有效果（终态重复指令等）。控制台
    // 据此把按钮渲染成『可点但无变化』」。禁用它会把一个可用的指令藏掉，操作者点不动
    // 只会以为是自己权限不够。
    expect(controlButtonState({ command: 'pause', available: true, no_op: true, reason: 'no-op' }))
      .toEqual({ disabled: false, label: '暂停（无变化）' })
  })

  it('disables only what the state machine disallows', () => {
    expect(controlButtonState({ command: 'resume', available: false, no_op: false, reason: '状态不允许' }))
      .toEqual({ disabled: true, label: '恢复' })
    expect(controlButtonState({ command: 'resume', available: true, no_op: false, reason: 'ok' }))
      .toEqual({ disabled: false, label: '恢复' })
  })

  it('falls back to the raw command name rather than hiding an unknown one', () => {
    // 控制面新增一种指令时，按钮上出现的是它的真名，而不是一个空标签或一个被
    // 误认成别的指令的名字。
    expect(controlButtonState({ command: 'quarantine', available: true, no_op: false, reason: 'ok' }))
      .toEqual({ disabled: false, label: 'quarantine' })
  })
})
