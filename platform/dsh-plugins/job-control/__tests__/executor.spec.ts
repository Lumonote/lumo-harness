import { describe, expect, it } from 'vitest'

import { JobControlExecutor } from '../src/executor.ts'
import type { JobControlInbox, LocalJobSnapshot, PendingJobControl } from '../src/pg-job-control.ts'

const owner = { session: { id: 'session-1' } }

class FakeInbox implements JobControlInbox {
  readonly recorded: LocalJobSnapshot[] = []
  readonly acknowledged: string[] = []
  pending: PendingJobControl[] = []

  async record(snapshot: LocalJobSnapshot): Promise<void> { this.recorded.push(snapshot) }
  async take(): Promise<PendingJobControl[]> {
    const out = this.pending
    this.pending = []
    return out
  }
  async ack(correlationId: string): Promise<void> { this.acknowledged.push(correlationId) }
}

describe('JobControlExecutor', () => {
  it('exports only session-owned jobs as node-addressed JobRefs', async () => {
    const inbox = new FakeInbox()
    const registry = {
      list: () => [
        { id: 'bash-1', kind: 'bash', label: 'build', ownerSession: 'session-1' as string | undefined,
          status: 'running' as const, startedAt: 10 },
        { id: 'bash-2', kind: 'bash', label: 'open', ownerSession: undefined,
          status: 'running' as const, startedAt: 11 },
      ],
      kill: () => 'requested' as const,
      onJobsChanged: () => () => {},
      onJobDone: () => () => {},
    }
    const executor = new JobControlExecutor('node-a', registry, inbox)

    await executor.observe(owner)

    expect(inbox.recorded).toEqual([{
      ref: { sessionRef: 'session-1', node: 'node-a', jobId: 'bash-1' },
      kind: 'bash', label: 'build', status: 'running', startedAt: 10,
    }])
  })

  it('executes kill/timeout only against the owning node-local handle, then acks', async () => {
    const inbox = new FakeInbox()
    const killed: Array<{ id: string; by: unknown; reason?: string }> = []
    const snapshot = {
      id: 'bash-1', kind: 'bash', label: 'build', ownerSession: 'session-1',
      status: 'running' as const, startedAt: 10,
    }
    const registry = {
      list: () => [snapshot],
      kill: (id: string, by: unknown, reason?: string) => {
        killed.push({ id, by, reason })
        return 'requested' as const
      },
      onJobsChanged: () => () => {},
      onJobDone: () => () => {},
    }
    const executor = new JobControlExecutor('node-a', registry, inbox)
    await executor.observe(owner)
    inbox.pending = [{
      correlationId: 'c1', command: 'timeout', reason: 'deadline',
      ref: { sessionRef: 'session-1', node: 'node-a', jobId: 'bash-1' },
    }]

    await executor.drainOnce()

    expect(killed).toEqual([{ id: 'bash-1', by: owner, reason: 'deadline' }])
    expect(inbox.acknowledged).toEqual(['c1'])
  })

  it('acks a command for a no-longer-local handle instead of killing a replacement process', async () => {
    const inbox = new FakeInbox()
    const registry = {
      list: () => [],
      kill: () => { throw new Error('must not kill') },
      onJobsChanged: () => () => {},
      onJobDone: () => () => {},
    }
    const executor = new JobControlExecutor('node-a', registry, inbox)
    inbox.pending = [{
      correlationId: 'c-gone', command: 'kill', reason: 'cancel',
      ref: { sessionRef: 'session-1', node: 'node-a', jobId: 'bash-404' },
    }]

    await executor.drainOnce()

    expect(inbox.acknowledged).toEqual(['c-gone'])
  })

  it('routes a non-ctx.jobs handle (remote subagent) through the same mailbox', async () => {
    const inbox = new FakeInbox()
    const registry = {
      list: () => [],
      kill: () => { throw new Error('must not use ctx.jobs for this handle') },
      onJobsChanged: () => () => {},
      onJobDone: () => () => {},
    }
    const executor = new JobControlExecutor('node-a', registry, inbox)
    const cancelled: string[] = []
    const ref = await executor.register(
      { sessionRef: 'parent-1', jobId: 'child-1' },
      { kind: 'subagent', label: 'research', status: 'running', startedAt: 1 },
      (reason) => { cancelled.push(reason ?? '') },
    )
    inbox.pending = [{ correlationId: 'c-child', ref, command: 'kill', reason: 'parent disposed' }]

    await executor.drainOnce()
    await executor.settle(ref, { kind: 'subagent', label: 'research', status: 'killed', startedAt: 1, finishedAt: 2 })

    expect(cancelled).toEqual(['parent disposed'])
    expect(inbox.acknowledged).toEqual(['c-child'])
    expect(inbox.recorded).toEqual([
      { ref, kind: 'subagent', label: 'research', status: 'running', startedAt: 1 },
      { ref, kind: 'subagent', label: 'research', status: 'killed', startedAt: 1, finishedAt: 2 },
    ])
  })
})
