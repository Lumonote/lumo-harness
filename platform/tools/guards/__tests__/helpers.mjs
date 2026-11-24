import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 在临时目录里按 { 相对路径: 内容 } 建一个假仓库，返回根目录。 */
export function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumo-guard-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}
