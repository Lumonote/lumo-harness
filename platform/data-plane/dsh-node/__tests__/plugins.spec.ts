import { describe, expect, it } from 'vitest'

import {
  missingProfilePluginSpecs,
  PLATFORM_PLUGIN_MODULES,
  profilePluginSpecs,
} from '../src/plugins.ts'

describe('profile plugin installation', () => {
  it('loads every platform plugin by package name instead of a filesystem path', () => {
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/knowledge')
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/dsh-platform-ui')
    expect(Object.values(PLATFORM_PLUGIN_MODULES).every(name => name.startsWith('@lumo/'))).toBe(true)
  })

  it('adds Web-only login and data-analysis bundles to the Web profile', () => {
    const web = profilePluginSpecs('web', '/workspace/platform')
    const headless = profilePluginSpecs('headless', '/workspace/platform')

    expect(web).toContainEqual({ name: 'deepseek-harness-auth', spec: 'deepseek-harness-auth@0.4.0' })
    expect(web).toContainEqual({ name: '@yejiming/dsh-data-agent', spec: '@yejiming/dsh-data-agent@0.1.3' })
    expect(headless.some(({ name }) => name === 'deepseek-harness-auth')).toBe(false)
    expect(headless.some(({ name }) => name === '@yejiming/dsh-data-agent')).toBe(false)
  })

  it('installs only dependencies missing from the profile manifest', () => {
    const desired = profilePluginSpecs('web', '/workspace/platform')
    const missing = missingProfilePluginSpecs(desired, {
      '@lumo/knowledge': 'link:/workspace/platform/dsh-plugins/knowledge',
      'deepseek-harness-auth': '0.4.0',
    })

    expect(missing.some(({ name }) => name === '@lumo/knowledge')).toBe(false)
    expect(missing.some(({ name }) => name === 'deepseek-harness-auth')).toBe(false)
    expect(missing.some(({ name }) => name === '@lumo/dsh-platform-ui')).toBe(true)
    expect(missing.some(({ name }) => name === '@yejiming/dsh-data-agent')).toBe(true)
  })
})
