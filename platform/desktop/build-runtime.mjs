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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { arch as hostArch, platform as hostPlatform } from 'node:os'
import { createHash } from 'node:crypto'
import { overriddenPackageDirectories } from '../dsh-overrides/apply.mjs'
import { resolveWorkspaceNodeTool } from './node-tools.mjs'
import { dshClientTypeConfigs, hasUsableDshClientTypes } from './dsh-client-types.mjs'
import { prepareSkillHubArchive, stageSkillHub } from './skillhub-tooling.mjs'
import { acquireBuildLock } from './build-lock.mjs'
import { findCrossTreeImports } from './dsh-node-self-contained.mjs'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopRoot, '..', '..')
// Snapshot preparation, compilation and runtime staging share output paths.
// Hold the lock for the entire process, including failure cleanup.
acquireBuildLock(resolve(repoRoot, 'platform', '.build', 'desktop-runtime.lock'))
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
const knowledgeVaultRoot = resolve(repoRoot, 'platform', 'dsh-plugins', 'knowledge-vault')
const bundledSkillsRoot = resolve(repoRoot, 'platform', 'upstream', 'skills')
const bundledSkillSources = resolve(repoRoot, 'platform', 'upstream', 'skill-sources.json')
// ---- 构建目标 ----
// 桌面包按 target 选二进制（Node、Python），而不是「构建机上恰好有什么」。target 由
// build.sh 经 LUMO_DESKTOP_TARGET 传入（tauri 的 beforeBuildCommand 不接受参数），
// 也可直接 `node build-runtime.mjs --target win-x64`。默认宿主平台与架构。
const SUPPORTED_TARGETS = ['darwin-arm64', 'darwin-x64', 'win-x64']
const buildTarget = resolveBuildTarget()
const targetPlatform = buildTarget.startsWith('win-') ? 'win32' : 'darwin'
const targetArch = buildTarget.slice(targetPlatform === 'win32' ? 'win-'.length : 'darwin-'.length)
const targetNativePty = targetPlatform === 'win32' ? `win32-${targetArch}` : `darwin-${targetArch}`
const targetNativeRipgrep = targetPlatform === 'win32' ? `${targetArch}-win32` : `${targetArch}-darwin`
// lipo -archs 报 x86_64 而非 x64；Windows 目标只有官方 x64 Node。
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
const packagedTypeScriptPlugins = new Set(['@lumo/open-design', '@lumo/archify', '@lumo/creative-skills', '@lumo/ruflo-orchestration', '@lumo/web-fetch-fakeip'])
// RuVector's current published manifest still lists MetaHarness packages in
// `dependencies`, although the integration is intentionally removable and all
// call sites degrade when the packages are absent. pnpm may therefore omit
// these packages after an optional dependency branch fails on a clean host.
// Keep them when present, but do not make the desktop bundle depend on them.
const gracefullyOptionalDependencyPrefixes = ['@metaharness/']
const gracefullyOptionalDependencyNames = new Set(['metaharness'])
// 裁剪规则见下方 pruneStagedRuntime；目录名单提前到常量区，避免顶层调用时撞上 TDZ。
const PRUNE_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github'])
// 这两个名字不会出现在可 require 的路径里，任意深度都可裁；其余只裁包根一层（见 pruneDeadWeight）。
const PRUNE_ANYWHERE_DIRECTORY_NAMES = new Set(['__tests__', '.github'])
const upstreamPluginSpecs = [
  'dshmarket@1.41.0',
  '@liustack/modlens@3.25.2',
  'dsh-context@0.41.3',
  'dsh-cost-meter@1.6.7',
  // Dream Skin：桌面换肤/主题插件（8 套 iOS / Linear 式清透冷调主题 + 弥散光壁纸 +
  // 每用户强调色）。纯原生 --dsw-* token 实现，经其 cordis.patch.yml 在 Web 壳激活。
  'dsh-dream-skin@8.30.1',
  // 任务看板：dsh web GUI 的 Host 权威任务台帐（替换 Lumo 左侧菜单「自动化」入口）。
  '@linxin666/dsh-client-ui-task-board@0.3.14',
  // @nanmicoder/dsh-agent-teams 不在桌面包基线（master 不兼容）；仍可通过 SkillHub 安装。
  // Univer 办公文档：DSH × Univer 协作网关与查看器——内联预览、浮动工作台与会话结束审阅（0.2.14）。
  'dsh-univer-office@0.2.14',
  // 版本漂移纪律：与 dsh-node/src/plugins.ts 的 BASE_PROFILE_PLUGINS 保持一致。
  // 两个提升是 dsh-settings 0.1.2 移除旧 API 的直接后果（installSettingsSection /
  // settingsNamespace），@anweat/dsh-browser 因无适配新版而退出基线，见其注释。
]

if (!existsSync(resolve(dshRoot, 'package.json'))) {
  throw new Error(`无法构建桌面 runtime：找不到 ${resolve(dshRoot, 'package.json')}`)
}

// The host half is compiled before the package-closure walk below. A partially
// linked upstream workspace therefore used to fail inside stream-server.ts
// with a misleading chain of TS2307/implicit-any diagnostics (most commonly
// after an interrupted cross-architecture pnpm install). Keep this small
// preflight before buildDshHostPackages so direct `cargo tauri build` invocations
// repair the same state that build.sh's install-components step repairs.
const dshHostDependencyProbes = [
  ['.', 'typescript', 'TypeScript'],
  ['packages/api/gateway', 'ws', 'ws'],
  ['packages/api/gateway', '@types/ws', '@types/ws'],
  ['packages/util/chunked-list', 'zod', 'zod'],
  ['packages/settings/settings-file', 'chokidar', 'chokidar'],
]

