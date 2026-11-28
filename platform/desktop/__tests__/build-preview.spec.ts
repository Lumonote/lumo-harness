import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { projectPreviewFrontend, projectPreviewLibraries } from '../build-preview.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(trackedLibrary = false) {
  const root = mkdtempSync(join(tmpdir(), 'lumo-preview-'))
  roots.push(root)
  const source = join(root, 'upstream'), stage = join(root, 'stage')
  for (const directory of [source, stage]) mkdirSync(join(directory, 'packages/ui/lib'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' })
  writeFileSync(join(source, 'package.json'), '{"name":"fixture"}')
  writeFileSync(join(source, 'packages/ui/package.json'), '{"name":"fixture-ui"}')
  writeFileSync(join(source, 'packages/ui/source.ts'), 'export const unchanged = true')
  writeFileSync(join(source, '.gitignore'), trackedLibrary ? '' : '**/lib/\n**/dist/\n')
  writeFileSync(join(source, 'packages/ui/lib/old.js'), 'old')
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture')
  writeFileSync(join(stage, 'packages/ui/source.ts'), 'must not be projected')
  writeFileSync(join(stage, 'packages/ui/lib/client.js'), 'new bundle')
  return { source, stage, git }
}

it('projects complete generated bundles, removes stale output and preserves all tracked bytes', () => {
  const { source, stage, git } = fixture()
  projectPreviewLibraries(source, stage)
  expect(readFileSync(join(source, 'packages/ui/lib/client.js'), 'utf8')).toBe('new bundle')
  expect(existsSync(join(source, 'packages/ui/lib/old.js'))).toBe(false)
  expect(readFileSync(join(source, 'packages/ui/source.ts'), 'utf8')).toBe('export const unchanged = true')
  expect(git('status', '--porcelain', '-uno')).toBe('')
})

it('refuses overlapping stages and any tracked lib tree before replacing it', () => {
  const { source, stage, git } = fixture(true)
  mkdirSync(join(source, 'stage'))
  expect(() => projectPreviewLibraries(source, source)).toThrow('outside')
  expect(() => projectPreviewLibraries(source, join(source, 'stage'))).toThrow('outside')
  expect(() => projectPreviewLibraries(source, stage)).toThrow('tracked library')
  expect(readFileSync(join(source, 'packages/ui/lib/old.js'), 'utf8')).toBe('old')
  expect(git('status', '--porcelain', '-uno')).toBe('')
})

it('projects the native frontend and refuses dirty source or tracked dist before replacing output', () => {
  const { source, stage, git } = fixture()
  for (const root of [source, stage]) mkdirSync(join(root, 'apps/web/dist'), { recursive: true })
  writeFileSync(join(source, 'apps/web/dist/old.js'), 'stale')
  writeFileSync(join(stage, 'apps/web/dist/index.html'), '<main>native</main>')
  projectPreviewFrontend(source, stage)
  expect(readFileSync(join(source, 'apps/web/dist/index.html'), 'utf8')).toBe('<main>native</main>')
  expect(existsSync(join(source, 'apps/web/dist/old.js'))).toBe(false)
  expect(git('status', '--porcelain', '-uno')).toBe('')
  writeFileSync(join(source, 'package.json'), '{}')
  expect(() => projectPreviewFrontend(source, stage)).toThrow('tracked modifications')
  git('restore', 'package.json')
  git('add', '-f', 'apps/web/dist/index.html')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'tracked dist')
  expect(() => projectPreviewFrontend(source, stage)).toThrow('tracked frontend')
  expect(readFileSync(join(source, 'apps/web/dist/index.html'), 'utf8')).toBe('<main>native</main>')
})

it('refuses missing frontend and symlink aliases of the source', () => {
  const { source, stage } = fixture()
  expect(() => projectPreviewFrontend(source, stage)).toThrow('index is missing')
  const alias = join(stage, 'source-alias')
  symlinkSync(source, alias)
  for (const project of [projectPreviewFrontend, projectPreviewLibraries]) {
    expect(() => project(source, alias)).toThrow('outside')
  }
})
