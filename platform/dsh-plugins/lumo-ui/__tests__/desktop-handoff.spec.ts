import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'

import { registerDesktopHandoff } from '../src/desktop-handoff.ts'

/**
 * 桌面壳与 dsh Web 的握手。dsh web 的浏览器会话鉴权用每个进程随机的 launch token，
 * 鉴权插件通过 `webserver/entry-url` 提供带 token 的入口；桌面产品关掉了
 * printUrl/openBrowser，壳如果直接打开裸 URL 就会撞上
 * 「dsh web authentication required; reopen the URL printed by dsh web」。
 * 这里由插件在 Loader 装配完成后把入口写进壳指定的文件。
 */

interface FakeContext {
  injected: string[][]
  services: Record<string, unknown>
  inject(deps: string[], callback: (ctx: FakeContext) => void): void
  get(name: string): unknown
  emit(service: unknown, event: string, baseUrl: string, entries: WebEntryUrl[]): void
}

const launchEntry = (base: string): WebEntryUrl => ({ label: 'dsh web', url: `${base}/?token=launch-token`, open: true })

function fakeContext(services: Record<string, unknown>, provideEntries = (base: string): WebEntryUrl[] => [launchEntry(base)]): FakeContext {
  const ctx: FakeContext = {
    injected: [],
    services,
    inject(deps, callback) { ctx.injected.push(deps); callback(ctx) },
    get(name) { return ctx.services[name] },
    emit(service, event, baseUrl, entries) {
      expect(service).toBe(ctx.services['webServer'])
      expect(event).toBe('webserver/entry-url')
      expect(baseUrl).toBe('http://127.0.0.1:3080')
      entries.push(...provideEntries(baseUrl))
    },
  }
  return ctx
}

// Current DSH's connection service no longer owns browser login URLs.
const connection = {}
const webServer = { port: 3080 }

let directory: string
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

describe('桌面握手文件', () => {
  it('从鉴权入口事件取得带 token 的回环入口,权限 0600', () => {
    directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-'))
    const file = join(directory, 'nested', 'web-url')
    const ctx = fakeContext({ connection, webServer })
    registerDesktopHandoff(ctx as never, file)
    expect(ctx.injected).toEqual([['webServer']])
    expect(readFileSync(file, 'utf8')).toBe('http://127.0.0.1:3080/?token=launch-token\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('不依赖 connection,并保留第一个允许自动打开的入口', () => {
    directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-'))
    const file = join(directory, 'web-url')
    const url = 'http://127.0.0.1:3080/?token=provider-token&next=%2Fworkspace'
    const ctx = fakeContext({ webServer }, () => [
      { label: 'API', url: 'http://127.0.0.1:3080/connect?token=api-token', open: false },
      { label: 'Browser', url, open: true },
      { label: 'Other browser', url: 'http://127.0.0.1:3080/?token=other-token', open: true },
    ])
    registerDesktopHandoff(ctx as never, file)
    expect(readFileSync(file, 'utf8')).toBe(`${url}\n`)
  })

  it.each([
    { scenario: '没有鉴权提供方', entries: [] },
    { scenario: '只有 API 入口', entries: [{ label: 'API', url: 'http://127.0.0.1:3080/connect?token=api-token', open: false }] },
  ])('$scenario 时不发布握手文件', ({ entries }) => {
    directory = mkdtempSync(join(tmpdir(), 'lumo-handoff-'))
    const file = join(directory, 'web-url')
    const ctx = fakeContext({ connection, webServer }, () => entries)
    registerDesktopHandoff(ctx as never, file)
    expect(existsSync(file)).toBe(false)
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
    delete ctx.services['webServer']
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(existsSync(file)).toBe(false)
  })
})
