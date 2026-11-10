import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signingInputKeys, signingInputs } from './prepare-release-signing.mjs'

/** Resolve independently for each desktop target; broken signing never falls back. */
export function resolveReleaseSigning(env = process.env, platform = process.platform) {
  const keys = signingInputKeys(platform)
  const requested = env.LUMO_RELEASE_SIGNING_MODE || 'auto'
  assert.ok(['auto', 'signed', 'unsigned'].includes(requested), 'LUMO_RELEASE_SIGNING_MODE must be auto, signed or unsigned')
  const configured = keys.some(key => env[key] !== undefined && env[key] !== '')
  const mode = requested === 'auto' ? configured ? 'signed' : 'unsigned' : requested
  if (mode === 'signed') signingInputs(env, platform)
  return { mode, required: mode === 'signed' ? '1' : '0' }
}

export function exportReleaseSigning({ env = process.env, platform = process.platform } = {}) {
  const result = resolveReleaseSigning(env, platform)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${result.mode}\nrequired=${result.required}\n`)
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `LUMO_RELEASE_SIGNING_MODE=${result.mode}\nLUMO_RELEASE_SIGNING_REQUIRED=${result.required}\n`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = exportReleaseSigning()
    console.log(`Desktop signing mode: ${result.mode}. ${result.mode === 'signed' ? 'Certificate signing is required; failures stop the build.' : 'No publisher certificate or notarization; installers are labelled unsigned.'}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
