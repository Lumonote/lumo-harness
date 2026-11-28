import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

export const overlayInventory = JSON.parse(readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'))

export function validateOverlayInventory(packages, inventory = overlayInventory) {
  if (inventory.version !== 1) throw Error('Unsupported overlay inventory version')
  const declared = inventory.packages.map(item => item.path)
  if (new Set(declared).size !== declared.length || JSON.stringify([...declared].sort()) !== JSON.stringify([...packages].sort())) {
    throw Error('Overlay package inventory differs from apply.mjs overriddenPackageDirectories')
  }
  if (JSON.stringify(inventory.rootFiles.map(item => item.path)) !== JSON.stringify(['tsdown.config.ts'])) throw Error('Overlay root inventory must match tsdown.config.ts')
  for (const item of [...inventory.packages, ...inventory.rootFiles]) {
    if (!item.purpose || !item.replacement || !item.exitGate || !Number.isInteger(item.exitPriority)) throw Error(`Overlay exit plan missing: ${item.path}`)
  }
}

export function snapshotOverlayFiles(root) {
  const result = new Map()
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) result.set(relative(root, path).replaceAll('\\', '/'), readFileSync(path))
    }
  }
  // The check runs in a disposable source-only copy; scan its entire tree so
  // accidentally added files outside the declared packages cannot escape audit.
  walk(root)
  return result
}

/** Compare actual before/after bytes in a disposable copy, including copied assets. */
export function auditOverlayEffects(before, after, inventory = overlayInventory) {
  const declared = new Set(inventory.rootFiles.map(item => item.path))
  const required = new Set(declared)
  for (const item of inventory.packages) {
    for (const file of [...item.files, ...(item.addedFiles ?? [])]) {
      const path = `${item.path}/${file}`
      declared.add(path)
      if (item.mode === 'rewrite') required.add(path)
      if (!after.has(path)) throw Error(`Inventory file absent after overlay: ${path}`)
    }
  }
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => !before.has(path) || !after.has(path) || !before.get(path).equals(after.get(path))).sort()
  for (const file of changed) if (!declared.has(file)) throw Error(`Undocumented overlay change: ${file}`)
  for (const file of required) if (!changed.includes(file)) throw Error(`Documented overlay no longer changes source; review removal: ${file}`)
  return {
    inventoryVersion: inventory.version,
    packageCount: inventory.packages.length,
    rootFiles: inventory.rootFiles.map(item => item.path),
    changedFiles: changed,
    unchangedCompatibilityPackages: inventory.packages.filter(item => !changed.some(path => path.startsWith(`${item.path}/`))).map(item => item.path),
  }
}