function findDshPackageManifest(relativeRoot, name) {
  const parts = name.split('/')
  for (let cursor = resolve(sourceDshRoot, relativeRoot); ; cursor = dirname(cursor)) {
    const candidate = resolve(cursor, 'node_modules', ...parts, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(cursor)
    if (parent === cursor) break
  }
  return undefined
}

function restoreDshPackageLink(relativeRoot, name) {
  const parts = name.split('/')
  const target = resolve(sourceDshRoot, relativeRoot, 'node_modules', ...parts)
  if (existsSync(resolve(target, 'package.json'))) return true
  const virtualStoreLink = resolve(sourceDshRoot, 'node_modules', '.pnpm', 'node_modules', ...parts)
  if (!existsSync(resolve(virtualStoreLink, 'package.json'))) return false

  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  const linkTarget = process.platform === 'win32'
    ? virtualStoreLink
    : relative(dirname(target), virtualStoreLink)
  symlinkSync(linkTarget, target, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

function ensureDshHostDependencies() {
  let missing = dshHostDependencyProbes
    .filter(([relativeRoot, name]) => findDshPackageManifest(relativeRoot, name) === undefined)
  if (missing.length === 0) return

  // pnpm's virtual store can survive while one workspace-level link is lost.
  // Restore that single link directly before invoking a full install.
  missing = missing.filter(([relativeRoot, name]) => !restoreDshPackageLink(relativeRoot, name))
  if (missing.length === 0) return

  repairWorkspaceDependencies(
    sourceDshRoot,
    missing.map(([, , label]) => label).join(', '),
    missing.map(([relativeRoot, name]) => join(relativeRoot, 'node_modules', ...name.split('/'))),
  )
  for (const [relativeRoot, name] of missing) restoreDshPackageLink(relativeRoot, name)
  const stillMissing = missing
    .filter(([relativeRoot, name]) => findDshPackageManifest(relativeRoot, name) === undefined)
  if (stillMissing.length > 0) {
    throw new Error(`无法构建桌面 runtime：重装 DSH 依赖后仍缺少 ${stillMissing.map(([, , label]) => label).join(', ')}`)
  }
}

// The packaged app must not run pnpm or reach the registry on first launch.
// Resolve the upstream plugin packages once while building, then copy their
// complete production dependency closure into the app bundle below.
const skillhubArchive = prepareSkillHubArchive(resolve(repoRoot, 'platform', '.build', 'skillhub'))
prepareUpstreamPlugins()
ensureDshHostDependencies()

// Overridden packages have no projected lib/. Emit each face before tsdown
// consumes it, including API packages with separate Host and Client programs.
buildDshHostPackages()
rebuildDshHostArtifacts()
// 快照对被覆盖的客户端包不投影 lib/（其产物必须从打补丁后的
// 快照源码重建），而它们的 tsdown 配置又消费 lib/types —— 全量 client pass 之前
// 必须先 tsc 出这些包的类型，否则 UNRESOLVED_ENTRY lib/types/index.js。
refreshDshClientTypePrerequisites()
buildDshClientPackages()
rebuildDshClientArtifacts()

// lumo-ui is bundled JavaScript (unlike the two small local server plugins
// compiled below). Build it before copying the package closure so a desktop
// bundle always receives the source UI that the user just edited.
buildLumoUiPlugin()
// knowledge-vault 在 src 里跨包 import 了 ../knowledge/src/consumer.ts，transpileModule
// 单文件语义搬不动它——用 tsdown 打成单入口 bundle（两个 src 目录都进图）。
buildKnowledgeVaultPlugin()

// Always rebuild the Web shell. The desktop artifact embeds the Vite bundle,
// so a cached dist/index.html would otherwise hide changes to the resident
// composer (including root-scoped homepage extension seats).
console.log('构建 DSH Web 前端资源（含创作与多智能体编排能力）...')
runWorkspaceBinary(join('apps', 'web'), 'vite', ['build'], 'DSH Web 前端构建失败')
runPlatformScript('brand-web.mjs', [dshRoot], 'DSH Web 品牌资源覆盖失败')

// The build lock excludes competing writers; retry transient filesystem errors.
rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 })
mkdirSync(modulesRoot, { recursive: true })

const moduleSearchRoots = [
  cliRoot,
  dshRoot,
  dshNodeRoot,
  resolve(repoRoot, 'platform', 'dsh-plugins'),
  upstreamPluginRoot,
  // Web 扩展插件把 react/react-dom 声明为必选 peer（
  // @linxin666/dsh-client-ui-task-board；dsh-context/dsh-dream-skin 的 react 是可选的，
  // 不被遍历点名）。这两个包在 Web 壳里只出现在 devDependencies（Vite 就地编译进前端
  // bundle），闭包遍历不读 devDependencies，向上回溯也到不了 apps/web 的 node_modules
  // （兄弟包）——react 因此只能撞上 lumo-ui 的 link: 依赖（指向源树 ui-jobs 的副本），
  // react-dom 则完全落空。把 Web 壳挂进搜索根，两包都能以壳内实例（apps/web/node_modules
  // 软链 → .pnpm 存储）解析，与壳渲染同源；react 在 link: 目标可用时仍走已入队副本，
  // 版本与壳一致（18.3.1）。
  resolve(dshRoot, 'apps', 'web'),
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

function isGracefullyOptionalDependency(name) {
  return gracefullyOptionalDependencyNames.has(name)
    || gracefullyOptionalDependencyPrefixes.some((prefix) => name.startsWith(prefix))
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
  resolve(repoRoot, 'platform', 'dsh-plugins', 'web-fetch-fakeip'),
  knowledgeVaultRoot,
  ...upstreamPluginSpecs.map((spec) => packagePath(spec.slice(0, spec.lastIndexOf('@')), upstreamPluginRoot)),
]) {
  if (root === undefined || !existsSync(resolve(root, 'package.json'))) {
    throw new Error(`无法构建桌面 runtime：找不到依赖包 ${String(root)}`)
  }
  queuePackage(realpathSync(root))
}

// pnpm 判定「已是最新」只看 node_modules 下的状态文件，不校验文件是否还在磁盘上：
// 被删掉或中断安装留下的空洞，`pnpm install --frozen-lockfile`（连 `--force` 一起）
// 都报 "Already up to date" 而不修复——pnpm 11.7.0 实测。要让它重建，得同时清掉虚拟
// 存储锁 .pnpm/lock.yaml 与工作区状态 .pnpm-workspace-state-v1.json（单包项目只需前者，
// 工作区少了后者照样走 fast path）。.modules.yaml 保留：它记着 nodeLinker / hoist 等
// 安装期设置，删掉会按默认值重新布局。换台机器打包正是靠它自愈，因此只在闭包确实
// 解析不到依赖时才付这份代价，健康机器上零成本。
const repairedWorkspaces = new Set()

// 缺失的依赖归属哪个工作区。快照目录在 platform/ 之下，必须先于 platform 判定并映射回
// 源树：往快照里跑 pnpm 会把源树的 workspace 链接重写成指向快照（见 runWorkspaceBinary
// 的说明）。上游插件目录有自己的 prepareUpstreamPlugins（--ignore-workspace --prod），
// 不走这条通用修复。
function workspaceRootOwning(packageRoot) {
  if (isUnder(packageRoot, upstreamPluginRoot)) return undefined
  if (isUnder(packageRoot, dshRoot)) return sourceDshRoot
  if (isUnder(packageRoot, sourceDshRoot)) return sourceDshRoot
  if (isUnder(packageRoot, resolve(repoRoot, 'platform'))) return resolve(repoRoot, 'platform')
  return undefined
}

function repairWorkspaceDependencies(root, missingName, staleDependencyPaths = []) {
  console.warn(`Lumo: [WARN] 缺少 ${missingName}，重装 ${relative(repoRoot, root)} 的依赖后重试...`)
  // pnpm may consider the workspace up to date while a package-level link is
  // missing. Remove only the links reported by the preflight; do not remove
  // the whole virtual store (or use --force, which fetches every optional
  // dependency for every platform).
  for (const staleDependencyPath of staleDependencyPaths) {
    rmSync(resolve(root, staleDependencyPath), { recursive: true, force: true })
  }
  for (const stateFile of ['node_modules/.pnpm/lock.yaml', 'node_modules/.pnpm-workspace-state-v1.json']) {
    rmSync(resolve(root, stateFile), { force: true })
  }
  const result = spawnExecutable(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', [
    'pnpm', 'install', '--frozen-lockfile', '--trust-lockfile', '--prod=false', '--config.confirmModulesPurge=false',
  ], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`无法构建桌面 runtime：重装 ${root} 依赖失败（${String(result.status ?? result.signal)}）`)
  }
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
      || isGracefullyOptionalDependency(name)
    if (root === undefined) {
      if (optional) continue
      // 换台机器（或依赖被裁过）时闭包会撞上缺包：先按工作区自愈一次，再判失败。
      const owner = workspaceRootOwning(current.root)
      if (owner !== undefined && !repairedWorkspaces.has(owner)) {
        repairedWorkspaces.add(owner)
        repairWorkspaceDependencies(owner, name)
        const repaired = packagePath(name, current.root)
        if (repaired !== undefined) {
          queuePackage(repaired)
          continue
        }
      }
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

const runtimeNode = resolve(stagingRoot, targetPlatform === 'win32' ? 'node.exe' : 'node')
const nodeSource = findPortableNode()
cpSync(nodeSource, runtimeNode)
if (targetPlatform !== 'win32') chmodSync(runtimeNode, 0o755)
assertBinaryArchitecture(runtimeNode, '打包 Node')
// 把随 Node 发行的 corepack/npm 与 pnpm shim 塞进 runtime，并落到 PATH——否则打包后插件市场
// 更新插件时会报“未找到 pnpm/corepack/npx”（见 stageNodeTooling 与 lumo-runtime.sh）。
stageNodeTooling(nodeSource, resolve(stagingRoot, 'bin'), resolve(stagingRoot, 'lib', 'node_modules'))
// Both launchers export bin/skillhub.mjs. Ship the actual CLI and check it using
// the final, pruned Python runtime before Tauri is allowed to bundle resources.
const skillhub = stageSkillHub(stagingRoot, skillhubArchive, targetPlatform)

const runtimeNodeSource = resolve(dshNodeRoot)
assertDshNodeSelfContained()
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

const launcherName = targetPlatform === 'win32' ? 'lumo-runtime.cmd' : 'lumo-runtime.sh'
const launcherSource = resolve(desktopRoot, launcherName)
const launcherDestination = resolve(stagingRoot, launcherName)
cpSync(launcherSource, launcherDestination)
if (targetPlatform !== 'win32') chmodSync(launcherDestination, 0o755)

writeFileSync(resolve(stagingRoot, 'runtime-manifest.json'), `${JSON.stringify({
  target: buildTarget,
  node: nodeVersion(nodeSource),
  nodeSource,
  packageCount: packageSources.size,
  python: pptPython,
  skillhub,
  prunedBytes,
  entrypoint: launcherName,
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
  const windows = targetPlatform === 'win32'
  const venvPython = windows
    ? resolve(pptVenvRoot, 'Scripts', 'python.exe')
    : resolve(pptVenvRoot, 'bin', 'python')
  if (!existsSync(venvPython)) {
    throw new Error(`无法构建桌面 runtime：PPT Master Python 环境不存在（${pptVenvRoot}）。请先执行 platform/upstream/install-components.sh --target ${buildTarget}`)
  }
  const probe = spawnSync(venvPython, ['-c', [
    'import json, pathlib, site, sys',
    // Windows returns the venv prefix itself as getsitepackages()[0]; select
    // the actual site-packages directory on every platform.
    'paths = site.getsitepackages()',
    'site_packages = next((path for path in paths if pathlib.Path(path).name.lower() == "site-packages"), None)',
    'assert site_packages is not None, "site-packages not found: " + repr(paths)',
    'print(json.dumps({"base": sys.base_prefix, "version": f"{sys.version_info.major}.{sys.version_info.minor}", "site": site_packages}))',
  ].join('; ')], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(`无法读取 PPT Master Python 环境：${probe.stderr || probe.error?.message || '未知错误'}`)
  }
  const inspected = JSON.parse(probe.stdout.trim())
  const baseRoot = realpathSync(inspected.base)
  const sitePackages = realpathSync(inspected.site)
  const versionDirectory = `python${inspected.version}`
  const baseSitePackages = windows
    ? resolve(baseRoot, 'Lib', 'site-packages')
    : resolve(baseRoot, 'lib', versionDirectory, 'site-packages')
  const destination = resolve(stagingRoot, 'python')
  const portableExecutable = realpathSync(venvPython)
  if (!isPortableRuntimeBinary(portableExecutable)) {
    throw new Error(`PPT Master Python 不是可重定位的 ${targetPlatform} 解释器：${portableExecutable}`)
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
  const runtimeSitePackages = windows
    ? resolve(destination, 'Lib', 'site-packages')
    : resolve(destination, 'lib', versionDirectory, 'site-packages')
  cpSync(sitePackages, runtimeSitePackages, {
    recursive: true,
    dereference: true,
    filter(source) {
      if (isDanglingSymlink(source)) return false
      return !relative(sitePackages, source).split(sep).some((part) => part === '__pycache__')
    },
  })
  const runtimePython = windows
    ? resolve(destination, 'python.exe')
    : resolve(destination, 'bin', 'python3')
  if (!windows) chmodSync(runtimePython, 0o755)
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
  return { version: inspected.version, entrypoint: windows ? 'python/python.exe' : 'python/bin/python3', skill: 'ppt-master@5.1.0' }
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
  const targetOnnxBinding = join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6', targetPlatform, targetArch, 'onnxruntime_binding.node')
  const hasTargetOnnx = existsSync(targetOnnxBinding)
  // 1) 原生二进制只保留当前桌面平台和架构。此前多种平台/架构一起打包，
  //    不仅浪费几十 MB，还可能让 x64 Node 误加载 arm64 ONNX 动态库。
  keepOnly(join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6'), (name) => name === targetPlatform, removeTree)
  keepOnly(join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6', targetPlatform), (name) => name === targetArch, removeTree)
  keepOnly(join(modulesRoot, 'node-pty', 'prebuilds'), (name) => name === targetNativePty, removeTree)
  keepOnly(join(modulesRoot, '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep'), (name) => name === 'COPYING' || name === targetNativeRipgrep, removeTree)
  // 1.5) fs-ext 原生锁定桩：fs-ext@2.1.1 的 C++ 无法在打包 Node 24 的 V8 头上编译，
  //    而桌面 worker 是单进程（无跨进程写入者），与上游 browser-worker 部署的
  //    fs-ext stub 同语义（session-persistence-jsonl/src/lease.ts）。替换闭包里
  //    复制进来的包体（见 runtime-stubs/fs-ext）。
  stageFsExtStub()
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
  const pythonLibRoot = resolve(stagingRoot, 'python', targetPlatform === 'win32' ? 'Lib' : 'lib')
  if (existsSync(pythonLibRoot)) {
    const stdlibRoots = targetPlatform === 'win32'
      ? [pythonLibRoot]
      : readdirSync(pythonLibRoot).map((versionDirectory) => join(pythonLibRoot, versionDirectory))
    for (const stdlibRoot of stdlibRoots) {
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

/** 用桌面单进程桩替换闭包里复制出的 fs-ext 原生包（原因见调用处注释）。 */
function stageFsExtStub() {
  const target = resolve(modulesRoot, 'fs-ext')
  const stubRoot = resolve(desktopRoot, 'runtime-stubs', 'fs-ext')
  if (!existsSync(stubRoot)) throw new Error(`缺少 fs-ext 桩目录：${stubRoot}`)
  rmSync(target, { recursive: true, force: true })
  cpSync(stubRoot, target, { recursive: true, dereference: true })
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
  const onnxRoot = join(modulesRoot, 'onnxruntime-node', 'bin', 'napi-v6', targetPlatform)
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
    const expected = targetNativePty
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
// dsh-node 在打包 runtime 里以 .ts 源码被 tsx 加载，值导入只能落在包内或
// runtime/node_modules 能解析的包名上。跨树相对路径（../../../shared/…、
// ../../../dsh-plugins/…）在源码布局成立、打包态必然 ERR_MODULE_NOT_FOUND ——
// cluster.ts 的 worker-binding 导入曾让桌面包启动即崩。语句级 `import type …`
// 由 tsx 擦除，不算违规。判定逻辑见 dsh-node-self-contained.mjs。
function assertDshNodeSelfContained() {
  const offenders = findCrossTreeImports(dshNodeRoot)
  if (offenders.length === 0) return
  const listed = offenders.map(({ file, line, specifier }) => `${file}:${line} → ${specifier}`).join('\n  ')
  throw new Error('无法构建桌面 runtime：dsh-node 存在逃出包根的值导入，打包后会 ERR_MODULE_NOT_FOUND：\n  '
    + `${listed}\n  仅类型导入请写成语句级 \`import type …\`；运行时需要的契约在 dsh-node/src 下留本地镜像（见 worker-binding.ts / mtls.ts）`)
}

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

