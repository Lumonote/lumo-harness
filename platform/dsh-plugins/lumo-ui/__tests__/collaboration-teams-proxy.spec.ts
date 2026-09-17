import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'admin-a', roles: ['realm_admin'], projectId: '', deptId: '',
  controlPlaneToken: '', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config

function request(method: string, url: string) {
  return Object.assign(Readable.from([]), { method, url, headers: {} })
}

function response(): { res: import('node:http').ServerResponse; result: { status: number; body: unknown } } {
  const result = { status: 0, body: undefined as unknown }
  const res = {
    setHeader: () => undefined,
    writeHead: (status: number) => { result.status = status; return res },
    end: (chunk?: string) => { result.body = chunk === undefined ? undefined : JSON.parse(chunk); return res },
  }
  return { res: res as unknown as import('node:http').ServerResponse, result }
}

/** 一个假 team 服务。这两个方法就是本路由用到的全部 dsh 面。 */
function teamsService() {
  return {
    list: vi.fn().mockResolvedValue([{ id: 'team-1', name: '秋季新品发布', topology: 'pipeline', captainSessionId: 's-1' }]),
    status: vi.fn().mockResolvedValue({
      team: {
        id: 'team-1', name: '秋季新品发布', topology: 'pipeline', captainSessionId: 's-1',
        members: [
          { name: '规划 Agent', role: 'planner', provider: 'spawn', status: 'working', ownerUserId: 'employee-1' },
          { name: '质检 Agent', provider: 'fork', status: 'idle' },
        ],
        tasks: [{ id: 't1', subject: '拆解', status: 'completed', assignee: '规划 Agent', dependencies: [] }],
      },
      progress: { total: 1, pending: 0, active: 0, completed: 1, failed: 0, cancelled: 0, ready: [], blocked: [] },
      settled: true,
    }),
  }
}

async function get(agentTeams: ReturnType<typeof teamsService> | undefined) {
  const { res, result } = response()
  // 位置参数与生产调用一致；agentTeams 是末尾那个可选项。
  await api(config, undefined, undefined, undefined, undefined,
    request('GET', '/lumo/api/collaboration/teams') as never, res, undefined, agentTeams)
  return result
}

describe('collaboration teams API', () => {
  it('把每个团队连同它的进度投影一起交出去', async () => {
    const result = await get(teamsService())
    expect(result.status).toBe(200)
    const teams = (result.body as { teams: Array<Record<string, unknown>> }).teams
    expect(teams).toHaveLength(1)
    expect(teams[0]?.id).toBe('team-1')
    expect(teams[0]?.topology).toBe('pipeline')
    // progress 用的是 agentTeams 自己的投影，而不是这里另算一份：`ready`/`blocked`
    // 的判据（依赖已齐、无人可派）是那边的定义，重算就会有两份会分叉的规则。
    expect(teams[0]?.progress).toMatchObject({ completed: 1, blocked: [] })
    expect(teams[0]?.settled).toBe(true)
  })

  it('原样带出成员，缺省的 ownerUserId 不会被补成空串或占位值', async () => {
    // 这条是整条链的接缝：客户端靠 `undefined` 把成员放进「未绑定」区。一旦这里
    // 用 `?? ''` 之类补一个值，两种含义在传输层就已经分不开——而图上看不出来，
    // 只会看到「这个 Agent 挂在一个不存在的员工下面」。
    const result = await get(teamsService())
    const members = (result.body as { teams: Array<{ members: Array<Record<string, unknown>> }> }).teams[0]?.members ?? []
    expect(members[0]?.ownerUserId).toBe('employee-1')
    expect(members[1]?.ownerUserId).toBeUndefined()
    expect('ownerUserId' in (members[1] ?? {})).toBe(false)
  })

  it('服务没装配时回 503 并说明缺席，而不是一个空列表', async () => {
    // 空列表读起来是「没有团队」——那是一个结论。而这台机器可能只是没装
    // agent-teams。把缺席说成结论，正是本仓库反复禁止的那一类。
    const result = await get(undefined)
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ error: 'agent_teams_unavailable' })
  })

  it('读取失败时回 502，不把异常当成空结果', async () => {
    const service = teamsService()
    service.status = vi.fn().mockRejectedValue(new Error('storage backend is closed'))
    const result = await get(service)
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'agent_teams_read_failed' })
  })
})
