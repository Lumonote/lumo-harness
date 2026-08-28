import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const IDENTITY_ASSERTION_HEADER = 'x-lumo-identity'
export const IDENTITY_SIGNATURE_HEADER = 'x-lumo-identity-signature'

const ASSERTION_AUDIENCE = 'lumo-ui'
const MAX_ASSERTION_BYTES = 4096
const MAX_ASSERTION_TTL_SECONDS = 300
const MAX_ROLES = 32
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u
const ROLE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u

export interface RequestIdentity {
  realm: string
  userId: string
  roles: string[]
  projectId?: string
  deptId?: string
}

export interface IdentityFallback extends RequestIdentity {
  identityAssertionSecret: string
}

interface IdentityAssertion extends RequestIdentity {
  aud: typeof ASSERTION_AUDIENCE
  exp: number
}

export class IdentityAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityAssertionError'
  }
}

export function assertIdentityConfiguration(config: Pick<IdentityFallback, 'identityAssertionSecret'>): void {
  if (config.identityAssertionSecret !== '' && Buffer.byteLength(config.identityAssertionSecret, 'utf8') < 32) {
    throw new IdentityAssertionError('identity assertion secret must contain at least 32 bytes')
  }
}

export function resolveRequestIdentity(
  req: Pick<IncomingMessage, 'headers'>,
  config: IdentityFallback,
  nowSeconds = Math.floor(Date.now() / 1000),
): RequestIdentity {
  assertIdentityConfiguration(config)
  if (config.identityAssertionSecret === '') {
    return fallbackIdentity(config)
  }

  const encoded = singleHeader(req, IDENTITY_ASSERTION_HEADER)
  const signature = singleHeader(req, IDENTITY_SIGNATURE_HEADER)
  if (encoded === undefined || signature === undefined) {
    throw new IdentityAssertionError('signed identity assertion is required')
  }
  if (Buffer.byteLength(encoded, 'ascii') > MAX_ASSERTION_BYTES || !BASE64URL_PATTERN.test(encoded)) {
    throw new IdentityAssertionError('identity assertion encoding is invalid')
  }

  const expected = signIdentityAssertion(encoded, config.identityAssertionSecret)
  if (!constantTimeEqual(expected, signature)) {
    throw new IdentityAssertionError('identity assertion signature is invalid')
  }

  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new IdentityAssertionError('identity assertion payload is invalid')
  }
  const assertion = validateAssertion(value, nowSeconds)
  return {
    realm: assertion.realm,
    userId: assertion.userId,
    roles: [...assertion.roles],
    ...(assertion.projectId === undefined ? {} : { projectId: assertion.projectId }),
    ...(assertion.deptId === undefined ? {} : { deptId: assertion.deptId }),
  }
}

export function encodeIdentityAssertion(assertion: IdentityAssertion): string {
  return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url')
}

export function signIdentityAssertion(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded, 'ascii').digest('base64url')
}

function fallbackIdentity(config: IdentityFallback): RequestIdentity {
  return {
    realm: config.realm,
    userId: config.userId,
    roles: [...config.roles],
    ...(config.projectId === undefined ? {} : { projectId: config.projectId }),
    ...(config.deptId === undefined ? {} : { deptId: config.deptId }),
  }
}

function singleHeader(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name]
  if (Array.isArray(raw)) throw new IdentityAssertionError(`${name} must occur once`)
  return raw === undefined || raw === '' ? undefined : raw
}

function validateAssertion(value: unknown, nowSeconds: number): IdentityAssertion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IdentityAssertionError('identity assertion must be an object')
  }
  const assertion = value as Record<string, unknown>
  if (assertion['aud'] !== ASSERTION_AUDIENCE) {
    throw new IdentityAssertionError('identity assertion audience is invalid')
  }
  if (!Number.isSafeInteger(assertion['exp'])) {
    throw new IdentityAssertionError('identity assertion expiry is invalid')
  }
  const expiresAt = assertion['exp'] as number
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + MAX_ASSERTION_TTL_SECONDS) {
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
    aud: ASSERTION_AUDIENCE,
    exp: expiresAt,
    userId,
    realm,
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

function optionalID(value: Record<string, unknown>, field: 'projectId' | 'deptId'): Partial<RequestIdentity> {
  const item = value[field]
  if (item === undefined) return {}
  return { [field]: requiredID(item, field) }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'ascii')
  const rightBytes = Buffer.from(right, 'ascii')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
