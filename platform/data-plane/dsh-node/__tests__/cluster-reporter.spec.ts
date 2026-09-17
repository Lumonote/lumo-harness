import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clusterReportIntervalMs,
  planClusterReporter,
  startClusterReporter,
  type ClusterReporterPlanEnabled,
} from '../src/cluster-reporter.ts'

const baseEnv = {
  LUMO_SCHEDULER_URL: 'http://scheduler-0:8083',
  LUMO_CONTROL_PLANE_TOKEN: 'token',
  LUMO_REALM: 'dev',
  LUMO_CLUSTER_ID: 'cluster-a',
}

function planOf(env: Record<string, string | undefined>, mode = 'cluster', role = 'node'): ClusterReporterPlanEnabled {
  const plan = planClusterReporter(env, mode, role)
  if (!plan.enabled) throw new Error(`用例期望自报开启，实际关闭：${plan.reason}`)
  return plan
}

describe('planClusterReporter', () => {
  it('非 cluster 形态不自报：注册表服务于跨集群放置，形态本身就没有消费者', () => {
    for (const mode of ['local', 'standalone']) {
      const plan = planClusterReporter(baseEnv, mode, 'node')
      expect(plan.enabled, `${mode} 应关闭自报`).toBe(false)
      if (plan.enabled) continue
      expect(plan.reason).toContain(mode)
      expect(plan.reason).toContain('cluster 形态')
    }
  })

  it('控制台/父节点不代报：它们配着同样的地址，但代报会把「承载节点全挂」伪装成健康', () => {
    for (const role of ['agent', '']) {
      const plan = planClusterReporter(baseEnv, 'cluster', role)
      expect(plan.enabled, `role=${role} 应关闭自报`).toBe(false)
      if (plan.enabled) continue
      expect(plan.reason).toContain('承载节点')
    }
  })

  it('缺调度地址或缺令牌时点名变量并说清后果，而不是启动失败', () => {
    const noScheduler = planClusterReporter({ ...baseEnv, LUMO_SCHEDULER_URL: undefined }, 'cluster', 'node')
    expect(noScheduler).toMatchObject({ enabled: false })
    if (!noScheduler.enabled) expect(noScheduler.reason).toContain('LUMO_SCHEDULER_URL')

    const noToken = planClusterReporter({ ...baseEnv, LUMO_CONTROL_PLANE_TOKEN: '  ' }, 'cluster', 'node')
    expect(noToken).toMatchObject({ enabled: false })
    if (!noToken.enabled) expect(noToken.reason).toContain('LUMO_CONTROL_PLANE_TOKEN')
  })

  it('拒绝带凭证/查询串的“base URL”，因为拼上路径只会得到静默 404', () => {
    for (const bad of ['http://u:p@h:1', 'http://h:1/?x=1', 'not-a-url', 'ftp://h:1']) {
      const plan = planClusterReporter({ ...baseEnv, LUMO_SCHEDULER_URL: bad }, 'cluster', 'node')
      expect(plan.enabled, `${bad} 应被拒绝`).toBe(false)
      if (!plan.enabled) expect(plan.reason).toContain('LUMO_SCHEDULER_URL')
    }
  })

  it('LUMO_SCHEDULER_API_URL 可作回落，末尾斜杠被吃掉', () => {
    const plan = planOf({ ...baseEnv, LUMO_SCHEDULER_URL: undefined, LUMO_SCHEDULER_API_URL: 'http://api:8083//' })
    expect(plan.target.schedulerUrl).toBe('http://api:8083')
  })

  it('cluster_id 与 Nacos 注册同源：未设时按 default 自报，并留下提醒', () => {
    const plan = planOf({ ...baseEnv, LUMO_CLUSTER_ID: undefined })
    expect(plan.target.clusterId).toBe('default')
    expect(plan.notes.join()).toContain('LUMO_CLUSTER_ID')

    const explicit = planOf({ ...baseEnv, LUMO_CLUSTER_ID: ' cluster-b ' })
    expect(explicit.target.clusterId).toBe('cluster-b')
    expect(explicit.notes).toEqual([])
  })

  it('realm 默认 dev，namespace/version 默认不声明（空串）', () => {
    const plan = planOf({ ...baseEnv, LUMO_REALM: undefined })
    expect(plan.target).toMatchObject({ realm: 'dev', namespace: '', version: '' })
  })
})

describe('clusterReportIntervalMs', () => {
  it('取 suspect/3（与调度器同一规则：连丢三次才算可疑）', () => {
    expect(clusterReportIntervalMs(30_000)).toBe(10_000)
    expect(clusterReportIntervalMs(9_000)).toBe(3_000)
    expect(clusterReportIntervalMs(1_500)).toBe(1_000)
  })

  it('极小或缺失的阈值不会派生出忙循环', () => {
    expect(clusterReportIntervalMs(900)).toBe(1_000)
    expect(clusterReportIntervalMs(0)).toBe(10_000)
    expect(clusterReportIntervalMs(Number.NaN)).toBe(10_000)
    expect(clusterReportIntervalMs(-1)).toBe(10_000)
  })
})

