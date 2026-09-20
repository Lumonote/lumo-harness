import type { KnowledgeSessionScope } from '../../../shared/seam-contracts/knowledge.ts'

/**
 * `KnowledgeSessionScope` 的进程内实现（接口在 `shared/seam-contracts/knowledge.ts`）。
 *
 * # 为什么需要一张表，而不是一个作用域上的值
 *
 * 最自然的想法是把允许的空间挂在 agent 的作用域上（`childCtx.provide(...)`），工具从
 * 同一个作用域读。那条路走不通：**`Agent` 不公开它的 `ctx`**（`agent-loop` 里是
 * `private readonly runtime: { ctx }`），而工具是在**插件自己的 ctx** 上注册的、执行时
 * 拿到的只有 `ToolRunContext`。所以「这次会话的收窄条件」只能由一个按会话键的查表回答
 * ——与 `@lumo/control` 按 `exec.agent.session.id` 读控制状态是同一个形状。
 *
 * # 语义：**没设过 = 不收窄**，而不是「一个都不许」
 *
 * 这与治理面对 `knowledge_space_ids` 的既有语义一致（那一侧 `length === 0` 表示「该预设
 * 不限制空间」），也与 `KnowledgeQuery.spaces` 的契约一致（省略 = 不收窄）。三处取同一个
 * 默认值是有意的：任一处不同，就会出现「没配空间的预设在一侧不受限、在另一侧什么都查不到」。
 *
 * **`[]` 与「没设过」仍然分开**：前者是「一个都不许」（必然召回零条），后者是「不按空间
 * 收窄」。合并它们会让一次本该返回零条的检索返回全部，而调用方只看到「有结果」。
 *
 * # 生命周期归调用方
 *
 * 谁 `set` 谁 `clear`。进程内的表**不跨节点**：受治理执行在哪个节点跑就在哪个节点设，
 * 换节点续跑时由新的执行重新设一次——所以不需要持久化，但**必须**在结束时 `clear`，
 * 否则同一个 `sessionRef` 被复用时（受治理执行的会话 id 是从 run_id 确定性派生的）会
 * 读到上一次的收窄条件。
 */
export function createSessionScope(): KnowledgeSessionScope {
  const bySession = new Map<string, readonly string[]>()
  return {
    set(sessionRef, spaces) {
      if (!sessionRef) throw new Error('knowledge: 会话作用域必须带 sessionRef')
      bySession.set(sessionRef, [...spaces])
    },
    clear(sessionRef) {
      bySession.delete(sessionRef)
    },
    spacesFor(sessionRef) {
      return bySession.get(sessionRef)
    },
  }
}
