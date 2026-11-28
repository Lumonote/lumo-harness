import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { stageDeviceAgent } from '../build-device-agent.mjs'

it('builds the governed device binary for the selected bundle target and propagates failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lumo-agent-build-'))
  try {
    const run = vi.fn(() => ({ status: 0 }))
    const output = stageDeviceAgent(directory, 'win-x64', run)
    expect(output).toMatch(/lumo-desktop-agent\.exe$/u)
    expect(run).toHaveBeenCalledWith(expect.any(String), ['build', '-trimpath', '-o', output, './cmd/desktop-agent'], expect.objectContaining({ env: expect.objectContaining({ GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' }) }))
    expect(() => stageDeviceAgent(directory, 'darwin-arm64', () => ({ status: 1 }))).toThrow('构建失败')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
