import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Older/source runtimes without a capability manifest retain their composition. */
export function packagedComputerUse(env: NodeJS.ProcessEnv = process.env): { available: boolean; omittedPackages?: string[] } | undefined {
  const root = env['LUMO_RUNTIME_ROOT']
  if (!root) return undefined
  const path = resolve(root, 'runtime-manifest.json')
  if (!existsSync(path)) return undefined
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { computerUse?: { available: boolean; omittedPackages?: string[] } }
  return manifest.computerUse
}

export function omittedPackagedPlugins(env: NodeJS.ProcessEnv): Set<string> {
  const capability = packagedComputerUse(env)
  if (capability?.available !== false) return new Set()
  // This optional capability cannot waive unrelated first-party dependencies.
  return new Set(['@lumo/computer-use', ...(capability.omittedPackages ?? []).filter(name =>
    /^@deepseek-ai\/dsh-(?:experimental-)?cua(?:-macos|-windows|-bundle|-mcp)?$/u.test(name))])
}
