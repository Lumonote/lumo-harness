import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RUN_TREE_STATUS_COLOR, RUN_TREE_STATUS_LABEL, RunTreePanel, runTreeEnabled } from '../src/client/run-tree-panel.tsx'

describe('run-tree panel', () => {
  it('covers every status with label and color', () => {
    for (const s of ['pending', 'running', 'awaiting_ask', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(RUN_TREE_STATUS_LABEL[s]).toBeTruthy()
      expect(RUN_TREE_STATUS_COLOR[s]).toBeTruthy()
    }
  })
  it('defaults to new tree when no legacy flag', () => {
    expect(runTreeEnabled()).toBe(true)
  })
  it('renders empty state without tasks', () => {
    const html = renderToStaticMarkup(<RunTreePanel tasks={[]} />)
    expect(html).toContain('data-run-tree="v1"')
    expect(html).toContain('还没有可展示的任务')
  })
})
