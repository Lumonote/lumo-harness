import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
export const SKILLHUB_ARCHIVE_URL = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz'
// 同一个 COS 桶的全球加速域名，与主源指向同一份对象（实测同为 200 / 64145 字节）。
// 区域域名的 DNS 在部分 CI runner 上会解析超时（curl 28），而加速域名是另一条接入，
// 因此把它作为等价备用源：主源失败不是终点，再打一次就能把这类单点抖动吃掉。
const SKILLHUB_ARCHIVE_MIRROR_URL = 'https://skillhub-1388575217.cos.accelerate.myqcloud.com/install/latest.tar.gz'

function run(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${label}：${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.signal || result.status}`)
  }
  return result.stdout.trim()
}

/** 官方归档的下载地址列表。`LUMO_SKILLHUB_ARCHIVE_URLS` 可整体替换（逗号分隔），便于镜像或自建源。 */
export function skillHubArchiveUrls() {
  const override = process.env.LUMO_SKILLHUB_ARCHIVE_URLS
  const urls = override === undefined
    ? [SKILLHUB_ARCHIVE_URL, SKILLHUB_ARCHIVE_MIRROR_URL]
    : override.split(',').map((value) => value.trim()).filter(Boolean)
  if (urls.length === 0) {
    throw new Error(`LUMO_SKILLHUB_ARCHIVE_URLS 没有可用地址：${JSON.stringify(override)}`)
  }
  return urls
}

/**
 * 不抛异常的 curl：调用方要在多个地址之间继续尝试，只有全部失败才升级为错误。
 * 内层重试刻意给到 ~4 分钟预算 —— 共享 CI runner 的 DNS 抖动通常是秒级，
 * 15s×4 次的窗口太短，会把一次可恢复的抖动判成构建失败。
 *
 * 只对**连接类**失败重试（DNS 解析超时、连接被拒/重置），这正是要治的那一类抖动。
 * 404 / URL 非法这类永久性错误换源也不会好，立刻返回让调用方换下一个地址 ——
 * 对它们退避重试只是把两分钟的失败拖成五分钟。
 */
function tryDownload(url, destination) {
  const result = spawnSync('curl', [
    '-fsSL',
    // --retry-connrefused 与 --retry-all-errors 互斥；这里要的是「传输层失败才重试」。
    '--retry', '4', '--retry-connrefused', '--retry-delay', '5', '--retry-max-time', '240',
    '--connect-timeout', '20', '--max-time', '300',
    '-o', destination, url,
  ], { encoding: 'utf8', windowsHide: true, timeout: 360_000 })
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail: result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.signal || String(result.status),
    }
  }
  // 落盘前确认拿到的是 gzip 而不是代理/网关的 200 错误页：缓存里的坏归档会让
  // 之后每一轮构建都失败，且症状指向解包而不是下载。入口文件的存在性由
  // stageSkillHub 负责（那才是契约的位置），这里只挡「压根不是归档」。
  let header = Buffer.alloc(0)
  try {
    header = readFileSync(destination, { length: 2 })
  } catch {
    return { ok: false, detail: '下载完成但读不到文件' }
  }
  if (header.length < 2 || header[0] !== 0x1f || header[1] !== 0x8b) {
    return { ok: false, detail: `下载结果不是 gzip 归档（前两字节 ${header.toString('hex') || '<空>'}）` }
  }
  return { ok: true }
}

/** Download only the official CLI payload; never install into the builder's home. */
export function prepareSkillHubArchive(cacheRoot, archivePath = process.env.LUMO_SKILLHUB_ARCHIVE) {
  if (archivePath) {
    const archive = resolve(archivePath)
    if (!existsSync(archive)) throw new Error(`SkillHub CLI 归档不存在：${archive}`)
    return { archive, source: archive }
  }
  mkdirSync(cacheRoot, { recursive: true })
  const archive = resolve(cacheRoot, 'latest.tar.gz')
  if (existsSync(archive)) return { archive, source: 'cache' }
  const urls = skillHubArchiveUrls()
  const temporary = mkdtempSync(resolve(cacheRoot, 'download-'))
  const failures = []
  try {
    const download = resolve(temporary, 'latest.tar.gz')
    for (const url of urls) {
      console.log(`下载官方 SkillHub CLI：${url}`)
      const attempt = tryDownload(url, download)
      if (attempt.ok) {
        renameSync(download, archive)
        return { archive, source: url }
      }
      failures.push(`  - ${url}：${attempt.detail}`)
      console.warn(`Lumo: [WARN] SkillHub CLI 下载失败，换下一个地址重试（${attempt.detail}）`)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  throw new Error(
    `下载 SkillHub CLI 失败（已尝试 ${String(urls.length)} 个地址）：\n${failures.join('\n')}\n`
    + `换源：设置 LUMO_SKILLHUB_ARCHIVE_URLS=https://<镜像>/latest.tar.gz（逗号分隔，优先在前）。\n`
    + '离线构建：预先下载官方 latest.tar.gz 并设置 LUMO_SKILLHUB_ARCHIVE=<路径>（见 platform/desktop/README.md）。',
  )
}

