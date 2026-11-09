import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const installer = fileURLToPath(new URL('../../upstream/install-components.sh', import.meta.url))
const platformJob = source => source.match(/^  platform:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/mu)?.[1] ?? ''
const steps = source => platformJob(source).match(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gmu) ?? []

function snapshotPreparation(source) {
  const blocks = steps(source)
  const preparation = blocks.find(block => block.startsWith('      - name: Prepare pinned skill snapshots\n'))
  const installation = blocks.find(block => block.startsWith('      - name: Install isolated document runtime\n'))
  assert.ok(preparation, 'A clean checkout needs pinned skill snapshots before pip reads requirements')
  assert.ok(installation, 'Document installation step must exist')
  assert.ok(blocks.indexOf(preparation) < blocks.indexOf(installation), 'Snapshot preparation must run before the pip installation step')
  const command = preparation.match(/^        run: (.+)$/mu)?.[1]
  assert.equal(command, 'bash upstream/install-components.sh --snapshots-only')
  return { command, preparation, installation }
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`)
  return result.stdout.trim()
}

function executable(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, { mode: 0o755 })
}

test('the actual CI preparation reconstructs pinned skills from an empty checkout without desktop installation', () => {
  const { command } = snapshotPreparation(workflow)
  const root = mkdtempSync(join(tmpdir(), 'lumo-ci-bootstrap-'))
  try {
    const platform = join(root, 'platform')
    const upstream = join(platform, 'upstream')
    const bin = join(root, 'bin')
    const nativeCalls = join(root, 'unexpected-native-call')
    mkdirSync(upstream, { recursive: true })
    copyFileSync(installer, join(upstream, 'install-components.sh'))
    const skills = ['gpt-image-2-style-library', 'archify', 'ppt-master'].map(name => {
      const repository = join(root, 'repositories', name)
      const subpath = `skills/${name}`
      mkdirSync(join(repository, subpath), { recursive: true })
      checked('git', ['init', '-q', repository])
      writeFileSync(join(repository, subpath, 'SKILL.md'), `# ${name}: pinned snapshot\n`)
      if (name === 'ppt-master') writeFileSync(join(repository, subpath, 'requirements.txt'), 'PyMuPDF>=1.23.0\n')
      checked('git', ['-C', repository, 'add', '.'])
      const commit = message => checked('git', ['-C', repository, '-c', 'user.name=Lumo CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message])
      commit('fixed skill snapshot')
      const pin = checked('git', ['-C', repository, 'rev-parse', 'HEAD'])
      writeFileSync(join(repository, subpath, 'SKILL.md'), '# Later unpinned content must not be installed\n')
      checked('git', ['-C', repository, 'add', '.'])
      commit('later upstream change')
      assert.notEqual(checked('git', ['-C', repository, 'rev-parse', 'HEAD']), pin)
      return { name, repository: pathToFileURL(repository).href, path: subpath, commit: pin }
    })
    writeFileSync(join(upstream, 'skill-sources.json'), JSON.stringify({ schemaVersion: 1, skills }))
    const python = checked('python3', ['-c', 'import sys; print(sys.executable)'])
    for (const tool of ['pnpm', 'corepack', 'npm', 'cargo']) {
      executable(join(bin, tool), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(nativeCalls)}, ${JSON.stringify(tool)}); process.exit(97);\n`)
    }
    assert.equal(existsSync(join(upstream, 'skills')), false)
    checked('bash', ['-c', command], {
      cwd: platform,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, LUMO_PPT_BOOTSTRAP_PYTHON: python, LUMO_DESKTOP_TARGET: 'darwin-x64' },
      timeout: 30_000,
    })
    assert.deepEqual(readdirSync(join(upstream, 'skills')).sort(), skills.map(skill => skill.name).sort())
    for (const skill of skills) {
      const directory = join(upstream, 'skills', skill.name)
      assert.equal(readFileSync(join(directory, 'SKILL.md'), 'utf8'), `# ${skill.name}: pinned snapshot\n`)
      assert.ok(!readdirSync(directory).some(name => name.startsWith('.venv')), 'Snapshot-only preparation must not create a desktop venv')
    }
    assert.equal(readFileSync(join(upstream, 'skills/ppt-master/requirements.txt'), 'utf8'), 'PyMuPDF>=1.23.0\n')
    assert.equal(existsSync(nativeCalls), false, 'Snapshot-only preparation must stop before native dependency installation')
    assert.equal(existsSync(join(root, 'deepseek-harness')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the bootstrap contract rejects an omitted preparation or preparation after pip', () => {
  const { preparation, installation } = snapshotPreparation(workflow)
  assert.throws(() => snapshotPreparation(workflow.replace(preparation, '')), /clean checkout/u)
  const late = workflow.replace(preparation, '').replace(installation, installation + preparation)
  assert.throws(() => snapshotPreparation(late), /before the pip/u)
})

