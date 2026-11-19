import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const id = '@lumo/dsh-platform-ui'
const cssPrefix = '\0lumo-css:'

const cssPlugin = {
  name: 'lumo-css-inline',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.css') || importer === undefined) return null
    return cssPrefix + resolve(dirname(importer), source) + '.mjs'
  },
  load(source: string) {
    if (!source.startsWith(cssPrefix)) return null
    const css = readFileSync(source.slice(cssPrefix.length, -4), 'utf8')
    return `const css=${JSON.stringify(css)};if(typeof document!=="undefined"){const s=document.createElement("style");s.dataset.lumo="platform-ui";s.textContent=css;document.head.appendChild(s)}export default {};`
  },
}

const browser = {
  name: `${id}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, sourcemap: true, clean: false,
  external: [/^@deepseek-ai\/dsh-client-ui-renderer(\/|$)/u, /^@deepseek-ai\/dsh-client-ui-theme(\/|$)/u,
    /^@deepseek-ai\/dsh-client-ui-sidebar-documentpreview\/client$/u],
  plugins: [cssPlugin],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const node = {
  name: id,
  entry: { index: 'src/index.ts' },
  outDir: 'lib', format: 'esm', platform: 'node', dts: false, sourcemap: true, clean: false,
  // This public source subpath uses TypeScript parameter properties. Bundle it
  // so the packaged Node process never has to execute uncompiled dependency TS.
  external: (source: string) => source !== '@deepseek-ai/dsh-host-authentication-token/src/browser-auth.ts'
    && (/^@deepseek-ai\//u.test(source) || /^node:/u.test(source)),
  noExternal: ['@deepseek-ai/dsh-host-authentication-token/src/browser-auth.ts'],
  outputOptions: { entryFileNames: 'index.js' },
}

export default [node, browser]
