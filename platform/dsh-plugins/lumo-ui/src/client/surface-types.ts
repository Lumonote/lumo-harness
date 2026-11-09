/** Shared read models for the independently mounted workbench domains. */

export type Surface = 'knowledge' | 'skills' | 'connectors' | 'operations' | 'design' | 'presentation' | 'account' | 'market' | 'skillhub' | 'collaboration' | 'computer'

export interface ServiceState { ok: boolean; status: number; error?: string }

export interface NodeState {
  node_id?: string
  cluster_id?: string
  capacity?: number
  residency?: string
  capabilities?: string[]
  cluster_state?: string
  cluster_version?: string
  cluster_version_unproven?: boolean
}

export interface DeploymentState { mode: 'local' | 'standalone' | 'cluster'; label: string; storage: 'sqlite' | 'postgres'; middleware: string[]; distributed: boolean; desktop: boolean; clusterReady: boolean; clusterOnly: boolean }

export interface Operation { name?: string; method?: string; write?: boolean; sensitivity?: string }

export interface Row { id?: string; name?: string; status?: string; realm?: string; version?: number; protocol?: string; operations?: Operation[]; projectId?: string; visibility?: string; author?: string; triggerKind?: string; triggerSpec?: string; flowRef?: string; enabled?: boolean; reviewComment?: string }

export interface Plugin { id: string; label: string; description: string; surface: Surface; kind: 'runtime' | 'governance' }

export interface Overview {
  generatedAt: string
  deployment: DeploymentState
  services: Record<string, ServiceState>
  cluster: { leader?: { holder?: string }; nodes: NodeState[] }
  projects: Row[]
  flows: Row[]
  connectors: Row[]
  plugins: Plugin[]
}

export interface RegistryArtifact {
  name: string; version: string; kind: 'Component' | 'Skill' | 'Agent' | 'Connector' | 'Flow'; publisher: string
  digest: string; scopes: string[]; requires?: { olap?: boolean; graph?: boolean; vector?: boolean; object?: boolean; gpu?: boolean }
  deps?: Array<{ name: string; version: string }>; published_at: string
}

export interface RegistryArtifactVersions { items: RegistryArtifact[]; advisory?: string }

export interface RegistryCatalog { items: RegistryArtifact[]; source: 'registry_index'; state: 'discoverable'; advisory?: string }

export interface RegistryShape { olap: boolean; graph: boolean; vector: boolean; object: boolean; gpu: boolean }

export interface RegistryInstallation {
  node_id: string; state: 'converged' | 'failed'; root: string
  installed: Array<{ name: string; version: string; digest: string }>
  shape: RegistryShape; reported_at: string
}

export interface RegistryInstallations { items: RegistryInstallation[]; source: 'provisioner_reports'; advisory?: string }

export interface RegistryRollout { channel: string; name: string; version: string; previous_version?: string; percent: number; updated_at: string }

export interface RegistryRollouts { items: RegistryRollout[]; channel: string; source: 'desired_state'; advisory?: string }

export interface RegistryRolloutSelection { node_id: string; version: string; cohort: 'target' | 'holdback' }

export interface RegistryRolloutSelectionResponse { rollout: RegistryRollout; selection?: RegistryRolloutSelection; source: 'desired_state'; advisory?: string }

export interface RegistryInstallPlan {
  root: string
  items: Array<{ name: string; version: string; kind: RegistryArtifact['kind']; publisher: string; digest: string; scopes: string[]; requires?: RegistryArtifact['requires'] }>
  scopes: string[]
  shape: RegistryShape
}

export interface KnowledgeHit { docId: string; sourceVersion: number; score: number; text: string }

export interface KnowledgeResult { query: string; scope: 'published'; hits: KnowledgeHit[] }

export interface KnowledgeSourceSummary {
  docId: string; realm: string; space: string; title: string; sourceVersion: number
  embeddingModel: string; chunkCount: number; updatedAt: string
}

export interface KnowledgeSource {
  doc: { docId: string; realm: string; space: string; title: string; sourceVersion: number; embeddingModel: string }
  chunks: Array<{ text: string; metadata: Record<string, unknown> }>
}

export interface VaultStatusInfo {
  vaultPath: string
  mode: 'keyword' | 'embedding'
  docCount: number
  chunkCount: number
  lastSyncAt: number | null
  error: string | null
}

export interface KnowledgeSources { realm: string; state: 'synchronized'; sources: KnowledgeSourceSummary[] }

export interface KnowledgeLibraryFolder { folderId: string; realm: string; parentId: string | null; name: string; ownerUserId: string; createdAt: string; revision?: number; canEdit?: boolean }

export interface KnowledgeLibraryFile { docId: string; realm: string; folderId: string | null; filename: string; mimeType: string; byteSize: number; sha256: string; ownerUserId: string; extractionState: string; ocrState: string; createdAt: string; revision?: number; canEdit?: boolean }

export interface KnowledgeLibraryGrant { type: 'user' | 'role'; id: string; access: 'viewer' | 'editor' }

export type AuthAccount = {
  mode: 'session'; provider: 'lumo-governance'; username: string; displayName: string; userId: string
  realm: string; roles: string[]; department: string; clientIp: string; captchaMode: 'always' | 'identity-provider'
  localAuthEnabled?: boolean; authMethod?: 'local' | 'oidc'
}

export type AuthSession = { id: string; client_ip: string; created_at: string; last_seen_at: string; expires_at: string; current: boolean }

export type AuthSecurityEvent = { id: number; event: string; client_ip?: string; detail: Record<string, unknown>; created_at: string }

export type AuthMFAStatus = { configured: boolean; enabled: boolean; pending_expires_at?: string; enrolled_at?: string }

export type TOTPEnrollment = { secret: string; expires_at: string }

export type AuthPasskey = { id: string; label?: string; created_at: string; last_used_at?: string }

export type AuthPasskeyStatus = { configured: boolean; rp_id?: string; require_user_verification?: boolean; passkeys?: AuthPasskey[] }