function readinessCommands(source) {
  const flattened = source.replace(/\\\r?\n\s*/gu, ' ')
  const commands = flattened.split('\n').map(line => line.trim()).filter(line => line.startsWith('curl ') && line.includes('/minio/health/ready'))
  assert.equal(commands.length, 2, 'Both platform and registry startup must have readiness probes')
  for (const command of commands) {
    assert.match(command, /--retry-all-errors(?:\s|$)/u, 'Connection reset must be retryable')
    assert.match(command, /--noproxy '\*'/u, 'Loopback readiness must bypass proxy environment')
  }
  return commands
}

async function run(command, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdout.resume()
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Readiness probe exceeded its test budget')) }, 8_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', status => { clearTimeout(timeout); resolve({ status, stderr }) })
  })
}

async function readinessFixture(command, mode, callback) {
  const root = mkdtempSync(join(tmpdir(), 'lumo-ci-readiness-'))
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    assert.equal(request.url, '/minio/health/ready')
    if (mode === 'reset' && requests === 1) { request.socket.resetAndDestroy(); return }
    response.writeHead(mode === 'unhealthy' ? 503 : 200, { Connection: 'close' })
    response.end(mode === 'unhealthy' ? 'not ready' : 'ready')
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const bin = join(root, 'bin')
    const curl = checked('sh', ['-c', 'command -v curl'])
    // Keep the workflow's error classification and proxy flags; only shorten its
    // retry/time budgets so a persistent 503 costs one second in this fixture.
    executable(join(bin, 'curl'), `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nconst budgets = new Map([['--retry', '1'], ['--retry-delay', '1'], ['--retry-max-time', '2'], ['--max-time', '1']]);\nfor (let i = 0; i < args.length; i++) if (budgets.has(args[i])) args[++i] = budgets.get(args[i - 1]);\nconst result = spawnSync(${JSON.stringify(curl)}, args, { stdio: 'inherit' });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`)
    const endpoint = `http://127.0.0.1:${server.address().port}/minio/health/ready`
    const actual = command.replace('http://127.0.0.1:19000/minio/health/ready', endpoint)
    assert.notEqual(actual, command)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1', NO_PROXY: '', no_proxy: '' }
    await callback(actual, env, () => requests)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
}

test('both actual MinIO readiness commands retry a connection reset and bypass proxies', async () => {
  for (const command of readinessCommands(workflow)) {
    await readinessFixture(command, 'reset', async (actual, env, requests) => {
      const result = await run(actual, env)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stderr, /reset|Recv failure/iu)
      assert.equal(requests(), 2)
    })
  }
})

test('both MinIO readiness commands fail within a bounded retry budget when never ready', async () => {
  for (const command of readinessCommands(workflow)) {
    await readinessFixture(command, 'unhealthy', async (actual, env, requests) => {
      const started = Date.now()
      const result = await run(actual, env)
      assert.equal(result.status, 22, result.stderr)
      assert.equal(requests(), 2)
      assert.ok(Date.now() - started < 5_000)
    })
  }
})
