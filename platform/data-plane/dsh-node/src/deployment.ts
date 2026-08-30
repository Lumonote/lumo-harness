/**
 * Deployment is a product boundary, not a best-effort infrastructure probe.
 *
 * `local` is the desktop shape: one process, SQLite, and no network
 * middleware. `standalone` is a server installation with one copy of each
 * service. `cluster` is the horizontally scalable server shape. Keeping this
 * decision explicit prevents a locally available Nacos/Redis process from
 * accidentally enabling cluster-only behavior.
 */
export type DeploymentMode = 'local' | 'standalone' | 'cluster'
export type StorageBackend = 'sqlite' | 'postgres'

export interface DeploymentProfile {
  mode: DeploymentMode
  label: string
  storage: StorageBackend
  middleware: string[]
  distributed: boolean
  desktop: boolean
  clusterReady: boolean
  clusterOnly: boolean
}

const profiles: Record<DeploymentMode, DeploymentProfile> = {
  local: {
    mode: 'local',
    label: '本地单机',
    storage: 'sqlite',
    middleware: [],
    distributed: false,
    desktop: true,
    clusterReady: false,
    clusterOnly: false,
  },
  standalone: {
    mode: 'standalone',
    label: '服务器单例',
    storage: 'postgres',
    middleware: ['PostgreSQL', 'Redis', 'MinIO', 'RocketMQ', 'Nacos'],
    distributed: false,
    desktop: false,
    clusterReady: false,
    clusterOnly: false,
  },
  cluster: {
    mode: 'cluster',
    label: '服务器集群',
    storage: 'postgres',
    middleware: ['PostgreSQL', 'Redis', 'MinIO', 'RocketMQ', 'Nacos'],
    distributed: true,
    desktop: false,
    clusterReady: false,
    clusterOnly: true,
  },
}

export function resolveDeploymentMode(raw: string | undefined): DeploymentMode {
  const value = (raw ?? 'standalone').trim().toLowerCase()
  if (value === 'local' || value === 'desktop') return 'local'
  if (value === 'standalone' || value === 'server-single' || value === 'server-singleton') return 'standalone'
  if (value === 'cluster') return 'cluster'
  throw new TypeError(`LUMO_DEPLOYMENT_MODE 只能是 local|standalone|cluster，收到 ${JSON.stringify(raw)}`)
}

export function resolveDeploymentProfile(raw: string | undefined = process.env['LUMO_DEPLOYMENT_MODE']): DeploymentProfile {
  const mode = resolveDeploymentMode(raw)
  return { ...profiles[mode], middleware: [...profiles[mode].middleware] }
}

export function withClusterStatus(profile: DeploymentProfile, status: string | undefined): DeploymentProfile {
  return { ...profile, clusterReady: profile.mode === 'cluster' && (status ?? '').trim().toLowerCase() === 'ready' }
}

export function assertLocalStoragePath(path: string): string {
  const value = path.trim()
  if (value === '') throw new TypeError('LUMO_SQLITE_PATH 不能为空')
  return value
}
