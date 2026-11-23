import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

// Exercise the *copied* browser entry, not a TypeScript import. Only the two
// services needed at activation time are provided. Optional features stay idle.
export function verifyWorkbenchClient(packageDir) {
  const require = createRequire(resolve(packageDir, 'package.json'))
  const file = require.resolve('@lumo/dsh-platform-ui/client')
  const code = readFileSync(file, 'utf8')
  const css = [], slots = new Set(), themes = new Map(), effects = []
  let handoff
  const window = { __LUMO_DESKTOP__: true, __ModuleLoader__: { load(value) { handoff = value } } }
  const document = {
    createElement(tag) { assert.equal(tag, 'style'); return { dataset: {} } },
    head: { appendChild(style) { css.push(style.textContent) } },
  }
  try {
    runInNewContext(code, { window, document }, { filename: file })
    assert.equal(handoff?.id, '@lumo/dsh-platform-ui')
    const plugin = handoff.factory(name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name)
      // A host-provided preview component is used during render, not activation.
      if (name === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client') return {}
      throw Error(`unknown browser external: ${name}`)
    })
    const services = {
      slots: {
        inject(_name, mount) { mount() },
        register(meta, component) {
          const key = `${meta.name}:${meta.id ?? ''}`
          assert.equal(typeof component, 'function'); assert.ok(!slots.has(key), `duplicate registration: ${key}`)
          slots.add(key); return () => slots.delete(key)
        },
      },
      theme: {
        getTheme: () => ({ active: { id: 'default' }, themes: [...themes.values()] }),
        register(theme) { themes.set(theme.id, theme); return () => themes.delete(theme.id) },
      },
    }
    const ctx = new Proxy({
      [Symbol.for('cordis.root')]: {},
      effect(body) { effects.push(body()) }, on: () => () => {},
      inject(deps, body) { if (deps.every(dep => Object.hasOwn(services, dep))) body(ctx) },
    }, { get(target, prop, receiver) {
      if (Reflect.has(target, prop) || typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (plugin.inject.includes(prop) && Object.hasOwn(services, prop)) return services[prop]
      throw Error(`cannot get property "${prop}" without inject`)
    } })
    plugin.apply(ctx)
    assert.ok(slots.has('sidebar.navigation:lumo-navigation'), 'missing Lumo sidebar navigation')
    assert.ok(slots.has('shell.overlay:lumo-platform'), 'missing Lumo workbench overlay')
    assert.ok(themes.has('obsidian-signal'), 'missing Lumo theme')
    assert.ok(css.some(text => text.includes('.lumo-sidebar-entry') && text.includes('.lumo-workbench')), 'missing workbench CSS')
    return { sha256: createHash('sha256').update(code).digest('hex'), themeCount: themes.size, slotCount: slots.size }
  } catch (cause) {
    throw Error(`Lumo 工作台客户端装配失败：${file}: ${cause.message}`, { cause })
  } finally {
    for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose()
  }
}
