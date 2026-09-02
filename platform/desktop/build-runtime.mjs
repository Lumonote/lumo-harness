import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { arch as hostArch, platform as hostPlatform } from 'node:os'
import { createHash } from 'node:crypto'
import { overriddenPackageDirectories } from '../dsh-overrides/apply.mjs'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopRoot, '..', '..')
// CI and local product builds may project an already-modified developer
// checkout into a clean temporary commit. Accept that clean snapshot directly
// so the source checkout never needs to be renamed, linked, or edited.
const sourceDshRoot = process.env.LUMO_DSH_SOURCE_ROOT === undefined
  ? resolve(repoRoot, 'deepseek-harness')
  : resolve(process.env.LUMO_DSH_SOURCE_ROOT)
const dshRoot = resolve(repoRoot, 'platform', '.build', 'deepseek-harness')
prepareIsolatedDshRuntime()
const cliRoot = resolve(dshRoot, 'apps', 'cli')
const dshNodeRoot = resolve(repoRoot, 'platform', 'data-plane', 'dsh-node')
// 覆盖层改写过的包必须从快照里取，不能靠闭包遍历撞运气：遍历走的是 node_modules，
// 而快照的 node_modules 是软链回源树的，realpathSync 一解析就落回上游 packages/，
// 拿到的是没有 Lumo 插槽的那份产物。显式播种能抢在遍历之前把名字占住。
const overriddenPackageRoots = overriddenPackageDirectories.map((directory) => resolve(dshRoot, directory))
const lumoUiRoot = resolve(repoRoot, 'platform', 'dsh-plugins', 'lumo-ui')
const bundledSkillsRoot = resolve(repoRoot, 'platform', 'upstream', 'skills')
const bundledSkillSources = resolve(repoRoot, 'platform', 'upstream', 'skill-sources.json')
// ---- 构建目标 ----
// 桌面包按 target 选二进制（Node、Python），而不是「构建机上恰好有什么」。target 由
// build.sh 经 LUMO_DESKTOP_TARGET 传入（tauri 的 beforeBuildCommand 不接受参数），
// 也可直接 `node build-runtime.mjs --target darwin-x64`。默认宿主架构。
// 目前只发 macOS：keepOnly(..., 'darwin') 仍只保留 darwin 原生二进制；Windows/Linux
// 是独立移植（设计 §1），不是给这里加一个 target 名字。
const SUPPORTED_TARGETS = ['darwin-arm64', 'darwin-x64']
const buildTarget = resolveBuildTarget()
const targetArch = buildTarget.slice('darwin-'.length)
// lipo -archs 报 x86_64 而非 x64。
const targetLipoArch = targetArch === 'x64' ? 'x86_64' : 'arm64'
// 与 nodejs.org 发布文件名一致；LUMO_RUNTIME_NODE 钉死本地文件时不下载。
const RUNTIME_NODE_VERSION = process.env['LUMO_RUNTIME_NODE_VERSION'] ?? '24.19.0'
const nodeCacheRoot = resolve(repoRoot, 'platform', '.build', 'node')
// PPT venv 按 target 分目录：native wheel 决定了 x64 venv 只能在 x64 环境里建。
const pptVenvRoot = resolve(bundledSkillsRoot, 'ppt-master', `.venv-${buildTarget}`)
console.log(`桌面 runtime 构建目标：${buildTarget}（宿主 ${hostPlatform()}-${hostArch()}）`)
const stagingRoot = resolve(desktopRoot, 'target', 'lumo-runtime')
const modulesRoot = resolve(stagingRoot, 'node_modules')
const upstreamPluginRoot = resolve(desktopRoot, 'target', 'lumo-upstream-plugins')
const upstreamPluginModulesRoot = resolve(upstreamPluginRoot, 'node_modules')
const packagedTypeScriptPlugins = new Set(['@lumo/open-design', '@lumo/archify', '@lumo/creative-skills', '@lumo/ruflo-orchestration'])
// 裁剪规则见下方 pruneStagedRuntime；目录名单提前到常量区，避免顶层调用时撞上 TDZ。
const PRUNE_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github'])
// 这两个名字不会出现在可 require 的路径里，任意深度都可裁；其余只裁包根一层（见 pruneDeadWeight）。
const PRUNE_ANYWHERE_DIRECTORY_NAMES = new Set(['__tests__', '.github'])
const upstreamPluginSpecs = [
  'dshmarket@1.36.0',
  '@liustack/modlens@3.25.2',
  '@anweat/dsh-browser@0.1.10',
  'dsh-context@0.38.1',
  'dsh-cost-meter@1.6.7',
]

if (!existsSync(resolve(dshRoot, 'package.json'))) {
  throw new Error(`无法构建桌面 runtime：找不到 ${resolve(dshRoot, 'package.json')}`)
}

// The packaged app must not run pnpm or reach the registry on first launch.
// Resolve the upstream plugin packages once while building, then copy their
// complete production dependency closure into the app bundle below.
prepareUpstreamPlugins()

