/** Explicit external recovery protocol. V1 is retained only for old receipts. */
export interface RecoveryProviderTarget {
  operation: 'restore' | 'key_destroy'
  namespace: string
  target_id: string
  recovery_point?: string
}
interface RecoveryProviderIdentity extends RecoveryProviderTarget {
  provider_id: string
  request_id: string
  realm: string
  request_digest: string
  execution_id: string
  idempotency_key: string
  fencing_token: number
}
export type RecoveryProviderExecution = RecoveryProviderIdentity & (
  | { version: 'lumo.recovery.v2'; mode: 'execute' | 'receipt'; expires_at: string }
  | { version: 'lumo.recovery.v1'; mode: 'receipt'; expires_at?: never }
)
export type RecoveryProviderReceipt = RecoveryProviderExecution & {
  outcome: 'succeeded' | 'rejected' | 'pending' | 'not_found'
  receipt_id: string
  completed_at: string
  signature: string
}
