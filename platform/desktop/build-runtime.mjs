import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopRoot, '..', '..')
const sourceDshRoot = resolve(repoRoot, 'deepseek-harness')
const dshRoot = resolve(repoRoot, 'platform', '.build', 'deepseek-harness')
prepareIsolatedDshRuntime()
const cliRoot = resolve(dshRoot, 'apps', 'cli')
const dshNodeRoot = resolve(repoRoot, 'platform', 'data-plane', 'dsh-node')
const dshConversationRoot = resolve(dshRoot, 'packages', 'client', 'ui-conversation')
const lumoUiRoot = resolve(repoRoot, 'platform', 'dsh-plugins', 'lumo-ui')
const bundledSkillsRoot = resolve(repoRoot, 'platform', 'upstream', 'skills')
const bundledSkillSources = resolve(repoRoot, 'platform', 'upstream', 'skill-sources.json')
const pptVenvRoot = resolve(bundledSkillsRoot, 'ppt-master', '.venv')
const stagingRoot = resolve(desktopRoot, 'target', 'lumo-runtime')
const modulesRoot = resolve(stagingRoot, 'node_modules')
const upstreamPluginRoot = resolve(desktopRoot, 'target', 'lumo-upstream-plugins')
const upstreamPluginModulesRoot = resolve(upstreamPluginRoot, 'node_modules')
const packagedTypeScriptPlugins = new Set(['@lumo/open-design', '@lumo/archify', '@lumo/creative-skills', '@lumo/ruflo-orchestration'])
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

// Rebuild the resident DSH conversation package first: its compiled client is
// what Vite resolves from the workspace package export, and it contains the
// homepage-scoped composer seats added for Lumo.
buildDshConversationPackage()

// lumo-ui is bundled JavaScript (unlike the two small local server plugins
// compiled below). Build it before copying the package closure so a desktop
// bundle always receives the source UI that the user just edited.
buildLumoUiPlugin()