// Rebuild the resident DSH client packages first: their compiled clients are
// what Vite resolves from the workspace package exports, and they contain the
// homepage composer seats and sidebar navigation slot added for Lumo. The
// isolated snapshot contains source only, so emit lib/types before tsdown.
buildDshClientPackages()

// lumo-ui is bundled JavaScript (unlike the two small local server plugins
// compiled below). Build it before copying the package closure so a desktop
// bundle always receives the source UI that the user just edited.
buildLumoUiPlugin()

// Always rebuild the Web shell. The desktop artifact embeds the Vite bundle,
// so a cached dist/index.html would otherwise hide changes to the resident
// composer (including root-scoped homepage extension seats).
console.log('构建 DSH Web 前端资源（含创作与多智能体编排能力）...')
runWorkspaceBinary(join('apps', 'web'), 'vite', ['build'], 'DSH Web 前端构建失败')
runPlatformScript('brand-web.mjs', [dshRoot], 'DSH Web 品牌资源覆盖失败')

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(modulesRoot, { recursive: true })

const moduleSearchRoots = [
  cliRoot,
  dshRoot,
  dshNodeRoot,
  resolve(repoRoot, 'platform', 'dsh-plugins'),
  upstreamPluginRoot,
]
const packageSources = new Map()
const packageQueue = []

function readManifest(packageRoot) {
  return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
}

// dsh 自家的包（@deepseek-ai/*）只能来自本地 dsh 快照。上游 npm 插件（如 dsh-cost-meter）
// 会把 @deepseek-ai/dsh-credentials 之类声明成普通 dependency，pnpm 便从 registry 拉一份
// 老版本（0.1.0-rc.6，只导出 CredentialProvider/credentialRef）；闭包遍历若按“谁先声明谁赢”
// 从上游插件目录解析，这份残缺副本就会顶掉快照里的完整实现，运行时 dsh-credentials-local、
// dsh-llm-pi-ai、dsh-client-connection 全部 import 失败——这正是打包后“启动不完整”的元凶。
const DSH_PACKAGE_SCOPE = '@deepseek-ai/'

function isUnder(path, root) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 快照是 pnpm workspace，同级包只链接在各依赖方自己的 node_modules 下，根目录没有。
// 所以 @deepseek-ai/* 不靠 node_modules 逐级上溯，而是直接按 workspace 的“包名 → 目录”表解析。
// 目录范围与快照的 pnpm-workspace.yaml 保持一致（packages/*/*、apps/*、vendor/*）。
const dshWorkspacePackages = new Map()
for (const pattern of [['packages', '*', '*'], ['apps', '*'], ['vendor', '*']]) {
  const [head, ...rest] = pattern
  let roots = [resolve(dshRoot, head)]
  for (const _segment of rest) {
    roots = roots.flatMap((root) => existsSync(root) && statSync(root).isDirectory()
      ? readdirSync(root).map((entry) => join(root, entry)).filter((path) => statSync(path).isDirectory())
      : [])
  }
  for (const root of roots) {
    if (!existsSync(resolve(root, 'package.json'))) continue
    const name = readManifest(root).name
    if (typeof name === 'string' && !dshWorkspacePackages.has(name)) dshWorkspacePackages.set(name, realpathSync(root))
  }
}

function packagePath(name, fromRoot) {
  const parts = name.split('/')
  const candidates = []
  const alreadyQueued = packageSources.get(name)?.root
  if (alreadyQueued !== undefined) return alreadyQueued
  if (name.startsWith(DSH_PACKAGE_SCOPE)) {
    const workspaceRoot = dshWorkspacePackages.get(name)
    if (workspaceRoot !== undefined) return workspaceRoot
    // 不在 workspace 里的 @deepseek-ai 包（如 vendor 之外的发布件）仍可从快照根解析，
    // 但绝不从上游插件的安装目录取。
    if (fromRoot !== undefined && isUnder(fromRoot, upstreamPluginRoot)) fromRoot = undefined
  }
  const searchRoots = name.startsWith(DSH_PACKAGE_SCOPE)
    ? [fromRoot, cliRoot, dshRoot, dshNodeRoot]
    : [fromRoot, ...moduleSearchRoots]
  for (const root of searchRoots.filter((value) => value !== undefined)) {
    for (let cursor = root; ; cursor = dirname(cursor)) {
      candidates.push(resolve(cursor, 'node_modules', ...parts))
      const parent = dirname(cursor)
      if (parent === cursor) break
    }
  }
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'package.json'))) return realpathSync(candidate)
  }
  return undefined
}

function queuePackage(packageRoot) {
  const manifest = readManifest(packageRoot)
  if (typeof manifest.name !== 'string' || packageSources.has(manifest.name)) return
  packageSources.set(manifest.name, { root: packageRoot, manifest })
  packageQueue.push({ root: packageRoot, manifest })
}

