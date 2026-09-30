/** Identity already installed in this process's project, metering and gateway plugins. */
export interface WorkerBinding {
  agentId: string
  userId: string
  projectId: string
  presetRevision: number
  provider: string
  model: string
}

export interface ExecutionPreset {
  id: string
  realm: string
  owner_user_id: string
  project_id?: string
  revision: number
  status: string
  provider: string
  model_ref: string
  system_prompt_ref?: string
  connector_ids: string[]
  knowledge_space_ids: string[]
  max_concurrency: number
  timeout_seconds: number
  max_delegation_depth: number
  max_budget_cents: number
}

export function assertWorkerBinding(binding: WorkerBinding): void {
  const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
  if (!binding || ![binding.agentId, binding.userId, binding.projectId].every(value => typeof value === 'string' && id.test(value)) ||
      !Number.isSafeInteger(binding.presetRevision) || binding.presetRevision < 1 ||
      typeof binding.provider !== 'string' || !binding.provider.trim() || typeof binding.model !== 'string' || !binding.model.trim()) {
    throw new Error('worker runtime requires a fixed Agent, owner, project, revision and model route')
  }
}

/**
 * 受治理执行者只支持文本任务，外加**已经建好执法面**的那些限制。
 *
 * 判据不是「这个能力重不重要」，而是**它有没有执法**：`max_budget_cents` 已由
 * `ScopeCapSeam` 落实（`governed-run` 开跑前给这一次执行封顶，计量截面在 reserve 时拦），
 * 所以放行；连接器按会话绑定预设白名单并在工具调用前执法。提示引用在运行时
 * 与节点上受保护的文件引用精确匹配，并读取该文件的内容。 */
export function assertExecutionPreset(binding: WorkerBinding, realm: string, preset: ExecutionPreset): void {
  assertWorkerBinding(binding)
  if (preset.id !== binding.agentId || preset.realm !== realm || preset.owner_user_id !== binding.userId ||
      (preset.project_id && preset.project_id !== binding.projectId) || preset.revision !== binding.presetRevision ||
      preset.provider !== binding.provider || preset.model_ref !== binding.model || preset.status !== 'active') {
    throw new Error('worker preset does not match the installed execution identity or revision')
  }
  // 连接器在执行前由 connectorScope 核对固定身份和可见目录，调用时按 sessionRef 再拦。
  // 引用只允许作为查找键；执行和心跳都须另行确认节点上的受保护文件。
  if ((preset.system_prompt_ref !== undefined &&
       (typeof preset.system_prompt_ref !== 'string' || !preset.system_prompt_ref.trim() || preset.system_prompt_ref.length > 256)) ||
      !Array.isArray(preset.connector_ids) ||
      preset.connector_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(id)) ||
      new Set(preset.connector_ids).size !== preset.connector_ids.length ||
      !Array.isArray(preset.knowledge_space_ids) ||
      !Number.isSafeInteger(preset.max_budget_cents) || preset.max_budget_cents < 0 ||
      !Number.isSafeInteger(preset.max_concurrency) || preset.max_concurrency < 1 ||
      !Number.isSafeInteger(preset.timeout_seconds) || preset.timeout_seconds < 1 || preset.timeout_seconds > 3600 ||
      !Number.isSafeInteger(preset.max_delegation_depth) || preset.max_delegation_depth < 0) {
    throw new Error('worker preset requires capabilities unsupported by the text execution profile')
  }
}
