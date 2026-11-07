/** Public receipt metadata never contains an object key, path or bearer URL. */
export interface SessionAttachmentReceipt {
  receipt_id: string
  kind: 'text' | 'image'
  name: string
  media_type: string
  bytes: number
  sha256: string
  created_at: string
}
export interface SessionAttachmentConfig { realm: string; maxUploadBytes?: number; maxTextBytes?: number; maxPerMessage?: number }
export interface SessionAttachmentUpload { name: string; mediaType: string }
export interface SessionAttachmentDownload { data: Uint8Array; name: string; mediaType: string }
export const SESSION_ATTACHMENT_PATH = '/lumo/session-attachments'
export const SESSION_ATTACHMENT_RUNTIME_PATH = '/lumo/runtime/session-attachments'
export const SESSION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const sessionAttachmentID = /^att_[a-f0-9]{48}$/u
