import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
/** Build the existing governed device agent for the actual bundle target. No runtime compiler dependency. */
export function stageDeviceAgent(destination, target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, run = spawnSync) {
  const targets = { 'darwin-arm64': ['darwin', 'arm64'], 'darwin-x64': ['darwin', 'amd64'], 'win-x64': ['windows', 'amd64'], 'linux-x64': ['linux', 'amd64'], 'linux-arm64': ['linux', 'arm64'] }
  const selected = targets[target]
  if (!selected) throw Error(`设备代理不支持构建目标：${target}`)
  mkdirSync(destination, { recursive: true })
  const output = resolve(destination, selected[0] === 'windows' ? 'lumo-desktop-agent.exe' : 'lumo-desktop-agent')
  const result = run(process.env.LUMO_GO_BINARY || 'go', ['build', '-trimpath', '-o', output, './cmd/desktop-agent'], {
    cwd: resolve(root, '../control-plane/registry'), stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: selected[0], GOARCH: selected[1] },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`设备代理构建失败：${result.status ?? result.signal}`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageDeviceAgent(resolve(root, '../.build'), process.argv[2])
}