/** 递归列出 src/ 下的 .ts/.tsx 源文件（绝对路径）。 */
function listTypeScriptSources(directory) {
  const sources = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) sources.push(...listTypeScriptSources(entryPath))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) sources.push(entryPath)
  }
  return sources
}

/**
 * 构建期兜底：产物里每条相对说明符都必须指向已产出的文件。单文件转译不解析模块图，
 * 漏转一个兄弟模块只会在用户机器上以「启动即 ERR_MODULE_NOT_FOUND」的形式暴露。
 */
function assertRelativeImportsEmitted(packageName, destination, emitted) {
  for (const outputPath of emitted) {
    const output = readFileSync(outputPath, 'utf8')
    const specifiers = [
      ...output.matchAll(/^(?:import|export)\b[^\n]*?["'](\.\.?\/[^"']+)["']/gm),
      ...output.matchAll(/\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g),
    ]
    for (const [, specifier] of specifiers) {
      const target = resolve(dirname(outputPath), specifier)
      if (!emitted.has(target) && !existsSync(target)) {
        throw new Error(`无法构建桌面 runtime：${packageName}/${relative(destination, outputPath)} 相对导入了 ${specifier}，但该文件未产出`)
      }
    }
  }
}

function compilePackagedTypeScriptPlugins() {
  const requireFromDsh = createRequire(resolve(dshRoot, 'package.json'))
  const typescript = requireFromDsh('typescript')

  for (const packageName of packagedTypeScriptPlugins) {
    const packageInfo = packageSources.get(packageName)
    if (packageInfo === undefined) throw new Error(`无法构建桌面 runtime：${packageName} 未进入依赖闭包`)

    const sourceRoot = resolve(packageInfo.root, 'src')
    const destination = resolve(modulesRoot, ...packageName.split('/'))
    // 转译整个 src/ 并保持目录形状，而不是只转入口 index.ts：transpileModule 是单文件
    // 语义（不解析模块图），多文件插件（web-fetch-fakeip 的 src/index.ts 相对导入了同目录
    // 的 ./resolver.ts）只转入口会把 `./resolver.ts` 原样留在产物里——Node 按导入方目录
    // 解析成 lib/resolver.ts，而该文件从未产出，桌面 runtime 启动即 ERR_MODULE_NOT_FOUND。
    // 相对说明符交给 rewriteRelativeImportExtensions 由 .ts 改写成 .js。
    const emitted = new Set()
    for (const sourcePath of listTypeScriptSources(sourceRoot)) {
      const relativeSource = relative(sourceRoot, sourcePath)
      const outputPath = resolve(destination, 'lib', relativeSource.replace(/\.tsx?$/, '.js'))
      const result = typescript.transpileModule(readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
          rewriteRelativeImportExtensions: true,
        },
        fileName: sourcePath,
      })

      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, result.outputText)
      emitted.add(outputPath)
    }
    assertRelativeImportsEmitted(packageName, destination, emitted)

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
  // 只查“目录存在”不够：版本漂移（比如 dshmarket 1.36.0 → 1.41.0）时旧包还躺在
  // 安装目录里，闭包会继续点名旧版。逐包核对已装版本，不匹配就整体重装。
  const ready = upstreamPluginSpecs.every((spec) => {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const expected = spec.slice(at + 1)
    const manifest = resolve(upstreamPluginModulesRoot, ...name.split('/'), 'package.json')
    if (!existsSync(manifest)) return false
    try {
      return JSON.parse(readFileSync(manifest, 'utf8')).version === expected
    } catch {
      return false
    }
  })
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
  const result = spawnExecutable(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', [
    'pnpm', 'install', '--prod', '--ignore-scripts', '--no-frozen-lockfile',
    '--ignore-workspace', '--config.auto-install-peers=false',
    '--registry', process.env.LUMO_NPM_REGISTRY ?? 'https://registry.npmjs.org',
    '--network-concurrency=8', '--fetch-retries=2', '--fetch-retry-mintimeout=2000', '--fetch-retry-maxtimeout=10000',
  ], {
    cwd: upstreamPluginRoot,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`桌面基础插件安装失败：${String(result.status ?? result.signal)}`)
}

