import { resolve } from 'node:path'

export function dshClientBundleArgs(root) {
  // Package-local tsconfig.json can be a solution file without source paths.
  // Bundling emitted lib/types JavaScript through it follows node_modules back
  // to the original checkout, whose Client outputs may not exist yet. Select
  // the snapshot's Client aliases for both individual and workspace bundles.
  return ['--env.DSH_BUILD_FACE', 'client', '--tsconfig', resolve(root, 'tsconfig.base.client.json')]
}
