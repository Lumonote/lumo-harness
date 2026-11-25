import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const plugin = fileURLToPath(new URL('../../dsh-plugins/lumo-ui/', import.meta.url))

test('the desktop UI compiler emits its cross-plugin graph and advertised type entrypoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-ui-build-'))
  try {
    const config = ts.getParsedCommandLineOfConfigFile(join(plugin, 'tsconfig.json'), {
      outDir: join(root, 'lib/types'),
      tsBuildInfoFile: join(root, 'tsconfig.tsbuildinfo'),
    }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) })
    assert.ok(config)
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, projectReferences: config.projectReferences })
    const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => '\n',
    }))
    assert.equal(program.emit().emitSkipped, false)

    const manifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
    for (const entry of [manifest.types, manifest.exports['.'].types, manifest.exports['./client'].types]) {
      assert.ok(existsSync(join(root, entry)), `Missing advertised declaration: ${entry}`)
    }
    // The emitted declarations must carry the sibling modules they refer to.
    for (const source of ['dsh-plugins/acp-engines/src/embed.ts', 'dsh-plugins/dual-plugins/src/index.ts', 'shared/seam-contracts/asks.ts']) {
      assert.ok(existsSync(join(root, 'lib/types', source.replace(/\.ts$/u, '.d.ts'))), `Missing transitive declaration: ${source}`)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
