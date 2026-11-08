import { useState, type FormEvent } from 'react'

export interface TeamCapabilities {
  provider: { provider: string; kind: string; reason: string }
  durableStore: boolean
  durableCourier: boolean
}

interface DraftBridge {
  getDraft(): string
  setDraft(text: string): void | boolean
}

// Creation and dispatch stay with the native captain session and its tools.
// The page prepares an editable request, preserving any existing composer draft.
export function TeamLauncher({ capabilities, bridge, onPrepared }: {
  capabilities: TeamCapabilities | null
  bridge: DraftBridge | null
  onPrepared(): void
}) {
  const [goal, setGoal] = useState('')
  const [topology, setTopology] = useState('planner-worker')
  const [subjects, setSubjects] = useState('')
  const [error, setError] = useState('')
  function prepare(event: FormEvent): void {
    event.preventDefault()
    if (bridge === null || capabilities === null || goal.trim() === '') return
    if (goal.length > 4000 || subjects.length > 8000 || !['planner-worker', 'pipeline', 'deliberation'].includes(topology)) { setError('请检查目标、任务主题长度与协作方式。'); return }
    const tasks = subjects.split('\n').map(line => line.trim()).filter(Boolean)
    const request = [
      '请使用 agent_teams 工具在当前会话中建立并推进智能体团队。',
      `协作拓扑：${topology}。`,
      `团队目标：${goal.trim()}`,
      tasks.length > 0 ? `任务主题：\n${tasks.map((task, index) => `${index + 1}. ${task}`).join('\n')}` : '请根据目标拆分可验收的任务主题。',
      '先检查可用成员执行能力，建立团队并添加适合的成员，再按任务依赖推进。汇报真实任务状态、阻塞原因和产物路径；缺少能力时明确说明。',
    ].join('\n\n')
    try {
      if (bridge.getDraft().trim() !== '') {
        setError('对话里还有未发送的内容。请先处理草稿，再准备团队任务。')
        return
      }
      if (bridge.setDraft(request) === false) throw new Error('当前输入框未接收内容，请重新连接对话后再试。')
      setError('')
      onPrepared()
    } catch (reason) {
      setError(`团队目标已保留，未能交给当前对话：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }
  return <section className="lumo-team-launcher" aria-label="智能体团队任务">
    <header><div><h2>智能体团队任务</h2><p>选择协作方式，把目标带回对话继续编辑并发送。</p></div>
      <span>{capabilities === null ? '成员执行能力未就绪' : `${capabilities.durableStore ? '持久任务板' : '本机任务板'} · ${capabilities.durableCourier ? '持久消息' : '本机消息'}`}</span>
    </header>
    <form onSubmit={prepare}>
      <label><span>团队目标</span><textarea aria-label="团队目标" rows={3} maxLength={4000} value={goal} onChange={event => { setGoal(event.target.value); setError('') }} placeholder="例如：检查发布风险，修复问题并输出验收报告" required /></label>
      <div className="lumo-team-launcher-options">
        <label><span>协作方式</span><select aria-label="团队协作方式" value={topology} onChange={event => { setTopology(event.target.value); setError('') }}><option value="planner-worker">先规划，再并行执行</option><option value="pipeline">按阶段串行推进</option><option value="deliberation">并行评议，再收敛</option></select></label>
        <label><span>任务主题（选填，每行一项）</span><textarea aria-label="团队任务主题" rows={3} maxLength={8000} value={subjects} onChange={event => { setSubjects(event.target.value); setError('') }} placeholder={'检查风险\n修复问题\n验收结果'} /></label>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <footer><small>{bridge === null ? '请先打开一个对话，以连接输入框。' : capabilities === null ? '当前节点尚未提供团队成员执行能力，请检查运行配置。' : '团队将由当前对话创建，执行结果会显示在任务板。'}</small><button type="submit" className="lumo-primary" disabled={bridge === null || capabilities === null || goal.trim() === ''}>准备团队任务</button></footer>
    </form>
  </section>
}
