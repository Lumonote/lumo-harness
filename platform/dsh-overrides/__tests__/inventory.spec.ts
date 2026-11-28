import { describe, expect, it } from 'vitest'
import { overriddenPackageDirectories } from '../apply.mjs'
import { auditOverlayEffects, overlayInventory, validateOverlayInventory } from '../inventory.mjs'

describe('overlay debt inventory', () => {
  it('covers all six build package scopes and root tsdown with explicit removal criteria', () => {
    expect(overriddenPackageDirectories).toHaveLength(6)
    expect(() => validateOverlayInventory(overriddenPackageDirectories)).not.toThrow()
    expect(overlayInventory.rootFiles.map(item => item.path)).toEqual(['tsdown.config.ts'])
    expect(() => validateOverlayInventory([...overriddenPackageDirectories, 'packages/hidden'])).toThrow('differs')
  })
  it('audits byte changes including additions, while allowing native boot packages to stay unchanged', () => {
    const before = new Map<string, Buffer>(), after = new Map<string, Buffer>()
    for (const item of overlayInventory.packages) {
      for (const file of item.files) {
        const path = `${item.path}/${file}`
        before.set(path, Buffer.from('original'))
        after.set(path, Buffer.from(item.mode === 'rewrite' ? 'changed' : 'original'))
      }
      for (const file of item.addedFiles ?? []) after.set(`${item.path}/${file}`, Buffer.from('new'))
    }
    before.set('tsdown.config.ts', Buffer.from('original')); after.set('tsdown.config.ts', Buffer.from('changed'))
    const report = auditOverlayEffects(before, after)
    expect(report.packageCount).toBe(6)
    expect(report.unchangedCompatibilityPackages).toEqual(['packages/client/modules', 'packages/client/web'])
    after.set('packages/unlisted/src/index.ts', Buffer.from('surprise'))
    expect(() => auditOverlayEffects(before, after)).toThrow('Undocumented overlay change')
    after.delete('packages/unlisted/src/index.ts'); after.set('tsdown.config.ts', Buffer.from('original'))
    expect(() => auditOverlayEffects(before, after)).toThrow('review removal')
  })
})