function copyPackage(packageName, packageRoot) {
  const destination = resolve(modulesRoot, ...packageName.split('/'))
  cpSync(packageRoot, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      const rel = relative(packageRoot, source)
      if (rel === '') return true
      const first = rel.split(sep)[0]
      if (first === 'node_modules' || first === 'tests' || first === '__tests__' || first === '.git') return false
      return true
    },
  })
}

// The official CLI manifest keeps the Web bundle in devDependencies because
// the CLI can also be used headlessly. The desktop product needs both Web
// bundles explicitly, plus the SQLite backend and Lumo's local UI/skills.
for (const root of [
  cliRoot,
  packagePath('@deepseek-ai/dsh-base'),
  packagePath('@deepseek-ai/dsh-web-app'),
  ...overriddenPackageRoots,
  resolve(dshRoot, 'packages', 'storage', 'storage-sqlite'),
  lumoUiRoot,
  resolve(repoRoot, 'platform', 'dsh-plugins', 'open-design'),
  resolve(repoRoot, 'platform', 'dsh-plugins', 'archify'),
  resolve(repoRoot, 'platform', 'dsh-plugins', 'creative-skills'),
  resolve(repoRoot, 'platform', 'dsh-plugins', 'ruflo-orchestration'),
  ...upstreamPluginSpecs.map((spec) => packagePath(spec.slice(0, spec.lastIndexOf('@')), upstreamPluginRoot)),
]) {
  if (root === undefined || !existsSync(resolve(root, 'package.json'))) {
    throw new Error(`无法构建桌面 runtime：找不到依赖包 ${String(root)}`)
  }
  queuePackage(realpathSync(root))
}

for (let index = 0; index < packageQueue.length; index += 1) {
  const current = packageQueue[index]
  const dependencies = {
    ...current.manifest.dependencies,
    ...current.manifest.optionalDependencies,
    ...current.manifest.peerDependencies,
  }
  // bundleDependencies（npm 上也作 bundledDependencies）是打包进父包 tarball 里、
  // 不单独解析的依赖（如 @claude-flow/cli 的 codex/mcp/plugin-agent-federation）。
  // pnpm 不会为它们在 .pnpm 里建独立条目，闭包遍历把它当成必需依赖就会误判缺失。
  const bundled = new Set([
    ...(current.manifest.bundledDependencies ?? []),
    ...(current.manifest.bundleDependencies ?? []),
  ])
  for (const [name] of Object.entries(dependencies)) {
    if (bundled.has(name)) continue
    const root = packagePath(name, current.root)
    const optional = current.manifest.optionalDependencies?.[name] !== undefined
      || current.manifest.peerDependenciesMeta?.[name]?.optional === true
    if (root === undefined) {
      if (optional) continue
      throw new Error(`无法构建桌面 runtime：${current.manifest.name} 缺少依赖 ${name}`)
    }
    queuePackage(root)
  }
}

assertDshPackagesCameFromSnapshot()
for (const [name, packageInfo] of packageSources) copyPackage(name, packageInfo.root)
assertOverridesCameFromSnapshot()
compilePackagedTypeScriptPlugins()

if (!existsSync(bundledSkillSources)) throw new Error(`无法构建桌面 runtime：找不到 ${bundledSkillSources}`)
cpSync(bundledSkillsRoot, resolve(stagingRoot, 'skills'), {
  recursive: true,
  dereference: true,
  filter(source) {
    const rel = relative(bundledSkillsRoot, source)
    if (rel === '') return true
    return !rel.split(sep).some((part) => part === '.git' || part.startsWith('.venv') || part === '__pycache__')
  },
})
const pptPython = bundlePptPython()
const prunedBytes = pruneStagedRuntime()
assertTargetNativePayload()

const runtimeNode = resolve(stagingRoot, 'node')
const nodeSource = findPortableNode()
cpSync(nodeSource, runtimeNode)
chmodSync(runtimeNode, 0o755)
assertBinaryArchitecture(runtimeNode, '打包 Node')

const runtimeNodeSource = resolve(dshNodeRoot)
cpSync(runtimeNodeSource, resolve(stagingRoot, 'dsh-node'), {
  recursive: true,
  dereference: true,
  filter(source) {
    const rel = relative(runtimeNodeSource, source)
    if (rel === '') return true
    const first = rel.split(sep)[0]
    return first !== 'node_modules' && first !== 'tests' && first !== '__tests__'
  },
})

const launcherSource = resolve(desktopRoot, 'lumo-runtime.sh')
const launcherDestination = resolve(stagingRoot, 'lumo-runtime.sh')
cpSync(launcherSource, launcherDestination)
chmodSync(launcherDestination, 0o755)

writeFileSync(resolve(stagingRoot, 'runtime-manifest.json'), `${JSON.stringify({
  target: buildTarget,
  node: nodeVersion(nodeSource),
  nodeSource,
  packageCount: packageSources.size,
  python: pptPython,
  prunedBytes,
  entrypoint: 'lumo-runtime.sh',
  upstreamPlugins: upstreamPluginSpecs,
  bundledSkills: JSON.parse(readFileSync(bundledSkillSources, 'utf8')).skills,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`)

