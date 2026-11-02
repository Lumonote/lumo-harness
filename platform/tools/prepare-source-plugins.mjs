import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit',
    ...(process.platform === 'win32' && /\.cmd$/i.test(command) ? { shell: true } : {}),
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`source plugin: ${command} failed (${result.status ?? result.signal})`)
}

/** Build unpublished baseline bundles at exact commits, outside the upstream DSH tree. */
export function prepareSourcePlugins(platformRoot, onlyName) {
  const manifest = JSON.parse(readFileSync(resolve(platformRoot, 'shared/manifests/plugin-baseline.manifest.json'), 'utf8'))
  const plugins = manifest.baseline.filter(pin => pin.source && (!onlyName || pin.name === onlyName))
  const roots = new Map()
  for (const pin of plugins) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(pin.name)
      || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(pin.source.repository)
      || !/^[a-f0-9]{40}$/.test(pin.source.commit)) throw new Error(`Invalid source plugin pin: ${pin.name}`)
    const parent = resolve(platformRoot, '.build/source-plugins')
    const target = resolve(parent, pin.name)
    // A builder change invalidates artifacts, including changes to files copied
    // into the distribution. Never treat a half-built checkout as ready.
    const fingerprint = createHash('sha256').update(readFileSync(scriptPath)).update(JSON.stringify(pin)).digest('hex')
    const marker = resolve(target, '.lumo-source-build')
    const outputs = ['lib/index.js', 'lib/client.js', 'lib/github-watch.js', 'lib/feishu-watch.js', 'cordis.patch.yml']
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === fingerprint
      && outputs.every(file => existsSync(resolve(target, file)))) {
      roots.set(pin.name, target)
      continue
    }
    mkdirSync(parent, { recursive: true })
    const temporary = mkdtempSync(resolve(parent, `${pin.name}-`))
    const checkout = resolve(temporary, 'source')
    const distribution = resolve(temporary, 'package')
    try {
      console.log(`Building baseline ${pin.name}@${pin.version} from ${pin.source.repository}#${pin.source.commit}`)
      run('git', ['init', checkout], temporary)
      run('git', ['-C', checkout, 'remote', 'add', 'origin', pin.source.repository], temporary)
      run('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', pin.source.commit], temporary)
      run('git', ['-C', checkout, 'checkout', '--detach', 'FETCH_HEAD'], temporary)
      const pkg = JSON.parse(readFileSync(resolve(checkout, 'package.json'), 'utf8'))
      if (pkg.name !== pin.name || pkg.version !== pin.version) throw new Error(`Source manifest differs from baseline pin: ${pin.name}`)
      const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
      // This checkout sits below platform/.build. Without --ignore-workspace,
      // pnpm installs the parent platform workspace and leaves this package
      // without its own build tools despite exiting successfully.
      run(corepack, [pkg.packageManager, 'install', '--frozen-lockfile', '--ignore-scripts',
        '--ignore-workspace', '--config.manage-package-manager-versions=false'], checkout)
      // Invoke the JS entry directly: avoid workspace relinking and .bin shims.
      const tool = JSON.parse(readFileSync(resolve(checkout, 'node_modules/tsdown/package.json'), 'utf8'))
      const entry = typeof tool.bin === 'string' ? tool.bin : tool.bin.tsdown
      run(process.execPath, [resolve(checkout, 'node_modules/tsdown', entry)], checkout)
      mkdirSync(distribution, { recursive: true })
      for (const file of ['lib', 'cordis.patch.yml', 'locale', 'README.md', 'LICENSE', 'prompts', 'skills']) {
        cpSync(resolve(checkout, file), resolve(distribution, file), { recursive: true })
      }
      writeFileSync(resolve(distribution, 'package.json'), `${JSON.stringify({ ...pkg, lumoSource: pin.source }, null, 2)}\n`)
      // Install only the production closure. DSH peers come from the host, never
      // a second copy of the SDK used to compile this unpublished prototype.
      run(corepack, [pkg.packageManager, 'install', '--prod', '--ignore-scripts', '--no-frozen-lockfile',
        '--ignore-workspace', '--config.auto-install-peers=false', '--config.manage-package-manager-versions=false'], distribution)
      for (const file of outputs) if (!existsSync(resolve(distribution, file))) throw new Error(`Missing source plugin output: ${pin.name}/${file}`)
      writeFileSync(resolve(distribution, '.lumo-source-build'), `${fingerprint}\n`)
      rmSync(target, { recursive: true, force: true })
      renameSync(distribution, target)
      roots.set(pin.name, target)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  return roots
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  prepareSourcePlugins(resolve(process.argv[2] ?? resolve(dirname(scriptPath), '..')), process.argv[3])
}
