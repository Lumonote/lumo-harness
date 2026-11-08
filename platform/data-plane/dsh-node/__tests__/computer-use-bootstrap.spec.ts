import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const entry = join(root, 'platform/data-plane/dsh-node/src/index.ts')
const loader = join(root, 'platform/data-plane/dsh-node/node_modules/tsx/dist/loader.mjs')
const require = createRequire(join(root, 'deepseek-harness/vendor/include/package.json'))
const yaml = require('js-yaml') as { load(text: string): Array<{ id?: string; insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }> }> }

function bootstrap(mode: 'local' | 'standalone') {
  const directory = mkdtempSync(join(tmpdir(), 'computer-use-bootstrap-'))
  const rendered = join(directory, 'rendered.yml')
  const cli = join(directory, 'fixture.mjs')
  writeFileSync(cli, "import {copyFileSync} from 'node:fs';const index=process.argv.indexOf('--patch');copyFileSync(process.argv[index+1],process.env.LUMO_FIXTURE_PATCH);")
  try {
    const result = spawnSync(process.execPath, ['--import', loader, entry], {
      cwd: directory,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        DSH_HOME: join(directory, 'dsh'), LUMO_RUNTIME_STATE_DIR: join(directory, 'runtime'),
        LUMO_SQLITE_PATH: join(directory, 'local.sqlite'),
        LUMO_DEPLOYMENT_MODE: mode, LUMO_DSH_PROFILE: 'web', LUMO_ROLE: 'agent',
        LUMO_AUTO_INSTALL_PLUGINS: '0', LUMO_DSH_CLI: cli,
        LUMO_PATCH_PATH: join(directory, 'patch.yml'), LUMO_FIXTURE_PATCH: rendered,
      },
      encoding: 'utf8', timeout: 15_000,
    })
    expect(result.status, String(result.error ?? '') + result.stderr + result.stdout).toBe(0)
    const text = readFileSync(rendered, 'utf8')
    return { text, rows: yaml.load(text).flatMap(row => row.insert ?? []) }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('desktop Computer Use composition', () => {
  it('mounts local coordination while preserving the official opt-in provider and preset', () => {
    const local = bootstrap('local')
    expect(local.rows.find(row => row.id === 'lumo-computer-use')).toMatchObject({ name: '@lumo/computer-use', config: { idleLeaseMs: 120000 } })
    expect(local.rows.some(row => row.name === '@deepseek-ai/dsh-experimental-cua-macos' || row.name === '@deepseek-ai/dsh-cua-bundle')).toBe(false)
    expect(local.text).not.toContain('allowedApps:')
    expect(local.text).not.toContain('selectedDefault: ptc')
  })

  it('does not expose a server host desktop through the standalone deployment', () => {
    expect(bootstrap('standalone').rows.some(row => row.id === 'lumo-computer-use')).toBe(false)
  })
})
