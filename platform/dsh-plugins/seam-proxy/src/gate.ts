/**
 * 闸 A —— 加载期可远程化校验（评审 R1 硬规矩 A 的客户端侧执法点）。
 *
 * 为什么是加载期而不是调用期：配置里写着一个 `never` 类 seam，说明装配意图本身是
 * 错的。等到第一次调用才炸，错误会出现在离原因很远的地方——用户按了 Ctrl-C，
 * 或者 resume 之后句柄失效，而 `cordis.yml` 那一行早就没人看了。
 *
 * 为什么闸 A 不够、还要有闸 B（`seam-host`）：这两道闸防的不是同一件事。闸 A 防
 * 装配错误（自己人写错配置），闸 B 防不可信对端（host 不能采信调用方关于「什么
 * 可远程」的声明）。少任何一道都留下一整类漏洞。
 */
import { assertRemotable } from '../../../shared/seam-contracts/remotability.ts'

/**
 * 校验配置里要接管的 seam 全部可远程化。任一不合格即抛，错误信息含类别与理由。
 *
 * **一次报全部**而不是遇到第一个就抛：配置里错了三个 seam 时，逐个报会让人改一轮
 * 试一轮，三轮才知道全貌。
 *
 * 空列表合法——不接管任何 seam 是一种正当装配（例如只想拿 `ctx.seamProxy` 客户端
 * 自己调）。
 */
export function assertSeamsRemotable(seams: readonly string[]): void {
  const problems: string[] = []
  for (const seam of seams) {
    try {
      assertRemotable(seam)
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e))
    }
  }
  if (problems.length === 0) return
  throw new Error(
    `seam-proxy: 配置的 seams 里有 ${problems.length} 个不可远程化，拒绝装配：\n` +
    problems.map((p) => `  - ${p}`).join('\n'),
  )
}
