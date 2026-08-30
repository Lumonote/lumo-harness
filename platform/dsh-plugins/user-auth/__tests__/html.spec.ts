import { describe, expect, it } from 'vitest'

import { loginPage, loginScript } from '../src/html.ts'

describe('first-party login surface', () => {
  it('renders an interactive click-captcha grid', () => {
    const html = loginPage()
    expect(html).toContain('id="captcha-grid"')
    expect(html).toContain('name="captcha"')
    expect(html).toContain('data-index="0"')
    expect(html).toContain('每张验证码仅可使用一次')
    expect(html).not.toContain('pattern="[0-9]{6}"')
    expect(html).not.toContain('captcha-image')
    expect(html).not.toContain('deepseek-harness-auth')
  })

  it('uses fixed messages instead of reflecting query input', () => {
    expect(loginPage({ state: 'invalid' })).toContain('用户名、密码或验证码不正确')
    expect(loginPage({ state: 'locked' })).toContain('暂时锁定')
    expect(loginPage({ theme: 'orbital-glass' })).toContain('data-lumo-theme="orbital-glass"')
    expect(loginPage({ theme: 'infrared-grid' })).toContain('--mint:#ff6685')
    expect(loginScript).toContain("fetch('/auth/captcha")
    expect(loginScript).toContain('请按顺序点击')
  })

  it('records clicked tile indices into the captcha field', () => {
    expect(loginScript).toContain("sequence.join('')")
    expect(loginScript).toContain('tile.dataset.index')
    expect(loginScript).toContain("'已选 ' + sequence.length")
  })
})
