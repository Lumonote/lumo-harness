// 守卫 3：仓库内禁止出现备份/合并残留文件（*.bak*、*.orig、*.orig2 …、*.rej、*~）。
import { walk } from './lib.mjs'

export const name = 'no-backup-files'
export const description = '禁止项目内出现 *.bak* / *.orig 等备份文件'
export const BACKUP_RE = /(\.bak[^/]*|\.orig\d*|\.rej|~)$/i

export function isBackupName(fileName) {
  return /\.bak/i.test(fileName) || BACKUP_RE.test(fileName)
}

export function check({ repoRoot }) {
  const errors = []
  for (const rel of walk(repoRoot, { skipPrefixes: ['platform/upstream/skills/'] })) {
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (isBackupName(base)) errors.push(`${rel}: 备份文件不得放进项目目录（请移到仓库外或删除）`)
  }
  return { errors, warnings: [] }
}
