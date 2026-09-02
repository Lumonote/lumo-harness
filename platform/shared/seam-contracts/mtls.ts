/**
 * Shared mTLS file configuration for east-west Node services.
 *
 * Certificates are deliberately file-backed: a deployment secret volume owns
 * rotation and the process never serializes private material into a Cordis
 * patch, registry manifest, log line, or environment-derived diagnostic.
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createSecureContext, type SecureContextOptions } from 'node:tls'

export interface MutualTLSFileConfig {
  /** PEM CA bundle that validates the peer certificate chain. */
  caFile: string
  /** PEM certificate chain for this node. */
  certFile: string
  /** PEM private key for this node; must be mounted read-only by deployment. */
  keyFile: string
  /** Optional expected DNS name; clients otherwise use the endpoint hostname. */
  serverName?: string
  /** Secret volume rotation check cadence; defaults to 30 seconds, minimum 1 second. */
  reloadIntervalMs?: number
}

export type MutualTLSCredentials = Pick<SecureContextOptions, 'ca' | 'cert' | 'key'> & {
  readonly serverName?: string
}

/** Refuse relative/config-embedded credential locations before opening a socket. */
export function assertMutualTLSFileConfig(config: MutualTLSFileConfig): void {
  for (const [name, value] of Object.entries({
    caFile: config.caFile,
    certFile: config.certFile,
    keyFile: config.keyFile,
  })) {
    if (value.includes('\u0000') || !isAbsolute(value)) {
      throw new Error(`mTLS ${name} must be an absolute PEM file path`)
    }
  }
  if (config.serverName !== undefined && (!/^[A-Za-z0-9.-]{1,253}$/u.test(config.serverName)
    || config.serverName.startsWith('.') || config.serverName.endsWith('.'))) {
    throw new Error('mTLS serverName must be a DNS name')
  }
  if (config.reloadIntervalMs !== undefined
    && (!Number.isInteger(config.reloadIntervalMs) || config.reloadIntervalMs < 1_000 || config.reloadIntervalMs > 3_600_000)) {
    throw new Error('mTLS reloadIntervalMs must be an integer from 1000 to 3600000')
  }
}

/** Load and validate an immutable PEM bundle. Private key text never leaves this module. */
export function loadMutualTLSCredentials(config: MutualTLSFileConfig): MutualTLSCredentials {
  assertMutualTLSFileConfig(config)
  const ca = readPEM(config.caFile, 'caFile')
  const cert = readPEM(config.certFile, 'certFile')
  const key = readPEM(config.keyFile, 'keyFile')
  // 读取字节不代表它们能组成 TLS 上下文。提前让 Node 校验 PEM、证书链和私钥
  // 的配对，轮换时才不会把一个无法握手的 context 安装为「当前」凭据。
  createSecureContext({ ca, cert, key, minVersion: 'TLSv1.2' })
  return { ca, cert, key, ...(config.serverName === undefined ? {} : { serverName: config.serverName }) }
}

/**
 * Checks the mounted bundle periodically. A changed-but-invalid bundle never
 * replaces the last known-good credentials; callers can inspect
 * {@link lastReloadError} to log or meter a failed Secret rotation.
 */
export class ReloadingMutualTLSCredentials {
  private current: MutualTLSCredentials
  private version: string
  private nextCheckAt = 0
  private readonly intervalMs: number
  private _lastReloadError: Error | undefined

  constructor(private readonly config: MutualTLSFileConfig) {
    assertMutualTLSFileConfig(config)
    this.current = loadMutualTLSCredentials(config)
    this.version = fileVersion(config)
    this.intervalMs = config.reloadIntervalMs ?? 30_000
  }

  get(now = Date.now()): MutualTLSCredentials {
    if (now < this.nextCheckAt) return this.current
    this.nextCheckAt = now + this.intervalMs
    try {
      const version = fileVersion(this.config)
      if (version === this.version) {
        this._lastReloadError = undefined
        return this.current
      }
      const next = loadMutualTLSCredentials(this.config)
      this.current = next
      this.version = version
      this._lastReloadError = undefined
    } catch (cause) {
      this._lastReloadError = cause instanceof Error ? cause : new Error(String(cause))
    }
    return this.current
  }

  /** The most recent periodic reload failure, if the active credentials are stale. */
  get lastReloadError(): Error | undefined {
    return this._lastReloadError
  }
}

/** A client certificate on an HTTP connection is not mTLS; reject that downgrade at assembly. */
export function assertMutualTLSEndpoint(endpoint: string): void {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`mTLS endpoint is not a valid URL: ${endpoint}`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`mTLS endpoint must use https: ${endpoint}`)
}

function readPEM(path: string, name: string): Buffer {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new Error(`mTLS ${name} cannot be read`)
  }
  if (bytes.length === 0) throw new Error(`mTLS ${name} is empty`)
  return bytes
}

function fileVersion(config: MutualTLSFileConfig): string {
  try {
    return [config.caFile, config.certFile, config.keyFile].map((path) => {
      const info = statSync(path)
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
    }).join('|')
  } catch {
    throw new Error('mTLS credential file metadata cannot be read')
  }
}
