import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { registerDesktopHandoff } from '../src/desktop-handoff.ts'

/**
 * 桌面壳与 dsh Web 的握手。dsh web 的浏览器会话鉴权用每个进程随机的 launch token，
 * 只有 `connection.authenticatedUrl()` 能给出带 token 的入口；桌面产品关掉了
 * printUrl/openBrowser，壳如果直接打开裸 URL 就会撞上
 * 「dsh web authentication required; reopen the URL printed by dsh web」。
 * 这里由插件在 Loader 装配完成后把入口写进壳指定的文件。
 */

interface FakeContext {
  injected: string[][]
  services: Record<string, unknown>
  inject(deps: string[], callback: (ctx: FakeContext) => void): void
  get(name: string): unknown
}

function fakeContext(services: Record<string, unknown>): FakeContext {
  const ctx: FakeContext = {
    injected: [],
    services,
    inject(deps, callback) { ctx.injected.push(deps); callback(ctx) },
    get(name) { return ctx.services[name] },
  }
  return ctx
}

const connection = { authenticatedUrl: (base: string) => `${base}/?token=launch-token` }
const webServer = { port: 3080 }

let directory: string
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

describe('桌面握手文件', () => {
  it('注入 connection 后写入带 token 的回环入口,权限 0600', () => {
    directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-'))
    const file = join(directory, 'nested', 'web-url')
    const ctx = fakeContext({ connection, webServer })
    registerDesktopHandoff(ctx as never, file)
    expect(ctx.injected).toEqual([['connection']])
    expect(readFileSync(file, 'utf8')).toBe('http://127.0.0.1:3080/?token=launch-token\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('有 Loader 时等装配结束再写,装配失败则不写', async () => {
    directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-'))
    const file = join(directory, 'web-url')
    let settle!: () => void
    const loader = { await: () => new Promise<void>((resolve) => { settle = resolve }) }
    const ctx = fakeContext({ connection, webServer, loader })
    registerDesktopHandoff(ctx as never, file)
    expect(existsSync(file)).toBe(false)
    settle()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readFileSync(file, 'utf8')).toBe('http://127.0.0.1:3080/?token=launch-token\n')

    const failed = join(directory, 'failed-url')
    const failing = fakeContext({ connection, webServer, loader: { await: () => Promise.reject(new Error('boot failed')) } })
    registerDesktopHandoff(failing as never, failed)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(existsSync(failed)).toBe(false)
  })

  it('装配完成前服务树已被拆掉则不写', async () => {
    directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-'))
    const file = join(directory, 'web-url')
    const ctx = fakeContext({ connection, webServer, loader: { await: () => Promise.resolve() } })
    registerDesktopHandoff(ctx as never, file)
    delete ctx.services['connection']
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(existsSync(file)).toBe(false)
  })
})
