// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserDirectoryPagination, userDirectoryURL } from '../src/client/user-directory.tsx'

afterEach(cleanup)

describe('user directory requests', () => {
  it('encodes independent filters with the requested page and omits the all-status UI value', () => {
    const url = new URL(userDirectoryURL({ query: '  王 & admin?  ', status: 'disabled', departmentId: ' sales ', limit: 50, offset: 200 }), 'https://example.test')
    expect(url.pathname).toBe('/lumo/api/users')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: '王 & admin?', status: 'disabled', department_id: 'sales', limit: '50', offset: '200' })
    expect(new URL(userDirectoryURL({ query: ' ', status: 'all', departmentId: '', limit: 50, offset: 0 }), url).search).toBe('?limit=50&offset=0')
  })

  it('moves through the whole directory without allowing duplicate loading clicks or going beyond its last page', () => {
    const onOffsetChange = vi.fn()
    const props = { total: 205, limit: 50, offset: 0, hasMore: true, loading: false, onOffsetChange }
    const view = render(<UserDirectoryPagination {...props} />)
    expect(screen.getByRole('status').textContent).toBe('共 205 位用户 · 第 1–50 位')
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(onOffsetChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(onOffsetChange).toHaveBeenLastCalledWith(50)
    view.rerender(<UserDirectoryPagination {...props} offset={200} hasMore={false} />)
    expect(screen.getByRole('status').textContent).toBe('共 205 位用户 · 第 201–205 位')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(onOffsetChange).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(onOffsetChange).toHaveBeenLastCalledWith(150)
    view.rerender(<UserDirectoryPagination {...props} offset={50} loading />)
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(onOffsetChange).toHaveBeenCalledTimes(2)
  })
})
