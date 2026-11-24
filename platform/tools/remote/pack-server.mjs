#!/usr/bin/env node
// 服务端安装包打包脚本（P1 SSH 一键接入）。
//
//   node platform/tools/remote/pack-server.mjs --tree <dir> --os linux --arch x64 [--out <dir>]
//        [--version V] [--dsh-sha S] [--dsh-tag T]
//   node platform/tools/remote/pack-server.mjs --sums <dir>      # 为 dir 下所有 lumo-server-*.tar.gz 写 SHA256SUMS
//
// --tree 指向一棵已构建好的运行树（结构与 dsh-node 镜像的 /workspace 一致：
//   <tree>/deepseek-harness（按 platform/dsh-pin.json 构建）、<tree>/platform（含 node_modules 与 dsh-node）。
// CI 中由 `docker build --target dsh-node` 产出后 `docker cp` 取出，构建逻辑与镜像同源，不另写一套。
//
// 产物：<out>/lumo-server-<V>-<os>-<arch>.tar.gz 与 .sha256，包内唯一顶层目录 lumo-server-<V>-<os>-<arch>/：
//   VERSION         key=value（version/dsh_sha/dsh_tag/os/arch），供远端 POSIX sh 无 JSON 解析读取
//   manifest.json   schema/version/os/arch/dsh{repository,tag,sha}/node.engines/entry/fileCount/filesSha256/createdAt
//   files.sha256    包内每个文件的 sha256（sha256sum -c 格式，不含自身与 manifest.json）
//   bin/lumo-node   启动入口（run / --version / --healthcheck）
//   app/            运行树（deepseek-harness + platform）
//   systemd/lumo-server.service.example  参考单元（实际单元由 lumo-remote.sh 按安装目录生成）
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '..', '..')

export const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
export const BUNDLE_RE = /^lumo-server-([0-9A-Za-z.+-]{1,40})-(linux|darwin)-(x64|arm64)\.tar\.gz$/u

export function normalizeArch(arch) {
  const a = String(arch).toLowerCase()
  if (a === 'x86_64' || a === 'amd64' || a === 'x64') return 'x64'
  if (a === 'aarch64' || a === 'arm64') return 'arm64'
  throw new Error(`unsupported arch ${arch}`)
}

export function bundleName(version, os, arch) {
  const target = `${os}-${normalizeArch(arch)}`
  if (!SUPPORTED_TARGETS.includes(target)) throw new Error(`unsupported target ${target}`)
  if (!/^[0-9A-Za-z.+-]{1,40}$/u.test(version)) throw new Error(`invalid version ${version}`)
  return `lumo-server-${version}-${target}`
}

export function readPin(root = platformRoot) {
  const pin = JSON.parse(readFileSync(join(root, 'dsh-pin.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!/^[0-9a-f]{40}$/u.test(pin.sha)) throw new Error('dsh-pin.json sha must be 40 hex')
  return { version: pkg.version, engines: pkg.engines?.node ?? '', dsh: { repository: pin.repository, tag: pin.tag, sha: pin.sha } }
}

export function sha256File(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

/** 递归列出文件（相对路径、`/` 分隔、排序）；符号链接按链接记录，不跟随。 */
export function listFiles(root) {
  const out = []
  const visit = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) visit(r)
      else out.push(r)
    }
  }
  visit('')
  return out.sort()
}

/** files.sha256 内容：普通文件记哈希；符号链接记 `link:<目标>` 的哈希不可被 sha256sum -c 校验，故跳过链接。 */
export function fileSums(root, exclude = new Set(['files.sha256', 'manifest.json'])) {
  const lines = []
  for (const rel of listFiles(root)) {
    if (exclude.has(rel)) continue
    if (lstatSync(join(root, rel)).isSymbolicLink()) continue
    lines.push(`${sha256File(join(root, rel))}  ${rel}`)
  }
  return `${lines.join('\n')}\n`
}

export function versionFile({ version, os, arch, dsh }) {
  return `version=${version}\ndsh_sha=${dsh.sha}\ndsh_tag=${dsh.tag}\nos=${os}\narch=${arch}\n`
}

export function buildManifest({ version, os, arch, dsh, engines, fileCount, filesSha256, createdAt = new Date().toISOString() }) {
  return { schema: 1, name: bundleName(version, os, arch), version, os, arch, dsh, node: { engines }, entry: 'bin/lumo-node', fileCount, filesSha256, createdAt }
}

/** 运行树里 dsh 检出的 HEAD（.git 元数据可能被裁剪；读不到返回 null）。 */
export function treeDshHead(tree) {
  const git = join(tree, 'deepseek-harness', '.git')
  try {
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/u.test(head)) return head
    const ref = /^ref: (.+)$/u.exec(head)?.[1]
    if (!ref) return null
    if (existsSync(join(git, ref))) return readFileSync(join(git, ref), 'utf8').trim()
    const packed = existsSync(join(git, 'packed-refs')) ? readFileSync(join(git, 'packed-refs'), 'utf8') : ''
    return packed.split('\n').map(l => l.split(' ')).find(([, r]) => r === ref)?.[0] ?? null
  } catch { return null }
}