console.log(`桌面 runtime 已准备：${buildTarget}，${packageSources.size} 个包，Node ${nodeVersion(nodeSource)}，裁剪回收 ${(prunedBytes / 1024 / 1024).toFixed(0)} MB`)

// 构建后复查上游洁净度。暂存副本的 node_modules 是软链回源树的，pnpm 有可能顺着
// workspace 链接把编译产物写回 deepseek-harness/packages —— 那正是仓库里那批
// .js/.d.ts/.map 的来路。产物已经落盘才发现，好过打包发出去之后才发现。
runPlatformScript('assert-pristine.mjs', [sourceDshRoot], '构建把产物写回了上游源码树')

function bundlePptPython() {
  const venvPython = resolve(pptVenvRoot, 'bin', 'python')
  if (!existsSync(venvPython)) {
    throw new Error(`无法构建桌面 runtime：PPT Master Python 环境不存在（${pptVenvRoot}）。请先执行 platform/upstream/install-components.sh --target ${buildTarget}`)
  }
  const probe = spawnSync(venvPython, ['-c', [
    'import json, site, sys',
    'print(json.dumps({"base": sys.base_prefix, "version": f"{sys.version_info.major}.{sys.version_info.minor}", "site": site.getsitepackages()[0]}))',
  ].join('; ')], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(`无法读取 PPT Master Python 环境：${probe.stderr || probe.error?.message || '未知错误'}`)
  }
  const inspected = JSON.parse(probe.stdout.trim())
  const baseRoot = realpathSync(inspected.base)
  const sitePackages = realpathSync(inspected.site)
  const versionDirectory = `python${inspected.version}`
  const baseSitePackages = resolve(baseRoot, 'lib', versionDirectory, 'site-packages')
  const destination = resolve(stagingRoot, 'python')
  const portableExecutable = realpathSync(venvPython)
  if (!isPortableDarwinBinary(portableExecutable)) {
    throw new Error(`PPT Master Python 不是可重定位的 macOS 解释器：${portableExecutable}`)
  }
  assertBinaryArchitecture(portableExecutable, 'PPT Master Python')

  cpSync(baseRoot, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      const rel = relative(baseRoot, source)
      if (rel === '') return true
      if (isDanglingSymlink(source)) return false
      if (source === baseSitePackages || source.startsWith(`${baseSitePackages}${sep}`)) return false
      return !rel.split(sep).some((part) => part === '__pycache__')
    },
  })
  cpSync(sitePackages, resolve(destination, 'lib', versionDirectory, 'site-packages'), {
    recursive: true,
    dereference: true,
    filter(source) {
      if (isDanglingSymlink(source)) return false
      return !relative(sitePackages, source).split(sep).some((part) => part === '__pycache__')
    },
  })
  const runtimePython = resolve(destination, 'bin', 'python3')
  chmodSync(runtimePython, 0o755)
  const verify = spawnSync(runtimePython, ['-c', 'import pptx, yaml, fitz, flask; print("LUMO_PPT_IMPORTS_OK")'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONHOME: destination, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
  })
  // 认最后一行而不是整段 stdout：PyMuPDF 把 `fitz` 的弃用横幅打到 stdout 上（不是
  // stderr），逐字比对会把一次完全成功的导入判成失败，而且 stderr 是空的，报错信息
  // 也就什么都不剩。断言的是导入本身成功，不要把上游横幅算进来。
  const verified = (verify.stdout ?? '').trim().split('\n').at(-1)?.trim()
  if (verify.error !== undefined || verify.status !== 0 || verified !== 'LUMO_PPT_IMPORTS_OK') {
    const detail = verify.error?.message
      || [verify.stderr, verify.stdout].filter((value) => value?.trim()).join('\n').trim()
    throw new Error(`打包后的 PPT Master Python 不可用：${detail || '依赖导入失败'}`)
  }
  return { version: inspected.version, entrypoint: 'python/bin/python3', skill: 'ppt-master@5.1.0' }
}

