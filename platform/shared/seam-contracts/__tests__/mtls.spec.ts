import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  assertMutualTLSEndpoint,
  assertMutualTLSFileConfig,
  loadMutualTLSCredentials,
  ReloadingMutualTLSCredentials,
} from '../mtls.ts'

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUAcSic+T76SnJ6PJu03G4cLELkSgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJc2VhbS50ZXN0MB4XDTI2MDkwMjA2MzczOFoXDTI2MDkw
MzA2MzczOFowFDESMBAGA1UEAwwJc2VhbS50ZXN0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAxOSwr5HN1lNRBST+9arL3i+bOxNx9sTdeoJc7nG2VI4C
X9of2LTIOc4wA+QB2hlg+zFIBItsJ78YFy6cJE3TMXwm+OjxW9LiqR8myC2z61zI
7jmlsNwz+w8eQPmy2M0S2mmfswobVP9Flo3rltYExHsre2goQliW8oCiLRWY0Daf
Jz2Vs4hdJkijle5tRHN57A2bVJhlxKphEROmLH1JCv65h1GZj3eM/q/42jPTMba1
xubUzEEXRMqwuECCwpJv+4hMXY/Urz2FDUH6VVgfrdHJ7pqg/Gq1gHmkHQYoQV2t
wnoUWZeScPyWHsGbj72bAYuT/GKKVbCz2+WPTOeMgQIDAQABo1MwUTAdBgNVHQ4E
FgQUACZXuA7UT6sAk3GbNrlHLLysdEwwHwYDVR0jBBgwFoAUACZXuA7UT6sAk3Gb
NrlHLLysdEwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAEGsn
Nuk7s8AJaB5+sckTdqgMcKRrfR1SnhsVuleSdiO2gqPnDjKtNP5CJySRJ3eiDml5
f36zOJT+VD/tKxiNpmpRu6WL2W3s7onncNHJgc5vjVHGaFEOnCYDdqkkE/jSGxCC
nsIZZpORCxN353ZklXIA5iOoueK5vZkTW/KWPB1C/ZwxdV5bK8aX7NTkXk59pEIA
kszXungP3dkfhtXzX/CwT4tZ5WywmFjh4RtuTHT3Xz0bKJWwt8kPdXbqfWPKczT8
xzteOpECB6VOwfs7fWOKo5vdXjNuyA08kcdTpQIZF6SU3AxI66fTU7p8wqgcULmn
UOZcao2zp+NEFyzJ0A==
-----END CERTIFICATE-----
`

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDE5LCvkc3WU1EF
JP71qsveL5s7E3H2xN16glzucbZUjgJf2h/YtMg5zjAD5AHaGWD7MUgEi2wnvxgX
LpwkTdMxfCb46PFb0uKpHybILbPrXMjuOaWw3DP7Dx5A+bLYzRLaaZ+zChtU/0WW
jeuW1gTEeyt7aChCWJbygKItFZjQNp8nPZWziF0mSKOV7m1Ec3nsDZtUmGXEqmER
E6YsfUkK/rmHUZmPd4z+r/jaM9MxtrXG5tTMQRdEyrC4QILCkm/7iExdj9SvPYUN
QfpVWB+t0cnumqD8arWAeaQdBihBXa3CehRZl5Jw/JYewZuPvZsBi5P8YopVsLPb
5Y9M54yBAgMBAAECggEARB8FfHEbQNyJqxh+N9wUdfaNpBZZtzGsmS7SXVMtbLrH
Wod6vjzqC4npdecktuNR+Qa3bo8YZ/YHLTocnrjoaXYVe8gIfacMccwL3HVnivaK
tFVwnKzLNUEpS/y4YqctLzEdJlJIW5OIbYsDqCe69YnR5PwH9dB1xUg5FBUlTmAE
Isw60BaPCpoFAAatKjVIsucd1JFhhF06m7jl5cCTd0mTK5cD0uzMem+xgw57LtLU
94U9E+VY5aimrOUO3FIl8AsDZ/bf1/SCPU8ic+4BBS7avsKgw9e04Ie+dK+qdQhs
eo7DsdDw+bGA/tpreI4XWSRNRFP5EmJ6q6VQ7E5bSwKBgQDoyOsSfeCg1WctUMaA
k+XjgU6FGsNRnz0NFyFYSb1mYX2h5R5cKCGT/tQnZZ5UyWvJKMYMP07wvzsUFSMn
OUiAgFL4kn7qzxjndP+xZfOwNPm5XC4FE8yTREK/mlMLvaCQMe83bliVJc1Imddo
STt64lbuMKIsOIecue+gIwppTwKBgQDYh3LNImPRXtFa+EpIwFq0IATBkGuWbUfm
uiU6N2u7NzUR8+fFeVkVji5iVZNRVVppQ2ocvAs76TU396oaqgCKXp3L16PkS2KD
E3tU1wXbnP8m+1QndMCPjkJRh5ez6JQhwldApm+xL1CrPas8m2j3YObXlwX+2rSq
P5eNipKZLwKBgHg2ac7e2oW0LtgkAp6bwfg+6oGqVHtuNGTyMPIbAohAiFR2sbr9
rnly+7RssdsvOU5klAH3H5kL6EJyt/iliF9z5WUgohI4aK/+p5zA/ZtdgCjNBabx
lo/mjGHOHFzPzH8qilKh1XUQVHbNm4PrbaAECshurREREFdLXgfgkJvZAoGBANUJ
bwolK9BzWcgHQg8SMivG1OcdEL2QB44a10XQAU7RooVnVEIWgm+S1FAroiYDtFCc
42oiGWt4p8PJCLPzT1TUgqxsHfQft2z/Xfi7Fihc7y2LWeD4Hf0gGl/c6IU574TH
kNEq7/mEc/oHUtLulPfPf0/eZye4Rsi6iIHaNSJBAoGAeh5scbJzWanonjunXcpD
ybFUBo2fJqS88Xk45m2oBHrIap3I85dQcbh0uunyrv5AqxpT3q4Eoqf19AkyW382
FgwtXrRDo8Z76xZ6WtXwveX6/oPU9VynZ2AiSj/vgw5K1vtrOAOvQTI/BYRG5rMD
ii3Y+Ah23aOc/tcwLrE8AKk=
-----END PRIVATE KEY-----
`

