import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Unit tests embed the checked-in static assets and do not build/package a runtime.
const root = fileURLToPath(new URL('.', import.meta.url))
const config = readFileSync(new URL('./tauri.test.conf.json', import.meta.url), 'utf8')
const result = spawnSync('cargo', ['test', '--locked', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TAURI_CONFIG: config },
})
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