function buildKnowledgeVaultPlugin() {
  runWorkspaceBinary(knowledgeVaultRoot, 'tsdown', ['--config', 'tsdown.config.ts'], 'Knowledge Vault 构建失败')
  if (!existsSync(resolve(knowledgeVaultRoot, 'lib', 'index.js'))) {
    throw new Error(`Knowledge Vault 构建失败：lib/index.js 未产出`)
  }
}

function buildLumoUiPlugin() {
  for (const [binary, args] of [
    ['tsc', ['-p', 'tsconfig.json']],
    ['tsdown', ['--config', 'tsdown.config.ts']],
  ]) {
    runWorkspaceBinary(lumoUiRoot, binary, args, 'Lumo UI 构建失败')
  }
}

// Host 面产物必须在快照上重产：`tsc -b` 只产出 lib/types，typert 的
// lib/typert.remote-client.*（`@deepseek-ai/dsh-api-*/remote` 子路径）与
// tsdown 的 host 包 bundle 只有 host 面的 tsdown 序能造；上游 master 重构期
// 根 tsdown.config.ts 的 dsh-root 花括号 entry 会卡死该序，apply.mjs 的
// LUMO_DSH_TYSDOWN_ENTRY 补丁已在快照上修好入口（synthesize-dsh-libs 补
// 附加入口形状）。依赖开发树旧 lib 是这个构建链最大的坑——旧产物会同包。
// 快照的 node_modules 软链指向开发树 packages/*（linkWorkspaceModules），
// 因此再生产物必须回拷开发树，否则闭包遍历/TS 解析落回旧 lib。
// 未覆盖的包复用投影的 lib/types，避免全量 tsc 跨越快照与开发树的两套类型声明。
// 被覆盖的 host 包先由 buildDshHostPackages 单包编译。
function rebuildDshHostArtifacts() {
  console.log('重建 DSH host 面产物（tsdown 包与 typert remote 投影）...')
  runWorkspaceBinary('.', 'tsdown', ['--env.DSH_BUILD_FACE', 'host'], 'DSH host 面产物重建失败')
  mirrorSnapshotLibsBackToSource()
}

