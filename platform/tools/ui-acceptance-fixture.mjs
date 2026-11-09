import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAcceptanceOptions, runUIAcceptance } from './ui-acceptance.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const upstream = createRequire(resolve(here, '../../deepseek-harness/package.json'))
const reactRequire = createRequire(upstream.resolve('react', { paths: [resolve(here, '../../deepseek-harness/packages/client/ui-jobs')] }))
const buildRequire = createRequire(upstream.resolve('tsdown'))

const account = { mode: 'session', provider: 'lumo-governance', username: 'ui-fixture', displayName: '隔离验收用户', userId: 'ui-fixture', realm: 'ui-fixture', roles: ['realm_admin'], department: '', clientIp: '127.0.0.1', captchaMode: 'always', localAuthEnabled: true, authMethod: 'local' }
const overview = { generatedAt: '2026-11-09T00:00:00Z', deployment: { mode: 'standalone', label: '隔离验收服务', storage: 'postgres', middleware: [], distributed: false, desktop: false, clusterReady: false, clusterOnly: false }, services: {}, cluster: { nodes: [] }, projects: [], flows: [], connectors: [], plugins: [] }
const emptyRead = { ok: true, status: 200, data: {} }
const responses = {
  '/lumo/api/overview': overview,
  '/lumo/api/capabilities': { organization: false },
  '/lumo/api/governance': { local: false, features: emptyRead, departments: emptyRead, roles: emptyRead, catalog: emptyRead, effective: emptyRead, permissions: emptyRead },
  '/lumo/api/delegations': { tasks: [] }, '/lumo/api/users': { users: [] },
  '/lumo/api/agent-presets': { agent_presets: [] }, '/lumo/api/workers': { workers: [] },
  '/lumo/api/projects': { projects: [] }, '/lumo/api/cluster-capabilities': { organization: false },
  '/lumo/api/registry/artifacts': { items: [], source: 'registry_index', state: 'discoverable' },
  '/lumo/api/registry/installations': { items: [], source: 'provisioner_reports' },
  '/lumo/api/registry/rollouts': { items: [], source: 'desired_state', channel: 'stable' },
  '/lumo/api/knowledge/sources': { realm: 'ui-fixture', state: 'synchronized', sources: [] },
  '/lumo/api/knowledge/library/folders': { folders: [] }, '/lumo/api/knowledge/library/files': { files: [] },
  '/auth/account': account, '/auth/account/sessions': { sessions: [] }, '/auth/account/security-events': { events: [] },
  '/auth/account/mfa': { configured: false, enabled: false }, '/auth/account/passkeys': { configured: false, passkeys: [] },
}

export async function startUIAcceptanceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumo-ui-fixture-'))
  const { rolldown } = await import(pathToFileURL(buildRequire.resolve('rolldown')).href)
  const cssPrefix = '\0lumo-fixture-css:'
  try {
    const bundle = await rolldown({
      input: resolve(here, 'fixtures/ui-acceptance-entry.tsx'),
      platform: 'browser',
      transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
      plugins: [{
        name: 'lumo-fixture-boundaries',
        resolveId(source, importer) {
          if (source === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client') return resolve(here, '../dsh-plugins/lumo-ui/__tests__/fixtures/document-preview.ts')
          if (/^react(?:-dom)?(?:\/|$)/u.test(source)) return reactRequire.resolve(source)
          if (source.endsWith('.css') && importer) return cssPrefix + resolve(dirname(importer), source) + '.mjs'
          return null
        },
        async load(id) {
          if (!id.startsWith(cssPrefix)) return null
          const css = await readFile(id.slice(cssPrefix.length, -4), 'utf8')
          return `const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);`
        },
      }],
    })
    await bundle.write({ file: join(directory, 'client.js'), format: 'iife' })
    await bundle.close()
    const script = await readFile(join(directory, 'client.js'))
    const server = createServer((request, response) => {
      const path = new URL(request.url, 'http://fixture.invalid').pathname
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Lumo-Acceptance-Fixture', 'source-workbench-read-only')
      if (path === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); return }
      if (path === '/' || path === '/index.html') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumo isolated UI acceptance</title><body style="margin:0"><div id="root"></div><script src="/client.js"></script></body></html>'); return }
      response.setHeader('Content-Type', 'application/json')
      if (path in responses) { response.end(JSON.stringify(responses[path])); return }
      if (path === '/lumo/api/knowledge/vault/status') { response.writeHead(404); response.end('{"error":"not_installed"}'); return }
      response.writeHead(501); response.end(JSON.stringify({ error: `unimplemented_fixture_read:${path}` }))
    })
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
    return { baseURL: `http://127.0.0.1:${server.address().port}/`, async close() { await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

/** Run and close the isolated source fixture in one process, including failures. */
export async function runUIAcceptanceFixture(options, dependencies) {
  const fixture = await startUIAcceptanceFixture()
  try { return await runUIAcceptance({ ...options, baseURL: fixture.baseURL }, dependencies) }
  finally { await fixture.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length) {
      if (args.includes('--base-url') || args.includes('--storage-state')) throw Error('Fixture accepts only --output <new directory> [--headless]; deployment URLs and credentials belong to ui-acceptance.mjs')
      const options = parseAcceptanceOptions(['--base-url', 'http://fixture.invalid/', ...args])
      console.log(JSON.stringify(await runUIAcceptanceFixture(options), null, 2))
    } else {
      const fixture = await startUIAcceptanceFixture()
      console.log(fixture.baseURL)
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0) })
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