// Always rebuild the Web shell. The desktop artifact embeds the Vite bundle,
// so a cached dist/index.html would otherwise hide changes to the resident
// composer (including root-scoped homepage extension seats).
console.log('构建 DSH Web 前端资源（含创作与多智能体编排能力）...')
const result = spawnSync('corepack', ['pnpm', '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'], {
  cwd: dshRoot,
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) throw new Error(`DSH Web 前端构建失败：${String(result.status ?? result.signal)}`)
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

function packagePath(name, fromRoot) {
  const parts = name.split('/')
  const candidates = []
  const alreadyQueued = packageSources.get(name)?.root
  if (alreadyQueued !== undefined) return alreadyQueued
  for (const root of [fromRoot, ...moduleSearchRoots].filter((value) => value !== undefined)) {
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
  dshConversationRoot,
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
  for (const [name] of Object.entries(dependencies)) {
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

for (const [name, packageInfo] of packageSources) copyPackage(name, packageInfo.root)
compilePackagedTypeScriptPlugins()

if (!existsSync(bundledSkillSources)) throw new Error(`无法构建桌面 runtime：找不到 ${bundledSkillSources}`)
cpSync(bundledSkillsRoot, resolve(stagingRoot, 'skills'), {
  recursive: true,
  dereference: true,
  filter(source) {
    const rel = relative(bundledSkillsRoot, source)
    if (rel === '') return true
    return !rel.split(sep).some((part) => part === '.git' || part === '.venv' || part === '__pycache__')
  },
})
const pptPython = bundlePptPython()

const runtimeNode = resolve(stagingRoot, 'node')
const nodeSource = findPortableNode()
cpSync(nodeSource, runtimeNode)
chmodSync(runtimeNode, 0o755)

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
  node: nodeVersion(nodeSource),
  nodeSource,
  packageCount: packageSources.size,
  python: pptPython,
  entrypoint: 'lumo-runtime.sh',
  upstreamPlugins: upstreamPluginSpecs,
  bundledSkills: JSON.parse(readFileSync(bundledSkillSources, 'utf8')).skills,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`)

console.log(`桌面 runtime 已准备：${packageSources.size} 个包，Node ${nodeVersion(nodeSource)}`)

function bundlePptPython() {
  const venvPython = resolve(pptVenvRoot, 'bin', 'python')
  if (!existsSync(venvPython)) {
    throw new Error(`无法构建桌面 runtime：PPT Master Python 环境不存在。请先执行 python3 -m venv ${pptVenvRoot}，再安装 ${resolve(bundledSkillsRoot, 'ppt-master', 'requirements.txt')}`)
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
  const inspect = spawnSync('/usr/bin/otool', ['-L', portableExecutable], { encoding: 'utf8' })
  if (inspect.error !== undefined || inspect.status !== 0 || hasNonSystemDarwinDependency(inspect.stdout)) {
    throw new Error(`PPT Master Python 不是可重定位的 macOS 解释器：${portableExecutable}`)
  }

  cpSync(baseRoot, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      const rel = relative(baseRoot, source)
      if (rel === '') return true
      if (source === baseSitePackages || source.startsWith(`${baseSitePackages}${sep}`)) return false
      return !rel.split(sep).some((part) => part === '__pycache__')
    },
  })
  cpSync(sitePackages, resolve(destination, 'lib', versionDirectory, 'site-packages'), {
    recursive: true,
    dereference: true,
    filter(source) {
      return !relative(sitePackages, source).split(sep).some((part) => part === '__pycache__')
    },
  })
  const runtimePython = resolve(destination, 'bin', 'python3')
  chmodSync(runtimePython, 0o755)
  const verify = spawnSync(runtimePython, ['-c', 'import pptx, yaml, fitz, flask; print("ok")'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONHOME: destination, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (verify.error !== undefined || verify.status !== 0 || verify.stdout.trim() !== 'ok') {
    throw new Error(`打包后的 PPT Master Python 不可用：${verify.stderr || verify.error?.message || '依赖导入失败'}`)
  }
  return { version: inspected.version, entrypoint: 'python/bin/python3', skill: 'ppt-master@5.1.0' }
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
  const result = spawnSync('corepack', ['pnpm', 'install', '--prod', '--ignore-scripts', '--no-frozen-lockfile'], {
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

function buildDshConversationPackage() {
  console.log('构建 DSH conversation 客户端包...')
  const result = spawnSync('corepack', [
    'pnpm', '--filter', '@deepseek-ai/dsh-client-ui-conversation', 'run', 'bundle',
  ], {
    cwd: dshRoot,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`DSH conversation 客户端包构建失败：${String(result.status ?? result.signal)}`)
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

function findPortableNode() {
  const candidates = [
    process.env['LUMO_RUNTIME_NODE'],
    process.execPath,
    ...nvmNodeCandidates(),
  ].filter((value, index, values) => value !== undefined && values.indexOf(value) === index)
  for (const candidate of candidates) {
    if (candidate === undefined || !existsSync(candidate)) continue
    const inspect = spawnSync('/usr/bin/otool', ['-L', candidate], { encoding: 'utf8' })
    if (inspect.status !== 0 || inspect.error !== undefined) continue
    if (!hasNonSystemDarwinDependency(inspect.stdout)) return candidate
  }
  throw new Error('找不到自包含的 macOS Node runtime；请设置 LUMO_RUNTIME_NODE 指向仅依赖系统库的 Node 可执行文件')
}

function nvmNodeCandidates() {
  const versionsRoot = resolve(homedir(), '.nvm', 'versions', 'node')
  if (!existsSync(versionsRoot)) return []
  return readdirSafe(versionsRoot)
    .sort()
    .reverse()
    .map((version) => resolve(versionsRoot, version, 'bin', 'node'))
}

function readdirSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}
