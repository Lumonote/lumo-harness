import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import typescript from 'typescript'
import { afterEach, expect, it } from 'vitest'
import { compilePackagedTypeScriptPlugin } from '../packaged-typescript.mjs'
import { resolveInstalledPackage } from '../runtime-dependencies.mjs'

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('loads the shipped computer-use JavaScript and mounts its real Cordis service without TypeScript support', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo packaged CUA (&) ')))
  roots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const packageRoot = join(platformRoot, 'dsh-plugins/computer-use')
  const destination = join(runtimeRoot, 'node_modules/@lumo/computer-use')
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'package.json'), readFileSync(join(packageRoot, 'package.json')))
  compilePackagedTypeScriptPlugin({ typescript, packageName: '@lumo/computer-use', packageRoot, destination, dependencyRoot: platformRoot })
  // Use the same built public dependencies as the desktop closure, with no
  // copied plugin sources or Vitest aliases available to the child process.
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-atomic-write', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
    const installed = resolveInstalledPackage(name, packageRoot)
    expect(installed, `missing runtime dependency ${name}`).toBeDefined()
    const link = join(runtimeRoot, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(installed!, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  expect(existsSync(join(destination, 'src'))).toBe(false)
  expect(existsSync(join(destination, 'lib/windows-worker.js'))).toBe(true)
  expect(existsSync(join(destination, 'lib/windows-runtime.js'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'))
  expect(manifest.exports['./windows'].import).toBe('./lib/windows.js')
  expect(manifest.exports['./windows-registry'].import).toBe('./lib/windows-registry.js')
  const source = `
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as ComputerUse from '@lumo/computer-use'
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(ComputerUse, { lockFile: join(process.cwd(), 'state/desktop') })
  const control = ctx.lumoComputerUse
  const initial = control.snapshot()
  const execution = { name: 'cua', callId: 'packaged-smoke', agent: { session: { id: 'smoke-session' } },
    arguments: { method: 'getCapabilities', params: {} }, signal: new AbortController().signal }
  const disabled = ctx.tools.checkGuards(execution)
  const enabled = control.enable('smoke-session')
  const allowed = ctx.tools.checkGuards({ ...execution, callId: 'enabled' })
  const unrelated = ctx.tools.checkGuards({ ...execution, callId: 'other-session', agent: { session: { id: 'other' } } })
  const stopped = control.stop()
  assert.equal(initial.phase, 'disabled')
  assert.equal(enabled.phase, 'ready')
  assert.equal(stopped.phase, 'disabled')
  assert.equal(disabled, 'COMPUTER_USE_DISABLED')
  assert.equal(allowed, undefined)
  assert.equal(unrelated, 'COMPUTER_USE_SESSION_NOT_AUTHORIZED')
  console.log(JSON.stringify({ entry: import.meta.resolve('@lumo/computer-use'),
    windowsEntry: import.meta.resolve('@lumo/computer-use/windows'),
    registryEntry: import.meta.resolve('@lumo/computer-use/windows-registry'),
    phases: [initial.phase, enabled.phase, stopped.phase], disabled, unrelated, owner: stopped.ownerSessionId }))
} finally { await ctx.fiber.dispose() }
`
  const child = spawnSync(process.execPath, ['--no-experimental-strip-types', '--input-type=module', '-e', source], {
    cwd: runtimeRoot, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  })
  expect(child.status, child.stderr || child.error?.message).toBe(0)
  const result = JSON.parse(child.stdout)
  expect(fileURLToPath(result.entry)).toBe(join(destination, 'lib/index.js'))
  expect(fileURLToPath(result.windowsEntry)).toBe(join(destination, 'lib/windows.js'))
  expect(fileURLToPath(result.registryEntry)).toBe(join(destination, 'lib/windows-registry.js'))
  expect(result).toMatchObject({ phases: ['disabled', 'ready', 'disabled'],
    disabled: 'COMPUTER_USE_DISABLED', unrelated: 'COMPUTER_USE_SESSION_NOT_AUTHORIZED', owner: null })
})
