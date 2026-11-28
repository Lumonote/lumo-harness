import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { findExecutable } from './registry.ts'
import { CLI_VERSION, NPM_REGISTRY, TRAE_INSTALLER, type CliRecipe } from './cli-install-catalog.ts'

export interface InstallContext {
  recipe: CliRecipe; directory: string; version: string; signal: AbortSignal
  progress(stage: string, text?: string): void
}
export type CliInstaller = (context: InstallContext) => Promise<string>
export interface CliCommand { bin: string; args: string[]; pathDir?: string }

/** No shell interpolation. Cancellation reaps the installer process group before returning. */
export function runInstallerCommand(command: CliCommand, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, output: (text: string) => void): Promise<void> {
  signal.throwIfAborted()
  return new Promise((done, reject) => {
    const child = spawn(command.bin, command.args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let killTimer: ReturnType<typeof setTimeout> | undefined, timedOut = false
    const kill = (kind: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind); else child.kill(kind) } catch { /* already exited */ }
    }
    const abort = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 2000); killTimer.unref() }
    const timeout = setTimeout(() => { timedOut = true; abort() }, 15 * 60_000); timeout.unref()
    signal.addEventListener('abort', abort, { once: true })
    let outputError: unknown
    const consume = (text: string) => { try { output(text) } catch (error) { outputError = error; abort() } }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', consume); child.stderr.on('data', consume)
    child.once('error', reject)
    child.once('close', (code, reason) => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (timedOut) reject(new Error('安装超时（15 分钟），请查看日志后重试'))
      else if (outputError) reject(outputError)
      else if (code !== 0) reject(new Error(`安装命令退出 ${code ?? reason ?? 'unknown'}`))
      else done()
    })
    if (signal.aborted) abort()
  })
}

/** Bounded HTTPS reads; installer/package locations never come from the browser. */
async function download(url: string, signal: AbortSignal, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('安装元数据超过大小限制')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function packageRoot(directory: string, packageName: string): string {
  return join(directory, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', packageName)
}
export function installedCommand(recipe: CliRecipe, directory: string): CliCommand {
  if (recipe.method === 'trae' || process.platform !== 'win32') {
    const bin = join(directory, 'bin', recipe.binary)
    if (!findExecutable(bin)) throw new Error('安装未产生可执行的 CLI 入口')
    return { bin, args: [], pathDir: join(directory, 'bin') }
  }
  const root = packageRoot(directory, recipe.packageName!)
  const info = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const entry = typeof info.bin === 'string' ? info.bin : info.bin?.[recipe.binary]
  if (typeof entry !== 'string') throw new Error('CLI 包未声明执行入口')
  const bin = resolve(root, entry), rel = relative(root, bin)
  if (rel.startsWith('..') || !statSync(bin).isFile()) throw new Error('CLI 入口不在安装包内')
  return /\.[cm]?js$/u.test(bin) ? { bin: process.execPath, args: [bin], pathDir: directory } : { bin, args: [], pathDir: directory }
}

function installEnv(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const home = join(directory, '.installer-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return { ...env, HOME: home, USERPROFILE: home, CI: '1', NO_COLOR: '1',
    PATH: [join(directory, 'bin'), dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter),
    npm_config_cache: join(directory, '.npm-cache'), npm_config_userconfig: join(home, '.npmrc'),
  }
}

export const installCli: CliInstaller = async ({ recipe, directory, version, signal, progress }) => {
  const env = installEnv(directory)
  const run = (bin: string, args: string[]) => runInstallerCommand({ bin, args }, directory, env, signal, text => progress('安装中', text))
  let installedVersion: string
  if (recipe.method === 'npm') {
    const npmBin = findExecutable(process.platform === 'win32' ? 'npm.cmd' : 'npm')
    if (!npmBin) throw new Error('需要本机 Node.js 与 npm；安装后点击重试')
    const npmCli = process.platform === 'win32' ? join(dirname(npmBin), 'node_modules/npm/bin/npm-cli.js') : realpathSync(npmBin)
    if (!npmCli.endsWith('npm-cli.js')) throw new Error('无法识别 npm 的原生执行入口')
    const packages = [recipe.packageName!, ...(recipe.companions ?? [])]
    const pinned: string[] = []
    progress('读取版本', '正在从 npm 官方仓库解析版本…\n')
    for (const [index, name] of packages.entries()) {
      const requested = index === 0 ? version : 'latest'
      const info = JSON.parse((await download(`${NPM_REGISTRY}/${encodeURIComponent(name)}/${requested}`, signal)).toString('utf8'))
      if (info.name !== name || typeof info.version !== 'string' || info.version === 'latest' || !CLI_VERSION.test(info.version)) throw new Error('官方仓库返回的版本无效')
      pinned.push(`${name}@${info.version}`)
    }
    progress('下载与安装', `安装 ${pinned.join('、')}\n`)
    await run(process.execPath, [npmCli, 'install', '--global', '--prefix', directory, '--registry', NPM_REGISTRY, '--no-audit', '--no-fund', '--no-update-notifier', ...pinned])
    const info = JSON.parse(readFileSync(join(packageRoot(directory, recipe.packageName!), 'package.json'), 'utf8'))
    if (`${info.name}@${info.version}` !== pinned[0]) throw new Error('实际安装版本与锁定版本不一致')
    installedVersion = info.version
  } else {
    progress('下载安装器', '正在读取 TRAE 官方安装器…\n')
    const script = await download(TRAE_INSTALLER, signal)
    const file = join(directory, 'install.sh')
    writeFileSync(file, script, { mode: 0o600, flag: 'wx' })
    progress('下载与安装', `安装器 SHA-256：${createHash('sha256').update(script).digest('hex')}\n`)
    Object.assign(env, { TRAECLI_INSTALL_DIR: join(directory, 'bin'), TRAECLI_STATE_DIR: join(directory, 'state'),
      TRAE_HOME: join(directory, '.installer-home/.trae'), TRAECLI_INSTALL_MIGRATE_BREW: '0', TRAECLI_INSTALL_REMOVE_BREW: '0',
      TRAECLI_INSTALL_REMOVE_COCO: '0', TRAECLI_INSTALL_RG: 'never', TRAECLI_INSTALL_BWRAP: 'never', TRAECLI_INSTALL_ASSUME_YES: '1',
    })
    mkdirSync(env.TRAE_HOME!, { recursive: true, mode: 0o700 })
    await run('/bin/sh', [file, '--release', version, '--no-auto-update', '--keep-existing-commands'])
    installedVersion = readFileSync(join(directory, 'state/current_version'), 'utf8').trim()
    if (!CLI_VERSION.test(installedVersion) || installedVersion === 'latest' || (version !== 'latest' && installedVersion !== version)) throw new Error('TRAE 实际安装版本与请求不一致')
  }
  progress('校验入口', '正在检查安装后的执行入口…\n')
  const command = installedCommand(recipe, directory)
  if (recipe.engineId === 'codex' || recipe.engineId === 'trae') {
    await run(command.bin, [...command.args, '--version'])
  }
  // Caches belong exclusively to this attempt. Keep immutable release paths for running sessions.
  rmSync(join(directory, '.npm-cache'), { recursive: true, force: true })
  rmSync(join(directory, '.installer-home'), { recursive: true, force: true })
  return installedVersion
}
