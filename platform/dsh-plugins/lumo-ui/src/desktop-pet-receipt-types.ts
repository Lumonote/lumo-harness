/** Metadata only: a desktop receipt must never contain a draft or attachment bytes. */
export interface DesktopPetUploadReceipt {
  receiptId: string
  file?: { attachmentId: string; name: string; bytes: number }
}
export interface DesktopPetReceipt {
  id: string
  digest: string
  workspaceId: string
  revision: number
  owner: string
  epoch: string
  phase: 'preparing' | 'creating' | 'submitting' | 'accepted'
  leaseUntil: number
  updatedAt: number
  sessionId?: string
  hostRequestId?: string
  uploads: DesktopPetUploadReceipt[]
  failure?: 'preparation-failed' | 'admission-rejected' | 'cancelled'
}
export interface DesktopPetReceiptClaim {
  id: string
  digest: string
  workspaceId: string
  owner: string
}
export interface DesktopPetReceiptUpdate {
  id: string
  digest: string
  owner: string
  revision: number
  phase: DesktopPetReceipt['phase']
  sessionId?: string
  hostRequestId?: string
  uploads?: DesktopPetUploadReceipt[]
  failure?: DesktopPetReceipt['failure']
}
export interface DesktopPetReceiptClient {
  claim(input: DesktopPetReceiptClaim): Promise<{ record: DesktopPetReceipt; acquired: boolean }>
  update(input: DesktopPetReceiptUpdate): Promise<DesktopPetReceipt>
}
