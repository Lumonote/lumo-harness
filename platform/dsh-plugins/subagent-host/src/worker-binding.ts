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

/** The initial governed executor supports text tasks only. Unsupported asset
 * references and monetary caps must be enforced before adding them to this profile. */
export function assertExecutionPreset(binding: WorkerBinding, realm: string, preset: ExecutionPreset): void {
  assertWorkerBinding(binding)
  if (preset.id !== binding.agentId || preset.realm !== realm || preset.owner_user_id !== binding.userId ||
      (preset.project_id && preset.project_id !== binding.projectId) || preset.revision !== binding.presetRevision ||
      preset.provider !== binding.provider || preset.model_ref !== binding.model || preset.status !== 'active') {
    throw new Error('worker preset does not match the installed execution identity or revision')
  }
  if (preset.system_prompt_ref || !Array.isArray(preset.connector_ids) || preset.connector_ids.length ||
      !Array.isArray(preset.knowledge_space_ids) || preset.knowledge_space_ids.length || preset.max_budget_cents !== 0 ||
      !Number.isSafeInteger(preset.max_concurrency) || preset.max_concurrency < 1 ||
      !Number.isSafeInteger(preset.timeout_seconds) || preset.timeout_seconds < 1 || preset.timeout_seconds > 3600 ||
      !Number.isSafeInteger(preset.max_delegation_depth) || preset.max_delegation_depth < 0) {
    throw new Error('worker preset requires capabilities unsupported by the text execution profile')
  }
}
