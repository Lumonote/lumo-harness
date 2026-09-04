import esbuild from 'esbuild'
import process from 'process'
import { copyFileSync } from 'node:fs'

const production = process.argv[2] === 'production'

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands', '@codemirror/language', '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight', '@lezer/lr'],
  format: 'cjs',
  target: 'es2021',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'dist/main.js',
})

if (production) {
  await context.rebuild()
  process.exit(0)
} else {
  copyFileSync('manifest.json', 'dist/manifest.json')
  await context.watch()
}