// ---- 产物体积裁剪 ----
// 依赖闭包按“能跑”标准全量拷贝：npm 包自带的跨平台原生二进制、wasm 推理运行时、
// sourcemap、测试与文档目录对桌面产物全是死重（首版 1.7G 中约 400M）。只删宿主
// 运行时不可达的内容；新增规则前先确认该路径不会被 require/import 触达。
function pruneStagedRuntime() {
  let reclaimed = 0
  const removeTree = (path) => {
    if (!existsSync(path)) return
    reclaimed += treeSize(path)
    rmSync(path, { recursive: true, force: true })
  }
  const removeFile = (path) => {
    reclaimed += lstatSync(path).size
    rmSync(path, { force: true })
  }
  const targetOnnxBinding = join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', targetArch, 'onnxruntime_binding.node')
  const hasTargetOnnx = existsSync(targetOnnxBinding)
  // 1) 原生二进制只保留当前桌面架构。此前两种 darwin 架构一起打包，
  //    不仅浪费几十 MB，还可能让 x64 Node 误加载 arm64 ONNX 动态库。
  keepOnly(join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6', 'darwin'), (name) => name === targetArch, removeTree)
  keepOnly(join(modulesRoot, 'node-pty', 'prebuilds'), (name) => name === `darwin-${targetArch}`, removeTree)
  keepOnly(join(modulesRoot, '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep'), (name) => name === 'COPYING' || name === `${targetArch}-darwin`, removeTree)
  // 2) onnxruntime-web：目标架构的 native binding 可用时只留 JS 壳；缺失时保留
  //    WASM 作为 optional native 依赖的降级路径，不能因体积裁剪把 fallback 一并删掉。
  const onnxWebDist = join(modulesRoot, 'onnxruntime-web', 'dist')
  if (hasTargetOnnx && existsSync(onnxWebDist)) {
    for (const entry of readdirSync(onnxWebDist, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.wasm')) removeFile(join(onnxWebDist, entry.name))
    }
  } else if (!hasTargetOnnx && existsSync(onnxWebDist)) {
    console.warn(`Lumo: [WARN] onnxruntime-node 缺少 ${buildTarget} 原生 binding，保留 onnxruntime-web WASM fallback`)
  }
  // 3) 全树死重：sourcemap、测试/文档/示例目录。
  pruneDeadWeight(modulesRoot, removeTree, removeFile, { isPackageRoot: false })
  // 4) Python：密封运行时里用不到 pip/ensurepip/idle/turtle 和解释器自带的单元测试。
  const pythonLibRoot = resolve(stagingRoot, 'python', 'lib')
  if (existsSync(pythonLibRoot)) {
    for (const versionDirectory of readdirSync(pythonLibRoot)) {
      const stdlibRoot = join(pythonLibRoot, versionDirectory)
      for (const name of ['ensurepip', 'idlelib', 'test', 'turtledemo', 'turtle.py']) removeTree(join(stdlibRoot, name))
      const sitePackages = join(stdlibRoot, 'site-packages')
      removeTree(join(sitePackages, 'pip'))
      if (existsSync(sitePackages)) {
        for (const name of readdirSync(sitePackages)) {
          if (/^pip-.*\.dist-info$/.test(name)) removeTree(join(sitePackages, name))
        }
        pruneDeadWeight(sitePackages, removeTree, removeFile, { scope: 'anywhere' })
      }
    }
  }
  return reclaimed
}

function keepOnly(directory, keep, removeTree) {
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (!keep(name)) removeTree(join(directory, name))
  }
}

// 测试/文档/示例目录只在“包根目录”这一层裁：dist/lib 里同名目录往往是真代码——
// yaml/dist/doc 是 Document 实现（被 compose/composer.js require），agentic-flow、fastmcp
// 的 dist/examples 也会被同包引用。之前全树裁剪把 yaml/dist/doc 删掉，直接让
// @deepseek-ai/dsh-settings-file 在启动时报 Cannot find module '../doc/directives.js'。
// 包根的判定：该目录自带 package.json（npm 包）或它就是扫描起点（python site-packages）。
// `scope`：'package-root' 用于 node_modules；'anywhere' 用于 Python site-packages——
// Python 包没有 package.json 可判包根，而其 tests 目录从不被 import，沿用全树裁剪。
function pruneDeadWeight(directory, removeTree, removeFile, { scope = 'package-root', isPackageRoot = true } = {}) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const prunable = PRUNE_ANYWHERE_DIRECTORY_NAMES.has(entry.name)
        || ((scope === 'anywhere' || isPackageRoot) && PRUNE_DIRECTORY_NAMES.has(entry.name))
      if (prunable) removeTree(path)
      else pruneDeadWeight(path, removeTree, removeFile, { scope, isPackageRoot: existsSync(join(path, 'package.json')) })
    } else if (entry.isFile() && (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts') || entry.name.endsWith('.d.mts') || entry.name.endsWith('.tsbuildinfo'))) {
      removeFile(path)
    }
  }
}

function assertTargetNativePayload() {
  const onnxRoot = join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6', 'darwin')
  if (existsSync(onnxRoot)) {
    const entries = readdirSync(onnxRoot)
    if (!entries.includes(targetArch)) {
      console.warn(`Lumo: [WARN] onnxruntime-node 缺少目标架构 ${targetArch}，继续构建并禁用原生推理`)
    }
    if (entries.some((name) => name !== targetArch)) {
      throw new Error(`无法构建桌面 runtime：onnxruntime-node 仍包含非目标架构：${entries.join(', ')}`)
    }
  }
  const ptyRoot = join(modulesRoot, 'node-pty', 'prebuilds')
  if (existsSync(ptyRoot)) {
    const expected = `darwin-${targetArch}`
    const entries = readdirSync(ptyRoot)
    if (!entries.includes(expected)) {
      console.warn(`Lumo: [WARN] node-pty 缺少目标架构 ${expected}，继续构建并禁用 PTY 能力`)
    }
    if (entries.some((name) => name !== expected)) {
      throw new Error(`无法构建桌面 runtime：node-pty 仍包含非目标架构：${entries.join(', ')}`)
    }
  }
}

