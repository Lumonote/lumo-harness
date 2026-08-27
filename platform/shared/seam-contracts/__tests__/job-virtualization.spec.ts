import { describe, expect, it } from 'vitest'
import {
  assertJobRef,
  assertJobVirtualizationContract,
  formatJobRef,
  isJobControlCommand,
  isJobResultEvent,
  isTerminal,
  isTerminalJobStatus,
  jobRefOf,
  parseJobRef,
  reduceJobEvents,
  type JobControlDecision,
  type JobControlRequest,
  type JobControlSeam,
  type JobLifecycleStatus,
  type JobRef,
  type JobResultEvent,
  type JobSnapshotView,
} from '../job-virtualization.ts'

/** 内存控制通道：预置 running job，模拟「下发与执行分离、执行节点以本地行动为准」。 */
class MemoryJobControlSeam implements JobControlSeam {
  private jobs = new Map<string, JobSnapshotView>()
  private log = new Map<string, JobResultEvent[]>()
  private seen = new Map<string, JobControlDecision>()

  /** 预置一个在跑 job（started 事件 + running 快照）。 */
  register(ref: JobRef, kind = 'bash', label = 'make build'): void {
    const key = formatJobRef(ref)
    const startedAt = 1000
    this.append({ type: 'job/started', seq: this.nextSeq(ref.sessionRef), ref, kind, label, startedAt })
    this.jobs.set(key, { ref, kind, status: 'running', startedAt })
  }

  private nextSeq(sessionRef: string): number {
    const arr = this.log.get(sessionRef)
    return arr && arr.length > 0 ? arr[arr.length - 1]!.seq + 1 : 1
  }

  private append(e: JobResultEvent): void {
    const arr = this.log.get(e.ref.sessionRef)
    if (arr) arr.push(e)
    else this.log.set(e.ref.sessionRef, [e])
  }

  private job(ref: JobRef): JobSnapshotView | undefined {
    return this.jobs.get(formatJobRef(ref))
  }

  async dispatch(request: JobControlRequest): Promise<JobControlDecision> {
    const prior = this.seen.get(request.correlationId)
    if (prior) return prior

    const decide = (d: JobControlDecision): JobControlDecision => {
      this.seen.set(request.correlationId, d)
      return d
    }

    // 授权先于存在性/终态判定（断言：无权者必须先于一切业务判定被拒）
    if (request.role === 'viewer') return decide({ allowed: false, reason: 'not-authorized' })

    const job = this.job(request.ref)
    if (!job) return decide({ allowed: false, reason: 'unknown-job' })

    if (request.command === 'status') {
      return decide({ allowed: true, effect: 'observed' })
    }

    // kill / timeout
    if (isTerminal(job.status)) {
      return decide({ allowed: true, effect: 'already-terminal' })
    }
    if (request.command === 'kill') {
      job.status = 'killed'
      job.detail = request.reason
      job.finishedAt = 2000
      this.append({
        type: 'job/finished', seq: this.nextSeq(request.ref.sessionRef),
        ref: request.ref, status: 'killed', detail: request.reason, finishedAt: job.finishedAt,
      })
    }
    return decide({ allowed: true, effect: 'requested' })
  }

  async events(sessionRef: string, fromSeq?: number): Promise<JobResultEvent[]> {
    const arr = this.log.get(sessionRef) ?? []
    return fromSeq === undefined ? [...arr] : arr.filter((e) => e.seq >= fromSeq)
  }

  async snapshot(ref: JobRef): Promise<JobSnapshotView | undefined> {
    return this.job(ref)
  }
}

describe('job-virtualization contract', () => {
  it('passes on the memory stub', async () => {
    const seam = new MemoryJobControlSeam()
    seam.register(jobRefOf('s1', 'node-1', 'bash-1'))
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertJobVirtualizationContract(seam, assert)
  })
})

