import { describe, expect, it } from 'vitest'
import { resolveSidebarIdentity } from '../src/client/sidebar-identity.ts'

/**
 * 侧边栏登录态的映射规则。
 *
 * 这个文件刻意**不带** jsdom 环境的 pragma：它只钉纯函数，跑得起来才算证据。
 * `client.spec.tsx` 里的 jsdom 用例在本机起不来（jsdom 未声明为 platform 的依赖，
 * 见 `.workbuddy-ai/memory/local-sandbox.md` §3/§4），所以凡是能抽成纯函数的判据
 * 都不放在那里。
 *
 * ⚠️ 别在注释里**写出那个 pragma 的字面量**（哪怕是在说「我不用它」）：vitest 是
 * 按字符串扫文件头找 pragma 的，写出来就会真的去加载 jsdom，而 jsdom 在这里装不上
 * ——症状是 `Failed to start forks worker` / 60s `Timeout waiting for worker to respond`，
 * 看起来像环境问题而不是这一行注释。实测踩过。
 */

const account = { mode: 'session', provider: 'lumo-governance', username: 'palmer', displayName: 'Palmer', userId: 'palmer', realm: 'dev', roles: ['operator'], department: 'platform', clientIp: '127.0.0.1', captchaMode: 'always' }

describe('resolveSidebarIdentity', () => {
  it('把 200 的账号读成身份：显示名 + realm 与角色', () => {
    expect(resolveSidebarIdentity({ ok: true, body: account })).toEqual({ state: 'signed-in', name: 'Palmer', facts: 'dev · operator' })
  })

  it('没有显示名时回落到用户名，而不是渲染一个空名字', () => {
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer' } })).toEqual({ state: 'signed-in', name: 'palmer', facts: '' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', displayName: '' } })).toEqual({ state: 'signed-in', name: 'palmer', facts: '' })
  })

  it('realm 与角色各自缺失时不留下悬空的分隔符', () => {
    // 拼出 `dev · ` 这种结尾，读起来像「还有一个角色没显示出来」——比少显示一个字段更坏。
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', realm: 'dev' } })).toEqual({ state: 'signed-in', name: 'palmer', facts: 'dev' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', roles: ['operator'] } })).toEqual({ state: 'signed-in', name: 'palmer', facts: 'operator' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', roles: [] } })).toEqual({ state: 'signed-in', name: 'palmer', facts: '' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', realm: '', roles: [''] } })).toEqual({ state: 'signed-in', name: 'palmer', facts: '' })
  })

  it('角色数组里混进坏值时不产出 "undefined"', () => {
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', roles: ['operator', null, 7, 'auditor'] } })).toEqual({ state: 'signed-in', name: 'palmer', facts: 'operator · auditor' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: 'palmer', roles: 'operator' } })).toEqual({ state: 'signed-in', name: 'palmer', facts: '' })
  })

  it('200 但正文不是账号（单机版把 HTML 用 200 回给你）时不当作身份', () => {
    // `api()` 对非 JSON 的响应会把正文原样返回，所以这条分支真的会发生。只看
    // response.ok 就会把半段 HTML 当成用户名渲染出来。
    expect(resolveSidebarIdentity({ ok: true, body: '<!doctype html><title>DeepSeek Harness</title>' })).toEqual({ state: 'unavailable' })
    expect(resolveSidebarIdentity({ ok: true, body: null })).toEqual({ state: 'unavailable' })
    expect(resolveSidebarIdentity({ ok: true, body: {} })).toEqual({ state: 'unavailable' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: '' } })).toEqual({ state: 'unavailable' })
    expect(resolveSidebarIdentity({ ok: true, body: { username: 42 } })).toEqual({ state: 'unavailable' })
  })

  it('401 是「有鉴权、没会话」，404 与请求失败是「这里没有登录这回事」', () => {
    // 这一条是这个模块存在的理由：把 404 也说成「未登录」，就是在一个没有登录的部署里
    // 陈述一个不存在的问题（单机版不挂 auth 代理，这个路径会落到原生 Web 服务上）。
    expect(resolveSidebarIdentity({ ok: false, status: 401 })).toEqual({ state: 'anonymous' })
    expect(resolveSidebarIdentity({ ok: false, status: 404 })).toEqual({ state: 'unavailable' })
    expect(resolveSidebarIdentity({ ok: false, status: 502 })).toEqual({ state: 'unavailable' })
    expect(resolveSidebarIdentity({ ok: false, status: undefined })).toEqual({ state: 'unavailable' })
  })
})
