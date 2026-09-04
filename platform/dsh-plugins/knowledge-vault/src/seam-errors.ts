/**
 * Seam 调用的**本地**错误分类（单机 vault 内嵌副本）。
 *
 * 来源：platform/shared/seam-contracts/errors.ts（权威定义）。权威版还依赖
 * remote.ts（网络错误归类），vault 没有跨节点调用，只裁走本地分类的三件套。
 * 修改权威定义时请同步本文件。
 */
/** 带分类的 seam 错误。本地 Provider 与 host 校验层均抛它。 */
export class SeamError extends Error {
  constructor(
    readonly code: 'forbidden' | 'invalid' | 'capability_unavailable' | 'internal',
    message: string,
  ) {
    super(message)
    this.name = 'SeamError'
  }
}

/** 越权：realm/角色不允许。不可重试，不计入熔断。 */
export function forbidden(message: string): SeamError {
  return new SeamError('forbidden', message)
}

/** 参数或方法非法。不可重试，不计入熔断。 */
export function invalid(message: string): SeamError {
  return new SeamError('invalid', message)
}

/** 该形态未提供此能力（§13.2：显式拒绝，绝不静默降级成空结果）。 */
export function capabilityUnavailable(message: string): SeamError {
  return new SeamError('capability_unavailable', message)
}
