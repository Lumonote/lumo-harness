/** Remote requests carry no implicit desktop authority. Only the device's local owner can approve them. */
export type RemoteComputerCapability = 'computer.observe' | 'computer.interact'
export type RemoteComputerState = 'pending' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled' | 'unknown'
export interface RemoteComputerPlan {
  realm: string
  node_id: string
  owner_user_id: string
  project_id: string
  session_ref: string
  capability: RemoteComputerCapability
  expires_at: string
  intent: string
  channel: string
  subject: string
  sender_user_id: string
  team_id: string
  agent_id: string
}
export interface RemoteComputerEnvelope { version: 1; request_id: string; digest: string; plan_json: string }
export interface RemoteComputerLeaseInput {
  digest: string
  expected_revision: number
  phase: 'approve' | 'check' | 'finish' | 'deny' | 'cancel'
  state?: 'completed' | 'failed' | 'cancelled' | 'unknown'
  summary?: string
}
export interface RemoteComputerLease {
  request_id: string
  digest: string
  state: RemoteComputerState
  revision: number
  expires_at: string
}
export interface RemoteComputerLocalRequest {
  envelope: RemoteComputerEnvelope
  plan: RemoteComputerPlan
  state: RemoteComputerState
  revision: number
  summary: string
}
