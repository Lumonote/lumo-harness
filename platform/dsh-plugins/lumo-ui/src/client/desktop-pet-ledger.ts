import type { DesktopPetReceipt, DesktopPetReceiptClaim, DesktopPetReceiptClient, DesktopPetReceiptUpdate } from '../desktop-pet-receipt-types.ts'

/** Host durability is required. A failed fetch must never become a memory-only send. */
export function desktopPetReceiptClient(view: Window): DesktopPetReceiptClient {
  async function post<T>(action: string, input: unknown): Promise<T> {
    const response = await view.fetch(`/lumo/api/desktop-pet/receipts/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!response.ok) throw Error('桌宠发送记录暂不可用，请稍后重试。')
    return await response.json() as T
  }
  return {
    claim: (input: DesktopPetReceiptClaim) => post<{ record: DesktopPetReceipt; acquired: boolean }>('claim', input),
    update: (input: DesktopPetReceiptUpdate) => post<DesktopPetReceipt>('update', input),
  }
}
