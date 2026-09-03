#!/usr/bin/env node

/**
 * SkillHub bridge for Lumo.
 *
 * SkillHub is a skill source/installer, not a DSH Cordis runtime plugin. This
 * command installs into a dedicated local directory, verifies each skill with
 * SkillHub, and emits the snapshot consumed by @lumo/skill-local.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(process.env.LUMO_SKILL_SNAPSHOT_ROOT ?? '.lumo/skills')
const snapshotFile = resolve(process.env.LUMO_SKILL_SNAPSHOT_FILE ?? '.lumo/skill-snapshot.json')

function usage() {
  console.log(`Usage:
  pnpm skillhub search <query>
  pnpm skillhub install <skill> [skill ...]

Environment:
  LUMO_SKILL_SNAPSHOT_ROOT  install directory (default: .lumo/skills)
  LUMO_SKILL_SNAPSHOT_FILE  generated snapshot (default: .lumo/skill-snapshot.json)`)
}

function run(args) {
  const result = spawnSync('skillhub', args, { stdio: 'inherit', encoding: 'utf8' })
  if (result.error) throw new Error(`找不到 SkillHub CLI：${result.error.message}`)
  if (result.status !== 0) throw new Error(`skillhub ${args.join(' ')} 失败，退出码 ${result.status ?? 'unknown'}`)
}

function frontmatter(bytes, directory) {
  const text = bytes.toString('utf8')
  if (!text.startsWith('---\n')) throw new Error(`${directory}/SKILL.md 缺少 frontmatter`)
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${directory}/SKILL.md frontmatter 未闭合`)
  const header = text.slice(4, end)
  const name = header.match(/^name:\s*([^\n]+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  const description = header.match(/^description:\s*([^\n]+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (!name || !description) throw new Error(`${directory}/SKILL.md 必须包含 name 和 description`)
  return { name, description }
}

function emitSnapshot() {
  if (!existsSync(root)) throw new Error(`技能目录不存在：${root}`)
  const skills = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const file = join(root, entry.name, 'SKILL.md')
      const bytes = readFileSync(file)
      const { name, description } = frontmatter(bytes, entry.name)
      if (name !== entry.name) throw new Error(`${entry.name}/SKILL.md 的 name 与目录名不一致`)
      return {
        name,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        description,
      }
    })
  mkdirSync(dirname(snapshotFile), { recursive: true })
  const temporary = `${snapshotFile}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(skills, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, snapshotFile)
  console.log(`已生成 SkillHub 技能快照：${snapshotFile}（${skills.length} 个技能）`)
}

const [command, ...names] = process.argv.slice(2)
if (!command || command === '--help' || command === '-h') {
  usage()
  process.exit(command ? 0 : 1)
}
if (command === 'search') {
  if (names.length === 0) throw new Error('search 需要查询词')
  run(['search', ...names])
} else if (command === 'install') {
  if (names.length === 0) throw new Error('install 至少需要一个技能名')
  mkdirSync(root, { recursive: true })
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*(?:@[^\s]+)?$/.test(name)) throw new Error(`非法技能标识：${name}`)
    run(['install', name, '--dir', root])
    run(['verify', name])
  }
  emitSnapshot()
} else if (command === 'snapshot') {
  emitSnapshot()
} else {
  usage()
  throw new Error(`未知命令：${command}`)
}
