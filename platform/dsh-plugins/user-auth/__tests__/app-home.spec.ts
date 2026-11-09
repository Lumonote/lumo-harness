import { describe, expect, it, vi } from 'vitest'

import { AUTHENTICATED_APP_HOME } from '../src/app-home.ts'
import { loginScript } from '../src/html.ts'
import { querySurface, surfaceMeta, availableSurfaces } from '../../lumo-ui/src/client/surface-navigation.ts'

/**
 * 登录成功之后落在哪一页。
 *
 * 这个常量本身只有一行，值得单测是因为它是一条**跨模块契约**的两半之一：
 * 这里写下的 `?lumo=collaboration`，要靠 `lumo-ui` 客户端解析成协作工作台。
 * 两半分叉时不会有任何报错——登录成功、页面正常打开，只是又回到那个**空白的原生
 * 会话页**，也就是这个常量存在的原因。所以下面既钉常量的形状，也钉消费方真的认它。
 */
describe('AUTHENTICATED_APP_HOME', () => {
  it('是同源的根路径 + 一个工作区参数，而不是裸的 "/"', () => {
    const url = new URL(AUTHENTICATED_APP_HOME, 'http://lumo.local')
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('lumo')).toBe('collaboration')
    // 裸 '/' 就是那个空白原生页：它必须**不是**这个常量的值。
    expect(AUTHENTICATED_APP_HOME).not.toBe('/')
  })

  it('消费方真的认这个参数名与这个工作区名', () => {
    // 两半必须**互相对上**，不能各自单独检查：分开查时「常量写错」与「客户端改键」
    // 都能通过，而它们的组合正是那个静默回落。所以参数名与工作区名都从常量里取。
    const url = new URL(AUTHENTICATED_APP_HOME, 'http://lumo.local')
    const [param] = [...url.searchParams.keys()]
    const surface = url.searchParams.get(param ?? '') ?? ''
    expect(param).toBeTruthy()
    expect(surface).toBeTruthy()
    vi.stubGlobal('location', url)
    try {
      // 执行真实消费方，避免纯函数搬文件后静态源码断言误报。
      expect(querySurface()).toBe(surface)
      expect(surfaceMeta).toHaveProperty(surface)
      expect(availableSurfaces(false)).toContain(surface)
    } finally { vi.unstubAllGlobals() }
  })

  it('把交互式登录脚本的落地页也钉在这里', () => {
    // 密码 / Passkey / 验证码那条路走的是这段脚本，不是服务端 302——只改一处就会分叉。
    expect(loginScript).toContain(`location.assign(${JSON.stringify(AUTHENTICATED_APP_HOME)})`)
    expect(loginScript).not.toContain("location.assign('/')")
  })
})
