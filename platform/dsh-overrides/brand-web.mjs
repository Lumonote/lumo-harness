import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(scriptRoot, '..')

export function brandWebBuild(dshRoot) {
  const dist = resolve(dshRoot, 'apps', 'web', 'dist')
  const indexFile = resolve(dist, 'index.html')
  const manifestFile = resolve(dist, 'manifest.webmanifest')
  if (!existsSync(indexFile) || !existsSync(manifestFile)) {
    throw new Error(`Lumo Web branding requires a completed DSH Web build at ${dist}`)
  }

  const branding = resolve(dist, 'branding')
  mkdirSync(branding, { recursive: true })
  copyFileSync(resolve(platformRoot, 'desktop-assets', 'lumo-logo.png'), resolve(branding, 'logo.png'))

  let html = readFileSync(indexFile, 'utf8')
  html = html.replace(/<link rel="icon"[^>]*>/u, '<link rel="icon" type="image/png" href="/branding/logo.png" />')
  html = html.replace(/<title>[^<]*<\/title>/u, '<title>Lumo</title>')
  writeFileSync(indexFile, html)

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.name = 'Lumo'
  manifest.short_name = 'Lumo'
  manifest.icons = [{ src: '/branding/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' }]
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dshRoot = process.argv[2]
  if (dshRoot === undefined) throw new Error('usage: node platform/dsh-overrides/brand-web.mjs <staged-dsh-root>')
  brandWebBuild(resolve(dshRoot))
}