export function sumsFor(dir) {
  const names = readdirSync(dir).filter(n => BUNDLE_RE.test(n)).sort()
  return names.map(n => `${sha256File(join(dir, n))}  ${n}`).join('\n') + (names.length ? '\n' : '')
}

const UNIT_EXAMPLE = `# 参考单元：实际由 lumo-remote.sh 按安装目录生成到 ~/.config/systemd/user/ 或 /etc/systemd/system/
[Unit]
Description=Lumo server (remote node)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.lumo-remote/current
EnvironmentFile=-%h/.lumo-remote/lumo.env
ExecStart=%h/.lumo-remote/current/bin/lumo-node run
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`

export function pack({ tree, os, arch, out, version, dshSha, dshTag, root = platformRoot, now }) {
  const pin = readPin(root)
  const v = version ?? pin.version
  const a = normalizeArch(arch)
  const dsh = { ...pin.dsh, ...(dshSha ? { sha: dshSha } : {}), ...(dshTag ? { tag: dshTag } : {}) }
  if (dsh.sha !== pin.dsh.sha) throw new Error(`dsh sha ${dsh.sha} != pin ${pin.dsh.sha}（服务端包必须与 dsh-pin 一致）`)
  for (const need of ['deepseek-harness', 'platform/data-plane/dsh-node/src/index.ts', 'platform/data-plane/dsh-node/node_modules/tsx']) {
    if (!existsSync(join(tree, need))) throw new Error(`运行树缺少 ${need}`)
  }
  const head = treeDshHead(tree)
  if (head && head !== dsh.sha) throw new Error(`运行树 dsh HEAD ${head} != pin ${dsh.sha}`)
  const name = bundleName(v, os, a)
  const outDir = resolve(out)
  const stage = join(outDir, `.stage-${name}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, name, 'bin'), { recursive: true })
  const pkgRoot = join(stage, name)
  cpSync(tree, join(pkgRoot, 'app'), { recursive: true, verbatimSymlinks: true, filter: s => !/(^|[/\\])\.git([/\\]|$)/u.test(relative(tree, s)) })
  cpSync(join(here, 'lumo-node.sh'), join(pkgRoot, 'bin', 'lumo-node'))
  chmodSync(join(pkgRoot, 'bin', 'lumo-node'), 0o755)
  mkdirSync(join(pkgRoot, 'systemd'))
  writeFileSync(join(pkgRoot, 'systemd', 'lumo-server.service.example'), UNIT_EXAMPLE)
  writeFileSync(join(pkgRoot, 'VERSION'), versionFile({ version: v, os, arch: a, dsh }))
  const sums = fileSums(pkgRoot)
  writeFileSync(join(pkgRoot, 'files.sha256'), sums)
  const manifest = buildManifest({ version: v, os, arch: a, dsh, engines: pin.engines, fileCount: sums.trim().split('\n').length, filesSha256: createHash('sha256').update(sums).digest('hex'), ...(now ? { createdAt: now } : {}) })
  writeFileSync(join(pkgRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const tarball = join(outDir, `${name}.tar.gz`)
  // 固定属主与排序，尽量可复现；GNU tar 支持这些参数（CI 在 ubuntu 上打包）
  const r = spawnSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', stage, name], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('tar failed')
  rmSync(stage, { recursive: true, force: true })
  const digest = sha256File(tarball)
  writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`)
  return { tarball, sha256: digest, manifest }
}

function arg(argv, flag) { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  try {
    const sumsDir = arg(argv, '--sums')
    if (sumsDir) {
      const body = sumsFor(sumsDir)
      if (!body) throw new Error(`${sumsDir} 下没有 lumo-server-*.tar.gz`)
      writeFileSync(join(sumsDir, 'SHA256SUMS'), body); process.stdout.write(body)
    } else {
      const tree = arg(argv, '--tree'), os = arg(argv, '--os'), arch = arg(argv, '--arch')
      if (!tree || !os || !arch) throw new Error('usage: pack-server.mjs --tree <dir> --os linux|darwin --arch x64|arm64 [--out dir]')
      const r = pack({ tree: resolve(tree), os, arch, out: arg(argv, '--out') ?? 'dist-server', version: arg(argv, '--version'), dshSha: arg(argv, '--dsh-sha'), dshTag: arg(argv, '--dsh-tag') })
      console.log(`bundle=${r.tarball}\nsha256=${r.sha256}`)
    }
  } catch (error) { console.error(`error=${error instanceof Error ? error.message : error}`); process.exit(1) }
}