describe('JobRef 句柄虚拟化映射', () => {
  it('format/parse 往返一致', () => {
    const ref = jobRefOf('s1', 'node-1', 'bash-3')
    expect(parseJobRef(formatJobRef(ref))).toEqual(ref)
  })

  it('format 编码了 node、sessionRef、jobId 三分量', () => {
    const s = formatJobRef(jobRefOf('sess', 'nodeA', 'subagent-2'))
    expect(s).toBe('nodeA::sess::subagent-2')
    expect(s.split('::')).toHaveLength(3)
  })

  it('assertJobRef 拒绝空分量与保留分隔符', () => {
    expect(() => assertJobRef({ sessionRef: '', node: 'n', jobId: 'j' })).toThrow(/缺 sessionRef/)
    expect(() => assertJobRef({ sessionRef: 's', node: 'n', jobId: 'a::b' })).toThrow(/分隔符/)
    expect(() => assertJobRef({ sessionRef: 's', node: 'n', jobId: 'j' })).not.toThrow()
  })

  it('parseJobRef 拒绝畸形串', () => {
    expect(() => parseJobRef('a::b')).toThrow(/非法/)
    expect(() => parseJobRef('')).toThrow(/非法/)
    expect(() => parseJobRef('a::b::c::d')).toThrow(/非法/)
  })
})

describe('job 级控制闭集', () => {
  it('kill/timeout/status 在闭集内，其余一律拒绝', () => {
    expect(isJobControlCommand('kill')).toBe(true)
    expect(isJobControlCommand('timeout')).toBe(true)
    expect(isJobControlCommand('status')).toBe(true)
    expect(isJobControlCommand('pause')).toBe(false)
    expect(isJobControlCommand('abort')).toBe(false)
    expect(isJobControlCommand('constructor')).toBe(false)
  })
})

describe('终态闭集', () => {
  it('仅 completed/killed/failed 是终态', () => {
    const terminals: JobLifecycleStatus[] = ['completed', 'killed', 'failed']
    for (const t of terminals) {
      expect(isTerminalJobStatus(t)).toBe(true)
      expect(isTerminal(t)).toBe(true)
    }
    for (const live of ['running', 'stopping'] as JobLifecycleStatus[]) {
      expect(isTerminalJobStatus(live)).toBe(false)
      expect(isTerminal(live)).toBe(false)
    }
  })
})

describe('结果事件闭集', () => {
  it('只认 started/output/finished', () => {
    expect(isJobResultEvent({ type: 'job/started' })).toBe(true)
    expect(isJobResultEvent({ type: 'job/output' })).toBe(true)
    expect(isJobResultEvent({ type: 'job/finished' })).toBe(true)
    expect(isJobResultEvent({ type: 'job/paused' })).toBe(false)
    expect(isJobResultEvent(null)).toBe(false)
    expect(isJobResultEvent('job/started')).toBe(false)
  })
})

describe('reduceJobEvents —— 从结果事件流重建 job 状态', () => {
  it('started + finished 折叠为终态快照', () => {
    const ref = jobRefOf('s1', 'node-1', 'bash-1')
    const events: JobResultEvent[] = [
      { type: 'job/started', seq: 1, ref, kind: 'bash', label: 'x', startedAt: 1 },
      { type: 'job/output', seq: 2, ref, text: 'hello' },
      { type: 'job/finished', seq: 3, ref, status: 'failed', detail: 'exit 1', finishedAt: 5 },
    ]
    const snap = reduceJobEvents(events).get(formatJobRef(ref))!
    expect(snap.status).toBe('failed')
    expect(snap.kind).toBe('bash')
    expect(snap.startedAt).toBe(1)
    expect(snap.finishedAt).toBe(5)
    expect(snap.detail).toBe('exit 1')
  })

  it('未 finished 的 job 保持 running', () => {
    const ref = jobRefOf('s1', 'node-1', 'bash-2')
    const snap = reduceJobEvents([
      { type: 'job/started', seq: 1, ref, kind: 'bash', label: 'x', startedAt: 1 },
    ]).get(formatJobRef(ref))!
    expect(snap.status).toBe('running')
    expect(snap.finishedAt).toBeUndefined()
  })

  it('多个 job 按 ref 分组，互不串扰', () => {
    const a = jobRefOf('s1', 'node-1', 'bash-1')
    const b = jobRefOf('s1', 'node-1', 'bash-2')
    const m = reduceJobEvents([
      { type: 'job/started', seq: 1, ref: a, kind: 'bash', label: 'a', startedAt: 1 },
      { type: 'job/started', seq: 2, ref: b, kind: 'subagent', label: 'b', startedAt: 2 },
      { type: 'job/finished', seq: 3, ref: a, status: 'completed', finishedAt: 4 },
    ])
    expect(m.get(formatJobRef(a))!.status).toBe('completed')
    expect(m.get(formatJobRef(b))!.status).toBe('running')
  })
})