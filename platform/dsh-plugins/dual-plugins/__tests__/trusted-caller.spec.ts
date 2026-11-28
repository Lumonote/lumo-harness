import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { bindToolCaller } from '../../../shared/seam-contracts/tool-caller.ts'
import { callerFromExec, createDualHost, registerDualPlugin, resetDualGateway, toDshTool, type DualPluginManifest } from '../src/index.ts'

const manifest: DualPluginManifest = { manifestVersion: 1, id: 'identity', title: 'Identity', pages: [], tools: [{ name: 'identity_read', description: 'fixture', action: 'identity:read', risk: 'low', parameters: { type: 'object', properties: {}, additionalProperties: true } }] }
const agent = () => ({ id: 'agent', session: { id: 'session' } })
const identity = { realm: 'realm', userId: 'alice', projectId: 'project' }
afterEach(() => { vi.unstubAllGlobals(); resetDualGateway() })

function setup(mode: 'local' | 'standalone' | 'cluster') {
  resetDualGateway()
  const authorization = vi.fn(async () => Response.json({ effect: 'allow', decision_id: 'decision', reason_code: 'authorized', reason: 'ok', matched: [] }))
  vi.stubGlobal('fetch', authorization)
  const host = createDualHost({ deploymentMode: mode, governanceUrl: 'http://governance', defaults: { realm: 'deployment', userId: 'admin' }, env: { LUMO_DUAL_ACP_MCP: 'off' } })!
  let tool!: ToolDefinition
  const handler = vi.fn((_args, ctx) => ctx.caller)
  const off = registerDualPlugin({ register: value => { tool = value; return () => {} } }, manifest, { identity_read: handler })
  const invoke = (current: object, args = {}) => tool.execute(args, { agent: current, signal: new AbortController().signal } as never)
  return { host, off, invoke, handler, authorization }
}

describe('trusted platform tool callers', () => {
  it.each(['local', 'standalone', 'cluster'] as const)('uses the authenticated binding in %s, ignoring model identity fields', async mode => {
    const h = setup(mode), current = agent()
    const release = bindToolCaller(current, async () => identity)
    try {
      expect(await h.invoke(current, { realm: 'attacker', userId: 'admin', projectId: 'other' })).toMatchObject({ ...identity, sessionRef: 'session', agentId: 'agent' })
      expect(h.authorization).toHaveBeenCalledTimes(mode === 'local' ? 0 : 1)
    } finally { release(); h.off(); h.host.close() }
  })

  it.each(['standalone', 'cluster'] as const)('denies missing and same-id copied Agents in %s before calling policy', async mode => {
    const h = setup(mode), current = agent()
    const release = bindToolCaller(current, () => identity)
    try {
      await expect(h.invoke(agent())).rejects.toThrow('realm_mismatch')
      expect(h.authorization).not.toHaveBeenCalled()
      release()
      await expect(h.invoke(current)).rejects.toThrow('no longer active')
      expect(h.handler).not.toHaveBeenCalled()
    } finally { release(); h.off(); h.host.close() }
  })

  it('rejects a revoked binding even when the old resolver later succeeds', async () => {
    const current = agent()
    let finish!: (value: typeof identity) => void
    const release = bindToolCaller(current, () => new Promise(resolve => { finish = resolve }))
    const pending = callerFromExec({ agent: current } as never)
    release(); finish(identity)
    await expect(pending).rejects.toThrow('no longer active')
  })

  it('does not let a previous disposer remove a new binding on the same exact Agent', async () => {
    const current = agent()
    const old = bindToolCaller(current, () => identity)
    const latest = bindToolCaller(current, () => ({ ...identity, userId: 'bob' }))
    old()
    expect(await callerFromExec({ agent: current } as never)).toMatchObject({ userId: 'bob' })
    latest()
  })

  it('cancels before a pending identity resolver finishes', async () => {
    const h = setup('cluster')
    const controller = new AbortController()
    const tool = toDshTool(h.host.gateway, manifest.tools[0]!, () => new Promise(() => {}))
    const pending = tool.execute({}, { agent: agent(), signal: controller.signal } as never)
    controller.abort(new Error('stopped'))
    await expect(pending).rejects.toThrow('stopped')
    expect(h.handler).not.toHaveBeenCalled()
    h.off(); h.host.close()
  })

  it('lets plugin registration supply an explicit asynchronous host resolver', async () => {
    resetDualGateway()
    let tool!: ToolDefinition
    const host = createDualHost({ deploymentMode: 'local', defaults: { realm: 'local', userId: 'local' }, env: { LUMO_DUAL_ACP_MCP: 'off' } })!
    const off = registerDualPlugin({ register: value => { tool = value; return () => {} } }, manifest, { identity_read: (_args, ctx) => ctx.caller }, async () => identity)
    expect(await tool.execute({}, { agent: agent() } as never)).toMatchObject(identity)
    off(); host.close()
  })
})
