import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSkillHubArchive, stageSkillHub, verifySkillHubRuntime } from '../skillhub-tooling.mjs'

const roots: string[] = []
const pythonCommand = process.platform === 'win32' ? 'python' : 'python3'
const pythonHome = execFileSync(pythonCommand, ['-c', 'import sys; print(sys.base_prefix)'], { encoding: 'utf8' }).trim()
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(options: { missingEntry?: boolean; unsafePath?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lumo skillhub (&) '))
  roots.push(root)
  const runtime = join(root, 'runtime')
  mkdirSync(runtime)
  symlinkSync(process.execPath, join(runtime, nodeName))
  symlinkSync(pythonHome, join(runtime, 'python'), process.platform === 'win32' ? 'junction' : 'dir')
  const cli = join(root, 'skillhub-kit', 'cli')
  mkdirSync(cli, { recursive: true })
  writeFileSync(join(cli, 'release.py'), "VERSION = 'skillhub fixture 1.0'\n")
  if (!options.missingEntry) writeFileSync(join(cli, 'skills_store_cli.py'), `
import argparse, pathlib
from release import VERSION
parser = argparse.ArgumentParser()
parser.add_argument('--version', action='version', version=VERSION)
install = parser.add_subparsers(dest='operation').add_parser('install')
install.add_argument('slug')
install.add_argument('--dir', required=True)
args = parser.parse_args()
target = pathlib.Path(args.dir) / args.slug / 'SKILL.md'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text('---\\nname: ' + args.slug + '\\ndescription: Fixture skill\\n---\\nInstalled body\\n', encoding='utf-8')
`)
  const archive = join(root, 'official-layout.tar.gz')
  execFileSync(pythonCommand, ['-c', `
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as bundle:
    bundle.add(sys.argv[2], arcname='skillhub-kit')
    if sys.argv[3] == 'unsafe':
        entry = tarfile.TarInfo('skillhub-kit/cli/../../escaped.txt')
        entry.size = 3
        bundle.addfile(entry, io.BytesIO(b'bad'))
`, archive, dirname(cli), options.unsafePath ? 'unsafe' : 'safe'])
  return { root, runtime, archive }
}

describe('packaged SkillHub CLI', () => {
  it('stages the CLI and sibling modules, then installs after the app moves to a path with spaces', () => {
    const { root, runtime, archive } = fixture()
    const manifest = stageSkillHub(runtime, archive)
    expect(manifest.version).toBe('skillhub fixture 1.0')
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(join(runtime, 'skillhub', 'release.py'))).toBe(true)
    const moved = join(root, '应用 (&)', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime')
    mkdirSync(dirname(moved), { recursive: true })
    renameSync(runtime, moved)
    expect(verifySkillHubRuntime(moved)).toBe('skillhub fixture 1.0')
    const skills = join(root, '用户技能 (&)')
    // No globally installed CLI/Python and no shell interpretation of the --dir path.
    execFileSync(join(moved, nodeName), [join(moved, 'bin', 'skillhub.mjs'), 'install', 'test-skill', '--dir', skills], {
      env: { ...process.env, PATH: '', PYTHONHOME: '/invalid-python-home', PYTHONPATH: '/invalid-python-path' },
    })
    expect(readFileSync(join(skills, 'test-skill', 'SKILL.md'), 'utf8')).toContain('Installed body')
    if (process.platform !== 'win32') {
      expect(execFileSync(join(moved, 'bin', 'skillhub'), ['--version'], { encoding: 'utf8' }).trim()).toBe('skillhub fixture 1.0')
    }
  })

  it('fails verification if the launcher that was missing from the app is removed', () => {
    const { runtime, archive } = fixture()
    stageSkillHub(runtime, archive)
    rmSync(join(runtime, 'bin', 'skillhub.mjs'))
    expect(() => verifySkillHubRuntime(runtime)).toThrow('skillhub.mjs')
  })

  it('fails verification if the Python CLI payload is missing', () => {
    const { runtime, archive } = fixture()
    stageSkillHub(runtime, archive)
    rmSync(join(runtime, 'skillhub', 'skills_store_cli.py'))
    expect(() => verifySkillHubRuntime(runtime)).toThrow('skills_store_cli.py')
  })

  it('rejects an archive without the official entrypoint', () => {
    const { runtime, archive } = fixture({ missingEntry: true })
    expect(() => stageSkillHub(runtime, archive)).toThrow('skills_store_cli.py')
  })

  it('rejects paths escaping the CLI directory', () => {
    const { runtime, archive } = fixture({ unsafePath: true })
    expect(() => stageSkillHub(runtime, archive)).toThrow('Unsafe SkillHub archive path')
    expect(existsSync(join(runtime, 'escaped.txt'))).toBe(false)
  })

  it('uses an explicit offline archive or the downloaded cache without a global installation', () => {
    const { root, archive } = fixture()
    expect(prepareSkillHubArchive(join(root, 'empty-cache'), archive)).toBe(resolve(archive))
    const cache = join(root, 'cache')
    mkdirSync(cache)
    renameSync(archive, join(cache, 'latest.tar.gz'))
    expect(prepareSkillHubArchive(cache, '')).toBe(join(cache, 'latest.tar.gz'))
    expect(() => prepareSkillHubArchive(cache, join(root, 'missing.tar.gz'))).toThrow('归档不存在')
  })
})
