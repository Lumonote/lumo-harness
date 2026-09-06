import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
export const SKILLHUB_ARCHIVE_URL = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz'

function run(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${label}：${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || result.signal || result.status}`)
  }
  return result.stdout.trim()
}

/** Download only the official CLI payload; never install into the builder's home. */
export function prepareSkillHubArchive(cacheRoot, archivePath = process.env.LUMO_SKILLHUB_ARCHIVE) {
  if (archivePath) {
    const archive = resolve(archivePath)
    if (!existsSync(archive)) throw new Error(`SkillHub CLI 归档不存在：${archive}`)
    return archive
  }
  mkdirSync(cacheRoot, { recursive: true })
  const archive = resolve(cacheRoot, 'latest.tar.gz')
  if (existsSync(archive)) return archive
  const temporary = mkdtempSync(resolve(cacheRoot, 'download-'))
  try {
    const download = resolve(temporary, 'latest.tar.gz')
    console.log(`下载官方 SkillHub CLI：${SKILLHUB_ARCHIVE_URL}`)
    run('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '15', '--max-time', '90', '-o', download, SKILLHUB_ARCHIVE_URL], {}, '下载 SkillHub CLI 失败')
    renameSync(download, archive)
    return archive
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
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
export function stageSkillHub(runtimeRoot, archive, targetPlatform = process.platform) {
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
    source: SKILLHUB_ARCHIVE_URL,
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