type Stubbed = {
  fetchImpl: typeof globalThis.fetch
  puts: string[]
  fails: { value: boolean }
}

function stubFetch(options: { suspectMs?: number; enforced?: boolean; putStatus?: number } = {}): Stubbed {
  const puts: string[] = []
  const fails = { value: options.putStatus !== undefined }
  const putStatus = options.putStatus ?? 200
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input)
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      puts.push(url)
      if (fails.value) {
        return new Response(JSON.stringify({ error: 'cluster-realm-conflict', message: '该 cluster_id 已属于另一个 realm' }), { status: putStatus })
      }
      return new Response('{}', { status: 200 })
    }
    return new Response(JSON.stringify({
      clusters: [], enforced: options.enforced ?? true, suspect_ms: options.suspectMs ?? 30_000,
    }), { status: 200 })
  })
  return { fetchImpl, puts, fails }
}

function loggerStub() {
  const info: string[] = []
  const warn: string[] = []
  const error: string[] = []
  return {
    logger: {
      info: (message: string) => { info.push(message) },
      warn: (message: string) => { warn.push(message) },
      error: (message: string) => { error.push(message) },
    },
    info, warn, error,
  }
}

describe('startClusterReporter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('第一次 cycle 先探控制面阈值，再按它决定后续周期', async () => {
    const stub = stubFetch({ suspectMs: 9_000 })
    const sink = loggerStub()
    const reporter = startClusterReporter(planOf(baseEnv), sink.logger, { fetch: stub.fetchImpl })
    await vi.advanceTimersByTimeAsync(0)

    expect(stub.puts).toEqual(['http://scheduler-0:8083/v1/clusters/cluster-a'])
    expect(sink.info.join()).toContain('10000ms → 3000ms')

    // 周期确实变成 3s：还没到点时不再有 PUT，到了点才有第二条。
    await vi.advanceTimersByTimeAsync(2_999)
    expect(stub.puts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(stub.puts).toHaveLength(2)
    // 阈值只探一次：第二、三轮不再发 GET（否则每轮多一次读，且阈值抖动会拖着周期抖）。
    const gets = vi.mocked(stub.fetchImpl).mock.calls
      .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'GET')
    expect(gets).toHaveLength(1)

    await reporter.close()
  })

  it('自报带上 realm 与控制面令牌，且声明只发非空字段', async () => {
    const stub = stubFetch()
    const reporter = startClusterReporter(
      planOf({ ...baseEnv, LUMO_CLUSTER_VERSION: '1.2.3' }),
      loggerStub().logger,
      { fetch: stub.fetchImpl },
    )
    await vi.advanceTimersByTimeAsync(0)

    const put = vi.mocked(stub.fetchImpl).mock.calls
      .find(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT')
    expect(put?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer token', 'X-Lumo-Realm': 'dev', 'Content-Type': 'application/json',
    })
    // namespace 未声明 → 不出现在体内（服务端对空值是「保持原值」）。
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ version: '1.2.3' })

    await reporter.close()
  })

  it('失败只做状态跃迁日志：连续失败不刷屏，恢复时补一条', async () => {
    const stub = stubFetch({ putStatus: 409 })
    const sink = loggerStub()
    const reporter = startClusterReporter(planOf(baseEnv), sink.logger, { fetch: stub.fetchImpl })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stub.puts).toHaveLength(2)
    expect(sink.error).toHaveLength(1)
    // 服务端的 message 必须带出来：409（realm 冲突）与不通网络处置完全不同。
    expect(sink.error[0]).toContain('已属于另一个 realm')

    stub.fails.value = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sink.error).toHaveLength(1)
    expect(sink.info.join()).toContain('集群自报已恢复')

    await reporter.close()
  })

  it('控制面开着却没开判定时必须说出来，否则运维会以为闸门在生效', async () => {
    const stub = stubFetch({ enforced: false })
    const sink = loggerStub()
    const reporter = startClusterReporter(planOf(baseEnv), sink.logger, { fetch: stub.fetchImpl })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    const noticed = sink.warn.filter(message => message.includes('enforced=false'))
    expect(noticed).toHaveLength(1)
    expect(noticed[0]).toContain('LUMO_CLUSTER_ENFORCE')

    await reporter.close()
  })

  it('close() 之后不再发请求（自报定时器不该拖住进程退出）', async () => {
    const stub = stubFetch()
    const reporter = startClusterReporter(planOf(baseEnv), loggerStub().logger, { fetch: stub.fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.puts).toHaveLength(1)

    await reporter.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stub.puts).toHaveLength(1)
  })

  it('读不到控制面阈值时按本地值继续，并只提醒一次', async () => {
    const puts: string[] = []
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
        puts.push(String(input))
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'cluster-registry-unavailable' }), { status: 503 })
    })
    const sink = loggerStub()
    const reporter = startClusterReporter(planOf(baseEnv), sink.logger, { fetch: fetchImpl })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(puts).toHaveLength(3)
    expect(sink.warn.filter(message => message.includes('读不到控制面的 suspect_ms'))).toHaveLength(1)
    expect(sink.info.join()).toContain('10000ms')

    await reporter.close()
  })
})
