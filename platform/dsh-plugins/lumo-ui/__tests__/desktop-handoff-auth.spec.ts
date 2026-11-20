import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import * as Connection from '../../../../deepseek-harness/packages/client/connection/src/index.ts'
import * as Token from '../../../../deepseek-harness/packages/host/authentication-token/src/index.ts'
import { provideBrowserCredentials } from '../../../../deepseek-harness/packages/client/connection/tests/browser-credentials.ts'
import { registerDesktopHandoff } from '../src/desktop-handoff.ts'

const authority = '127.0.0.1:3080'

function request(url: string, cookie?: string): IncomingMessage {
  return { method: 'GET', url, headers: { host: authority, ...(cookie ? { cookie } : {}) } } as IncomingMessage
}

it('waits for token authentication to load and publishes a URL that exchanges for an accepted browser cookie', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-auth-'))
  const file = join(directory, 'web-url')
  const ctx = new Context()
  try {
    provideBrowserCredentials(ctx)
    const routes: WebRoute[] = []
    ctx.provide('webServer', {
      protocol: 'http:', host: '127.0.0.1', port: 3080,
      register: (route: WebRoute) => { routes.push(route); return () => {} },
    } as never)
    await ctx.plugin({ inject: [...Connection.inject], apply: Connection.apply }).await()

    const ready = Promise.withResolvers<void>()
    const loader = { await: vi.fn(() => ready.promise) }
    ctx.provide('loader', loader as never)
    await ctx.plugin({ apply: (scope: Context) => { registerDesktopHandoff(scope, file) } }).await()
    expect(loader.await).toHaveBeenCalledOnce()
    expect(existsSync(file)).toBe(false)

    await ctx.plugin(Token, { cookieMaxAgeDays: 30 }).await()
    expect(existsSync(file)).toBe(false)
    ready.resolve()
    await vi.waitFor(() => { expect(existsSync(file)).toBe(true) })

    const launch = new URL(readFileSync(file, 'utf8').trim())
    expect(launch.origin).toBe(`http://${authority}`)
    expect(launch.pathname).toBe('/')
    expect(launch.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const reply = { status: 0, headers: {} as Record<string, string> }
    const response = {
      writeHead(status: number, headers: Record<string, string>) { reply.status = status; reply.headers = headers },
      end() {},
    } as ServerResponse
    await ctx.waterfall('webserver/request', request(`${launch.pathname}${launch.search}`), response, async () => {})
    expect(reply.status).toBe(303)
    const cookie = reply.headers['set-cookie']?.split(';')[0]
    expect(cookie).toBeTruthy()
    expect(ctx.connection.admit(request('/', cookie))).toHaveProperty('peer.principal.kind', 'owner')
    expect(ctx.connection.admit(request('/'))).toHaveProperty('rejection', 401)
  } finally {
    await ctx.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
