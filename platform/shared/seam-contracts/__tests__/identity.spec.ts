import { describe, expect, it } from 'vitest'

import {
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_SIGNATURE_HEADER,
  SEAM_IDENTITY_AUDIENCE,
  issueIdentityAssertion,
  verifyIdentityAssertion,
} from '../identity.ts'

const config = { audience: SEAM_IDENTITY_AUDIENCE, secret: 'identity-root-that-is-longer-than-thirty-two-bytes' }
const claims = { realm: 'realm-a', userId: 'alice', roles: ['viewer', 'operator'], projectId: 'proj-a' }

describe('seam identity assertion', () => {
  it('round-trips a short-lived audience-bound caller identity', () => {
    const headers = issueIdentityAssertion(claims, config, 1_000)
    expect(verifyIdentityAssertion(headers, config, 1_001)).toEqual(claims)
  })

  it('rejects a modified payload even when its shape remains valid', () => {
    const headers = issueIdentityAssertion(claims, config, 1_000)
    const modified = Buffer.from(JSON.stringify({
      aud: SEAM_IDENTITY_AUDIENCE, exp: 1_060, realm: 'realm-a', userId: 'mallory', roles: ['admin'],
    })).toString('base64url')
    expect(() => verifyIdentityAssertion({ ...headers, [IDENTITY_ASSERTION_HEADER]: modified }, config, 1_001)).toThrow('signature')
  })

  it('rejects an assertion replayed to another service audience', () => {
    const headers = issueIdentityAssertion(claims, config, 1_000)
    expect(() => verifyIdentityAssertion(headers, { ...config, audience: 'lumo-ui' }, 1_001)).toThrow('audience')
  })

  it('rejects expired, duplicate-header and weak-secret assertions', () => {
    const headers = issueIdentityAssertion(claims, config, 1_000)
    expect(() => verifyIdentityAssertion(headers, config, 1_060)).toThrow('expired')
    expect(() => verifyIdentityAssertion({ ...headers, [IDENTITY_SIGNATURE_HEADER]: [headers[IDENTITY_SIGNATURE_HEADER]!] }, config, 1_001)).toThrow('must occur once')
    expect(() => issueIdentityAssertion(claims, { ...config, secret: 'too-short' }, 1_000)).toThrow('at least 32 bytes')
  })
})
