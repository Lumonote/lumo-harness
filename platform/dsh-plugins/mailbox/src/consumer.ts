/**
 * 信箱 Consumer：把 `ctx.mailbox` 暴露成模型可见的三个工具，
 * 支撑 §8.1 的 `A await(wait(id))` / `B resolve(id)` 协同原语。
 *
 * 安全边界：realm 由装配层固定注入，模型不可改——否则一个 agent 能读写另一个
 * 租户的等待项。TTL 有上限，模型不能靠一个超大 ttl 绕过 A3 的强制过期。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MailboxSeam } from '../../../shared/seam-contracts/mailbox.ts'

export interface MailboxToolConfig {
  /** 本 agent 的 realm —— 固定注入，模型不可改 */
  realm: string
  /** 默认 TTL */
  defaultTtlMs: number
  /** TTL 上限：模型给的 ttl 会被夹到这个值以内 */
  maxTtlMs: number
  /** 单次 wait 的等待上限（不改变等待项状态，只是本次不再等） */
  maxWaitMs: number
}

export function defineMailboxTools(
  ctx: Context,
  seam: MailboxSeam,
  config: MailboxToolConfig,
): () => void {
  const create: ToolDefinition = {
    name: 'mailbox_create',
    description: '建立一个等待项（future），用于等待其他智能体或人工的结果。'
      + '返回后即可把 futureId 交给对方，对方以 mailbox_resolve 兑现。',
    parameters: {
      type: 'object',
      properties: {
        futureId: { type: 'string', description: '等待项标识，需在 realm 内唯一' },
        ttlMs: { type: 'number', description: `等待有效期毫秒（默认 ${config.defaultTtlMs}，上限 ${config.maxTtlMs}）` },
      },
      required: ['futureId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['futureId', 'state', 'expiresAt'],
        properties: {
          futureId: { type: 'string' },
          state: { type: 'string' },
          expiresAt: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, _exec: ToolRunContext) {
      const { futureId, ttlMs } = args as { futureId?: string; ttlMs?: number }
      if (!futureId?.trim()) throw new Error('mailbox_create: futureId 不能为空')
      const ttl = Math.min(Math.max(ttlMs ?? config.defaultTtlMs, 1_000), config.maxTtlMs)
      const record = await seam.create(scoped(config.realm, futureId), config.realm, ttl)
      return { futureId, state: record.state, expiresAt: record.expiresAt }
    },
  }

  const resolveTool: ToolDefinition = {
    name: 'mailbox_resolve',
    description: '兑现一个等待项，把结果交给正在等待它的智能体。'
      + '已兑现或已过期的等待项不会被覆盖。',
    parameters: {
      type: 'object',
      properties: {
        futureId: { type: 'string', description: '要兑现的等待项标识' },
        value: { description: '兑现的结果值（任意 JSON）' },
        error: { type: 'string', description: '以失败兑现时的原因；与 value 二选一' },
      },
      required: ['futureId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' }, state: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, _exec: ToolRunContext) {
      const { futureId, value, error } = args as { futureId?: string; value?: unknown; error?: string }
      if (!futureId?.trim()) throw new Error('mailbox_resolve: futureId 不能为空')
      const key = scoped(config.realm, futureId)
      const outcome = error !== undefined && error !== ''
        ? await seam.reject(key, error)
        : await seam.resolve(key, value)
      return outcome.status === 'already-settled'
        ? { status: outcome.status, state: outcome.state }
        : { status: outcome.status }
    },
  }

  const wait: ToolDefinition = {
    name: 'mailbox_wait',
    description: '等待一个等待项被兑现。返回 resolved/rejected/expired 三种终态之一；'
      + 'expired 表示超时未兑现，应当重试或上报，不要再次无限等待。',
    parameters: {
      type: 'object',
      properties: {
        futureId: { type: 'string', description: '要等待的等待项标识' },
        timeoutMs: { type: 'number', description: `本次等待上限毫秒（上限 ${config.maxWaitMs}）` },
      },
      required: ['futureId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['state'],
        properties: {
          state: { type: 'string' },
          value: {},
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, _exec: ToolRunContext) {
      const { futureId, timeoutMs } = args as { futureId?: string; timeoutMs?: number }
      if (!futureId?.trim()) throw new Error('mailbox_wait: futureId 不能为空')
      const budget = Math.min(timeoutMs ?? config.maxWaitMs, config.maxWaitMs)
      return await seam.wait(scoped(config.realm, futureId), budget)
    },
  }

  const disposers = [create, resolveTool, wait].map((d) => ctx.tools.register(d))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * realm 前缀：等待项 id 由模型给出，不加前缀的话 A 租户能猜到并兑现 B 租户的等待项。
 * 前缀在工具层加、模型看不到，因此模型无法跨 realm 构造 id。
 */
function scoped(realm: string, futureId: string): string {
  return `${realm}:${futureId}`
}
