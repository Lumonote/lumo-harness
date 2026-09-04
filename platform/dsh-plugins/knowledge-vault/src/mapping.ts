/**
 * Vault 源文件 → 知识库文档键的映射（纯函数）。
 * docId 是 vault 相对路径的 base64url（路由只接受 `[^/]+`；相对路径含 `/`，防路由穿透）。
 * space：frontmatter `space:` 覆盖，否则为一级目录；根文件为 `general`。
 * sourceVersion：文件 mtime 的 Unix 秒（契约要求 number；同秒覆盖为单用户罕见情形，接受）。
 */

export interface VaultSourceKey {
  docId: string
  path: string
  space: string
  title: string
  sourceVersion: number
}

export function encodeDocId(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('base64url')
}

export function decodeDocId(docId: string): string {
  const decoded = Buffer.from(docId, 'base64url').toString('utf8')
  if (decoded === '') throw new Error('invalid vault docId')
  return decoded
}

/** 极简 frontmatter：`---` 包裹、`key: value` 行。 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u)
  if (match === null) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u)
    if (kv !== null) meta[kv[1]!] = kv[2]!.trim()
  }
  return { meta, body: raw.slice(match[0].length) }
}

export function sourcePathToKey(relativePath: string, raw = '', mtimeMs = 0): VaultSourceKey {
  const { meta } = parseFrontmatter(raw)
  const segments = relativePath.split('/').filter(Boolean)
  const space = meta['space'] ?? (segments.length > 1 ? segments[0]! : 'general')
  const base = segments[segments.length - 1] ?? relativePath
  const title = meta['title'] ?? base.replace(/\.md$/iu, '')
  return {
    docId: encodeDocId(relativePath),
    path: relativePath,
    space,
    title,
    sourceVersion: Math.floor(mtimeMs / 1000),
  }
}