describe('mutual TLS configuration', () => {
  const config = {
    caFile: '/var/run/lumo/ca.pem', certFile: '/var/run/lumo/node.pem', keyFile: '/var/run/lumo/node-key.pem',
  }

  it('requires absolute secret-volume paths and a valid optional server name', () => {
    expect(() => assertMutualTLSFileConfig(config)).not.toThrow()
    expect(() => assertMutualTLSFileConfig({ ...config, keyFile: 'secrets/key.pem' })).toThrow('absolute')
    expect(() => assertMutualTLSFileConfig({ ...config, serverName: 'bad/name' })).toThrow('DNS')
    expect(() => assertMutualTLSFileConfig({ ...config, reloadIntervalMs: 999 })).toThrow('reloadIntervalMs')
  })

  it('does not permit mTLS configuration to silently use plaintext HTTP', () => {
    expect(() => assertMutualTLSEndpoint('https://seam.internal:9443')).not.toThrow()
    expect(() => assertMutualTLSEndpoint('http://seam.internal:8090')).toThrow('https')
  })

  it('fails closed when a configured secret volume cannot be read', () => {
    expect(() => loadMutualTLSCredentials(config)).toThrow('cannot be read')
  })

  it('rotates only after the check interval and retains a last-known-good bundle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumo-mtls-'))
    const files = {
      caFile: join(directory, 'ca.pem'),
      certFile: join(directory, 'cert.pem'),
      keyFile: join(directory, 'key.pem'),
      reloadIntervalMs: 1_000,
    }
    try {
      writeFileSync(files.caFile, CERTIFICATE)
      writeFileSync(files.certFile, CERTIFICATE)
      writeFileSync(files.keyFile, PRIVATE_KEY)
      const reloader = new ReloadingMutualTLSCredentials(files)
      expect((reloader.get(1_000).cert as Buffer).toString()).toBe(CERTIFICATE)

      const rotatedCertificate = `${CERTIFICATE}\n`
      writeFileSync(files.certFile, rotatedCertificate)
      expect((reloader.get(1_500).cert as Buffer).toString()).toBe(CERTIFICATE)
      expect((reloader.get(2_000).cert as Buffer).toString()).toBe(rotatedCertificate)

      writeFileSync(files.certFile, '')
      expect((reloader.get(3_000).cert as Buffer).toString()).toBe(rotatedCertificate)
      expect(reloader.lastReloadError?.message).toContain('empty')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
