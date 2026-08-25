/**
 * Seam 网络化的线协议（§4.1 DistributedSeamProxy）。
 *
 * 设计要点：**协议对 seam 是通用的**。每加一个 seam 不需要新协议、新代码生成，
 * 只需要在两端各注册一次方法表 —— 否则「让任意 seam 可远程」会退化成
 * 「给每个 seam 手写一遍 RPC」，杠杆就没了。
 *
 * 传输选型：当前 JSON over HTTP。§12.1 的目标形态是 gRPC/QUIC；
 * 换传输只换 Transport 实现，本文件的信封语义不变。
 */

/** 调用信封。args 是**位置参数数组**，与 seam 接口的方法签名一一对应。 */
export interface SeamCall {
  seam: string
  method: string
  args: unknown[]
}

/** 错误分类。决定客户端「能不能重试」与「该不该熔断」，因此必须精确。 */
export type SeamErrorCode =
  /** 目标节点不可达 / 未就绪。可重试，且计入熔断。 */
  | 'unavailable'
  /** 调用超时。可重试（幂等方法），计入熔断。 */
  | 'timeout'
  /** 越权。不可重试，**不计入熔断** —— 这是调用方的问题，不是节点故障。 */
  | 'forbidden'
  /** 参数/方法非法。不可重试，不计入熔断。 */
  | 'invalid'
  /** 远端 Provider 自身抛错。不可重试（语义未知），计入熔断。 */
  | 'internal'
  /** 该形态未提供此能力（§13.2 Local-lite 显式拒绝，非模拟）。不可重试，不计入熔断。 */
  | 'capability_unavailable'

export interface SeamOk {
  ok: true
  value: unknown
}

export interface SeamFail {
  ok: false
  code: SeamErrorCode
  message: string
}

export type SeamResponse = SeamOk | SeamFail

/** 跨节点 seam 调用失败。保留 code 供上层决定重试/降级。 */
export class RemoteSeamError extends Error {
  constructor(
    readonly code: SeamErrorCode,
    message: string,
    readonly endpoint?: string,
  ) {
    super(message)
    this.name = 'RemoteSeamError'
  }

  /** 只有「没拿到语义结果」的失败才可重试。 */
  get retryable(): boolean {
    return this.code === 'unavailable' || this.code === 'timeout'
  }

  /** 越权与参数错误是调用方的问题，不该把远端节点判死刑。 */
  get countsAsFailure(): boolean {
    return this.code !== 'forbidden' && this.code !== 'invalid' && this.code !== 'capability_unavailable'
  }
}

/**
 * 各 seam 的**幂等方法白名单**住在分级表里，不在这里。
 *
 * 曾经这里有一张 `IDEMPOTENT_METHODS`，而评审 R1 要求的分级表里幂等性又是一列。
 * 两处并存必然漂移：加一个方法时只会改一处，另一处静默过期，而过期的方向是
 * 「以为不幂等所以不重试」（可用性损失）或「以为幂等所以重试」（重复副作用）——
 * 后者是正确性事故。所以幂等性只留一处，见 `remotability.ts`。
 *
 * 本函数签名保持不变，`client.ts` 无需改动。
 */
export { isIdempotent } from './remotability.ts'

/** 把线上的错误码映射成 HTTP 状态（host 侧用），保持两端语义一致。 */
export function statusForCode(code: SeamErrorCode): number {
  switch (code) {
    case 'forbidden': return 403
    case 'invalid': return 400
    case 'capability_unavailable': return 501
    case 'timeout': return 504
    case 'unavailable': return 503
    default: return 500
  }
}

/** 反向映射（client 侧用）：未知状态一律当作 internal，不猜。 */
export function codeForStatus(status: number): SeamErrorCode {
  switch (status) {
    case 400: return 'invalid'
    case 403: return 'forbidden'
    case 501: return 'capability_unavailable'
    case 503: return 'unavailable'
    case 504: return 'timeout'
    default: return 'internal'
  }
}
