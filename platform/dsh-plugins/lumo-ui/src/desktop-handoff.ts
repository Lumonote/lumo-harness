import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'

/**
 * 桌面壳与 dsh Web 的握手。
 *
 * dsh web 的鉴权插件通过 `webserver/entry-url` 发布带 launch token 的浏览器入口，
 * 浏览器用它换取签名 cookie。桌面产品关掉了 printUrl/openBrowser（见 dsh-node 的本地 patch），
 * Rust 壳如果直接打开裸 URL，拿到的就是那句
 * 「dsh web authentication required; reopen the URL printed by dsh web」。
 *
 * 做法与上游 web-app 宣告就绪的时机一致：等 Loader 树装配完成（/api 等兄弟路由
 * 都挂好）再把入口写到壳指定的文件里；壳读到文件即可导航。这是纯插件侧的
 * 消费者，不改上游任何代码。
 */

const LOOPBACK_HOST = '127.0.0.1'

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
  ctx.inject(['webServer'], (webCtx) => {
    const announce = (): void => {
      const webServer = webCtx.get('webServer')
      // 树可能在装配途中被拆掉（提前 SIGTERM）；给一个已死服务写入口只会误导壳。
      if (webServer === undefined) return
      const entries: WebEntryUrl[] = []
      webCtx.emit(webServer, 'webserver/entry-url', `http://${LOOPBACK_HOST}:${String(webServer.port)}`, entries)
      const entry = entries.find(entry => entry.open)
      if (entry !== undefined) writeHandoff(file, entry.url)
    }
    const loader = webCtx.get('loader') as LoaderLike | undefined
    const settled = loader?.await()
    if (settled === undefined) announce()
    // Loader 报装配失败时保持沉默：壳会因端口不就绪或进程退出而给出真正的原因。
    else void settled.then(announce, () => {})
  })
}
