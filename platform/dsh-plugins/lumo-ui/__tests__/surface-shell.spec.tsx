// @vitest-environment jsdom
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BusyButton, Notice } from '../src/client/surface-shell.tsx'
import { useFocusTrap } from '../src/client/focus-trap.ts'
afterEach(cleanup)
describe('shared workbench keyboard and announcement behavior', () => {
  it('keeps a busy write disabled even when its caller supplies disabled=false', () => {
    const submit = vi.fn(); render(<BusyButton busy disabled={false} onClick={submit}>保存</BusyButton>)
    const button = screen.getByRole('button', { name: '保存' })
    expect(button.hasAttribute('disabled')).toBe(true); expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button); expect(submit).not.toHaveBeenCalled()
  })
  it('announces errors and successful state changes with distinct live roles', () => {
    render(<><Notice error>读取失败，可重试。</Notice><Notice>已更新。</Notice></>)
    expect(screen.getByRole('alert').textContent).toBe('读取失败，可重试。')
    expect(screen.getByRole('status').textContent).toBe('已更新。')
  })
  it('cycles keyboard focus through visible enabled controls and returns from the dialog itself', () => {
    function Dialog() {
      const ref = useRef<HTMLDivElement>(null); useFocusTrap(ref, true)
      return <div ref={ref} role="dialog" tabIndex={-1}><button hidden>隐藏按钮</button><div style={{ display: 'none' }}><button>隐藏菜单</button></div><button disabled>禁用按钮</button><button>首项</button><details><summary>展开选项</summary><button>收起内容</button></details><button>末项</button></div>
    }
    render(<Dialog />)
    const first = screen.getByRole('button', { name: '首项' }), last = screen.getByRole('button', { name: '末项' })
    expect(document.activeElement).toBe(first)
    first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Tab' }); expect(document.activeElement).toBe(first)
    const dialog = screen.getByRole('dialog'); dialog.focus(); fireEvent.keyDown(dialog, { key: 'Tab' }); expect(document.activeElement).toBe(first)
  })
})
