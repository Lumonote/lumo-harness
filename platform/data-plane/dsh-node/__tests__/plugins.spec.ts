import { describe, expect, it } from 'vitest'

import {
  missingProfilePluginSpecs,
  obsoleteProfilePluginNames,
  PLATFORM_PLUGIN_MODULES,
  profilePluginSpecs,
} from '../src/plugins.ts'

describe('profile plugin installation', () => {
  it('loads every platform plugin by package name instead of a filesystem path', () => {
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/knowledge')
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/dsh-platform-ui')
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/open-design')
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/archify')
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/creative-skills')
    expect(Object.values(PLATFORM_PLUGIN_MODULES)).toContain('@lumo/ruflo-orchestration')
    expect(Object.values(PLATFORM_PLUGIN_MODULES).every(name => name.startsWith('@lumo/'))).toBe(true)
  })

  it('uses the first-party local auth plugin and keeps only data analysis as a Web community bundle', () => {
    const web = profilePluginSpecs('web', '/workspace/platform')
    const headless = profilePluginSpecs('headless', '/workspace/platform')
    const local = profilePluginSpecs('web', '/workspace/platform', 'local')

    expect(web).toContainEqual({ name: '@lumo/user-auth', spec: 'link:/workspace/platform/dsh-plugins/user-auth' })
    expect(web).toContainEqual({ name: '@lumo/open-design', spec: 'link:/workspace/platform/dsh-plugins/open-design' })
    expect(web).toContainEqual({ name: '@lumo/archify', spec: 'link:/workspace/platform/dsh-plugins/archify' })
    expect(headless).toContainEqual({ name: '@lumo/open-design', spec: 'link:/workspace/platform/dsh-plugins/open-design' })
    expect(headless).toContainEqual({ name: '@lumo/archify', spec: 'link:/workspace/platform/dsh-plugins/archify' })
    expect(web.some(({ name }) => name === 'deepseek-harness-auth')).toBe(false)
    expect(web).toContainEqual({ name: '@yejiming/dsh-data-agent', spec: '@yejiming/dsh-data-agent@0.1.3' })
    expect(headless.some(({ name }) => name === 'deepseek-harness-auth')).toBe(false)
    expect(headless.some(({ name }) => name === '@yejiming/dsh-data-agent')).toBe(false)
    expect(local.map(({ name }) => name)).toEqual([
      '@lumo/dsh-platform-ui', '@lumo/open-design', '@lumo/archify', '@lumo/creative-skills',
      '@lumo/ruflo-orchestration', '@lumo/skill-local',
      'dshmarket', '@liustack/modlens', '@anweat/dsh-browser', 'dsh-context', 'dsh-cost-meter',
    ])
    expect(local).toContainEqual({ name: 'dshmarket', spec: 'dshmarket@1.36.0' })
    expect(local).toContainEqual({ name: '@anweat/dsh-browser', spec: '@anweat/dsh-browser@0.1.10' })
  })

  it('installs only dependencies missing from the profile manifest', () => {
    const desired = profilePluginSpecs('web', '/workspace/platform')
    const missing = missingProfilePluginSpecs(desired, {
      '@lumo/knowledge': 'link:/workspace/platform/dsh-plugins/knowledge',
      '@lumo/user-auth': 'link:/workspace/platform/dsh-plugins/user-auth',
    })

    expect(missing.some(({ name }) => name === '@lumo/knowledge')).toBe(false)
    expect(missing.some(({ name }) => name === '@lumo/user-auth')).toBe(false)
    expect(missing.some(({ name }) => name === '@lumo/dsh-platform-ui')).toBe(true)
    expect(missing.some(({ name }) => name === '@yejiming/dsh-data-agent')).toBe(true)
  })

  it('removes the obsolete third-party auth bundle from persistent Web profiles', () => {
    expect(obsoleteProfilePluginNames('web', { 'deepseek-harness-auth': '0.4.0' })).toEqual(['deepseek-harness-auth'])
    expect(obsoleteProfilePluginNames('headless', { 'deepseek-harness-auth': '0.4.0' })).toEqual([])
  })
})
