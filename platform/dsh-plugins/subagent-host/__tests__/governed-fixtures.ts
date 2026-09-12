import type { ExecutionPreset, WorkerBinding } from '../src/worker-binding.ts'
import type { RuntimeReportConfig } from '../src/runtime-report.ts'
import type { GovernedExecution, GovernedResult } from '../src/governed-dispatch.ts'

export const binding: WorkerBinding = {
  agentId: 'writer', userId: 'owner', projectId: 'project', presetRevision: 7, provider: 'mock', model: 'mock',
}
export const preset: ExecutionPreset = {
  id: binding.agentId, realm: 'realm', owner_user_id: binding.userId, project_id: binding.projectId,
  revision: binding.presetRevision, status: 'active', provider: binding.provider, model_ref: binding.model,
  connector_ids: [], knowledge_space_ids: [], max_concurrency: 2, timeout_seconds: 30,
  max_delegation_depth: 2, max_budget_cents: 0,
}
export const config: RuntimeReportConfig = {
  governanceUrl: 'http://governance.invalid', token: 'service', realm: 'realm', nodeId: 'node-1', binding, capacity: 2,
}
export function execution(runId = 'run-1'): GovernedExecution {
  return {
    runId, attempt: 1, sessionRef: 'session-' + runId, deadlineMS: 0, preset: structuredClone(preset),
    task: { id: 'task-' + runId, realm: config.realm, project_id: binding.projectId, title: 'Research',
      intent: 'Produce a cited text deliverable',
      intent_contract: { objective: 'Answer the question', root_objective: 'Complete the research',
        constraints: ['Use the supplied evidence'], acceptance_criteria: ['Cite the sources'], depth: 1, parent_task_id: 'parent' } },
  }
}
export function resultFor(item: GovernedExecution): GovernedResult {
  return { task_id: item.task.id, run_id: item.runId, session_ref: item.sessionRef, node_id: config.nodeId,
    state: 'COMPLETED', summary: 'Verified deliverable', output: { a: 1, b: 2 } }
}
