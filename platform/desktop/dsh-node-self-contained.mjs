import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

// dsh-node 在打包 runtime 里以 .ts 源码被 tsx 直接加载（tauri.conf.json 把
// target/lumo-runtime 映射到 Resources/runtime），所以它的值导入只能落在包内，或者
// 是 runtime/node_modules 能解析的包名。跨树相对路径（../../../shared/…、
// ../../../dsh-plugins/…）在源码布局成立、打包态必然 ERR_MODULE_NOT_FOUND：
// cluster.ts 的 worker-binding 导入曾让桌面包启动即崩。
// 语句级 `import type …` 由 tsx 擦除，不参与运行时解析，因此不算违规；
// 一旦被改成值导入，就会被这条扫描抓住。

// 行首（允许缩进）的 import/export，第二组捕获语句级 type 修饰符，第三组是说明符。
const MODULE_SPECIFIER = /(?:^|[\r\n])[ \t]*(import|export)[ \t]+(?:(type)[ \t]+)?(?:[^'"]*?[ \t]+from[ \t]+)?['"]([^'"]+)['"]/gu
// 与 build-runtime.mjs 的 cpSync 过滤口径一致：这三个目录不进打包产物。
const SKIPPED_TOP_LEVEL = new Set(['node_modules', 'tests', '__tests__', '.git'])

function isUnder(path, root) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function listSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED_TOP_LEVEL.has(entry.name)) return []
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listSources(path)
    return /\.(?:ts|mts|tsx)$/u.test(entry.name) && statSync(path).isFile() ? [path] : []
  })
}

/** 返回逃出 `sourceRoot` 的**值**导入说明符；语句级类型导入不计入。 */
export function findCrossTreeImports(sourceRoot) {
  const offenders = []
  for (const file of listSources(sourceRoot)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(MODULE_SPECIFIER)) {
      const [, , typeOnly, specifier] = match
      if (!specifier.startsWith('.') || typeOnly !== undefined) continue
      if (isUnder(resolve(dirname(file), specifier), sourceRoot)) continue
      offenders.push({
        file: relative(sourceRoot, file),
        line: text.slice(0, match.index).split('\n').length,
        specifier,
      })
    }
  }
  return offenders
}
