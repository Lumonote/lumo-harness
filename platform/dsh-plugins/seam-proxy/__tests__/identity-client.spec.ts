import { describe, expect, it } from 'vitest'

import { seamRequestHeaders } from '../src/client.ts'
import {
  IDENTITY_ASSERTION_HEADER,
  SEAM_IDENTITY_AUDIENCE,
  verifyIdentityAssertion,
} from '../../../shared/seam-contracts/identity.ts'

const secret = 'identity-root-that-is-longer-than-thirty-two-bytes'

describe('SeamProxy outbound identity', () => {
  it('uses legacy headers only when signed identity is not configured', () => {
    expect(seamRequestHeaders({ realm: 'r1', userId: 'alice' })).toMatchObject({
      'X-Lumo-Realm': 'r1', 'X-Lumo-User': 'alice',
    })
  })

  it('issues an audience-bound assertion instead of spoofable identity headers', () => {
    const headers = seamRequestHeaders({
      realm: 'r1', userId: 'alice', roles: ['viewer'], identityAssertionSecret: secret,
    })
    expect(headers['X-Lumo-Realm']).toBeUndefined()
    expect(headers['X-Lumo-User']).toBeUndefined()
    expect(headers[IDENTITY_ASSERTION_HEADER]).toBeDefined()
    expect(verifyIdentityAssertion(headers, { audience: SEAM_IDENTITY_AUDIENCE, secret })).toEqual({
      realm: 'r1', userId: 'alice', roles: ['viewer'],
    })
  })

  it('does not permit a signed but role-less runtime identity', () => {
    expect(() => seamRequestHeaders({ realm: 'r1', identityAssertionSecret: secret })).toThrow('at least one role')
  })
})
