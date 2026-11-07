/** Browser choices resolve through this detached deployment policy. Native
 * model/selection and request/header remain the durable source of truth. */
import { createHash } from 'node:crypto'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionModelBillingRoute } from '../../../shared/seam-contracts/model-billing.ts'

export interface SessionModelChoice extends SessionModelBillingRoute { id: string; label: string; reasoningEffort?: ModelSelection['reasoningEffort'] }
export interface SessionModelConfiguration { provider: string; model: string; modelChoices?: SessionModelChoice[] }
export class SessionModelPolicyError extends Error {
  constructor(readonly code: 'session_model_changed' | 'session_model_busy' | 'session_model_unavailable', message: string) { super(message) }
}
const fail = () => new SessionModelPolicyError('session_model_unavailable', 'The model route is not approved or has no verified rate')
const literal = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v)
const same = (a: Readonly<ModelSelection>, b: Readonly<ModelSelection>) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
export function modelSelection(choice: Readonly<SessionModelChoice>): ModelSelection {
  return { provider: choice.provider, model: choice.model, ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }) }
}
export class SessionModelPolicy {
  readonly choices: readonly Readonly<SessionModelChoice>[]
  readonly dynamic: boolean
  readonly digest: string
  readonly fallback: Readonly<SessionModelChoice>
  constructor(config: SessionModelConfiguration) {
    if (!literal(config.provider) || !literal(config.model)) throw fail()
    this.dynamic = config.modelChoices !== undefined
    const input = config.modelChoices ?? [{ id: 'default', label: config.model, provider: config.provider, model: config.model, billingModel: '' }]
    if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw fail()
    const ids = new Set<string>(), selections = new Set<string>(), billing = new Map<string, string>()
    this.choices = Object.freeze(input.map(value => {
      if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['id', 'label', 'provider', 'model', 'billingModel', 'reasoningEffort'].includes(k))
        || typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.id) || !literal(value.label, 120) || !literal(value.provider) || !literal(value.model)
        || (this.dynamic && !literal(value.billingModel)) || value.reasoningEffort !== undefined && !literal(value.reasoningEffort, 64)) throw fail()
      const route = JSON.stringify([value.provider, value.model]), selection = JSON.stringify(modelSelection(value))
      if (ids.has(value.id) || selections.has(selection) || billing.has(route) && billing.get(route) !== value.billingModel) throw fail()
      ids.add(value.id); selections.add(selection); billing.set(route, value.billingModel)
      return Object.freeze({ ...value })
    }))
    const fallback = this.choices.find(c => c.provider === config.provider && c.model === config.model && c.reasoningEffort === undefined)
    if (!fallback) throw fail()
    this.fallback = fallback
    this.digest = createHash('sha256').update(JSON.stringify([...this.choices].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex')
  }
  require(selection: Readonly<ModelSelection> | undefined): Readonly<SessionModelChoice> {
    const choice = selection && this.choices.find(c => same(modelSelection(c), selection))
    if (!choice) throw fail()
    return choice
  }
  billingRoutes(): SessionModelBillingRoute[] {
    return this.choices.map(({ provider, model, billingModel }) => ({ provider, model, billingModel }))
  }
  view(agent: Agent) {
    const choice = this.require(agent.model.current())
    return { policy_digest: this.digest, selection_revision: Number(agent.session.seq), selected_choice_id: choice.id,
      can_select: this.dynamic && agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length,
      choices: this.choices.map(({ id, label, provider, model, reasoningEffort }) => ({ id, label, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })) }
  }
  async select(agent: Agent, request: Record<string, unknown>, hooks: {
    authorize(): Promise<void>; admit(route: SessionModelBillingRoute): Promise<unknown>; resolve(selection: ModelSelection): Promise<unknown>; flush(): Promise<unknown>
  }) {
    if (!this.dynamic || Object.keys(request).some(k => !['sessionId', 'choice_id', 'expected_revision', 'policy_digest'].includes(k)) || typeof request.choice_id !== 'string'
      || !Number.isSafeInteger(request.expected_revision) || Number(request.expected_revision) < 0 || request.policy_digest !== this.digest) throw fail()
    const choice = this.choices.find(c => c.id === request.choice_id)
    if (!choice) throw fail()
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new SessionModelPolicyError('session_model_busy', 'Wait until the current turn and queue are idle')
    let claimed = false
    try {
      return await agent.runMaintenance(async signal => {
        claimed = true
        if (Number(agent.session.seq) !== request.expected_revision) throw new SessionModelPolicyError('session_model_changed', 'Refresh the current model selection')
        // A removed route must be explicitly replaced only after a fresh read;
        // never silently switch a resumed session to the deployment default.
        this.require(agent.model.current())
        await hooks.authorize(); await hooks.admit(choice); await hooks.resolve(modelSelection(choice)); signal.throwIfAborted(); await hooks.authorize()
        if (Number(agent.session.seq) !== request.expected_revision) throw new SessionModelPolicyError('session_model_changed', 'Refresh the current model selection')
        agent.model.select(modelSelection(choice)); await hooks.flush(); signal.throwIfAborted()
        return this.view(agent)
      })
    } catch (error) {
      if (!claimed) throw new SessionModelPolicyError('session_model_busy', 'Another operation owns the idle session')
      throw error
    }
  }
}
export class SessionTurnModelGuard {
  private turn = -1
  private fixed?: Readonly<ModelSelection>
  constructor(private readonly policy: SessionModelPolicy) {}
  check(turn: number, selection: Readonly<ModelSelection>): Readonly<ModelSelection> {
    this.policy.require(selection)
    if (turn === this.turn && this.fixed && !same(this.fixed, selection)) throw new SessionModelPolicyError('session_model_changed', 'The active turn model snapshot cannot change')
    if (turn !== this.turn) { this.turn = turn; this.fixed = Object.freeze({ ...selection }) }
    return this.fixed!
  }
}
