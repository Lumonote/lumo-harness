import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Resolve the package's actual Node entry, independent of .bin shell shims. */
export function resolveWorkspaceNodeTool(cwd, workspaceRoot, binaryName) {
  const packageName = binaryName === 'tsc' ? 'typescript' : binaryName
  for (const root of new Set([cwd, workspaceRoot])) {
    const require = createRequire(resolve(root, 'package.json'))
    let manifestPath
    try {
      manifestPath = require.resolve(`${packageName}/package.json`)
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue
      throw error
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binaryName]
    if (typeof entry !== 'string') throw new Error(`${packageName} does not expose the ${binaryName} binary`)
    const filename = resolve(dirname(manifestPath), entry)
    if (!existsSync(filename)) throw new Error(`Missing ${binaryName} entry: ${filename}`)
    return filename
  }
  throw new Error(`Cannot find ${packageName} in ${cwd} or ${workspaceRoot}`)
}

// Isolated previews share installed dependencies with the source checkout.
// Execute the tool itself: package-manager scripts can rewrite those links.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cwd, workspaceRoot, binaryName, ...args] = process.argv.slice(2)
  if (!cwd || !workspaceRoot || !binaryName) throw new Error('usage: node node-tools.mjs <cwd> <workspace-root> <binary> [...args]')
  const result = spawnSync(process.execPath, [resolveWorkspaceNodeTool(cwd, workspaceRoot, binaryName), ...args], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
