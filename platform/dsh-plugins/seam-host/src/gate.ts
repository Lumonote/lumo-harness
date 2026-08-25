/**
 * 闸 B —— 服务端可远程化闸（评审 R1 硬规矩 A 的 host 侧执法点）。
 *
 * 为什么客户端已有闸 A 还要这一道：两道闸防的不是同一件事。闸 A 防装配错误
 * （自己人在 `cordis.yml` 里写错），闸 B 防**不可信对端** —— host 不能采信调用方
 * 关于「什么可远程」的声明。准入判据交给调用方等于没有判据：一个改过配置的、
 * 旧版本的、或者压根不是我们写的客户端都能绕过闸 A。
 *
 * 错误码为什么是 `forbidden` 而不是 `invalid`：
 * - `invalid` 的语义是「参数/方法非法」，而这里 seam 名是个合法标识符，被拒的原因
 *   是**准入策略**，不是格式问题。混用会让客户端的重试与告警逻辑读错原因。
 * - `forbidden` 不计入熔断（见 `remote.ts` 的 `countsAsFailure`），这正是想要的：
 *   客户端配置错了不该把一个健康的 host 判死刑。
 */
import { forbidden } from '../../../shared/seam-contracts/errors.ts'
import { assertRemotable } from '../../../shared/seam-contracts/remotability.ts'

/**
 * 校验请求里的 seam 名可远程化。不合格即抛 `forbidden`，理由原样带出。
 *
 * `assertRemotable` 抛的是普通 `Error`（分级表不依赖 `remote.ts`，反向会成环），
 * 由本函数负责翻译成线协议的错误码 —— 这就是分级表注释里说的「由 host 侧负责
 * 转成 forbidden」。
 */
export function assertSeamRemotable(seam: string): void {
  try {
    assertRemotable(seam)
  } catch (e) {
    throw forbidden(e instanceof Error ? e.message : String(e))
  }
}
