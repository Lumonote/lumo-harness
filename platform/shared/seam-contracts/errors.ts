/**
 * Seam 调用的**本地**错误分类。
 *
 * 为什么需要它：Provider 抛错时，调用方（尤其是 seam host 要把错误翻译成线上的
 * `SeamErrorCode`）必须能区分「越权」「参数非法」「节点故障」。靠 message 正则去
 * 猜是不可接受的 —— 改一句中文文案就会把 403 变成 500，把「调用方的问题」误判成
 * 「节点该熔断」。所以分类由抛出方显式承担。
 *
 * 与 {@link RemoteSeamError} 的分工：本文件是 seam **实现侧**抛的（本地 Provider、
 * host 的参数校验）；RemoteSeamError 是 seam **调用侧**收到的（网络/远端失败）。
 * 两者都带同一套 code，因此 host 串联（Provider 本身又是个远程代理）时
 * 分类不会在中转处丢失 —— 见 {@link seamErrorCode}。
 */
import { RemoteSeamError, type SeamErrorCode } from './remote.ts'

/** 带分类的 seam 错误。本地 Provider 与 host 校验层均抛它。 */
export class SeamError extends Error {
  constructor(
    readonly code: SeamErrorCode,
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

/**
 * 把任意抛出物归类成线上的 code。
 *
 * 未知错误一律 `internal` —— 不猜。猜错的代价是：把调用方的 bug 记到节点头上并
 * 熔断一个健康节点，或者反过来放过一次真实故障。
 */
export function seamErrorCode(e: unknown): SeamErrorCode {
  if (e instanceof SeamError) return e.code
  if (e instanceof RemoteSeamError) return e.code
  return 'internal'
}
