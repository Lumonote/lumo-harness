/** Read-only tool for an owned Session. No deployment actor or global tool is
 * reused: the current login authority supplies every query's identity. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AuthenticatedKnowledgeQuery } from '../../../shared/seam-contracts/knowledge.ts'
import type { Principal } from './client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { knowledgeAuthenticatedQuery: AuthenticatedKnowledgeQuery }
}

export const USER_SESSION_KNOWLEDGE_TOOL = 'user_knowledge_query'
export interface SessionKnowledgeConfig {
  realm: string
  defaultTopK?: number
  spaces?: readonly string[]
}
export function validateSessionKnowledge(value: unknown, realm?: string): asserts value is SessionKnowledgeConfig | undefined {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session knowledge requires an explicit fixed realm configuration')
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => !['realm', 'defaultTopK', 'spaces'].includes(key))
    || typeof config.realm !== 'string' || !config.realm.trim() || realm !== undefined && config.realm !== realm
    || config.defaultTopK !== undefined && (!Number.isInteger(config.defaultTopK) || Number(config.defaultTopK) < 1 || Number(config.defaultTopK) > 10)
    || config.spaces !== undefined && (!Array.isArray(config.spaces) || config.spaces.length > 100
      || config.spaces.some(space => typeof space !== 'string' || !space.trim())
      || new Set(config.spaces).size !== config.spaces.length)) throw new Error('Session knowledge must fix the deployment realm, optional spaces and topK 1–10')
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function identity(principal: Principal): string {
  return JSON.stringify([principal.realm, principal.user_id, [...principal.roles].sort()])
}
export function installSessionKnowledge(agent: Agent, service: AuthenticatedKnowledgeQuery, config: SessionKnowledgeConfig,
  projectId: string, currentPrincipal: () => Promise<Principal>): void {
  const spaces = config.spaces === undefined ? undefined : Object.freeze([...config.spaces])
  agent.ctx.tools.register({
    name: USER_SESSION_KNOWLEDGE_TOOL,
    description: '只读检索当前用户在本项目中有权访问的已发布知识，返回可引用的文档片段。',
    parameters: { type: 'object', additionalProperties: false, required: ['question'], properties: {
      question: { type: 'string', minLength: 1, maxLength: 8000 }, topK: { type: 'integer', minimum: 1, maximum: 10 },
    } },
    output: { schema: { type: 'object', additionalProperties: false, required: ['hits'], properties: {
      hits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['docId', 'sourceVersion', 'text', 'score'], properties: {
        docId: { type: 'string' }, sourceVersion: { type: 'number' }, text: { type: 'string' }, score: { type: 'number' },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('Knowledge tool requires its exact owned Session')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Knowledge query requires an object')
      const input = args as Record<string, unknown>
      if (Object.keys(input).some(key => !['question', 'topK'].includes(key))
        || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8000
        || input.topK !== undefined && (!Number.isInteger(input.topK) || Number(input.topK) < 1 || Number(input.topK) > 10)) throw new Error('Knowledge query accepts only a question and topK 1–10')
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(15_000)])
      const principal = await abortable(currentPrincipal(), signal)
      if (principal.realm !== config.realm) throw new Error('Knowledge query cannot cross the configured realm')
      const hits = await abortable(service.query({ realm: principal.realm, userId: principal.user_id, roles: [...principal.roles] },
        { projectId, text: input.question, topK: Number(input.topK ?? config.defaultTopK ?? 5), spaces }, signal), signal)
      const current = await abortable(currentPrincipal(), signal)
      if (identity(current) !== identity(principal)) throw new Error('Knowledge query authorization changed')
      signal.throwIfAborted()
      let remaining = 48_000
      return { hits: hits.slice(0, Number(input.topK ?? config.defaultTopK ?? 5)).map(hit => {
        const text = hit.text.slice(0, Math.min(8000, remaining)); remaining -= text.length
        return { docId: hit.docId, sourceVersion: hit.sourceVersion, text, score: hit.score }
      }).filter(hit => hit.text.length > 0) }
    },
  })
}
