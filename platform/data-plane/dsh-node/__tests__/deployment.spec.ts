import { describe, expect, it } from 'vitest'
import { assertLocalStoragePath, resolveDeploymentMode, resolveDeploymentProfile, withClusterStatus } from '../src/deployment.ts'

describe('deployment shapes', () => {
  it('keeps local desktop mode on SQLite without distributed middleware', () => {
    const profile = resolveDeploymentProfile('desktop')
    expect(profile).toMatchObject({ mode: 'local', storage: 'sqlite', desktop: true, distributed: false, middleware: [] })
  })

  it('separates the single-server shape from the cluster gate', () => {
    const server = resolveDeploymentProfile('server-singleton')
    const cluster = withClusterStatus(resolveDeploymentProfile('cluster'), 'ready')
    expect(server).toMatchObject({ mode: 'standalone', storage: 'postgres', desktop: false, clusterOnly: false })
    expect(cluster).toMatchObject({ mode: 'cluster', storage: 'postgres', clusterReady: true, clusterOnly: true })
  })

  it('does not infer a mode from middleware availability', () => {
    expect(resolveDeploymentMode(undefined)).toBe('standalone')
    expect(() => resolveDeploymentMode('with-nacos')).toThrow('只能是 local|standalone|cluster')
  })

  it('requires an explicit non-empty SQLite path', () => {
    expect(assertLocalStoragePath(' /tmp/lumo.sqlite ')).toBe('/tmp/lumo.sqlite')
    expect(() => assertLocalStoragePath('  ')).toThrow('不能为空')
  })
})
