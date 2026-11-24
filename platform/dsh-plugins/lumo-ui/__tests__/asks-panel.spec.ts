import { describe, expect, it } from 'vitest'

import { askStatusLabel } from '../src/client/asks-panel.tsx'

describe('askStatusLabel', () => {
  const future = '2999-01-01T00:00:00Z'
  it('distinguishes approved-but-unused from consumed', () => {
    expect(askStatusLabel({ status: 'answered', expires_at: future, source_status: 'approved' })).toBe('已批准 · 等待一次执行')
    expect(askStatusLabel({ status: 'answered', expires_at: future, source_status: 'consumed' })).toBe('已批准 · 已执行')
  })
  it('shows read-time expiry for stale pending asks', () => {
    expect(askStatusLabel({ status: 'pending', expires_at: '2000-01-01T00:00:00Z' })).toBe('已过期')
    expect(askStatusLabel({ status: 'pending', expires_at: future })).toBe('等待处理')
  })
})