// Compile only the overridden Host programs against projected dependencies.
// A dual-face package's root config is solution-only, so tsc -p must select
// tsconfig.host.json explicitly to emit the entry consumed by tsdown.
function buildDshHostPackages() {
  console.log('构建 DSH 覆盖层主机包...')
  for (const directory of overriddenPackageDirectories) {
    const hostConfig = existsSync(resolve(dshRoot, directory, 'tsconfig.host.json'))
      ? 'tsconfig.host.json'
      : directory.startsWith('packages/client/') ? undefined : 'tsconfig.json'
    if (hostConfig === undefined) continue
    runWorkspaceBinary(directory, 'tsc', ['-p', hostConfig, '--pretty', 'false'], `${directory} 主机类型产物构建失败`)
  }
}

// Client 面整 workspace 重建：host 面里 clientBundle 包被 SKIP_WORKSPACE_BUILD
// 跳过（其 node 半要靠 client 面补齐——tsdown.client.ts 的契约），只打被点名的
// 包会漏掉所有 loader 入口包的 node 半（typert-registry / api-gateway /
// client-modules 的 lib/index.js 曾因此停留在合成再导出形态，default 丢失导致
// cordis "invalid plugin, received object"——2026-09 的实测根因）。client 面在
// 修复后的 tsdown.config.ts 下可完整跑通（UNRESOLVED_ENTRY 幻影发生在补丁落地前）。
function rebuildDshClientArtifacts() {
  console.log('重建 DSH client 面产物（整 workspace：clientBundle 包 node 半 + 浏览器 bundle）...')
  runWorkspaceBinary('.', 'tsdown', ['--env.DSH_BUILD_FACE', 'client'], 'DSH client 面产物重建失败')
  mirrorSnapshotLibsBackToSource()
}

