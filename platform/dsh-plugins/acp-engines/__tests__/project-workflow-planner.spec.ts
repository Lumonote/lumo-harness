import { describe, expect, it } from 'vitest'
import { defaultProjectTasks, parsePlannerReply, plannerPrompt, routeProjectTasks, type ProjectRoutingRole } from '../src/project-workflow-planner.ts'
import type { ProjectCapability, ProjectTaskInput } from '../src/project-workflow-model.ts'

const role = (id: string, capabilities?: ProjectCapability[], instruction = '完成工作'): ProjectRoutingRole => ({ id, name: id, engineId: `engine-${id}`, instruction, ...(capabilities ? { capabilities } : {}) })
const task = (id = 'implement', capabilities: ProjectCapability[] = ['frontend']): ProjectTaskInput => ({ id, title: id, instruction: '实现指定需求', capabilities, dependsOn: [], acceptanceCriteria: ['提供实际结果'] })
const probes = (roles: ProjectRoutingRole[]) => roles.map(r => ({ id: r.engineId, available: true }))
const reviewer = role('reviewer', ['review'])

describe('project task routing', () => {
  it('routes by capability and reserves an independent reviewer even when all Bots share the same engine', () => {
    const roles = [role('ui', ['frontend']), role('api', ['backend']), reviewer].map(r => ({ ...r, engineId: 'same-engine' }))
    const result = routeProjectTasks([task('page', ['frontend']), task('endpoint', ['backend'])], roles, [{ id: 'same-engine', available: true }])
    expect(result.reviewerId).toBe('reviewer')
    expect(result.tasks.map(t => t.roleId)).toEqual(['ui', 'api'])
    expect(result.tasks.every(t => t.state === 'pending')).toBe(true)
    expect(result.tasks[0]?.routingReason).toContain('显式能力：前端')
  })
  it('prefers explicit capabilities to matching inferred responsibilities and balances equivalent Bots', () => {
    const roles = [role('inferred', undefined, 'frontend UI developer'), role('explicit-a', ['frontend']), role('explicit-b', ['frontend']), reviewer]
    const result = routeProjectTasks([task('one'), task('two'), task('three')], roles, probes(roles))
    expect(result.tasks.map(t => t.roleId)).toEqual(['explicit-a', 'explicit-b', 'explicit-a'])
    expect(result.tasks[2]?.routingReason).toContain('分配前已有 1 个任务')
  })
  it('infers Chinese and English role skills but never tool-brand strengths', () => {
    const roles = [role('api', undefined, '编写后端接口和数据库'), role('docs', undefined, 'Write documentation and README'), role('reviewer', undefined, '独立审查代码')]
    const input = [task('backend', ['backend']), task('docs', ['documentation'])]
    const first = routeProjectTasks(input, roles, probes(roles))
    const renamed = roles.map(r => ({ ...r, engineId: r.id === 'api' ? 'claude-code' : 'codex' }))
    const second = routeProjectTasks(input, renamed, probes(renamed))
    expect(first.tasks.map(t => t.roleId)).toEqual(['api', 'docs'])
    expect(second.tasks.map(t => t.roleId)).toEqual(first.tasks.map(t => t.roleId))
    expect(first.tasks[0]?.routingReason).toContain('推断')
  })
  it('supports two Bots and explains the general fallback for an unknown specialty', () => {
    const roles = [role('worker'), reviewer]
    const result = routeProjectTasks([{ ...task(), capabilities: [], instruction: '处理粒子轨迹', title: '计算轨迹' }], roles, probes(roles))
    expect(result.tasks[0]).toMatchObject({ roleId: 'worker', capabilities: ['general'] })
    expect(result.tasks[0]?.routingReason).toContain('回退通用开发')
    expect(result.reviewerId).toBe('reviewer')
  })
  it('honors manual choices without selecting them again as reviewer', () => {
    const roles = [role('chosen', ['review']), role('spare', ['backend'])]
    const result = routeProjectTasks([{ ...task(), roleId: 'chosen' }], roles, probes(roles))
    expect(result.tasks[0]?.roleId).toBe('chosen')
    expect(result.tasks[0]?.routingReason).toContain('按手动指定')
    expect(result.tasks[0]?.routingReason).toContain('缺少已声明的前端能力')
    expect(result.reviewerId).toBe('spare')
    expect(() => routeProjectTasks([{ ...task(), roleId: 'chosen' }], roles, probes(roles), 'chosen')).toThrow('不能同时承担')
  })
  it('does not route to unavailable engines and exposes manual selection failures', () => {
    const roles = [role('offline', ['frontend']), role('worker', ['general']), reviewer]
    const available = probes(roles).map(p => p.id === 'engine-offline' ? { ...p, available: false, reason: '工具被禁用' } : p)
    expect(routeProjectTasks([task()], roles, available).tasks[0]?.roleId).toBe('worker')
    expect(() => routeProjectTasks([{ ...task(), roleId: 'offline' }], roles, available)).toThrow('工具被禁用')
    expect(() => routeProjectTasks([{ ...task(), roleId: 'missing' }], roles, available)).toThrow('不存在')
    expect(() => routeProjectTasks([task()], roles, available, 'offline')).toThrow('独立评审')
    expect(() => routeProjectTasks([task()], roles, available, 'missing')).toThrow('不存在')
  })
  it('refuses a plan with no independent available reviewer or invalid task dependencies', () => {
    const roles = [role('a'), role('b')]
    expect(() => routeProjectTasks([{ ...task('a'), roleId: 'a' }, { ...task('b'), roleId: 'b' }], roles, probes(roles))).toThrow('独立评审')
    expect(() => routeProjectTasks([task()], roles, [{ id: 'engine-a', available: true }])).toThrow('独立评审')
    expect(() => routeProjectTasks([{ ...task(), dependsOn: ['missing'] }], roles, probes(roles))).toThrow('不存在')
  })
})

