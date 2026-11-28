import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import type * as Renderer from '@deepseek-ai/dsh-client-ui-renderer/client'

// The public /client entry is a browser module factory. Activate that artifact
// just as the host module loader does, rather than importing upstream internals.
export function nativeRenderer(): typeof Renderer {
  const require = createRequire(import.meta.url)
  const file = require.resolve('@deepseek-ai/dsh-client-ui-renderer/client')
  const dependencies = createRequire(require.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'))
  let exported: typeof Renderer | undefined
  runInNewContext(readFileSync(file, 'utf8'), {
    window: { __ModuleLoader__: { load(entry: { factory(require: (id: string) => unknown): typeof Renderer }) {
      exported = entry.factory(id => id === '@deepseek-ai/cordis' ? cordis : dependencies(id))
    } } }, console, setTimeout, clearTimeout, queueMicrotask,
  }, { filename: file })
  if (!exported?.SlotRegistry) throw new Error('Native renderer public client artifact is unavailable; build upstream client bundles first')
  return exported
}
