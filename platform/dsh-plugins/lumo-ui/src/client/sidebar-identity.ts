/**
 * 侧边栏底部「登录态」的**可测内核**：把一次 `/auth/account` 读面的结局映射成一个状态。
 *
 * # 为什么单独一个文件
 *
 * 这段映射只有三条分支，而**三条分支的区别就是它的全部内容**：
 *
 *   - 有会话 → 显示身份；
 *   - 这个部署有会话鉴权、当前浏览器没有会话 → 显示「未登录」，点击去登录页；
 *   - 这个部署根本没有会话这回事（单机版不挂 auth 代理）→ **什么都不渲染**。
 *
 * 第三条与第二条长得像但说的不是一件事：前者是「缺一个会话」，后者是「这里不存在登录」。
 * 把它们混成一句「未登录」，就是在一个没有登录的产品里陈述一个不存在的问题。
 *
 * 写在组件里就只能靠 jsdom 验证，而 `lumo-ui/__tests__/client.spec.tsx` 在本机与 CI
 * 都跑不起来（jsdom 未声明为依赖，见 `.workbuddy-ai/memory/local-sandbox.md` §3/§4）。
 * 纯函数能被 node 环境的 spec 直接钉住——与 `collaboration-layout.ts` 同一个做法。
 *
 * # 读的是哪个面
 *
 * `/auth/account`，也就是「用户中心」用的**同一个读面**。自己另存一份用户名迟早会和
 * 会话里那份分叉（改密码、被改角色、被撤销），而这里要说的恰恰是「服务端现在认为你是谁」。
 */

/** 一次 `/auth/account` 读面的结局。`status` 为 `undefined` 表示请求本身就没发出去。 */
export type IdentityReadOutcome =
  | { ok: true; body: unknown }
  | { ok: false; status: number | undefined }

/**
 * 登录态的四种结局。`loading` 只存在于组件里（一次请求那么长的空窗），
 * 不经过这个纯函数——所以这里只有三种。
 */
export type SidebarIdentity =
  | { state: 'signed-in'; name: string; facts: string }
  | { state: 'anonymous' }
  | { state: 'unavailable' }

/** `/auth/account` 的响应里本视图用得上的字段；全部按 `unknown` 收，逐个验。 */
interface AccountBody {
  username?: unknown
  displayName?: unknown
  realm?: unknown
  roles?: unknown
}

/**
 * 把读面结局映射成登录态。
 *
 * 两处「验形状」不是防御性编程：`api()` 对**非 JSON 的响应会把正文原样返回**，所以
 * 200 也可能是别人在回话——单机版没有 auth 代理时，`/auth/account` 落到原生 Web 服务上，
 * 拿回来的是一份 HTML 而不是 404。只看 `response.ok` 就会把一个字符串当成身份渲染出来，
 * 而那种错误在界面上表现为「用户名是半段 HTML」，比空着难查得多。
 */
export function resolveSidebarIdentity(outcome: IdentityReadOutcome): SidebarIdentity {
  if (!outcome.ok) {
    // 401 = 这个部署有会话鉴权，而当前浏览器没有会话。其余状态码（404 最常见）与
    // 「请求都没发出去」归同一档：这个部署里没有「登录」这回事。
    return outcome.status === 401 ? { state: 'anonymous' } : { state: 'unavailable' }
  }
  const value = outcome.body
  if (typeof value !== 'object' || value === null) return { state: 'unavailable' }
  const account = value as AccountBody
  if (typeof account.username !== 'string' || account.username === '') return { state: 'unavailable' }
  const name = typeof account.displayName === 'string' && account.displayName !== '' ? account.displayName : account.username
  // 角色可能是空数组、也可能整条缺失。先各自滤空再拼，否则会拼出 `dev · ` 这种
  // 结尾悬着一个分隔符的串——那看起来像「还有一个角色没显示出来」。
  const facts = [
    typeof account.realm === 'string' ? account.realm : '',
    Array.isArray(account.roles) ? account.roles.filter((role): role is string => typeof role === 'string' && role !== '').join(' · ') : '',
  ].filter(fact => fact !== '').join(' · ')
  return { state: 'signed-in', name, facts }
}