function pythonEnvironment(runtimeRoot) {
  return {
    ...process.env,
    PYTHONHOME: resolve(runtimeRoot, 'python'),
    PYTHONPATH: '',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
  }
}

/** Stage the CLI alongside the already bundled Node/Python, then execute it. */
export function stageSkillHub(runtimeRoot, archive, targetPlatform = process.platform, source = SKILLHUB_ARCHIVE_URL) {
  const python = resolve(runtimeRoot, 'python', targetPlatform === 'win32' ? 'python.exe' : 'bin/python3')
  const destination = resolve(runtimeRoot, 'skillhub')
  // Read regular files explicitly: no archive symlinks or paths may escape the CLI directory.
  // Keep sibling modules/data, since the upstream CLI may import files beside its entrypoint.
  run(python, ['-B', '-c', `
import pathlib, sys, tarfile
archive, destination = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as bundle:
    entries = [m for m in bundle.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name == 'skills_store_cli.py']
    if len(entries) != 1:
        raise RuntimeError('SkillHub archive must contain one skills_store_cli.py entrypoint')
    prefix = pathlib.PurePosixPath(entries[0].name).parent
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or '\\\\' in member.name:
            raise RuntimeError('Unsafe SkillHub archive path: ' + member.name)
        if not path.is_relative_to(prefix) or not member.isfile():
            continue
        relative = path.relative_to(prefix)
        if '__pycache__' in relative.parts:
            continue
        target = pathlib.Path(destination).joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(bundle.extractfile(member).read())
`, archive, destination], { env: pythonEnvironment(runtimeRoot) }, '解包 SkillHub CLI 失败')
  const bin = resolve(runtimeRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  cpSync(resolve(desktopRoot, 'skillhub-launcher.mjs'), resolve(bin, 'skillhub.mjs'))
  if (targetPlatform === 'win32') {
    writeFileSync(resolve(bin, 'skillhub.cmd'), '@echo off\r\n"%~dp0..\\node.exe" "%~dp0skillhub.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n')
  } else {
    writeFileSync(resolve(bin, 'skillhub'), '#!/bin/sh\nscript_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$script_dir/../node" "$script_dir/skillhub.mjs" "$@"\n')
    chmodSync(resolve(bin, 'skillhub'), 0o755)
  }
  return {
    source,
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    entrypoint: 'bin/skillhub.mjs',
    version: verifySkillHubRuntime(runtimeRoot, targetPlatform),
  }
}

/** A missing launcher, CLI module or Python must fail the build, not the Install button. */
export function verifySkillHubRuntime(runtimeRoot, targetPlatform = process.platform) {
  const node = resolve(runtimeRoot, targetPlatform === 'win32' ? 'node.exe' : 'node')
  const launcher = resolve(runtimeRoot, 'bin', 'skillhub.mjs')
  for (const entry of [node, launcher, resolve(runtimeRoot, 'skillhub', 'skills_store_cli.py')]) {
    if (!existsSync(entry)) throw new Error(`内置 SkillHub CLI 不完整：缺少 ${entry}`)
  }
  const options = {
    cwd: runtimeRoot,
    // Probes must work without a user-installed skillhub/node/python on PATH.
    env: { ...pythonEnvironment(runtimeRoot), PATH: [resolve(runtimeRoot, 'bin'), dirname(node)].join(delimiter) },
  }
  const version = run(node, [launcher, '--version'], options, '打包后的 SkillHub CLI 不可用')
  const help = run(node, [launcher, 'install', '--help'], options, '打包后的 SkillHub install 不可用')
  if (!version || !help.includes('--dir')) throw new Error('打包后的 SkillHub CLI 未提供版本或 install --dir 参数')
  return version
}
