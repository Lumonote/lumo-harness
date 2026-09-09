import { describe, expect, it } from 'vitest'
import { clusterWiring } from '../src/cluster.ts'

describe('cluster runtime assembly', () => {
  it('routes agents to remote seams and moves ledger transport to RocketMQ', () => {
    const config = clusterWiring({ LUMO_SEAM_ENDPOINTS: 'https://capability:8090', LUMO_MILVUS_URL: 'http://milvus:19530', LUMO_OPA_ADDR: 'http://opa:8181' }, 'cluster', 'agent')
    expect(config).toMatchObject({ seamMode: 'proxy', ledgerTransport: 'rmq', opaUrl: 'http://opa:8181', knowledge: { providerMode: 'remote' } })
    expect(clusterWiring({}, 'cluster', 'node').seamMode).toBe('host')
  })

  it('preserves standalone and local defaults', () => {
    for (const mode of ['local', 'standalone']) {
      expect(clusterWiring({}, mode, 'agent')).toMatchObject({ seamMode: 'disabled', ledgerTransport: 'local', knowledge: { providerMode: 'local' } })
    }
  })

  it('rejects incomplete remote or TLS configuration before runtime startup', () => {
    expect(() => clusterWiring({}, 'cluster', 'agent')).toThrow('LUMO_SEAM_ENDPOINTS')
    expect(() => clusterWiring({ LUMO_SEAM_TLS_CA_FILE: '/ca.pem' }, 'cluster', 'node')).toThrow('mTLS')
    expect(() => clusterWiring({ LUMO_LEDGER_TRANSPORT: 'invalid' }, 'cluster', 'node')).toThrow('LUMO_LEDGER_TRANSPORT')
  })
})
