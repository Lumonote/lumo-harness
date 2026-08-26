import { describe, expect, it } from 'vitest'

import {
  PROJECT_ACTIONS,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  canProject,
  transitionProject,
} from '../projects.ts'

/**
 * 项目工作区契约（§11.1，设计说明 2026-08-26 §3）。
 *
 * 三闭集 + 两个纯函数。矩阵逐格断言而不是抽样——能力矩阵的 bug 恰恰藏在「看起来
 * 对」的组合里（editor 能不能 archive？viewer 能不能 manage members？）。
 */
describe('闭集', () => {
  it('状态：active | archived（删除不是状态，是终局动作）', () => {
    expect(PROJECT_STATUSES).toEqual(['active', 'archived'])
  })

  it('角色：owner | editor | viewer', () => {
    expect(PROJECT_ROLES).toEqual(['owner', 'editor', 'viewer'])
  })

  it('动作六项（§11.1 表格直译）', () => {
    expect(PROJECT_ACTIONS).toEqual([
      'project.read',
      'project.edit',
      'members.manage',
      'project.archive',
      'project.delete',
      'budget.configure',
    ])
  })
})

describe('canProject 能力矩阵（3 角色 × 6 动作逐格）', () => {
  const matrix: Record<string, Record<string, boolean>> = {
    owner: {
      'project.read': true, 'project.edit': true, 'members.manage': true,
      'project.archive': true, 'project.delete': true, 'budget.configure': true,
    },
    editor: {
      'project.read': true, 'project.edit': true, 'members.manage': false,
      'project.archive': false, 'project.delete': false, 'budget.configure': false,
    },
    viewer: {
      'project.read': true, 'project.edit': false, 'members.manage': false,
      'project.archive': false, 'project.delete': false, 'budget.configure': false,
    },
  }

  it('18 格逐格一致（改矩阵不改测试 → 红）', () => {
    for (const role of PROJECT_ROLES) {
      for (const action of PROJECT_ACTIONS) {
        expect(
          canProject(role, action),
          `${role} × ${action}`,
        ).toBe(matrix[role]![action])
      }
    }
  })

  it('闭集外角色/动作拒绝（未知值不得静默放行）', () => {
    expect(() => canProject('admin' as never, 'project.read')).toThrow(/角色/)
    expect(() => canProject('owner', 'project.summon' as never)).toThrow(/动作/)
  })
})

describe('transitionProject 状态机', () => {
  it('active --archive--> archived；archived --unarchive--> active', () => {
    expect(transitionProject('active', 'archive')).toBe('archived')
    expect(transitionProject('archived', 'unarchive')).toBe('active')
  })

  it('自反转移幂等（重复 archive 是重放不是错误）', () => {
    expect(transitionProject('archived', 'archive')).toBe('archived')
    expect(transitionProject('active', 'unarchive')).toBe('active')
  })

  it('闭集外状态/事件即抛——状态机没有「默认放行」分支', () => {
    expect(() => transitionProject('deleted' as never, 'archive')).toThrow(/状态/)
    expect(() => transitionProject('active', 'delete' as never)).toThrow(/事件/)
  })
})