// 把快照里重产出的 lib/ 回拷到开发库（只覆盖 gitignored 产物；快照为源头）。
// 快照的 node_modules 软链指向 sourceDshRoot 的 packages/*（linkWorkspaceModules），
// 两边必须同态，否则 TS 解析与闭包遍历落回旧产物。
function mirrorSnapshotLibsBackToSource() {
  if (sourceDshRoot !== resolve(repoRoot, 'deepseek-harness')) {
    // LUMO_DSH_SOURCE_ROOT 指向外部 checkout 时回拷由用户自行决定
    console.log('跳过快照产物回拷（LUMO_DSH_SOURCE_ROOT 为外部库）')
    return
  }
  let copied = 0
  const manifests = spawnSync('git', ['-C', sourceDshRoot, 'ls-files', '-z', '**/package.json', 'package.json'], { encoding: 'utf8' })
  if (manifests.error !== undefined || manifests.status !== 0) return
  for (const manifest of manifests.stdout.split('\0').filter(Boolean)) {
    const packageDir = dirname(resolve(sourceDshRoot, manifest))
    const snapshotLib = resolve(dshRoot, dirname(manifest), 'lib')
    if (!existsSync(snapshotLib)) continue
    const targetLib = join(packageDir, 'lib')
    rmSync(targetLib, { recursive: true, force: true })
    cpSync(snapshotLib, targetLib, { recursive: true, dereference: true })
    copied++
  }
  console.log(`DSH 产物已回拷开发库（${copied} 个包）`)
}

function buildDshClientPackages() {
  const clientConfigs = overriddenPackageDirectories.flatMap((directory) => {
    if (existsSync(resolve(dshRoot, directory, 'tsconfig.client.json'))) return [join(directory, 'tsconfig.client.json')]
    return directory.startsWith('packages/client/') ? [join(directory, 'tsconfig.json')] : []
  })
  console.log('构建 DSH 覆盖层客户端包...')
  runWorkspaceBinary('.', 'tsc', [
    '-b',
    ...clientConfigs,
    '--pretty', 'false',
  ], 'DSH 客户端类型产物构建失败')

  for (const config of clientConfigs) {
    const packageDirectory = dirname(config)
    runWorkspaceBinary(packageDirectory, 'tsdown', ['--env.DSH_BUILD_FACE', 'client'], `${packageDirectory} 客户端包构建失败`)
  }
}

function refreshDshClientTypePrerequisites() {
  const staleConfigs = dshClientTypeConfigs(dshRoot).filter((config) => !hasUsableDshClientTypes(dshRoot, config))
  if (staleConfigs.length === 0) return
  console.log(`刷新 DSH 客户端基础声明（隔离快照：${staleConfigs.length} 个 Client 项目）...`)
  for (const config of staleConfigs) {
    // tsc does not remove files that belonged to a deleted source module. Clear
    // only the generated type tree in the snapshot, otherwise the sourcemap
    // plugin can still discover an orphaned `.js.map` after a successful emit.
    rmSync(resolve(dshRoot, dirname(config), 'lib', 'types'), { recursive: true, force: true })
  }
  runWorkspaceBinary('.', 'tsc', [
    '-b', ...staleConfigs,
    '--force',
    '--pretty', 'false',
  ], 'DSH 客户端基础声明刷新失败')
}

