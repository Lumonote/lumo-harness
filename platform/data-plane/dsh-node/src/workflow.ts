/**
 * The stock dsh profile mounts one worker-thread workflow engine whose default
 * child route is `spawn`. A parent (agent-role) Lumo node must override that
 * existing row instead of inserting a second engine: `workflowEngine` is a
 * unary service and duplicate engines would make route selection timing-based.
 */
import { dirname, join } from 'node:path'
export function workflowEngineOverlay(role: 'node' | 'agent'): string {
  if (role !== 'agent') return ''
  return `- id: workflow-worker-thread
  config:
    provider: lumo-remote
`
}

/**
 * The shipped headless profile is a one-shot application and rejects an empty
 * task. A Compose node without app arguments is instead a long-lived plugin
 * host, so keep the shared headless runtime but disable its startup parser and
 * one-shot runner. Explicit CLI tasks retain the stock one-shot behaviour.
 */
export function profileLifetimeOverlay(profile: string, hasAppArgs: boolean): string {
  if (profile !== 'headless' || hasAppArgs) return ''
  return `- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
`
}

/**
 * Unlike the Web bundle, the stock headless bundle does not mount the storage
 * hub. Lumo's PostgreSQL backend injects that hub, so persistent headless nodes
 * must add it before the backend row. The Web profile already owns the same id.
 */
export function profileStorageRows(profile: string): string {
  if (profile !== 'headless') return ''
  return `    - id: storage
      name: '@deepseek-ai/dsh-storage'
`
}

/** Assemble the local desktop storage hub with the official SQLite backend. */
/** 单机版知识库（vault 为源；sqlite+FTS5 关键词档）。realm 与身份一致（§5.4.1 装配层固定）。 */
export function localVaultRows(sqlitePath: string, realm: string): string {
  return `    - id: lumo-knowledge-vault
      name: '@lumo/knowledge-vault'
      inject: [tools]
      config:
        vaultRoot: ${JSON.stringify(process.env['LUMO_KNOWLEDGE_VAULT_ROOT'] ?? '')}
        dbPath: ${JSON.stringify(join(dirname(sqlitePath), 'knowledge-vault.sqlite'))}
        realm: ${JSON.stringify(realm)}
`
}

export function localStorageRows(profile: string, sqlitePath: string): string {
  if (profile === 'web') {
    return `    - id: lumo-storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
      inject: [storage]
      config:
        path: ${JSON.stringify(sqlitePath)}
`
  }
  if (profile !== 'headless') return ''
  return `    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: lumo-storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
      inject: [storage]
      config:
        path: ${JSON.stringify(sqlitePath)}
`
}
