/**
 * Worker 身份绑定契约（dsh-node 侧镜像）。
 *
 * 权威定义：platform/dsh-plugins/subagent-host/src/worker-binding.ts —— 插件侧始终
 * 以那份为准，本文件只是它在数据平面的本地镜像，改这里之前先改权威版。
 *
 * 为什么要镜像而不是直接相对导入：dsh-node 在打包 runtime 里是以 .ts 源码被 tsx
 * 直接加载的（tauri.conf.json 把 target/lumo-runtime 映射到 Resources/runtime），
 * 因此 `../../../dsh-plugins/...` 会落到 Resources/ 下——那里没有 dsh-plugins，
 * 启动即 ERR_MODULE_NOT_FOUND。打包形态只把本地模式需要的 @lumo 插件装进
 * runtime/node_modules，subagent-host 不在其中，所以也不能改成包名导入。
 * 与 knowledge-vault 复制 shared/seam-contracts 的做法同源。
 */

/** Identity already installed in this process's project, metering and gateway plugins. */
export interface WorkerBinding {
  agentId: string
  userId: string
  projectId: string
  presetRevision: number
  provider: string
  model: string
}

export function assertWorkerBinding(binding: WorkerBinding): void {
  const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
  if (![binding.agentId, binding.userId, binding.projectId].every(value => id.test(value)) ||
      !Number.isSafeInteger(binding.presetRevision) || binding.presetRevision < 1 ||
      !binding.provider?.trim() || !binding.model?.trim()) {
    throw new Error('worker runtime requires a fixed Agent, owner, project, revision and model route')
  }
}
