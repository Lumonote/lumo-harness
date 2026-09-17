import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

let root = ''
let config: Config

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumo-local-assets-'))
  config = {
    schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
    realm: 'local', userId: 'desktop-user', roles: ['realm_admin'], projectId: '', deptId: '',
    controlPlaneToken: '', identityAssertionSecret: '', timeoutMs: 50,
    deploymentMode: 'local', storageBackend: 'sqlite', middleware: [], clusterStatus: 'not_ready', plugins: [],
    desktopHandoffFile: '', skillhubCatalogFile: join(root, 'catalog.json'),
    skillhubInstallFile: join(root, 'installs.json'), skillhubRoot: join(root, 'skills'),
    skillhubCommand: '', skillhubApiBase: 'https://skillhub.invalid', skillhubSnapshotFile: join(root, 'snapshot.json'),
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function call(method: string, url: string, body?: unknown, refresh = vi.fn()) {
  const raw = body === undefined ? [] : [JSON.stringify(body)]
  const req = Object.assign(Readable.from(raw), { method, url, headers: { 'content-type': 'application/json' } })
  const result = { status: 0, body: undefined as unknown }
  const res = {
    setHeader: () => undefined,
    writeHead: (status: number) => { result.status = status; return res },
    end: (chunk?: string) => {
      result.body = chunk === undefined || chunk === '' ? undefined : JSON.parse(chunk)
      return res
    },
  }
  await api(config, undefined, undefined, undefined, undefined, req as never, res as never, { refresh })
  return { ...result, refresh }
}

describe('local desktop skill and expert assets', () => {
  it('persists, lists, edits, and deletes a runtime skill without a governance server', async () => {
    const refresh = vi.fn().mockResolvedValue([])
    const created = await call('POST', '/lumo/api/governance/skills', {
      name: 'campaign-review', kind: 'prompt', description: '检查发布计划', current_version: '1.0.0',
      content: '# Review\n\nCheck the campaign.',
    }, refresh)
    expect(created.status).toBe(201)
    const skill = created.body as { id: string; name: string }
    expect(skill.name).toBe('campaign-review')

    // 落盘位置是 `<skillhubRoot>/lumo-local-<id>/SKILL.md`：目录名用随机 id 而不是用户
    // 提供的名称，名称不参与路径拼接；正文没有 frontmatter 时由实现补一个
    // `name: local-<id>`，运行时仍能把它当作可发现的技能。
    const document = join(root, 'skills', `lumo-local-${skill.id}`, 'SKILL.md')
    expect(readFileSync(document, 'utf8')).toContain(`name: local-${skill.id.toLowerCase()}`)

    const listed = await call('GET', '/lumo/api/governance')
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({ local: true, catalog: { data: { skills: [{ id: skill.id }] } } })

    const updated = await call('PATCH', `/lumo/api/governance/skills/${skill.id}`, {
      description: '检查发布计划与风险', content: '# Updated\n\nCheck risks.',
    }, refresh)
    expect(updated.status).toBe(200)
    expect(readFileSync(document, 'utf8')).toContain('Check risks.')

    expect((await call('DELETE', `/lumo/api/governance/skills/${skill.id}`, undefined, refresh)).status).toBe(204)
    expect((await call('GET', '/lumo/api/governance')).body).toMatchObject({ catalog: { data: { skills: [] } } })
    // 删除必须连带清掉运行时目录，否则运行时的文件系统 provider 会把已删技能重新发现。
    expect(existsSync(join(root, 'skills', `lumo-local-${skill.id}`))).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('persists, lists, edits, and deletes a local expert', async () => {
    const created = await call('POST', '/lumo/api/agent-presets', {
      name: '研究专家', description: '整理证据', provider: 'openai', model_ref: 'gpt-5',
      max_concurrency: 1, timeout_seconds: 3600,
    })
    expect(created.status).toBe(201)
    const expert = created.body as { id: string; revision: number }

    expect((await call('GET', '/lumo/api/agent-presets')).body).toMatchObject({ local: true, agent_presets: [{ id: expert.id, name: '研究专家' }] })
    const updated = await call('PATCH', `/lumo/api/agent-presets/${expert.id}`, { revision: expert.revision, name: '研究分析专家', max_concurrency: 2 })
    expect(updated.body).toMatchObject({ name: '研究分析专家', revision: 2, max_concurrency: 2 })

    expect((await call('DELETE', `/lumo/api/agent-presets/${expert.id}`)).status).toBe(204)
    expect((await call('GET', '/lumo/api/agent-presets')).body).toMatchObject({ local: true, agent_presets: [] })
  })
})
