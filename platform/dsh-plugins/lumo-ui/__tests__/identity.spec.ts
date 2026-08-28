import { describe, expect, it } from 'vitest'

import {
  assertIdentityConfiguration,
  encodeIdentityAssertion,
  resolveRequestIdentity,
  signIdentityAssertion,
} from '../src/identity.ts'

const secret = '0123456789abcdef0123456789abcdef'

function request(encoded?: string, signature?: string): { headers: Record<string, string> } {
  return { headers: {
    ...(encoded === undefined ? {} : { 'x-lumo-identity': encoded }),
    ...(signature === undefined ? {} : { 'x-lumo-identity-signature': signature }),
  } }
}

const fallback = {
  identityAssertionSecret: secret,
  realm: 'static-realm',
  userId: 'static-user',
  roles: ['viewer'],
  projectId: 'static-project',
  deptId: 'static-dept',
}

describe('signed Lumo identity assertions', () => {
  it('binds a valid edge assertion to the request', () => {
    const encoded = encodeIdentityAssertion({
      aud: 'lumo-ui', exp: 1_200, realm: 'realm-a', userId: 'user-a',
      roles: ['operator'], projectId: 'project-a', deptId: 'dept-a',
    })

    expect(resolveRequestIdentity(request(encoded, signIdentityAssertion(encoded, secret)), fallback, 1_000)).toEqual({
      realm: 'realm-a', userId: 'user-a', roles: ['operator'], projectId: 'project-a', deptId: 'dept-a',
    })
  })

  it('rejects missing, tampered, expired, and long-lived assertions', () => {
    expect(() => resolveRequestIdentity(request(), fallback, 1_000)).toThrow('required')

    const expired = encodeIdentityAssertion({ aud: 'lumo-ui', exp: 999, realm: 'realm-a', userId: 'user-a', roles: ['viewer'] })
    expect(() => resolveRequestIdentity(request(expired, signIdentityAssertion(expired, secret)), fallback, 1_000)).toThrow('expired')

    const longLived = encodeIdentityAssertion({ aud: 'lumo-ui', exp: 1_301, realm: 'realm-a', userId: 'user-a', roles: ['viewer'] })
    expect(() => resolveRequestIdentity(request(longLived, signIdentityAssertion(longLived, secret)), fallback, 1_000)).toThrow('long-lived')

    const valid = encodeIdentityAssertion({ aud: 'lumo-ui', exp: 1_100, realm: 'realm-a', userId: 'user-a', roles: ['viewer'] })
    expect(() => resolveRequestIdentity(request(valid, signIdentityAssertion(valid, `${secret}x`)), fallback, 1_000)).toThrow('signature')
  })

  it('uses configured development identity only when signed mode is disabled', () => {
    expect(resolveRequestIdentity(request(), { ...fallback, identityAssertionSecret: '' }, 1_000)).toEqual({
      realm: 'static-realm', userId: 'static-user', roles: ['viewer'], projectId: 'static-project', deptId: 'static-dept',
    })
  })

  it('rejects weak configured secrets during startup validation', () => {
    expect(() => assertIdentityConfiguration({ identityAssertionSecret: 'too-short' })).toThrow('32 bytes')
  })
})
