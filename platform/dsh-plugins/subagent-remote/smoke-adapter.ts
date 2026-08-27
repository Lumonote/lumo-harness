/**
 * 冒烟专用 mock 适配器插件(qv. 真 dsh 承载进程)。
 *
 * 承载进程用 base bundle 起真树,树里没有 API key 可用的 provider;runner 由
 * 平台插件行注入本插件,在真 `ctx.llm` 上注册 `provider='mock'` 的文本适配器,
 * 使 child agent(agentOptions provider=mock)零密钥跑完单 turn。
 *
 * 只走 dsh 公开件(LlmAdapter + registerAdapter),与 host.spec 的 10 行最小 mock
 * 同款 —— 但这是真树装配面,撑得起 subagent-host 的 runChild 全链。
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** 冒烟判据:父侧断言 output 非空且含本串(闭集验证,不猜)。 */
export const SMOKE_REPLY_TEXT = 'carrier-mock-child 答复(来自承载节点进程内 mock provider)'

function textOnlyAdapter(text: string): LlmAdapter {
  return new (class extends LlmAdapter {
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

export const inject = ['llm']

export function apply(ctx: Context, _config: unknown): void {
  ctx.llm.registerAdapter(['mock'], textOnlyAdapter(SMOKE_REPLY_TEXT))
  ctx.logger.info('lumo-smoke-adapter: mock 适配器已注册(provider=mock, text=%s)', SMOKE_REPLY_TEXT)
}

export default apply
