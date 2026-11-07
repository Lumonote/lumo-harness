import { describe, expect, it } from 'vitest'
import { Balancer } from '../src/balancer.ts'

describe('half-open endpoint admission', () => {
  it('admits a single probe and does not reserve probes from health reads', () => {
    let now = 0
    const pool = new Balancer({ endpoints: ['http://a'], failureThreshold: 1, openForMs: 100, now: () => now })
    pool.fail('http://a')
    expect(pool.next()).toBeNull()
    now = 101
    pool.health()
    expect(pool.next()).toBe('http://a')
    expect(Array.from({ length: 10 }, () => pool.next())).toEqual(Array(10).fill(null))
    expect(pool.health()[0]?.state).toBe('half-open')
    pool.fail('http://a')
    expect(pool.next()).toBeNull()
    now = 202
    expect(pool.next()).toBe('http://a')
    pool.succeed('http://a')
    expect(pool.next()).toBe('http://a')
    expect(pool.next()).toBe('http://a')
  })

  it('preserves an outstanding probe through discovery refresh', () => {
    let now = 0
    const pool = new Balancer({ endpoints: ['http://a'], failureThreshold: 1, openForMs: 100, now: () => now })
    pool.fail('http://a')
    now = 101
    expect(pool.next()).toBe('http://a')
    pool.setEndpoints(['http://a', 'http://b'])
    expect(pool.next()).toBe('http://b')
    expect(pool.next()).toBe('http://b')
  })
})
