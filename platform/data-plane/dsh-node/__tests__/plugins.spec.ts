import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

import { PACKAGED_PROFILE_MODULES } from '../src/generated/plugin-baseline.ts'
import {
  baselineBundlePackages,
  clearReintroducedPluginQuarantine,
  ensurePackagedBaselineBundles,
  ensureProfilePlugins,
  failedProfilePluginNames,
  isOptionalProfilePlugin,
  missingProfilePluginSpecs,
  obsoleteProfilePluginNames,
  PLATFORM_PLUGIN_MODULES,
  profilePluginSpecs,
  profileBundleNames,
  quarantineProfilePlugins,
  reconcileBaselineBundles,
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
      '@lumo/agent-teams',
      '@lumo/dsh-platform-ui', '@lumo/open-design', '@lumo/archify',
      '@lumo/creative-skills', '@lumo/ruflo-orchestration', '@lumo/knowledge-vault', '@lumo/skill-local',
      '@lumo/web-fetch-fakeip',
      'dshmarket', '@liustack/modlens', 'dsh-context', 'dsh-cost-meter', 'dsh-dream-skin',
      '@linxin666/dsh-client-ui-task-board',
    ])
    expect(local).toContainEqual({ name: 'dshmarket', spec: 'dshmarket@1.41.0' })
    expect(local).toContainEqual({ name: 'dsh-context', spec: 'dsh-context@0.41.3' })
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

  it('continues startup when an optional plugin installer fails or throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-install-failure-'))
    const profileDir = join(root, 'dsh', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const desired = profilePluginSpecs('web', root, 'local')
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      dependencies: Object.fromEntries(desired.filter(plugin => plugin.name !== '@yejiming/dsh-data-agent').map(plugin => [plugin.name, plugin.spec])),
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })}\n`)
    const options = {
      profile: 'web', platformRoot: root, dshRoot: root, deploymentMode: 'local' as const,
      env: { DSH_HOME: join(root, 'dsh') } as NodeJS.ProcessEnv,
    }

    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)
    expect(() => ensureProfilePlugins(options)).not.toThrow()
    vi.mocked(spawnSync).mockImplementationOnce(() => { throw new Error('installer unavailable') })
    expect(() => ensureProfilePlugins(options)).not.toThrow()
    expect(profileBundleNames('web', options.env)).toEqual(['@deepseek-ai/dsh-base'])
  })
})

describe('baseline bundle reconciliation', () => {
  it('recognizes an optional bundle in a loader failure while keeping first-party failures loud', () => {
    const stderr = [
      'Error: dsh: plugin tree failed to load',
      'failed to apply loader entry agent-teams (@nanmicoder/dsh-agent-teams):',
      'ctx.subagents.registerContinuableSetup is not a function',
    ].join('\n')

    expect(failedProfilePluginNames(stderr, [
      '@deepseek-ai/dsh-base', '@lumo/dsh-platform-ui', '@nanmicoder/dsh-agent-teams',
    ])).toEqual(['@nanmicoder/dsh-agent-teams'])
    expect(isOptionalProfilePlugin('@nanmicoder/dsh-agent-teams')).toBe(true)
    expect(isOptionalProfilePlugin('@lumo/dsh-platform-ui')).toBe(false)
    expect(failedProfilePluginNames(stderr, ['@deepseek-ai/dsh-base'])).toEqual([])
    expect(failedProfilePluginNames(
      'failed to apply loader entry manual-plugin: incompatible runtime',
      ['@acme/manual-plugin'],
    )).toEqual(['@acme/manual-plugin'])
  })

  it('quarantines only failed bundle layers and permits an explicit re-add', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-quarantine-'))
    const profileDir = join(root, 'dsh', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const env = { DSH_HOME: join(root, 'dsh') } as NodeJS.ProcessEnv
    const manifestPath = join(profileDir, 'package.json')
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: {
        '@nanmicoder/dsh-agent-teams': '0.1.15',
        '@acme/manual-plugin': '1.0.0',
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base', '@nanmicoder/dsh-agent-teams',
            '@acme/manual-plugin', '@lumo/dsh-platform-ui',
          ],
        },
      },
    }, undefined, 2)}\n`)

    expect(quarantineProfilePlugins({
      profile: 'web', packages: ['@nanmicoder/dsh-agent-teams', '@acme/manual-plugin'], reason: 'loader test', env,
    })).toEqual(['@nanmicoder/dsh-agent-teams', '@acme/manual-plugin'])
    expect(profileBundleNames('web', env)).toEqual(['@deepseek-ai/dsh-base', '@lumo/dsh-platform-ui'])
    const quarantinePath = join(profileDir, '.lumo-plugin-quarantine.json')
    expect(JSON.parse(readFileSync(quarantinePath, 'utf8'))).toMatchObject({
      packages: {
        '@nanmicoder/dsh-agent-teams': { reason: 'loader test' },
        '@acme/manual-plugin': { reason: 'loader test' },
      },
    })

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles.splice(1, 0, '@nanmicoder/dsh-agent-teams')
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
    expect(clearReintroducedPluginQuarantine('web', env)).toEqual(['@nanmicoder/dsh-agent-teams'])
    expect(existsSync(quarantinePath)).toBe(true)
    expect(readFileSync(quarantinePath, 'utf8')).toContain('acme/manual-plugin')
  })

  it('appends every missing baseline package without duplicating an existing slot', () => {
    const { bundles, added, removed, owned } = reconcileBaselineBundles({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-context'],
      available: ['dshmarket', 'dsh-context', 'dsh-cost-meter'],
      owned: [],
    })

    expect(added).toEqual(['dshmarket', 'dsh-cost-meter'])
    expect(removed).toEqual([])
    expect(owned).toEqual(['dshmarket', 'dsh-cost-meter'])
    // `dsh-context` keeps the single slot the market gave it: a second one
    // would mount its loader rows twice and fail the boot.
    expect(bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context', 'dshmarket', 'dsh-cost-meter'])
  })

  it('retires only the baseline slots it owns, never a market-owned entry', () => {
    const { bundles, added, removed, owned } = reconcileBaselineBundles({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-retired-plugin', 'dshmarket', 'dsh-cost-meter'],
      available: ['dshmarket'],
      owned: ['dsh-retired-plugin', 'dshmarket'],
    })

    expect(removed).toEqual(['dsh-retired-plugin'])
    expect(added).toEqual([])
    expect(owned).toEqual(['dshmarket'])
    expect(bundles).toEqual(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-cost-meter'])
  })

  it('carries the whole pinned baseline', () => {
    expect(baselineBundlePackages()).toEqual([
      'dshmarket', '@liustack/modlens', 'dsh-context', 'dsh-cost-meter', 'dsh-dream-skin',
      '@linxin666/dsh-client-ui-task-board',
    ])
  })

  it('registers the baseline as profile layers in a packaged runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-baseline-'))
    const runtimeModules = join(root, 'runtime', 'node_modules')
    for (const name of baselineBundlePackages()) {
      mkdirSync(join(runtimeModules, ...name.split('/')), { recursive: true })
      writeFileSync(join(runtimeModules, ...name.split('/'), 'package.json'), '{"name":"x","version":"1.0.0"}\n')
    }
    const profileDir = join(root, 'dsh', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const manifestPath = join(profileDir, 'package.json')
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-context': '^0.42.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context'], patchReload: 'live' } },
    }, undefined, 2)}\n`)

    ensurePackagedBaselineBundles({
      profile: 'web',
      env: { DSH_HOME: join(root, 'dsh'), LUMO_RUNTIME_NODE_MODULES: runtimeModules } as NodeJS.ProcessEnv,
    })

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh: { profile: { bundles: string[]; patchReload: string } }
    }
    const bundles = manifest.dsh.profile.bundles
    // The market-owned `dsh-context` slot is preserved, never appended twice.
    expect(bundles.filter(name => name === 'dsh-context')).toHaveLength(1)
    expect(bundles.slice(0, 3)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context'])
    expect(bundles).toContain('dshmarket')
    expect(new Set(bundles).size).toBe(bundles.length)
    // Existing dependency specs survive; the shipped baseline is recorded so
    // the market's Installed tab agrees with Discover.
    expect(manifest.dependencies).toEqual({
      'dsh-context': '^0.42.0',
      dshmarket: '1.0.0',
      '@liustack/modlens': '1.0.0',
      'dsh-cost-meter': '1.0.0',
      'dsh-dream-skin': '1.0.0',
      '@linxin666/dsh-client-ui-task-board': '1.0.0',
    })
    // The market resolves presence and activation from the profile's own
    // node_modules, not the shared fallback directory.
    for (const name of baselineBundlePackages()) {
      expect(lstatSync(join(profileDir, 'node_modules', ...name.split('/'))).isSymbolicLink()).toBe(true)
    }
    expect(manifest.dsh.profile.patchReload).toBe('live')

    // Re-running is a no-op: the reconciled list is already persisted.
    ensurePackagedBaselineBundles({
      profile: 'web',
      env: { DSH_HOME: join(root, 'dsh'), LUMO_RUNTIME_NODE_MODULES: runtimeModules } as NodeJS.ProcessEnv,
    })
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } })
      .dsh.profile.bundles).toEqual(bundles)
  })

  it('links the packaged modules into every directory the plugin tree resolves bare names from', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-packed-modules-'))
    const runtimeModules = join(root, 'runtime', 'node_modules')
    for (const name of PACKAGED_PROFILE_MODULES) {
      mkdirSync(join(runtimeModules, ...name.split('/')), { recursive: true })
      writeFileSync(join(runtimeModules, ...name.split('/'), 'package.json'), '{"name":"x","version":"1.0.0"}\n')
    }
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, undefined, 2)}\n`)

    ensureProfilePlugins({
      profile: 'web',
      platformRoot: root,
      dshRoot: root,
      env: {
        DSH_HOME: dshHome,
        LUMO_PACKAGED_RUNTIME: '1',
        LUMO_RUNTIME_NODE_MODULES: runtimeModules,
      } as NodeJS.ProcessEnv,
    })

    // 两个锚点缺一不可：bundle 层从 profile 目录解析，而启动器补丁层
    // （`--patch` 的 insert 条目）从 `DSH_HOME` 解析裸包名（实测
    // `parentURL = <DSH_HOME>/package.json`）。少了后者时首方插件全部
    // ERR_MODULE_NOT_FOUND，boot 只报「N entries did not activate」，能力静默消失。
    for (const name of PACKAGED_PROFILE_MODULES) {
      const segments = name.split('/')
      const target = join(runtimeModules, ...segments)
      for (const anchor of ['node_modules', join('profiles', 'node_modules')]) {
        const link = join(dshHome, anchor, ...segments)
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(realpathSync(link)).toBe(realpathSync(target))
      }
    }
  })

  it('does not re-add a quarantined baseline bundle until it is explicitly reintroduced', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-baseline-quarantine-'))
    const runtimeModules = join(root, 'runtime', 'node_modules')
    for (const name of baselineBundlePackages()) {
      mkdirSync(join(runtimeModules, ...name.split('/')), { recursive: true })
      writeFileSync(join(runtimeModules, ...name.split('/'), 'package.json'), '{"name":"x","version":"1.0.0"}\n')
    }
    const profileDir = join(root, 'dsh', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const manifestPath = join(profileDir, 'package.json')
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })}\n`)
    const env = { DSH_HOME: join(root, 'dsh'), LUMO_RUNTIME_NODE_MODULES: runtimeModules } as NodeJS.ProcessEnv

    ensurePackagedBaselineBundles({ profile: 'web', env })
    expect(quarantineProfilePlugins({
      profile: 'web', packages: ['dsh-dream-skin'], env,
    })).toEqual(['dsh-dream-skin'])
    ensurePackagedBaselineBundles({ profile: 'web', env })
    let bundles = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
    expect(bundles).not.toContain('dsh-dream-skin')

    bundles.push('dsh-dream-skin')
    writeFileSync(manifestPath, `${JSON.stringify({ dsh: { profile: { bundles } } })}\n`)
    ensurePackagedBaselineBundles({ profile: 'web', env })
    bundles = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
    expect(bundles).toContain('dsh-dream-skin')
  })

  it('leaves a profile it cannot initialize alone instead of writing a partial manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-baseline-missing-'))
    const runtimeModules = join(root, 'runtime', 'node_modules')
    mkdirSync(resolve(runtimeModules, 'dshmarket'), { recursive: true })

    expect(() => ensurePackagedBaselineBundles({
      profile: 'web',
      env: { DSH_HOME: join(root, 'dsh'), LUMO_RUNTIME_NODE_MODULES: runtimeModules } as NodeJS.ProcessEnv,
    })).not.toThrow()
    expect(existsSync(join(root, 'dsh', 'profiles', 'web', 'package.json'))).toBe(false)
  })
})
