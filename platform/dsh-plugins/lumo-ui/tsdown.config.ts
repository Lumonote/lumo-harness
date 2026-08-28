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
  external: [/^@deepseek-ai\/dsh-client-runtime(\/|$)/u],
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
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib', format: 'esm', platform: 'node', dts: false, sourcemap: true, clean: false,
  external: [/^@deepseek-ai\//u, /^node:/u],
  outputOptions: { entryFileNames: 'index.js' },
}

export default [node, browser]
