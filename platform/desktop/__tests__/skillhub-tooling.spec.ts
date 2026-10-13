import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSkillHubArchive, skillHubArchiveUrls, stageSkillHub, verifySkillHubRuntime } from '../skillhub-tooling.mjs'

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

/** 在指定源列表下运行断言，结束后还原调用方的环境（用例之间不得互相污染源配置）。 */
function withArchiveUrls(value: string, body: () => void) {
  const previous = process.env.LUMO_SKILLHUB_ARCHIVE_URLS
  process.env.LUMO_SKILLHUB_ARCHIVE_URLS = value
  try {
    body()
  } finally {
    if (previous === undefined) delete process.env.LUMO_SKILLHUB_ARCHIVE_URLS
    else process.env.LUMO_SKILLHUB_ARCHIVE_URLS = previous
  }
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
    expect(prepareSkillHubArchive(join(root, 'empty-cache'), archive).archive).toBe(resolve(archive))
    const cache = join(root, 'cache')
    mkdirSync(cache)
    renameSync(archive, join(cache, 'latest.tar.gz'))
    expect(prepareSkillHubArchive(cache, '').archive).toBe(join(cache, 'latest.tar.gz'))
    expect(() => prepareSkillHubArchive(cache, join(root, 'missing.tar.gz'))).toThrow('归档不存在')
  })

  it('falls back to the next source when the first address yields no gzip archive', () => {
    const { root, archive } = fixture()
    const good = join(root, 'good.tar.gz')
    cpSync(archive, good)
    // 首个地址必须「连得上但给不出 gzip」，才能证明第二次尝试真的接上了手；
    // 用 .invalid 域名只会停在 DNS，测不出「换源」这件事。file URL 走
    // pathToFileURL 而非字符串拼接：临时目录名含空格与 & ，裸拼会被 curl 判为非法 URL。
    const notAnArchive = pathToFileURL(join(root, 'not-an-archive')).href
    writeFileSync(fileURLToPath(notAnArchive), 'gateway says 200')
    const goodUrl = pathToFileURL(good).href
    const cache = join(root, 'fallback-cache')
    withArchiveUrls(`${notAnArchive},${goodUrl}`, () => {
      const prepared = prepareSkillHubArchive(cache)
      expect(prepared.archive).toBe(join(cache, 'latest.tar.gz'))
      // 清单里的来源必须是真正取到归档的那个地址，而不是列表里的第一个。
      expect(prepared.source).toBe(goodUrl)
      const staged = stageSkillHub(join(root, 'runtime'), prepared.archive, process.platform, prepared.source)
      expect(staged.source).toBe(goodUrl)
    })
  })

  it('names every attempted address plus both escape hatches when all sources fail', () => {
    const { root } = fixture()
    const notAnArchive = pathToFileURL(join(root, 'not-an-archive')).href
    writeFileSync(fileURLToPath(notAnArchive), 'gateway says 200')
    const unreachable = pathToFileURL(join(root, 'no-such-host.invalid', 'latest.tar.gz')).href
    withArchiveUrls(`${notAnArchive},${unreachable}`, () => {
      const download = () => prepareSkillHubArchive(join(root, 'dead-cache'))
      expect(download).toThrow(/不是 gzip 归档/)
      // 另一个地址也要点名，且给出换源与离线两条出路。
      expect(download).toThrow(/no-such-host\.invalid/)
      expect(download).toThrow(/LUMO_SKILLHUB_ARCHIVE_URLS/)
      expect(download).toThrow(/LUMO_SKILLHUB_ARCHIVE=/)
      // 失败不得留下半个归档进缓存，否则下一轮会直接命中缓存而再也不可能重试。
      expect(existsSync(join(root, 'dead-cache', 'latest.tar.gz'))).toBe(false)
    })
  })

  it('rejects a source list that is empty after trimming', () => {
    const previous = process.env.LUMO_SKILLHUB_ARCHIVE_URLS
    process.env.LUMO_SKILLHUB_ARCHIVE_URLS = ' , '
    try {
      expect(() => skillHubArchiveUrls()).toThrow('没有可用地址')
    } finally {
      if (previous === undefined) delete process.env.LUMO_SKILLHUB_ARCHIVE_URLS
      else process.env.LUMO_SKILLHUB_ARCHIVE_URLS = previous
    }
  })
})
