import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

// One list drives both dependency-closure roots and compilation. A source
// plugin cannot be compiled unless its runtime dependencies were staged too.
export const packagedTypeScriptPluginDirectories = Object.freeze([
  'agent-teams', 'computer-use', 'open-design', 'archify', 'creative-skills', 'ruflo-orchestration', 'web-fetch-fakeip',
])

function isWithin(root, path) {
  const value = relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function emittedExtension(path) {
  return path.replace(/\.(?:tsx?|jsx?)$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs')
}

function listTypeScriptSources(directory) {
  const sources = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) sources.push(...listTypeScriptSources(entryPath))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) sources.push(entryPath)
  }
  return sources
}

// Inspect emitted JavaScript: TypeScript has already erased type-only imports.
// AST nodes cover multiline named exports and literal dynamic imports as well
// as ordinary imports, without mistaking comments or strings for dependencies.
function relativeModuleSpecifiers(typescript, source) {
  const specifiers = []
  const visit = (node) => {
    let specifier
    if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) specifier = node.moduleSpecifier
    else if (typescript.isCallExpression(node)
      && (node.expression.kind === typescript.SyntaxKind.ImportKeyword
        || (typescript.isIdentifier(node.expression) && node.expression.text === 'require'))) specifier = node.arguments[0]
    if (specifier && (typescript.isStringLiteral(specifier) || typescript.isNoSubstitutionTemplateLiteral(specifier))
      && /^\.\.?\//.test(specifier.text)) specifiers.push(specifier)
    typescript.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

function assertRelativeImportsEmitted(typescript, packageName, destination, emitted) {
  for (const outputPath of emitted) {
    if (outputPath.endsWith('.json')) continue
    const output = readFileSync(outputPath, 'utf8')
    const source = typescript.createSourceFile(outputPath, output, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS)
    for (const specifier of relativeModuleSpecifiers(typescript, source)) {
      const target = resolve(dirname(outputPath), specifier.text)
      if (!isWithin(destination, target) || !existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`无法构建桌面 runtime：${packageName}/${relative(destination, outputPath)} 相对导入了 ${specifier.text}，但该文件未产出`)
      }
    }
  }
}

/** Compile one copied source plugin without executing the desktop build pipeline. */
export function compilePackagedTypeScriptPlugin({ typescript, packageName, packageRoot, destination, dependencyRoot, outputDirectory = 'lib' }) {
  const sourceRoot = resolve(packageRoot, 'src')
  dependencyRoot = resolve(dependencyRoot)
  const outputRoot = resolve(destination, outputDirectory)
  if (!isWithin(destination, outputRoot) || outputRoot === resolve(destination)) {
    throw new Error(`无法构建桌面 runtime：${packageName} 的产物目录必须位于包内：${outputDirectory}`)
  }
  const compilerOptions = {
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.Bundler,
    target: typescript.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
    rewriteRelativeImportExtensions: true,
    allowJs: true,
    resolveJsonModule: true,
  }
  const outputs = new Map()
  const outputOwners = new Map()
  const queue = []
  const enqueue = (sourcePath) => {
    sourcePath = resolve(sourcePath)
    if (outputs.has(sourcePath)) return outputs.get(sourcePath)
    if (!isWithin(dependencyRoot, sourcePath) || /\.d\.[cm]?ts$/.test(sourcePath)) {
      throw new Error(`无法构建桌面 runtime：${packageName} 的运行依赖不在可打包源码内：${sourcePath}`)
    }
    // Keep src/ entry locations stable (some plugins use import.meta.url).
    // Cross-root modules live inside this plugin's ESM/dependency scope, with
    // their source-root-relative shape; never emit into node_modules/shared.
    const outputPath = isWithin(sourceRoot, sourcePath)
      ? resolve(outputRoot, emittedExtension(relative(sourceRoot, sourcePath)))
      : resolve(outputRoot, '__lumo_runtime__', emittedExtension(relative(dependencyRoot, sourcePath)))
    if (outputOwners.has(outputPath)) throw new Error(`无法构建桌面 runtime：${packageName} 的产物路径冲突：${outputPath}`)
    outputs.set(sourcePath, outputPath)
    outputOwners.set(outputPath, sourcePath)
    queue.push(sourcePath)
    return outputPath
  }
  for (const sourcePath of listTypeScriptSources(sourceRoot)) enqueue(sourcePath)
  const emitted = new Set()
  for (let index = 0; index < queue.length; index += 1) {
    const sourcePath = queue[index]
    const outputPath = outputs.get(sourcePath)
    if (sourcePath.endsWith('.json')) {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, readFileSync(sourcePath))
      emitted.add(outputPath)
      continue
    }
    const result = typescript.transpileModule(readFileSync(sourcePath, 'utf8'), {
      compilerOptions,
      fileName: sourcePath,
      reportDiagnostics: true,
    })
    const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === typescript.DiagnosticCategory.Error) ?? []
    if (errors.length > 0) {
      throw new Error(`无法构建桌面 runtime：${sourcePath} 转译失败：${errors.map(diagnostic => typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')}`)
    }
    const output = typescript.createSourceFile(outputPath, result.outputText, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS)
    const replacements = relativeModuleSpecifiers(typescript, output).map((specifier) => {
      // TypeScript extension substitution resolves './file.js' to file.ts,
      // including specifiers rewritten from .ts by transpileModule above.
      const resolved = typescript.resolveModuleName(specifier.text, sourcePath, compilerOptions, typescript.sys).resolvedModule
      if (!resolved || !existsSync(resolved.resolvedFileName)) {
        throw new Error(`无法构建桌面 runtime：${packageName}/${relative(packageRoot, sourcePath)} 相对导入了 ${specifier.text}，但找不到运行源码`)
      }
      const target = enqueue(resolved.resolvedFileName)
      let rewritten = relative(dirname(outputPath), target).split(sep).join('/')
      if (!rewritten.startsWith('.')) rewritten = `./${rewritten}`
      return { start: specifier.getStart(output), end: specifier.getEnd(), text: JSON.stringify(rewritten) }
    })
    let rewritten = result.outputText
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end)
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, rewritten)
    emitted.add(outputPath)
  }
  assertRelativeImportsEmitted(typescript, packageName, destination, emitted)

  const manifestPath = resolve(destination, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.type = 'module'
  const entry = `./${relative(destination, resolve(outputRoot, 'index.js')).split(sep).join('/')}`
  manifest.main = entry
  if (manifest.exports?.['.'] !== undefined && typeof manifest.exports['.'] === 'object') {
    manifest.exports['.'] = { ...manifest.exports['.'], import: entry, default: entry }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return emitted
}
