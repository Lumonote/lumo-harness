import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function parseAcceptanceOptions(args) {
  const options = { headless: false }
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--headless') { options.headless = true; continue }
    if (!['--base-url', '--output', '--storage-state'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Unknown or missing argument: ${key}`)
    options[{ '--base-url': 'baseURL', '--output': 'output', '--storage-state': 'storageState' }[key]] = args[++index]
  }
  if (!options.baseURL || !options.output) throw Error('Required: --base-url <explicit URL> --output <new evidence directory> [--storage-state <file>] [--headless]')
  const url = new URL(options.baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Base URL must be HTTP(S), without credentials, query or fragment')
  return { ...options, baseURL: url.href, output: resolve(options.output) }
}

async function playwrightModule() {
  if (process.env.LUMO_PLAYWRIGHT_MODULE) return import(pathToFileURL(resolve(process.env.LUMO_PLAYWRIGHT_MODULE)).href)
  const require = createRequire(resolve(here, '../package.json'))
  return import(pathToFileURL(require.resolve('playwright')).href)
}

function surfaceURL(baseURL, surface) { const url = new URL(baseURL); url.searchParams.set('lumo', surface); return url.href }
const workbench = page => page.locator('.lumo-workbench[role="dialog"]')

async function checkGeometry(page) {
  const geometry = await workbench(page).evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const main = element.querySelector('.lumo-workbench-main > main')
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight, mainWidth: main.clientWidth, mainScroll: main.scrollWidth, pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth }
  })
  assert(geometry.left >= -1 && geometry.right <= geometry.width + 1 && geometry.top >= -1 && geometry.bottom <= geometry.height + 1, `Dialog outside viewport: ${JSON.stringify(geometry)}`)
  assert(geometry.mainScroll <= geometry.mainWidth + 1 && geometry.pageScroll <= geometry.pageWidth + 1, `Horizontal overflow: ${JSON.stringify(geometry)}`)
  return geometry
}

async function checkKeyboard(page) {
  await workbench(page).focus()
  for (const key of ['Tab', 'Shift+Tab', ...Array(20).fill('Tab')]) {
    await page.keyboard.press(key)
    assert(await workbench(page).evaluate(element => element.contains(document.activeElement)), `Focus escaped workbench on ${key}`)
  }
  await page.keyboard.press('Control+k')
  const command = page.getByRole('dialog', { name: 'Lumo 工作区菜单', exact: true })
  await command.waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: '搜索工作区' }).fill('不存在的验收工作区')
  await page.getByText('没有匹配的工作区。', { exact: true }).waitFor()
  await page.keyboard.press('Tab')
  assert(await command.evaluate(element => element.contains(document.activeElement)), 'Focus escaped empty command palette')
  await page.keyboard.press('Escape')
  await command.waitFor({ state: 'hidden' })
  assert(await workbench(page).evaluate(element => element.contains(document.activeElement)), 'Focus did not return to workbench')
}

export async function runUIAcceptance(options, { chromium } = {}) {
  chromium ??= (await playwrightModule()).chromium
  // A new directory prevents old PASS reports or screenshots from surviving a failed run.
  await mkdir(options.output, { recursive: false })
  const report = { schema: 'lumo-ui-acceptance/v1', startedAt: new Date().toISOString(), baseURL: options.baseURL, environment: 'deployment', headless: options.headless === true, checks: [], blockedRequests: [], pageErrors: [], status: 'failed', limitations: ['Read-only workbench flows; no writes, live model calls, native OS actions or PDF/Excel rendering are certified.'] }
  let browser
  try {
    browser = await chromium.launch({ headless: options.headless === true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: options.storageState, serviceWorkers: 'block' })
    await context.route('**/*', async route => {
      const request = route.request()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || new URL(request.url()).origin !== new URL(options.baseURL).origin) {
        report.blockedRequests.push({ method: request.method(), path: new URL(request.url()).pathname })
        await route.abort('blockedbyclient'); return
      }
      await route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => report.pageErrors.push(error.message))
    for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'narrow', width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const surface of ['market', 'knowledge', 'operations', 'account']) {
        const response = await page.goto(surfaceURL(options.baseURL, surface), { waitUntil: 'networkidle' })
        if (response?.headers()['x-lumo-acceptance-fixture']) report.environment = 'isolated-source-fixture'
        await workbench(page).waitFor({ state: 'visible' })
        await page.locator(`.lumo-workbench[data-lumo-view="${surface}"]`).waitFor()
        // Loading must settle, even when the deployment returns an explicit unavailable state.
        await page.waitForFunction(() => !document.querySelector('.lumo-workbench [aria-busy="true"]'))
        const geometry = await checkGeometry(page)
        await checkKeyboard(page)
        await page.screenshot({ path: join(options.output, `${viewport.name}-${surface}.png`) })
        report.checks.push({ name: `${viewport.name}-${surface}`, status: 'passed', geometry })
      }
    }
    // Fail one known read locally, then let the refresh reach the selected host.
    const faultPath = '/lumo/api/knowledge/sources'
    let injected = false
    const fault = async route => {
      if (new URL(route.request().url()).pathname !== faultPath || route.request().method() !== 'GET' || injected) return route.fallback()
      injected = true
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"UI_ACCEPTANCE_TEMPORARY_READ_FAILURE"}' })
    }
    await page.route('**/*', fault)
    await page.goto(surfaceURL(options.baseURL, 'knowledge'), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '来源内容 按空间浏览和维护文档' }).click()
    await page.getByRole('alert').filter({ hasText: 'UI_ACCEPTANCE_TEMPORARY_READ_FAILURE' }).waitFor()
    assert(injected, 'Read fault was not exercised')
    await page.unroute('**/*', fault)
    const refresh = page.getByRole('button', { name: '刷新来源', exact: true })
    const recovered = page.waitForResponse(response => new URL(response.url()).pathname === faultPath && response.request().method() === 'GET')
    await refresh.click()
    const recovery = await recovered
    assert(recovery.ok(), `Recovery read failed with HTTP ${recovery.status()}`)
    await page.getByRole('alert').filter({ hasText: 'UI_ACCEPTANCE_TEMPORARY_READ_FAILURE' }).waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(options.output, 'read-error-recovered.png') })
    report.checks.push({ name: 'knowledge-read-error-recovery', status: 'passed', injectedStatus: 503, recoveredStatus: recovery.status() })
    await page.keyboard.press('Escape')
    await workbench(page).waitFor({ state: 'hidden' })
    await page.evaluate(() => {
      const button = document.createElement('button')
      button.id = 'lumo-acceptance-opener'; button.textContent = 'Lumo acceptance opener'
      button.addEventListener('click', () => window.dispatchEvent(new CustomEvent('lumo:open-workbench', { detail: 'knowledge' })))
      document.body.appendChild(button)
    })
    await page.locator('#lumo-acceptance-opener').click()
    await workbench(page).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await workbench(page).waitFor({ state: 'hidden' })
    assert(await page.locator('#lumo-acceptance-opener').evaluate(element => element === document.activeElement), 'Closing workbench did not restore opener focus')
    await page.locator('#lumo-acceptance-opener').evaluate(element => element.remove())
    report.checks.push({ name: 'opener-focus-restored', status: 'passed' })
    assert.deepEqual(report.pageErrors, [], 'Browser emitted unhandled errors')
    assert.deepEqual(report.blockedRequests, [], 'The read-only run attempted a write or off-origin request')
    report.status = 'passed'
    return report
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error }
  finally {
    await browser?.close()
    report.finishedAt = new Date().toISOString()
    await writeFile(join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runUIAcceptance(parseAcceptanceOptions(process.argv.slice(2))); console.log(JSON.stringify(report, null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
