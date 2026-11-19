import { rmSync } from 'node:fs'
import { cuaProviderPackages, stageCuaHelper } from './cua-helper.mjs'
import { stageWindowsCua } from './windows-cua.mjs'

// The registry/seam stays installed: other plugins may use its public types.
const pluginPackages = Object.freeze([
  '@lumo/computer-use', ...cuaProviderPackages,
  '@deepseek-ai/dsh-cua-windows', '@deepseek-ai/dsh-experimental-cua-windows',
  '@deepseek-ai/dsh-cua-bundle', '@deepseek-ai/dsh-cua-mcp', '@deepseek-ai/dsh-cua',
])

/** Optional native capability failure must not prevent shipping the desktop. */
export function stageOptionalComputerUse({ runtimePackages, targetPlatform, targetArch, modulesRoot, scratchPath, hostPlatform, run, warn = console.warn }) {
  try {
    if (targetPlatform === 'win32') {
      const packageRoot = runtimePackages.find(({ manifest }) => manifest.name === '@lumo/computer-use')?.destination
      return stageWindowsCua({ packageRoot, targetArch, modulesRoot, hostPlatform, run })
    }
    const packageRoot = runtimePackages.find(({ manifest }) => cuaProviderPackages.includes(manifest.name))?.destination
    return stageCuaHelper({ packageRoot, targetPlatform, targetArch, scratchPath, hostPlatform, run })
  } catch (error) {
    // Remove all copies, including nested placements and partially built binaries.
    // Cleanup errors remain fatal: an incomplete plugin must not ship accidentally.
    for (const { manifest, destination } of runtimePackages) {
      if (pluginPackages.includes(manifest.name)) rmSync(destination, { recursive: true, force: true })
    }
    const diagnostic = error instanceof Error ? error.message : String(error)
    warn(`Lumo: 可选插件 Computer Use 打包失败，已跳过安装：${diagnostic}`)
    return { available: false, reason: 'packaging-failed', diagnostic, omittedPackages: [...pluginPackages] }
  }
}