describe('real coordinator plan contract', () => {
  it('keeps the initial draft as a single task and preserves its full short goal', () => {
    const goal = '开发前端页面、后端接口和文档'
    expect(defaultProjectTasks(goal)).toHaveLength(1)
    expect(defaultProjectTasks(goal)[0]?.instruction).toBe(goal)
    expect(defaultProjectTasks(goal)[0]?.capabilities).toEqual(['frontend', 'backend', 'documentation'])
    expect(defaultProjectTasks('长'.repeat(6000))[0]?.instruction).toContain('完整项目目标')
    expect(() => defaultProjectTasks('')).toThrow('目标不能为空')
  })
  it('constrains the coordinator to a plan with no command or authorization channel', () => {
    const roles = [role('worker', ['frontend']), reviewer]
    const prompt = plannerPrompt('做 UI', roles, [task()])
    expect(prompt).toContain('只规划，不修改文件、不运行命令')
    expect(prompt).toContain('必须保留一位未承担实现任务的 Bot')
    expect(prompt).toContain('不得提供 command')
    expect(prompt).toContain('"capabilities":["frontend"]')
  })
  it('parses JSON or a sole JSON code fence with valid dependency and acceptance criteria', () => {
    const tasks = [task('page'), { ...task('tests', ['testing']), dependsOn: ['page'] }]
    const reply = JSON.stringify({ tasks })
    expect(parsePlannerReply(reply)).toEqual(tasks)
    expect(parsePlannerReply(`\`\`\`json\n${reply}\n\`\`\``)).toEqual(tasks)
  })
  it.each([
    { tasks: [task()], command: 'danger' },
    { tasks: [{ ...task(), command: 'danger' }] },
    { tasks: [{ ...task(), args: ['danger'] }] },
    { tasks: [{ ...task(), env: { ANY: 'value' } }] },
    { tasks: [{ ...task(), checks: [] }] },
  ])('rejects executable or extra fields in model output: %j', value => {
    expect(() => parsePlannerReply(JSON.stringify(value))).toThrow(/字段/u)
  })
  it('rejects narrative wrappers, missing criteria, unknown capabilities, duplicate ids, cycles and oversized plans', () => {
    expect(() => parsePlannerReply(`计划如下：${JSON.stringify({ tasks: [task()] })}`)).toThrow('有效 JSON')
    expect(() => parsePlannerReply(JSON.stringify({ tasks: [{ ...task(), acceptanceCriteria: [] }] }))).toThrow('验收条件')
    expect(() => parsePlannerReply(JSON.stringify({ tasks: [{ ...task(), capabilities: ['magic'] }] }))).toThrow('能力标签')
    expect(() => parsePlannerReply(JSON.stringify({ tasks: [task(), task()] }))).toThrow('唯一')
    expect(() => parsePlannerReply(JSON.stringify({ tasks: [{ ...task('a'), dependsOn: ['b'] }, { ...task('b'), dependsOn: ['a'] }] }))).toThrow('含环')
    expect(() => parsePlannerReply(JSON.stringify({ tasks: Array.from({ length: 9 }, (_, i) => task(`t${i}`)) }))).toThrow('1–8')
    expect(() => parsePlannerReply('x'.repeat(128 * 1024 + 1))).toThrow('上限')
  })
})