function treeSize(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += treeSize(join(path, entry.name))
  }
  return total
}

// 覆盖层生效与否只有构建时能查：产物拷完立刻比对来源，落回上游源码树就当场失败。
// 这类回归不会报错，只会安静地发出一个少了 Lumo 插槽的 app。
function assertOverridesCameFromSnapshot() {
  for (const packageRoot of overriddenPackageRoots) {
    const name = readManifest(packageRoot).name
    const used = packageSources.get(name)?.root
    if (used !== packageRoot) {
      throw new Error(`无法构建桌面 runtime：${name} 取自 ${String(used)}，而非覆盖后的快照 ${packageRoot}`)
    }
  }
}

// 与上面同类的护栏：任何 @deepseek-ai/* 包若取自上游插件的 pnpm 安装目录，就是 registry
// 上的陈旧副本混进了闭包。这种回归同样不会在构建期报错，只会发出一个启动到一半就崩的 app。
function assertDshPackagesCameFromSnapshot() {
  const strayPackages = [...packageSources]
    .filter(([name, info]) => name.startsWith(DSH_PACKAGE_SCOPE) && isUnder(info.root, upstreamPluginRoot))
    .map(([name, info]) => `${name} ← ${info.root}`)
  if (strayPackages.length > 0) {
    throw new Error(`无法构建桌面 runtime：以下 dsh 包取自上游插件安装目录而非 dsh 快照：\n  ${strayPackages.join('\n  ')}`)
  }
}

// `dereference: true` materialises a symlink's target, so one dangling link
// aborts the entire copy. The Python prefix Lumo bundles ships three of them
// (lib/pkgconfig/python3{,-embed}.pc and share/man/man1/python3.1 point into
// the deleted temp dir the interpreter was unpacked in) — build metadata the
// packaged interpreter never reads. Drop dangling links instead of failing.
function isDanglingSymlink(source) {
  return lstatSync(source).isSymbolicLink() && !existsSync(source)
}

function hasNonSystemDarwinDependency(output) {
  return output.split('\n').some((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('/')) return false
    const dependency = trimmed.split(' ')[0]
    if (dependency.endsWith(':')) return false
    return !dependency.startsWith('/usr/lib/')
      && !dependency.startsWith('/System/Library/')
      && !dependency.startsWith('/Library/Apple/')
  })
}

