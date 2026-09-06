import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

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
