import { describe, expect, it } from 'vitest'

import { assertRequestedRoles, authenticateHeaders } from '../src/server.ts'
import { issueIdentityAssertion, SEAM_IDENTITY_AUDIENCE } from '../../../shared/seam-contracts/identity.ts'

const secret = 'identity-root-that-is-longer-than-thirty-two-bytes'

describe('SeamHost signed caller identity', () => {
  it('uses signed claims rather than ordinary identity headers', () => {
    const headers = {
      ...issueIdentityAssertion({ realm: 'r1', userId: 'alice', roles: ['viewer'] }, {
        audience: SEAM_IDENTITY_AUDIENCE, secret,
      }),
      'x-lumo-realm': 'other',
      'x-lumo-user': 'mallory',
      'x-lumo-seam-token': 'realm-token',
    }
    expect(authenticateHeaders(headers, {
      identityAssertionSecret: secret,
      tokens: new Map([['r1', 'realm-token']]),
    })).toEqual({ realm: 'r1', userId: 'alice', roles: ['viewer'] })
  })

  it('rejects missing or modified signed identity instead of downgrading to headers', () => {
    expect(() => authenticateHeaders({ 'x-lumo-realm': 'r1' }, {
      identityAssertionSecret: secret, tokens: new Map(),
    })).toThrow('身份断言无效')
  })

  it('does not let request roles expand a signed caller role set', () => {
    expect(() => assertRequestedRoles(['viewer'], ['viewer', 'admin'])).toThrow('admin')
    expect(() => assertRequestedRoles(['viewer', 'operator'], ['viewer'])).not.toThrow()
  })
})
