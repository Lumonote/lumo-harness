import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'
import { localStorageRows, profileLifetimeOverlay, profileStorageRows, workflowEngineOverlay } from '../src/workflow.ts'

const upstream = new URL('../../../../deepseek-harness/', import.meta.url)
const require = createRequire(new URL('vendor/include/package.json', upstream))
const yaml = require('js-yaml') as { load(text: string, options: object): PatchOptions[] }
const parse = (text: string) => yaml.load(text, { schema: entryListSchema })
const bundle = (name: string) => parse(readFileSync(new URL(`packages/bundle/${name}/cordis.patch.yml`, upstream), 'utf8'))

describe('composition against the actual upstream bundle contracts', () => {
  it('keeps the headless sandbox independent of the disabled one-shot startup and routes parent workflows remotely', () => {
    const warnings: unknown[] = []
    const warn = (...args: unknown[]) => { warnings.push(args) }
    let rows = applyEntryPatches([], bundle('base'), warn)
    rows = applyEntryPatches(rows, bundle('headless'), warn)
    rows = applyEntryPatches(rows, parse(profileLifetimeOverlay('headless', false)), warn)
    rows = applyEntryPatches(rows, parse(workflowEngineOverlay('agent')), warn)
    expect(warnings).toEqual([])
    expect(rows.find(row => row.id === 'headless-startup')?.disabled).toBe(true)
    const sandbox = rows.find(row => row.id === 'sandbox-policy')!
    expect(sandbox.inject).toEqual([])
    expect(JSON.stringify(sandbox.config)).not.toContain('headlessStartup')
    expect(sandbox.config.mode).toEqual({ __jsExpr: "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'" })
    expect(rows.find(row => row.id === 'workflow-ptc')?.config.provider).toBe('lumo-remote')
    expect(rows.filter(row => row.id === 'storage')).toHaveLength(1)
    expect(profileStorageRows('headless')).toBe('')
    expect(parse(`- insert:\n${localStorageRows('headless', '/tmp/test.sqlite')}`)[0]!.insert?.some(row => row.id === 'storage')).toBe(false)
  })

  it('declares the UI host package as a bundle so the market cannot treat it as client-only', () => {
    const root = new URL('../../../dsh-plugins/lumo-ui/', import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    expect(parse(readFileSync(new URL(manifest.dsh.bundle.patch, root), 'utf8'))).toEqual([])
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.files).toContain(manifest.dsh.bundle.patch)
  })
})