function compilePackagedTypeScriptPlugins() {
  const requireFromDsh = createRequire(resolve(dshRoot, 'package.json'))
  const typescript = requireFromDsh('typescript')

  for (const packageName of packagedTypeScriptPlugins) {
    const packageInfo = packageSources.get(packageName)
    if (packageInfo === undefined) throw new Error(`无法构建桌面 runtime：${packageName} 未进入依赖闭包`)

    const sourcePath = resolve(packageInfo.root, 'src', 'index.ts')
    const destination = resolve(modulesRoot, ...packageName.split('/'))
    const outputPath = resolve(destination, 'lib', 'index.js')
    const source = readFileSync(sourcePath, 'utf8')
    const result = typescript.transpileModule(source, {
      compilerOptions: {
        module: typescript.ModuleKind.ESNext,
        target: typescript.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
      fileName: sourcePath,
    })

    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, result.outputText)

    const manifestPath = resolve(destination, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.main = './lib/index.js'
    if (manifest.exports?.['.'] !== undefined && typeof manifest.exports['.'] === 'object') {
      manifest.exports['.'] = {
        ...manifest.exports['.'],
        import: './lib/index.js',
        default: './lib/index.js',
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

function prepareUpstreamPlugins() {
  const packageNames = upstreamPluginSpecs.map((spec) => spec.slice(0, spec.lastIndexOf('@')))
  const ready = packageNames.every((name) => existsSync(resolve(upstreamPluginModulesRoot, ...name.split('/'), 'package.json')))
  if (ready) return

  rmSync(upstreamPluginRoot, { recursive: true, force: true })
  mkdirSync(upstreamPluginRoot, { recursive: true })
  writeFileSync(resolve(upstreamPluginRoot, 'package.json'), `${JSON.stringify({
    name: 'lumo-desktop-upstream-plugins',
    private: true,
    packageManager: 'pnpm@11.7.0',
    dependencies: Object.fromEntries(upstreamPluginSpecs.map((spec) => {
      const at = spec.lastIndexOf('@')
      return [spec.slice(0, at), spec.slice(at + 1)]
    })),
  }, null, 2)}\n`)
  console.log('准备桌面基础插件（市场 / 视觉 / 浏览器 / 上下文 / 费用）...')
  // --ignore-workspace：这个目录位于 platform/desktop/target 下，pnpm 会一路向上找到
  // platform/pnpm-workspace.yaml，转而安装整个平台工作区，插件一个都装不进来。
  // --config.auto-install-peers=false：几个上游插件把 @deepseek-ai/* 声明为 peer，交集
  // 出来的范围（>=0.1.1 <0.2.0）匹配不上只有预发布号的 dsh-settings。这些 peer 本就该由
  // 下面的闭包遍历从本地 dsh 快照解析——从 registry 再装一份会让包里出现两套 dsh。
  const result = spawnSync('corepack', [
    'pnpm', 'install', '--prod', '--ignore-scripts', '--no-frozen-lockfile',
    '--ignore-workspace', '--config.auto-install-peers=false',
  ], {
    cwd: upstreamPluginRoot,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`桌面基础插件安装失败：${String(result.status ?? result.signal)}`)
}

function buildLumoUiPlugin() {
  const tsc = resolve(dshRoot, 'node_modules', '.bin', 'tsc')
  const tsdown = resolve(dshRoot, 'node_modules', '.bin', 'tsdown')
  for (const [command, args] of [
    [tsc, ['-p', 'tsconfig.json']],
    [tsdown, ['--config', 'tsdown.config.ts']],
  ]) {
    const result = spawnSync(command, args, { cwd: lumoUiRoot, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`Lumo UI 构建失败：${String(result.status ?? result.signal)}`)
  }
}

function buildDshClientPackages() {
  console.log('构建 DSH conversation / sidebar 客户端包...')
  const tsc = resolve(dshRoot, 'node_modules', '.bin', 'tsc')
  const typecheck = spawnSync(tsc, [
    '-b',
    'packages/client/ui-conversation/tsconfig.json',
    'packages/client/ui-sidebar/tsconfig.json',
    '--pretty', 'false',
  ], {
    cwd: dshRoot,
    stdio: 'inherit',
  })
  if (typecheck.error !== undefined) throw typecheck.error
  if (typecheck.status !== 0) throw new Error(`DSH 客户端类型产物构建失败：${String(typecheck.status ?? typecheck.signal)}`)

  for (const packageDirectory of [
    join('packages', 'client', 'ui-conversation'),
    join('packages', 'client', 'ui-sidebar'),
  ]) {
    runWorkspaceBinary(packageDirectory, 'tsdown', [], `${packageDirectory} 客户端包构建失败`)
  }
}

// 快照里的每个 node_modules 都是软链回源树的同一份目录，所以绝不能在快照里跑
// `pnpm run` —— pnpm 会顺着链接把源树的 workspace 链接重写成指向快照，而快照只有
// src/、没有构建好的 lib/，下一次 Vite 解析 experimental/webworker-runtime/worker
// 就崩。直调二进制既跳过了这层重链，也跳过了 registry。
function runWorkspaceBinary(packageDirectory, binaryName, args, failureMessage) {
  const cwd = resolve(dshRoot, packageDirectory)
  const candidates = [
    resolve(cwd, 'node_modules', '.bin', binaryName),
    resolve(dshRoot, 'node_modules', '.bin', binaryName),
  ]
  const binary = candidates.find((candidate) => existsSync(candidate))
  if (binary === undefined) {
    throw new Error(`${failureMessage}：在 ${candidates.join(' 与 ')} 都找不到 ${binaryName}`)
  }
  const result = spawnSync(binary, args, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${failureMessage}：${String(result.status ?? result.signal)}`)
}

function runPlatformScript(name, args, failureMessage) {
  const script = resolve(repoRoot, 'platform', 'dsh-overrides', name)
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${failureMessage}：${String(result.status ?? result.signal)}`)
}

function prepareIsolatedDshRuntime() {
  if (!existsSync(resolve(sourceDshRoot, 'package.json'))) {
    throw new Error(`无法构建桌面 runtime：找不到 ${resolve(sourceDshRoot, 'package.json')}`)
  }
  runPlatformScript('prepare-runtime.mjs', [sourceDshRoot, dshRoot], 'DSH 隔离运行时准备失败')
}

function nodeVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`无法读取 Node 版本：${binary}`)
  }
  return result.stdout.trim()
}

function resolveBuildTarget() {
  const flagIndex = process.argv.indexOf('--target')
  const fromFlag = flagIndex === -1 ? undefined : process.argv[flagIndex + 1]
  const fromArg = process.argv.find((value) => value.startsWith('--target='))?.slice('--target='.length)
  const requested = fromFlag ?? fromArg ?? process.env['LUMO_DESKTOP_TARGET']
  if (requested === undefined) {
    if (hostPlatform() !== 'darwin') {
      throw new Error(`桌面 runtime 只能在 macOS 上构建（当前宿主 ${hostPlatform()}）；Windows/Linux 见设计 §1 的移植清单`)
    }
    return `darwin-${hostArch() === 'arm64' ? 'arm64' : 'x64'}`
  }
  if (!SUPPORTED_TARGETS.includes(requested)) {
    throw new Error(`不支持的桌面构建目标：${requested}（可用：${SUPPORTED_TARGETS.join(', ')}）`)
  }
  return requested
}

function findPortableNode() {
  const pinned = process.env['LUMO_RUNTIME_NODE']
  if (pinned !== undefined) {
    // 钉死语义：设了就必须可用。静默回退到别的解释器等于没钉，版本照样漂。
    if (!existsSync(pinned)) {
      throw new Error(`LUMO_RUNTIME_NODE 指向的 Node 不存在：${pinned}`)
    }
    if (!isPortableDarwinBinary(pinned)) {
      throw new Error(`LUMO_RUNTIME_NODE 指向的 Node 不是自包含的 macOS 可执行文件：${pinned}`)
    }
    assertBinaryArchitecture(pinned, 'LUMO_RUNTIME_NODE')
    console.log(`打包 Node：${pinned}（LUMO_RUNTIME_NODE 钉死，${nodeVersion(pinned)}）`)
    return pinned
  }
  // 默认按 target 从 nodejs.org 下载官方 tarball：构建机上装了什么 Node 不再影响产物，
  // 也是 darwin-x64 能在 M 芯片 CI 之外产出的唯一途径（以前扫 nvm 只能拿到宿主架构）。
  const downloaded = downloadOfficialNode(RUNTIME_NODE_VERSION, buildTarget)
  if (!isPortableDarwinBinary(downloaded)) {
    throw new Error(`下载的官方 Node 不是自包含的 macOS 可执行文件：${downloaded}`)
  }
  assertBinaryArchitecture(downloaded, '官方 Node')
  console.log(`打包 Node：${downloaded}（nodejs.org v${RUNTIME_NODE_VERSION} ${buildTarget}）`)
  return downloaded
}

// 缓存到 platform/.build/node/<version>-<target>/node；tarball 经 SHASUMS256.txt 校验。
function downloadOfficialNode(version, target) {
  const cacheDirectory = resolve(nodeCacheRoot, `${version}-${target}`)
  const cached = resolve(cacheDirectory, 'node')
  if (existsSync(cached)) return cached
  const mirror = (process.env['LUMO_NODE_DIST_MIRROR'] ?? 'https://nodejs.org/dist').replace(/\/+$/, '')
  const tarballName = `node-v${version}-${target}.tar.gz`
  mkdirSync(cacheDirectory, { recursive: true })
  const tarball = resolve(cacheDirectory, tarballName)
  const shasums = resolve(cacheDirectory, 'SHASUMS256.txt')
  console.log(`下载官方 Node：${mirror}/v${version}/${tarballName}`)
  curl(`${mirror}/v${version}/${tarballName}`, tarball)
  curl(`${mirror}/v${version}/SHASUMS256.txt`, shasums)
  const expected = readFileSync(shasums, 'utf8').split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === tarballName)?.[0]
  if (expected === undefined) throw new Error(`SHASUMS256.txt 里没有 ${tarballName}`)
  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  if (actual !== expected) {
    rmSync(tarball, { force: true })
    throw new Error(`官方 Node tarball 校验失败：${tarballName} 期望 ${expected} 实际 ${actual}`)
  }
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', cacheDirectory, '--strip-components', '2', `node-v${version}-${target}/bin/node`], { encoding: 'utf8' })
  if (extract.error !== undefined || extract.status !== 0 || !existsSync(cached)) {
    throw new Error(`解压官方 Node 失败：${extract.stderr || extract.error?.message || tarballName}`)
  }
  chmodSync(cached, 0o755)
  rmSync(tarball, { force: true })
  return cached
}

function curl(url, destination) {
  const result = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', destination, url], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`下载失败：${url}\n${result.stderr || result.error?.message || ''}`.trim())
  }
}

function isPortableDarwinBinary(candidate) {
  const inspect = spawnSync('/usr/bin/otool', ['-L', candidate], { encoding: 'utf8' })
  if (inspect.status !== 0 || inspect.error !== undefined) return false
  return !hasNonSystemDarwinDependency(inspect.stdout)
}

// 双架构支持的关键闸门：没有它，在 M 上构建 darwin-x64 会产出一个内含 arm64 Node 的
// 「x64 包」——打包成功、能分发、在 Intel 上直接起不来，且错误信息不指向架构。
function assertBinaryArchitecture(binary, label) {
  const inspect = spawnSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' })
  if (inspect.error !== undefined || inspect.status !== 0) {
    throw new Error(`无法读取 ${label} 的架构（lipo -archs）：${binary}\n${inspect.stderr ?? ''}`.trim())
  }
  const archs = inspect.stdout.trim().split(/\s+/).filter(Boolean)
  if (!archs.includes(targetLipoArch)) {
    throw new Error(`${label} 架构为 [${archs.join(' ')}]，与构建目标 ${buildTarget}（${targetLipoArch}）不符：${binary}`)
  }
}
