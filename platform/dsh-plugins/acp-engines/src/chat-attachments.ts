/** Shared wire metadata; file contents stay in the scoped attachment store. */
export interface ChatAttachment { id: string; name: string; mimeType: string; size: number }
export const ATTACHMENT_LIMITS = { count: 4, fileBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, bodyBytes: 12 * 1024 * 1024 } as const
export const attachmentId = /^[a-f0-9]{64}$/u
export function attachmentRefs(value: unknown): ChatAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.count) throw new Error('每条消息最多添加 4 个附件')
  const files = value.map((item: unknown) => {
    const f = item as Partial<ChatAttachment> | null
    if (!f || typeof f.id !== 'string' || !attachmentId.test(f.id) || typeof f.name !== 'string' || !f.name.trim() || f.name.length > 240
      || /[\x00-\x1f/\\]/u.test(f.name) || typeof f.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/u.test(f.mimeType)
      || !Number.isSafeInteger(f.size) || f.size! < 0 || f.size! > ATTACHMENT_LIMITS.fileBytes) throw new Error('附件信息无效，请重新添加')
    return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size! }
  })
  if (new Set(files.map(f => f.id)).size !== files.length || files.reduce((sum, f) => sum + f.size, 0) > ATTACHMENT_LIMITS.totalBytes) throw new Error('附件重复或总大小超过 16 MB')
  return files
}