// 快照里的每个 node_modules 都是软链回源树的同一份目录，所以绝不能在快照里跑
// `pnpm run` —— pnpm 会顺着链接把源树的 workspace 链接重写成指向快照，而快照只有
// src/、没有构建好的 lib/，下一次 Vite 解析 experimental/webworker-runtime/worker
// 就崩。直调二进制既跳过了这层重链，也跳过了 registry。
function runWorkspaceBinary(packageDirectory, binaryName, args, failureMessage) {
  const cwd = resolve(dshRoot, packageDirectory)
  const binary = resolveWorkspaceNodeTool(cwd, dshRoot, binaryName)
  const result = spawnSync(process.execPath, [binary, ...args], { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${failureMessage}：${String(result.status ?? result.signal)}`)
}

function spawnExecutable(command, args, options = {}) {
  const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command)
  return spawnSync(command, args, { ...options, ...(windowsScript ? { shell: true } : {}) })
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
    if (hostPlatform() !== 'darwin' && hostPlatform() !== 'win32') {
      throw new Error(`桌面 runtime 只能在 macOS 或 Windows 上构建（当前宿主 ${hostPlatform()}）`)
    }
    return hostPlatform() === 'win32'
      ? 'win-x64'
      : `darwin-${hostArch() === 'arm64' ? 'arm64' : 'x64'}`
  }
  if (!SUPPORTED_TARGETS.includes(requested)) {
    throw new Error(`不支持的桌面构建目标：${requested}（可用：${SUPPORTED_TARGETS.join(', ')}）`)
  }
  const expectedHost = requested.startsWith('win-') ? 'win32' : 'darwin'
  if (hostPlatform() !== expectedHost) {
    throw new Error(`${requested} 必须在 ${expectedHost === 'win32' ? 'Windows' : 'macOS'} 上构建（当前宿主 ${hostPlatform()}）`)
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
    if (!isPortableRuntimeBinary(pinned)) {
      throw new Error(`LUMO_RUNTIME_NODE 指向的 Node 不是自包含的 ${targetPlatform} 可执行文件：${pinned}`)
    }
    assertBinaryArchitecture(pinned, 'LUMO_RUNTIME_NODE')
    console.log(`打包 Node：${pinned}（LUMO_RUNTIME_NODE 钉死，${nodeVersion(pinned)}）`)
    return pinned
  }
  // 默认按 target 从 nodejs.org 下载官方归档：构建机上装了什么 Node 不再影响产物。
  const downloaded = downloadOfficialNode(RUNTIME_NODE_VERSION, buildTarget)
  if (!isPortableRuntimeBinary(downloaded)) {
    throw new Error(`下载的官方 Node 不是自包含的 ${targetPlatform} 可执行文件：${downloaded}`)
  }
  assertBinaryArchitecture(downloaded, '官方 Node')
  console.log(`打包 Node：${downloaded}（nodejs.org v${RUNTIME_NODE_VERSION} ${buildTarget}）`)
  return downloaded
}

// 缓存到 platform/.build/node/<version>-<target>/node[.exe]；归档经 SHASUMS256.txt 校验。
function downloadOfficialNode(version, target) {
  const cacheDirectory = resolve(nodeCacheRoot, `${version}-${target}`)
  const windows = targetPlatform === 'win32'
  const cached = resolve(cacheDirectory, windows ? 'node.exe' : 'node')
  const cachedCorepack = resolve(cacheDirectory, 'node_modules', 'corepack')
  if (existsSync(cached) && existsSync(cachedCorepack)) return cached
  const mirror = (process.env['LUMO_NODE_DIST_MIRROR'] ?? 'https://nodejs.org/dist').replace(/\/+$/, '')
  const archiveName = windows ? `node-v${version}-win-x64.zip` : `node-v${version}-${target}.tar.gz`
  mkdirSync(cacheDirectory, { recursive: true })
  const archive = resolve(cacheDirectory, archiveName)
  const shasums = resolve(cacheDirectory, 'SHASUMS256.txt')
  console.log(`下载官方 Node：${mirror}/v${version}/${archiveName}`)
  curl(`${mirror}/v${version}/${archiveName}`, archive)
  curl(`${mirror}/v${version}/SHASUMS256.txt`, shasums)
  const expected = readFileSync(shasums, 'utf8').split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0]
  if (expected === undefined) throw new Error(`SHASUMS256.txt 里没有 ${archiveName}`)
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== expected) {
    rmSync(archive, { force: true })
    throw new Error(`官方 Node 归档校验失败：${archiveName} 期望 ${expected} 实际 ${actual}`)
  }
  // Windows 的官方归档是 zip，macOS 是 tar.gz；两者都只取 node/corepack/npm，
  // 其余文件交由平台工作区的依赖闭包提供。
  const extractedRoot = resolve(cacheDirectory, `node-v${version}-${target}`)
  rmSync(extractedRoot, { recursive: true, force: true })
  const extract = windows
    // Git/MSYS GNU tar treats the colon in a Windows drive path as the
    // remote-archive separator (for example, `E:\\...`). Run inside the
    // cache directory and pass only the archive name so every tar variant
    // sees a local file, without relying on GNU-only --force-local.
    ? spawnSync('tar', ['-xf', archiveName], { cwd: cacheDirectory, encoding: 'utf8' })
    : spawnSync('tar', ['-xzf', archive, '-C', cacheDirectory, '--strip-components', '2',
      `node-v${version}-${target}/bin/node`,
      `node-v${version}-${target}/lib/node_modules/corepack`,
      `node-v${version}-${target}/lib/node_modules/npm`,
    ], { encoding: 'utf8' })
  if (extract.error !== undefined || extract.status !== 0) {
    throw new Error(`解压官方 Node 失败：${extract.stderr || extract.error?.message || archiveName}`)
  }
  if (windows) {
    const extractedNode = resolve(extractedRoot, 'node.exe')
    const extractedCorepack = resolve(extractedRoot, 'node_modules', 'corepack')
    const extractedNpm = resolve(extractedRoot, 'node_modules', 'npm')
    if (!existsSync(extractedNode) || !existsSync(extractedCorepack)) {
      throw new Error(`解压官方 Node 失败：${archiveName} 缺少 node.exe 或 corepack`)
    }
    cpSync(extractedNode, cached)
    mkdirSync(resolve(cacheDirectory, 'node_modules'), { recursive: true })
    cpSync(extractedCorepack, resolve(cacheDirectory, 'node_modules', 'corepack'), { recursive: true, dereference: true })
    if (existsSync(extractedNpm)) cpSync(extractedNpm, resolve(cacheDirectory, 'node_modules', 'npm'), { recursive: true, dereference: true })
    rmSync(extractedRoot, { recursive: true, force: true })
  }
  if (!existsSync(cached)) {
    throw new Error(`解压官方 Node 失败：${archiveName}`)
  }
  if (!windows) chmodSync(cached, 0o755)
  rmSync(archive, { force: true })
  return cached
}

/**
 * 把随 Node 发行的 corepack / npm 与一个 pnpm shim 塞进桌面 runtime，让打包后的应用在
 * 插件市场更新插件时能找到 pnpm/corepack/npx（否则报「未找到 pnpm」）。仅依赖 node
 * 二进制同目录下的 Node 发行件；LUMO_RUNTIME_NODE 指向裸 node 二进制时跳过并告警（只影响
 * 开发钉死场景）。shim 用相对路径定位，保证安装包里的 runtime 可整体搬移。
 */
function stageNodeTooling(nodeBinary, binDir, libDir) {
  const sourceDir = dirname(nodeBinary)
  const corepackSrc = resolve(sourceDir, 'node_modules', 'corepack')
  const npmSrc = resolve(sourceDir, 'node_modules', 'npm')
  if (!existsSync(corepackSrc)) {
    console.warn(`Lumo: [WARN] 未在 ${sourceDir}/node_modules 找到 corepack；插件更新将不可用（通常因 LUMO_RUNTIME_NODE 指向裸 node 二进制）`)
    return
  }
  mkdirSync(binDir, { recursive: true })
  mkdirSync(libDir, { recursive: true })
  cpSync(corepackSrc, resolve(libDir, 'corepack'), { recursive: true, dereference: true })
  if (existsSync(npmSrc)) cpSync(npmSrc, resolve(libDir, 'npm'), { recursive: true, dereference: true })
  const shims = targetPlatform === 'win32'
    ? [
        ['corepack.cmd', '@echo off\r\n"%~dp0..\\node.exe" "%~dp0..\\lib\\node_modules\\corepack\\dist\\corepack.js" %*\r\n'],
        ['npm.cmd', '@echo off\r\n"%~dp0..\\node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n'],
        ['npx.cmd', '@echo off\r\n"%~dp0..\\node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\npx-cli.js" %*\r\n'],
        ['pnpm.cmd', '@echo off\r\ncall "%~dp0corepack.cmd" pnpm %*\r\n'],
      ]
    : [
        ['corepack', '#!/bin/sh\nexec "$(dirname "$0")/../node" "$(dirname "$0")/../lib/node_modules/corepack/dist/corepack.js" "$@"\n'],
        ['npm', '#!/bin/sh\nexec "$(dirname "$0")/../node" "$(dirname "$0")/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n'],
        ['npx', '#!/bin/sh\nexec "$(dirname "$0")/../node" "$(dirname "$0")/../lib/node_modules/npm/bin/npx-cli.js" "$@"\n'],
        ['pnpm', '#!/bin/sh\nexec "$(dirname "$0")/corepack" pnpm "$@"\n'],
      ]
  for (const [name, body] of shims) {
    const path = resolve(binDir, name)
    writeFileSync(path, body)
    if (targetPlatform !== 'win32') chmodSync(path, 0o755)
  }
  console.log(`桌面 runtime 已注入 corepack/npm/pnpm shim（${binDir}）`)
}

function curl(url, destination) {
  const result = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', destination, url], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`下载失败：${url}\n${result.stderr || result.error?.message || ''}`.trim())
  }
}

function isPortableRuntimeBinary(candidate) {
  if (targetPlatform === 'win32') {
    if (!candidate.toLowerCase().endsWith('.exe')) return false
    const inspect = spawnExecutable(candidate, ['--version'], { encoding: 'utf8' })
    return inspect.error === undefined && inspect.status === 0
  }
  const inspect = spawnExecutable('/usr/bin/otool', ['-L', candidate], { encoding: 'utf8' })
  if (inspect.status !== 0 || inspect.error !== undefined) return false
  return !hasNonSystemDarwinDependency(inspect.stdout)
}

// 双架构支持的关键闸门：没有它，在 M 上构建 darwin-x64 会产出一个内含 arm64 Node 的
// 「x64 包」——打包成功、能分发、在 Intel 上直接起不来，且错误信息不指向架构。
function assertBinaryArchitecture(binary, label) {
  if (targetPlatform === 'win32') return
  const inspect = spawnSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' })
  if (inspect.error !== undefined || inspect.status !== 0) {
    throw new Error(`无法读取 ${label} 的架构（lipo -archs）：${binary}\n${inspect.stderr ?? ''}`.trim())
  }
  const archs = inspect.stdout.trim().split(/\s+/).filter(Boolean)
  if (!archs.includes(targetLipoArch)) {
    throw new Error(`${label} 架构为 [${archs.join(' ')}]，与构建目标 ${buildTarget}（${targetLipoArch}）不符：${binary}`)
  }
}
