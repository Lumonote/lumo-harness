// Copied to runtime/bin/skillhub.mjs. Resolve everything from this file so the
// application can move between machines and directories (including spaces).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pythonRoot = resolve(runtimeRoot, 'python')
const python = resolve(pythonRoot, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const cli = resolve(runtimeRoot, 'skillhub', 'skills_store_cli.py')
for (const entry of [python, cli]) {
  if (!existsSync(entry)) {
    console.error(`内置 SkillHub CLI 不完整：缺少 ${entry}，请重新安装完整的桌面应用包。`)
    process.exit(1)
  }
}
const result = spawnSync(python, [
  '-B', cli, ...process.argv.slice(2),
], {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONHOME: pythonRoot,
    PYTHONPATH: '',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
  },
})
if (result.error) console.error(`内置 SkillHub CLI 启动失败：${result.error.message}`)
process.exit(result.status ?? 1)
