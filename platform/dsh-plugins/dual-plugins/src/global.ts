/**
 * 进程级共享网关。各插件（@lumo/project 等）在自己的 apply 里把清单注册进来，
 * lumo-ui 宿主负责 configure（判定器 / 运行树 / 缺省身份）并挂路由、MCP 与平台工具。
 * 用 globalThis 上的 Symbol 保存，避免不同导入路径产生两份模块实例。
 */
import { DualPluginGateway } from './gateway.ts'

const KEY = Symbol.for('lumo.dualPluginGateway')

export function dualGateway(): DualPluginGateway {
  const g = globalThis as Record<symbol, unknown>
  let gw = g[KEY] as DualPluginGateway | undefined
  if (!gw) { gw = new DualPluginGateway(); g[KEY] = gw }
  return gw
}

/** LUMO_DUAL_PLUGINS=off 时整套关闭：插件回到各自直接注册工具的旧路径。 */
export function dualPluginsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LUMO_DUAL_PLUGINS ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'legacy')
}

/** 测试用：换掉全局实例 */
export function resetDualGateway(gw?: DualPluginGateway): DualPluginGateway {
  const next = gw ?? new DualPluginGateway()
  ;(globalThis as Record<symbol, unknown>)[KEY] = next
  return next
}
