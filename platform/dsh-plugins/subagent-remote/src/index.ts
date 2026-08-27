/**
 * @lumo/subagent-remote —— 父节点侧的跨节点子代理 provider(行 5 切片 1)。
 *
 * 挂在**父节点**上(挂 dsh 的 ctx.subagents —— SubagentTable 的 Provider 角色):
 * `start()` 经 Scheduler 放置选承载节点、POST 承载节点 `/subagent/start`(Task 3 的
 * wire),把 child 放远地跑;本进程回调 server 结集回执,返回远端 `SubagentRun`
 * (`localAgent: undefined`)。取消经承载侧 `/subagent/stop` 直连(行 6 控制信号通道
 * 未到,本切片不做)。
 *
 * 回调 server 与本 provider 同**进程**起停:插件 `apply` 里 `ctx.effect`
 * (disposable)听 `callbackPort`;无认证(只受进程外网络形态约束 —— 生产经边缘
 * 网关 mTLS,§6.3);回执校验在 callback.ts(契约 `assertChildResultBody`)。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { assembleRemote } from './provider.ts'
import type { RemoteConfig } from './provider.ts'

/** Schemastery validation for {@link RemoteConfig}(仅加载器形态;程序化调用走 assembleRemote)。 */
export const Config: z<RemoteConfig> = z.object({
  schedulerUrl: z.string().required(),
  nodeUrls: z.dict(z.string()).required(),
  hostTokens: z.dict(z.string()).required(),
  realm: z.string().required(),
  callbackPort: z.number().required(),
  callbackHost: z.string(),
})

export function registerSubagentRemote(ctx: Context, config: RemoteConfig): void {
  const assembly = assembleRemote(config)
  const host = config.callbackHost ?? '127.0.0.1'

  ctx.effect(() => {
    assembly.server.on('error', (e: unknown) => {
      // 端口占用等致命错误:必须响亮,否则节点看着活着却收不到回执,所有委派永久挂起
      ctx.logger.error('subagent-remote: 回调监听 %s:%d 失败: %s', host, config.callbackPort, e)
    })
    assembly.server.listen(config.callbackPort, host, () => {
      ctx.logger.info('subagent-remote: 回调监听 %s:%d(realm=%s)', host, config.callbackPort, config.realm)
    })
    return () => {
      assembly.server.closeAllConnections?.()
      assembly.server.close()
    }
  })

  // registerProvider 自身即 effect-scoped 注册(HMR 安全;移除后不再接新 start,
  // 已返回的 run 由持有者负责 dispose)。Service 层会在 provider.start 返回后发布
  // subagent/start,后续结集发布 subagent/end —— 本插件不重复发布。
  ctx.subagents.registerProvider(assembly.provider)
  ctx.logger.info('subagent-remote: provider "%s" 已注册(realm=%s, scheduler=%s)',
    assembly.provider.name, config.realm, config.schedulerUrl)
}

/** dsh 函数插件惯例出口:`apply` 即插件入口,`registerSubagentRemote` 同义暴露(可直接 ctx.plugin)。 */
export const apply = registerSubagentRemote

export default registerSubagentRemote
