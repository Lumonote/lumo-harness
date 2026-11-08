import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const installer = fileURLToPath(new URL('../install-components.sh', import.meta.url))
const constraints = fileURLToPath(new URL('../ppt-constraints.txt', import.meta.url))
const sources = fileURLToPath(new URL('../skill-sources.json', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function executable(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, { mode: 0o755 })
}

/** Run the actual installer with complete snapshots and process-boundary fakes.
 * No Python packages, native dependencies or upstream source are installed.
 */
function fixture(target: 'darwin-x64' | 'darwin-arm64' | 'win-x64', installExit = 0, checkExit = 0) {
  const root = mkdtempSync(join(tmpdir(), 'lumo ppt (&) '))
  roots.push(root)
  const upstream = join(root, 'platform', 'upstream')
  const bin = join(root, 'bin')
  mkdirSync(upstream, { recursive: true }); mkdirSync(bin)
  copyFileSync(installer, join(upstream, 'install-components.sh'))
  copyFileSync(constraints, join(upstream, 'ppt-constraints.txt'))
  copyFileSync(sources, join(upstream, 'skill-sources.json'))
  const snapshots = JSON.parse(readFileSync(sources, 'utf8')) as { skills: Array<{ name: string }> }
  for (const skill of snapshots.skills) {
    const path = join(upstream, 'skills', skill.name)
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), '# Pinned snapshot fixture\n')
  }
  const ppt = join(upstream, 'skills', 'ppt-master')
  const requirements = join(ppt, 'requirements.txt')
  writeFileSync(requirements, 'PyMuPDF>=1.23.0\n')
  const log = join(root, 'calls.jsonl')
  const python = join(bin, 'bootstrap-python')
  const fakePython = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-c') {
  if (args[1].includes('print(sys.executable)')) process.stdout.write(process.argv[1] + '\\n');
  process.exit(0);
}
if (args[0] === '-') {
  for (const skill of JSON.parse(fs.readFileSync(args[1], 'utf8')).skills) {
    process.stdout.write([skill.name, skill.repository, skill.path, skill.commit].join('\\t') + '\\n');
  }
  process.exit(0);
}
if (args[0] === '-m' && args[1] === 'pip') {
  fs.appendFileSync(process.env.LUMO_PPT_TEST_LOG, JSON.stringify({ command: 'python', args }) + '\\n');
  process.exit(args[2] === 'install' ? Number(process.env.LUMO_PPT_TEST_INSTALL_EXIT) : Number(process.env.LUMO_PPT_TEST_CHECK_EXIT));
}
process.stderr.write('Unexpected Python invocation: ' + JSON.stringify(args));
process.exit(97);
`
  executable(python, fakePython)
  const venvPython = join(ppt, `.venv-${target}`, ...(target === 'win-x64' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
  executable(venvPython, fakePython)
  executable(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in\n-s) echo '${target === 'win-x64' ? 'MINGW64_NT-10.0' : 'Darwin'}';;\n-m) echo '${target === 'darwin-arm64' ? 'arm64' : 'x86_64'}';;\nesac\n`)
  executable(join(bin, 'otool'), '#!/bin/sh\nprintf "fixture:\\n\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\\n"\n')
  executable(join(bin, 'git'), '#!/bin/sh\necho "Unexpected snapshot network access" >&2\nexit 98\n')
  executable(join(bin, 'corepack'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.LUMO_PPT_TEST_LOG, JSON.stringify({ command: 'corepack', args: process.argv.slice(2) }) + '\\n');\nprocess.exit(69);\n`)
  const run = () => spawnSync('bash', [join(upstream, 'install-components.sh'), '--target', target], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LUMO_PPT_BOOTSTRAP_PYTHON: python,
      LUMO_PIP_ALLOW_RUSTC: '1', LUMO_PPT_TEST_LOG: log,
      LUMO_PPT_TEST_INSTALL_EXIT: String(installExit), LUMO_PPT_TEST_CHECK_EXIT: String(checkExit) },
  })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] }) : []
  return { run, calls, requirements, constraints: join(upstream, 'ppt-constraints.txt') }
}

// POSIX process fakes exercise every target branch, including win-x64. Native
// Windows needs Git Bash path conversion and cannot execute these Node shebangs.
describe.skipIf(process.platform === 'win32')('PPT dependency installation contract', () => {
  it.each(['darwin-x64', 'darwin-arm64', 'win-x64'] as const)('requires constrained wheels and checks installed dependencies on %s', target => {
    const f = fixture(target)
    const result = f.run()
    expect(result.error).toBeUndefined()
    // Stop at the first native dependency operation after Python verification.
    expect(result.status, result.stderr).toBe(69)
    const calls = f.calls()
    expect(calls[0]?.command).toBe('python')
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-m', 'pip', 'install', '--only-binary=:all:', '--constraint', f.constraints, '-r', f.requirements]))
    expect(readFileSync(f.constraints, 'utf8')).toMatch(/^PyMuPDF==1\.27\.2\s*$/mu)
    expect(calls[1]).toEqual({ command: 'python', args: ['-m', 'pip', 'check'] })
    expect(calls[2]?.command).toBe('corepack')
  })

  it('stops before dependency checks or native installation when no wheel can be installed', () => {
    const f = fixture('darwin-x64', 47)
    const result = f.run()
    expect(result.status, result.stderr).toBe(47)
    expect(f.calls()).toHaveLength(1)
    expect(f.calls()[0]?.args).toContain('--only-binary=:all:')
  })

  it('stops before native installation when the installed Python dependencies conflict', () => {
    const f = fixture('darwin-x64', 0, 55)
    const result = f.run()
    expect(result.status, result.stderr).toBe(55)
    expect(f.calls().map(call => call.command)).toEqual(['python', 'python'])
    expect(f.calls()[1]?.args).toEqual(['-m', 'pip', 'check'])
  })
})
