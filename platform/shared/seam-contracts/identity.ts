/**
 * 跨进程身份声明：让网络 seam 只接受装配层给出的调用身份，而不信任
 * RPC 载荷或普通 X-Lumo-* 头自报的用户/角色。
 *
 * 这不是用户会话 token，也不替代 mTLS。它是短时 HMAC 声明，受众严格绑定到
 * 一个服务；因此浏览器 → lumo-ui 的断言不能被重放到 seam host。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const IDENTITY_ASSERTION_HEADER = 'x-lumo-identity'
export const IDENTITY_SIGNATURE_HEADER = 'x-lumo-identity-signature'
export const SEAM_IDENTITY_AUDIENCE = 'lumo-seam-host'

const MAX_ASSERTION_BYTES = 4096
const MAX_ASSERTION_TTL_SECONDS = 300
const MAX_ROLES = 32
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u
const ROLE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u

export interface IdentityClaims {
  realm: string
  userId: string
  roles: string[]
  projectId?: string
  deptId?: string
}

export interface IdentityAssertionConfig {
  /** Assertion audience. A verifier must use the exact same audience. */
  audience: string
  /** A deployment-managed HMAC secret of at least 32 bytes. */
  secret: string
}

interface IdentityAssertion extends IdentityClaims {
  aud: string
  exp: number
}

export class IdentityAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityAssertionError'
  }
}

type HeaderValue = string | string[] | undefined
type HeaderSource = Readonly<Record<string, HeaderValue>>

/** Refuse a weak identity root before it becomes a runtime authentication path. */
export function assertIdentityAssertionConfig(config: IdentityAssertionConfig): void {
  if (!ID_PATTERN.test(config.audience)) {
    throw new IdentityAssertionError('identity assertion audience is invalid')
  }
  if (Buffer.byteLength(config.secret, 'utf8') < 32) {
    throw new IdentityAssertionError('identity assertion secret must contain at least 32 bytes')
  }
}

/** Issue a short-lived assertion for a specific downstream audience. */
export function issueIdentityAssertion(
  claims: IdentityClaims,
  config: IdentityAssertionConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> {
  assertIdentityAssertionConfig(config)
  const assertion = validateAssertion({
    ...claims,
    aud: config.audience,
    exp: nowSeconds + 60,
  }, config.audience, nowSeconds)
  const encoded = Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url')
  return {
    [IDENTITY_ASSERTION_HEADER]: encoded,
    [IDENTITY_SIGNATURE_HEADER]: signIdentityAssertion(encoded, config.secret),
  }
}

/** Verify, parse and validate an assertion without falling back to spoofable headers. */
export function verifyIdentityAssertion(
  headers: HeaderSource,
  config: IdentityAssertionConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): IdentityClaims {
  assertIdentityAssertionConfig(config)
  const encoded = singleHeader(headers, IDENTITY_ASSERTION_HEADER)
  const signature = singleHeader(headers, IDENTITY_SIGNATURE_HEADER)
  if (encoded === undefined || signature === undefined) {
    throw new IdentityAssertionError('signed identity assertion is required')
  }
  if (Buffer.byteLength(encoded, 'ascii') > MAX_ASSERTION_BYTES || !BASE64URL_PATTERN.test(encoded)) {
    throw new IdentityAssertionError('identity assertion encoding is invalid')
  }
  const expected = signIdentityAssertion(encoded, config.secret)
  if (!constantTimeEqual(expected, signature)) {
    throw new IdentityAssertionError('identity assertion signature is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new IdentityAssertionError('identity assertion payload is invalid')
  }
  const assertion = validateAssertion(value, config.audience, nowSeconds)
  return {
    realm: assertion.realm,
    userId: assertion.userId,
    roles: [...assertion.roles],
    ...(assertion.projectId === undefined ? {} : { projectId: assertion.projectId }),
    ...(assertion.deptId === undefined ? {} : { deptId: assertion.deptId }),
  }
}

export function signIdentityAssertion(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded, 'ascii').digest('base64url')
}

function singleHeader(headers: HeaderSource, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) throw new IdentityAssertionError(`${name} must occur once`)
  return value === undefined || value === '' ? undefined : value
}

function validateAssertion(value: unknown, audience: string, nowSeconds: number): IdentityAssertion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IdentityAssertionError('identity assertion must be an object')
  }
  const assertion = value as Record<string, unknown>
  if (assertion['aud'] !== audience) {
    throw new IdentityAssertionError('identity assertion audience is invalid')
  }
  if (!Number.isSafeInteger(assertion['exp'])) {
    throw new IdentityAssertionError('identity assertion expiry is invalid')
  }
  const exp = assertion['exp'] as number
  if (exp <= nowSeconds || exp > nowSeconds + MAX_ASSERTION_TTL_SECONDS) {
    throw new IdentityAssertionError('identity assertion is expired or too long-lived')
  }
  const userId = requiredID(assertion['userId'], 'userId')
  const realm = requiredID(assertion['realm'], 'realm')
  const roles = assertion['roles']
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > MAX_ROLES
    || roles.some((role) => typeof role !== 'string' || !ROLE_PATTERN.test(role))) {
    throw new IdentityAssertionError('identity assertion roles are invalid')
  }
  return {
    aud: audience,
    exp,
    realm,
    userId,
    roles: [...roles] as string[],
    ...optionalID(assertion, 'projectId'),
    ...optionalID(assertion, 'deptId'),
  }
}

function requiredID(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new IdentityAssertionError(`identity assertion ${field} is invalid`)
  }
  return value
}

function optionalID(value: Record<string, unknown>, field: 'projectId' | 'deptId'): Partial<IdentityClaims> {
  const item = value[field]
  return item === undefined ? {} : { [field]: requiredID(item, field) }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'ascii')
  const rightBytes = Buffer.from(right, 'ascii')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
