import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ContentBlock } from './acp-protocol.ts'

function within(cwd: string, value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\\]/u.test(value)) throw new Error('文件路径无效')
  const root = realpathSync(cwd), path = realpathSync(resolve(root, value)), rel = relative(root, path)
  if (isAbsolute(value) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('只能引用当前项目内的文件')
  return path
}

export const PREVIEW_LIMITS = { textBytes: 1024 * 1024, imageBytes: 4 * 1024 * 1024 } as const
export interface ProjectFilePreview { path: string; name: string; mimeType: string; size: number; text?: string; data?: string; truncated?: boolean; unsupported?: boolean }
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
function raster(bytes: Buffer, mime: string): boolean {
  return mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/gif' ? /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}
/** Bounded bytes only; callers render text as text and images from the returned allowlisted MIME. */
export function projectFilePreview(cwd: string, value: string): ProjectFilePreview {
  const path = within(cwd, value), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error('只能预览项目文件')
    // Recheck the canonical path after opening to reject a swapped symlink or directory.
    const check = statSync(within(cwd, value))
    if (check.dev !== info.dev || check.ino !== info.ino) throw new Error('文件已变更，请重试')
    const mime = imageTypes[extname(value).toLowerCase()], limit = mime ? PREVIEW_LIMITS.imageBytes : PREVIEW_LIMITS.textBytes
    const preview: ProjectFilePreview = { path: value, name: basename(value), mimeType: mime ?? (extname(value).toLowerCase() === '.pdf' ? 'application/pdf' : 'text/plain'), size: info.size }
    if (mime && info.size > limit) return { ...preview, unsupported: true, truncated: true }
    const bytes = Buffer.alloc(Math.min(info.size, limit)), length = readSync(fd, bytes, 0, bytes.length, 0), content = bytes.subarray(0, length)
    if (mime) return raster(content, mime) ? { ...preview, data: content.toString('base64') } : { ...preview, mimeType: 'application/octet-stream', unsupported: true }
    if (content.includes(0) || preview.mimeType === 'application/pdf') return { ...preview, mimeType: preview.mimeType === 'application/pdf' ? 'application/pdf' : 'application/octet-stream', unsupported: true }
    try {
      // Stream decoding permits an incomplete final codepoint only when the bounded preview is truncated.
      const truncated = info.size > length, text = new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: truncated })
      return { ...preview, text, ...(truncated ? { truncated } : {}) }
    } catch { return { ...preview, mimeType: 'application/octet-stream', unsupported: true } }
  } finally { closeSync(fd) }
}
export function projectFiles(cwd: string, query: string) {
  if (query.length > 4096 || /[\x00-\x1f\\]/u.test(query)) throw new Error('文件查询无效')
  const split = query.lastIndexOf('/'), parent = split >= 0 ? query.slice(0, split + 1) : '', needle = query.slice(split + 1).toLowerCase()
  const dir = within(cwd, parent)
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.name !== '.git' && e.name !== 'node_modules' && e.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 40)
    .flatMap(e => {
      try {
        const path = `${parent}${e.name}`, stat = statSync(within(cwd, path))
        return stat.isFile() || stat.isDirectory() ? [{ path, name: e.name, directory: stat.isDirectory() }] : []
      } catch { return [] }
    })
}
export function projectFileBlocks(cwd: string, files: string[]): ContentBlock[] {
  return files.map(name => {
    const path = within(cwd, name)
    if (!statSync(path).isFile()) throw new Error(`项目文件不可用：${name}`)
    return { type: 'resource_link', name, uri: pathToFileURL(path).href }
  })
}
