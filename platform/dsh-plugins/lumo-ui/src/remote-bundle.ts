/**
 * 远端服务端安装包（P1 SSH 一键接入）的本机侧辅助：包命名、下载地址、离线 scp 推送。
 * 独立文件，remote-hosts-api.ts 只通过 `prepareBundle` / `bundleUrl` 两个钩子使用。
 *
 *   - 包名：lumo-server-<version>-<os>-<arch>.tar.gz（与 platform/tools/remote/pack-server.mjs 一致）；
 *   - 在线：bundleUrl 返回**发布目录**（如 GitHub Release 下载目录），远端脚本自行拼包名、拉 SHA256SUMS 校验；
 *   - 离线：本机目录 LUMO_REMOTE_BUNDLE_DIR 下有对应包时，先 `ssh mkdir -p R/incoming` 再 `scp` 推送
 *     包和 .sha256 到 R/incoming/，远端 install 优先使用 incoming 中的包（同样强制校验 sha256）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReleaseTarget, RemoteHost } from '../../../shared/seam-contracts/remote-hosts.ts'
import { runSshCommand } from './remote-ssh-process.ts'

export const DEFAULT_RELEASE_BASE = 'https://github.com/Lumonote/lumo-harness/releases/download'

export function serverBundleName(version: string, os: string, arch: string): string {
  const a = arch === 'x86_64' || arch === 'amd64' ? 'x64' : arch === 'aarch64' ? 'arm64' : arch
  return `lumo-server-${version}-${os}-${a}.tar.gz`
}

/**
 * 远端 --bundle-url 取值：显式 LUMO_REMOTE_BUNDLE_BASE（https 目录）优先；否则默认 GitHub Release `v<version>/` 目录。
 * LUMO_REMOTE_BUNDLE_BASE=off 关闭在线下载（只走离线推送）。
 */
export function bundleBaseUrl(target: ReleaseTarget, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.LUMO_REMOTE_BUNDLE_BASE ?? ''
  if (raw === 'off') return undefined
  if (raw) return raw.startsWith('https://') ? `${raw.replace(/\/+$/u, '')}/` : undefined
  return `${DEFAULT_RELEASE_BASE}/v${target.version}/`
}

export async function sha256OfFile(file: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((ok, fail) => { createReadStream(file).on('data', d => h.update(d)).on('end', () => ok()).on('error', fail) })
  return h.digest('hex')
}

/** 本机离线包：存在则返回路径与 sha256（优先读旁边的 .sha256，没有就现算并写回）。 */
export async function findLocalBundle(dir: string | undefined, target: ReleaseTarget, host: Pick<RemoteHost, 'probe'>): Promise<{ file: string; name: string; sha256: string } | undefined> {
  if (!dir || !host.probe) return undefined
  const name = serverBundleName(target.version, host.probe.os, host.probe.arch)
  const file = join(dir, name)
  if (!existsSync(file)) return undefined
  const side = `${file}.sha256`
  let sha = existsSync(side) ? readFileSync(side, 'utf8').trim().split(/\s+/u)[0] ?? '' : ''
  if (!/^[0-9a-f]{64}$/u.test(sha)) { sha = await sha256OfFile(file); try { writeFileSync(side, `${sha}  ${name}\n`) } catch { /* 只读目录时不写回 */ } }
  return { file, name, sha256: sha }
}

/** scp 参数：沿用 ssh 的安全选项（BatchMode/known_hosts/禁口令），`-P` 端口，目标用 `--` 隔开。 */
export function scpArgs(sshBase: string[], files: string[], dest: string): string[] {
  const at = sshBase.indexOf('--')
  const opts = sshBase.slice(0, at)
  const out: string[] = ['-q', '-B']
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '-p') { out.push('-P', opts[++i]!); continue }
    out.push(opts[i]!)
  }
  return [...out, '--', ...files, `${sshBase[at + 1]}:${dest}`]
}

export function runScp(args: string[], timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  return runSshCommand('scp', args, { timeoutMs, ...(signal ? { signal } : {}) })
}

/** 远端 incoming 目录（安装目录可能是 `~/` 开头；scp 目标对 `~` 不展开，转成相对 home 的路径）。 */
export function incomingDir(installRoot: string): string {
  const root = installRoot.startsWith('~/') ? installRoot.slice(2) : installRoot
  return `${root.replace(/\/+$/u, '')}/incoming/`
}
