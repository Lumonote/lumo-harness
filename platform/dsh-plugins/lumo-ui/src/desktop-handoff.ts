import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 桌面壳与 dsh Web 的握手。
 *
 * dsh web 的浏览器会话鉴权（client-connection/browser-auth）用每个进程随机的
 * launch token 换取签名 cookie；只有 `connection.authenticatedUrl()` 能给出带
 * token 的入口。桌面产品关掉了 printUrl/openBrowser（见 dsh-node 的本地 patch），
 * Rust 壳如果直接打开裸 URL，拿到的就是那句
 * 「dsh web authentication required; reopen the URL printed by dsh web」。
 *
 * 做法与上游 web-app 宣告就绪的时机一致：等 Loader 树装配完成（/api 等兄弟路由
 * 都挂好）再把入口写到壳指定的文件里；壳读到文件即可导航。这是纯插件侧的
 * 消费者，不改上游任何代码。
 */

const LOOPBACK_HOST = '127.0.0.1'

interface ConnectionLike { authenticatedUrl(baseUrl: string): string }
interface WebServerLike { port: number }
interface LoaderLike { await(): Promise<unknown> }

/** 先写临时文件再 rename，壳永远不会读到半截 URL；0600 因为 token 就是会话凭证。 */
function writeHandoff(file: string, url: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const staging = `${file}.${String(process.pid)}.tmp`
  writeFileSync(staging, `${url}\n`, { mode: 0o600 })
  renameSync(staging, file)
}

/**
 * 注册桌面握手：装配完成后把带 token 的回环入口写入 `file`。
 * @param ctx - 插件上下文
 * @param file - 壳通过 LUMO_DESKTOP_HANDOFF_FILE 指定的绝对路径
 */
export function registerDesktopHandoff(ctx: Context, file: string): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const announce = (): void => {
      const connection = connectionCtx.get('connection') as ConnectionLike | undefined
      const webServer = connectionCtx.get('webServer') as WebServerLike | undefined
      // 树可能在装配途中被拆掉（提前 SIGTERM）；给一个已死服务写入口只会误导壳。
      if (connection === undefined || webServer === undefined) return
      writeHandoff(file, connection.authenticatedUrl(`http://${LOOPBACK_HOST}:${String(webServer.port)}`))
    }
    const loader = connectionCtx.get('loader') as LoaderLike | undefined
    const settled = loader?.await()
    if (settled === undefined) announce()
    // Loader 报装配失败时保持沉默：壳会因端口不就绪或进程退出而给出真正的原因。
    else void settled.then(announce, () => {})
  })
}
