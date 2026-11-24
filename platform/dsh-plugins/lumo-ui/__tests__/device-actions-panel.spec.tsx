import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviceActionsPanel, CALL_STATE_LABEL, callTime, canTrigger, missingPermission, parseArgs, type DeviceCatalog } from '../src/client/device-actions-panel.tsx'

const catalog: DeviceCatalog = {
  switches: { enabled: true, input: false, always_ask: false },
  actions: [
    { spec: { id: 'open.url', family: 'files', title: '打开链接', risk: 'low', permissions: [], optional: false }, decision: { effect: 'allow' } },
    { spec: { id: 'clipboard.read', family: 'clipboard', title: '读取剪贴板', risk: 'high', permissions: [], optional: false }, decision: { effect: 'ask', reason: '高风险' } },
    { spec: { id: 'screen.capture', family: 'screen', title: '截图', risk: 'high', permissions: ['screen-recording'], optional: false }, decision: { effect: 'deny', code: 'os_permission_missing', reason: '缺少屏幕录制', settings_url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' } },
  ],
}

describe('device actions panel', () => {
  it('only low-risk allowed actions can be triggered', () => {
    expect(canTrigger(catalog.actions[0]!)).toBe(true)
    expect(canTrigger(catalog.actions[1]!)).toBe(false)
    expect(canTrigger({ spec: { risk: 'low' }, decision: { effect: 'deny' } })).toBe(false)
  })
  it('detects missing macOS permission', () => {
    expect(missingPermission(catalog.actions[2]!)).toBe('screen-recording')
    expect(missingPermission(catalog.actions[0]!)).toBeUndefined()
  })
  it('parses args and time', () => {
    expect(parseArgs('{"url":"https://x"}').ok).toBe(true)
    expect(parseArgs('[1]').ok).toBe(false)
    expect(parseArgs('{').ok).toBe(false)
    expect(callTime(0)).toBe('—')
    expect(callTime(1_700_000_000)).toBe(callTime(1_700_000_000_000))
    expect(CALL_STATE_LABEL.confirming).toBe('等待本机确认')
  })
  it('renders risk, permission guidance and waiting state without approve button', () => {
    const html = renderToStaticMarkup(<DeviceActionsPanel initial={catalog} initialCalls={[{ id: 'c1', action: 'clipboard.read', risk: 'high', state: 'confirming', created_at: 1_700_000_000_000 }]} />)
    expect(html).toContain('data-device-actions="v1"')
    expect(html).toContain('高风险')
    expect(html).toContain('打开系统设置')
    expect(html).toContain('Privacy_ScreenCapture')
    expect(html).toContain('等待本机确认')
    expect(html).toContain('撤回')
    expect(html).not.toContain('允许本次')
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/u)
  })
})
