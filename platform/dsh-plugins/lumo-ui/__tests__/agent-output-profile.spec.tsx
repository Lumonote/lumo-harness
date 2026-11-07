// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPresetEditor, FILES_OUTPUT_PROFILE, TEXT_OUTPUT_PROFILE, TaskEvidencePanel, type AgentPreset } from '../src/client/cluster-panels.tsx'

afterEach(cleanup)
const preset: AgentPreset = {
  id: 'writer', name: '报告专家', owner_user_id: 'owner', status: 'active', version: '1', revision: 1,
  provider: 'provider', model_ref: 'writer', connector_ids: [], knowledge_space_ids: [],
  max_concurrency: 1, max_budget_cents: 0, timeout_seconds: 3600, max_delegation_depth: 0,
}

async function mount(extra: Partial<AgentPreset> = {}, clusterReady = true) {
  const request = vi.fn(async (_path: string, init?: RequestInit) => init?.method === 'PATCH'
    ? { ...preset, ...extra, ...JSON.parse(String(init.body)), revision: 2 }
    : { clusterReady, organization: true })
  const refresh = vi.fn().mockResolvedValue(undefined)
  render(<AgentPresetEditor request={request} presets={[{ ...preset, ...extra }]} refresh={refresh} />)
  await waitFor(() => expect(request).toHaveBeenCalledWith('/lumo/api/capabilities'))
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: preset.id } })
  return { request, refresh }
}

describe('controlled file preset configuration', () => {
  it('persists the selected profile with its optimistic revision', async () => {
    const f = await mount()
    fireEvent.change(screen.getByRole('combobox', { name: '产出类型' }), { target: { value: FILES_OUTPUT_PROFILE } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('Agent 配置已保存。')
    const update = f.request.mock.calls.find(call => call[1]?.method === 'PATCH')!
    expect(JSON.parse(String(update[1]?.body))).toMatchObject({ revision: 1, output_profile: FILES_OUTPUT_PROFILE })
    expect(f.refresh).toHaveBeenCalledOnce()
  })

  it('preserves external resource fields and requires the user to resolve conflicts', async () => {
    const f = await mount({ connector_ids: ['crm'], knowledge_space_ids: ['legal'], system_prompt_ref: 'protected' })
    fireEvent.change(screen.getByRole('combobox', { name: '产出类型' }), { target: { value: FILES_OUTPUT_PROFILE } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect((await screen.findByRole('alert')).textContent).toContain('不能配置系统提示引用、连接器或知识空间')
    expect(f.request.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false)
    expect((screen.getByRole('textbox', { name: '连接器范围' }) as HTMLInputElement).value).toBe('crm')
    fireEvent.change(screen.getByRole('combobox', { name: '产出类型' }), { target: { value: TEXT_OUTPUT_PROFILE } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('Agent 配置已保存。')
    const update = f.request.mock.calls.find(call => call[1]?.method === 'PATCH')!
    expect(JSON.parse(String(update[1]?.body))).toMatchObject({ output_profile: TEXT_OUTPUT_PROFILE, connector_ids: ['crm'], knowledge_space_ids: ['legal'], system_prompt_ref: 'protected' })
  })

  it('keeps file configuration unavailable when the cluster is not ready', async () => {
    const f = await mount({}, false)
    expect((screen.getByRole('option', { name: '文本与受控文件' }) as HTMLOptionElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: '产出类型' }), { target: { value: FILES_OUTPUT_PROFILE } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    expect((await screen.findByRole('alert')).textContent).toContain('需要已就绪的集群审核服务')
    expect(f.request.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false)
  })

  it('renders file bodies as inert text without inventing an approval', async () => {
    const body = '<img src="https://example.invalid/tracker" onerror="alert(1)">'
    const request = vi.fn().mockResolvedValue({ artifacts: [] })
    render(<TaskEvidencePanel taskID="task" runID="run" request={request} result={{ run_id: 'run', state: 'COMPLETED', summary: '报告', files: [{ name: 'report.md', media_type: 'text/markdown; charset=utf-8', text: body }] }} error="" busy={false} label={value => value} close={vi.fn()} />)
    const files = screen.getByRole('region', { name: '受控文本文件' })
    expect(files.querySelector('pre')?.textContent).toBe(body)
    expect(files.querySelector('img, script, iframe, a')).toBeNull()
    expect(within(files).getByText(/审核结论请在独立审核任务中查看/u)).toBeTruthy()
    await waitFor(() => expect(request).toHaveBeenCalled())
  })
})
