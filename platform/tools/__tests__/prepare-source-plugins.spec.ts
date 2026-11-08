import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const preparePath = fileURLToPath(new URL('../prepare-source-plugins.mjs', import.meta.url))
const fetchPath = fileURLToPath(new URL('../source-plugin-fetch.mjs', import.meta.url))
const commit = '6337fc823ce20251c8de8085948165c81aaa701e'
const pin = { name: 'dsh-superagent', version: '0.1.0', source: {
  repository: 'https://github.com/deepseek-ai/dsh-superagent-prototype.git', commit,
} }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface Call { command: 'git' | 'corepack' | 'tsdown'; args: string[]; cwd: string }

function executable(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o755 })
}

/** Invoke a copied real builder through its CLI and fake only external tools.
 * All fixtures stay in a disposable tree; no Git repository or package is fetched.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo source plugins (&) ')))
  roots.push(root)
  const platform = join(root, 'platform')
  const tools = join(platform, 'tools')
  const bin = join(root, 'tool bin (&)')
  const log = join(root, 'calls.jsonl')
  mkdirSync(tools, { recursive: true }); mkdirSync(bin)
  copyFileSync(preparePath, join(tools, 'prepare-source-plugins.mjs'))
  copyFileSync(fetchPath, join(tools, 'source-plugin-fetch.mjs'))
  const manifest = join(platform, 'shared/manifests/plugin-baseline.manifest.json')
  mkdirSync(dirname(manifest), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ baseline: [pin] }))
  const tsdown = `const fs = require('node:fs');
const path = require('node:path');
const log = process.env.LUMO_SOURCE_TEST_LOG;
fs.appendFileSync(log, JSON.stringify({ command: 'tsdown', args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.env.LUMO_SOURCE_TEST_BUILD_EXIT) process.exit(Number(process.env.LUMO_SOURCE_TEST_BUILD_EXIT));
const generation = fs.readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse).filter(call => call.command === 'tsdown').length;
fs.mkdirSync('lib', { recursive: true });
for (const name of ['index', 'client', 'github-watch', 'feishu-watch']) {
  fs.writeFileSync(path.join('lib', name + '.js'), 'export const generation = ' + generation + ';\\n');
}
`
  executable(join(bin, 'git'), `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LUMO_SOURCE_TEST_LOG, JSON.stringify({ command: 'git', args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'init') { fs.mkdirSync(path.join(args[1], '.git'), { recursive: true }); process.exit(0); }
const directoryIndex = args.indexOf('-C');
if (directoryIndex < 0) process.exit(91);
const checkout = args[directoryIndex + 1];
const operation = args[directoryIndex + 2];
if (operation === 'remote' || operation === 'fetch') process.exit(0);
if (operation === 'rev-parse') { process.stdout.write((process.env.LUMO_SOURCE_TEST_ACTUAL_COMMIT || ${JSON.stringify(commit)}) + '\\n'); process.exit(0); }
if (operation !== 'checkout') process.exit(92);
const write = (name, contents) => { const target = path.join(checkout, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); };
write('package.json', JSON.stringify({ name: ${JSON.stringify(pin.name)}, version: ${JSON.stringify(pin.version)}, type: 'module', packageManager: 'pnpm@11.7.0' }));
write('node_modules/tsdown/package.json', JSON.stringify({ name: 'tsdown', bin: 'entry.cjs' }));
write('node_modules/tsdown/entry.cjs', ${JSON.stringify(tsdown)});
for (const name of ['cordis.patch.yml', 'locale/en.yml', 'README.md', 'LICENSE', 'prompts/task.md', 'skills/helper/SKILL.md']) write(name, 'fixture: ' + name + '\\n');
`)
  executable(join(bin, 'corepack'), `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LUMO_SOURCE_TEST_LOG, JSON.stringify({ command: 'corepack', args, cwd: process.cwd() }) + '\\n');
if (args.includes('--prod')) {
  fs.mkdirSync(path.join('node_modules', 'fixture-runtime'), { recursive: true });
  fs.writeFileSync(path.join('node_modules', 'fixture-runtime', 'index.js'), 'module.exports = true;\\n');
}
`)
  const run = (overrides: Record<string, string> = {}) => spawnSync(process.execPath, [join(tools, 'prepare-source-plugins.mjs'), platform], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LUMO_SOURCE_TEST_LOG: log, ...overrides },
  })
  const calls = (): Call[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call) : []
  const parent = join(platform, '.build/source-plugins')
  const target = join(parent, pin.name)
  const invalidate = () => appendFileSync(join(tools, 'source-plugin-fetch.mjs'), '\n// Changed fetch implementation fixture.\n')
  return { run, calls, parent, target, invalidate }
}

function assertSuccess(result: ReturnType<ReturnType<typeof fixture>['run']>) {
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

const fetchCalls = (calls: Call[]) => calls.filter(call => call.command === 'git' && call.args.includes('fetch'))
const installCalls = (calls: Call[]) => calls.filter(call => call.command === 'corepack')

// The fake executables use POSIX shebangs. These process-boundary cases do not
// substitute for a native Windows build of the actual pinned source bundle.
describe.skipIf(process.platform === 'win32')('source plugin build, cache and immutable commit contract', () => {
  it('builds a complete pinned distribution, then reuses it without fetching or installing again', () => {
    const f = fixture()
    assertSuccess(f.run())
    const builtCalls = f.calls()
    expect(fetchCalls(builtCalls)).toHaveLength(1)
    expect(fetchCalls(builtCalls)[0]?.args).toEqual(['-c', 'http.version=HTTP/1.1', '-C', expect.any(String), 'fetch', '--depth', '1', 'origin', commit])
    expect(installCalls(builtCalls)).toHaveLength(2)
    expect(installCalls(builtCalls)[0]?.args).toContain('--frozen-lockfile')
    expect(installCalls(builtCalls)[1]?.args).toContain('--prod')
    for (const file of ['lib/index.js', 'lib/client.js', 'lib/github-watch.js', 'lib/feishu-watch.js', 'cordis.patch.yml', 'locale/en.yml', 'prompts/task.md', 'skills/helper/SKILL.md', 'node_modules/fixture-runtime/index.js']) {
      expect(existsSync(join(f.target, file)), file).toBe(true)
    }
    expect(JSON.parse(readFileSync(join(f.target, 'package.json'), 'utf8'))).toMatchObject({ name: pin.name, version: pin.version, lumoSource: pin.source })
    expect(readFileSync(join(f.target, '.lumo-source-build'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/u)
    assertSuccess(f.run())
    expect(f.calls()).toEqual(builtCalls)
    expect(readdirSync(f.parent)).toEqual([pin.name])
  })

  it.each(['lib/client.js', 'node_modules', 'package.json', 'prompts'])('rebuilds an incomplete cached distribution missing %s', missing => {
    const f = fixture()
    assertSuccess(f.run())
    rmSync(join(f.target, missing), { recursive: true })
    assertSuccess(f.run())
    expect(fetchCalls(f.calls())).toHaveLength(2)
    expect(installCalls(f.calls())).toHaveLength(4)
    expect(readFileSync(join(f.target, 'lib/client.js'), 'utf8')).toContain('generation = 2')
    expect(readdirSync(f.parent)).toEqual([pin.name])
  })

  it('invalidates the build fingerprint when the fetch helper changes', () => {
    const f = fixture()
    assertSuccess(f.run())
    const marker = readFileSync(join(f.target, '.lumo-source-build'), 'utf8')
    f.invalidate()
    assertSuccess(f.run())
    expect(fetchCalls(f.calls())).toHaveLength(2)
    expect(readFileSync(join(f.target, '.lumo-source-build'), 'utf8')).not.toBe(marker)
    expect(readFileSync(join(f.target, 'lib/index.js'), 'utf8')).toContain('generation = 2')
  })

  it('rejects a different checkout commit before installation, preserving the previous build and removing staging', () => {
    const f = fixture()
    assertSuccess(f.run())
    const marker = readFileSync(join(f.target, '.lumo-source-build'), 'utf8')
    const output = readFileSync(join(f.target, 'lib/index.js'), 'utf8')
    const previousInstalls = installCalls(f.calls())
    f.invalidate()
    const result = f.run({ LUMO_SOURCE_TEST_ACTUAL_COMMIT: '0'.repeat(40) })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Source commit differs from baseline pin')
    expect(fetchCalls(f.calls())).toHaveLength(2)
    expect(installCalls(f.calls())).toEqual(previousInstalls)
    expect(readFileSync(join(f.target, '.lumo-source-build'), 'utf8')).toBe(marker)
    expect(readFileSync(join(f.target, 'lib/index.js'), 'utf8')).toBe(output)
    expect(readdirSync(f.parent)).toEqual([pin.name])
  })

  it('does not publish or replace a previously successful distribution when compilation fails', () => {
    const f = fixture()
    assertSuccess(f.run())
    const marker = readFileSync(join(f.target, '.lumo-source-build'), 'utf8')
    const output = readFileSync(join(f.target, 'lib/index.js'), 'utf8')
    f.invalidate()
    const result = f.run({ LUMO_SOURCE_TEST_BUILD_EXIT: '47' })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('failed (47)')
    expect(fetchCalls(f.calls())).toHaveLength(2)
    // The failed build reaches dev dependency install, never the prod install.
    expect(installCalls(f.calls())).toHaveLength(3)
    expect(readFileSync(join(f.target, '.lumo-source-build'), 'utf8')).toBe(marker)
    expect(readFileSync(join(f.target, 'lib/index.js'), 'utf8')).toBe(output)
    expect(readdirSync(f.parent)).toEqual([pin.name])
  })
})
