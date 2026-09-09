import type { MutualTLSFileConfig } from './mtls.ts'
import { assertWorkerBinding, type WorkerBinding } from './worker-binding.ts'

type Environment = Record<string, string | undefined>

export function workerBindingFromEnv(env: Environment, identity: Pick<WorkerBinding, 'agentId' | 'userId' | 'projectId'>): WorkerBinding | undefined {
  if (!env['LUMO_AGENT_PRESET_REVISION']) return undefined
  const ids = (env['LUMO_AGENT_IDS'] ?? identity.agentId).split(',').map(value => value.trim()).filter(Boolean)
  if (ids.length !== 1 || ids[0] !== identity.agentId) throw new Error('a governed process can execute only LUMO_AGENT_ID; deploy separate processes for other Workers')
  const binding: WorkerBinding = { ...identity, presetRevision: Number(env['LUMO_AGENT_PRESET_REVISION']),
    provider: env['LUMO_AGENT_PROVIDER'] ?? '', model: env['LUMO_AGENT_MODEL'] ?? '' }
  assertWorkerBinding(binding)
  return binding
}

export function clusterWiring(env: Environment, mode: string, role: string) {
  const cluster = mode === 'cluster'
  const seamMode = env['LUMO_SEAM_MODE'] || (cluster ? (role === 'agent' ? 'proxy' : 'host') : 'disabled')
  if (!['disabled', 'host', 'proxy'].includes(seamMode)) throw new Error('LUMO_SEAM_MODE must be disabled, host or proxy')
  if (mode === 'local' && seamMode !== 'disabled') throw new Error('Local deployment cannot enable remote seams')
  const endpoints = (env['LUMO_SEAM_ENDPOINTS'] ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (seamMode === 'proxy' && endpoints.length === 0) throw new Error('LUMO_SEAM_ENDPOINTS is required for seam proxy mode')
  for (const endpoint of endpoints) {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid LUMO_SEAM_ENDPOINTS URL')
    }
  }
  const caFile = env['LUMO_SEAM_TLS_CA_FILE'] || undefined
  const certFile = env['LUMO_SEAM_TLS_CERT_FILE'] || undefined
  const keyFile = env['LUMO_SEAM_TLS_KEY_FILE'] || undefined
  let tls: MutualTLSFileConfig | undefined
  if (caFile || certFile || keyFile) {
    if (!caFile || !certFile || !keyFile) throw new Error('Seam mTLS requires CA, certificate and key files')
    tls = { caFile, certFile, keyFile, serverName: env['LUMO_SEAM_TLS_SERVER_NAME'] || undefined }
    if (endpoints.some(endpoint => !endpoint.startsWith('https://'))) throw new Error('Seam mTLS requires HTTPS endpoints')
  }
  const ledgerTransport = env['LUMO_LEDGER_TRANSPORT'] || (cluster ? 'rmq' : 'local')
  if (!['local', 'rmq'].includes(ledgerTransport)) throw new Error('LUMO_LEDGER_TRANSPORT must be local or rmq')
  const port = Number(env['LUMO_SEAM_PORT'] || 8090)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LUMO_SEAM_PORT')
  return {
    seamMode, endpoints, tls, port, ledgerTransport,
    seamHost: env['LUMO_SEAM_BIND'] || '127.0.0.1',
    opaUrl: env['LUMO_OPA_ADDR'] || '',
    opaToken: env['LUMO_OPA_TOKEN'] || '',
    knowledge: {
      providerMode: seamMode === 'proxy' ? 'remote' : 'local',
      milvusUrl: env['LUMO_MILVUS_URL'] || undefined,
      milvusCollection: env['LUMO_MILVUS_COLLECTION'] || 'lumo_knowledge',
      milvusRebuildUrl: env['LUMO_MILVUS_REBUILD_URL'] || undefined,
      nebulaUrl: env['LUMO_NEBULA_URL'] || undefined,
      remoteApiKey: env['LUMO_KNOWLEDGE_API_KEY'] || undefined,
      rerank: env['LUMO_RERANK_BASE_URL'] ? {
        baseUrl: env['LUMO_RERANK_BASE_URL'], model: env['LUMO_RERANK_MODEL'] || 'BAAI/bge-reranker-v2-m3',
      } : undefined,
    },
  }
}
