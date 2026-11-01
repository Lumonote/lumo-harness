import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * 上游源码洁净度闸门 —— 第一铁律的可执行形式。
 *
 * 构建**前**跑：拒绝把尚未迁移到 platform 覆盖层的产品改动打进包里。
 * 构建**后**再跑：`prepare-runtime.mjs` 把源树的 node_modules 软链进暂存副本，
 * pnpm 可能顺着 workspace 链接把编译产物写回源码目录。仓库里那批
 * `.js/.d.ts/.map` 正是这么产生的；只查前不查后等于把这条路留着。
 */

// spawnSync 的默认 maxBuffer 只有 1 MiB，超了不是「截断」而是直接 ENOBUFS 抛错。
// `git ls-files -z` 在 dsh 这棵树上 2026-11-01 实测是 1,126,691 字节 / 19,188 条路径
// （比默认线多 78 KB），于是 copyTrackedTree 当场炸：
//   Error: spawnSync git ENOBUFS  at git (assert-pristine.mjs:15) ← copyTrackedTree
// 报错长得像 git 崩了，其实是 Node 把管道读断了。这棵树只会越长越大，给足余量。
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function git(root, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-C', root, ...args], { encoding, maxBuffer: GIT_MAX_BUFFER })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  return result.stdout
}

/**
 * 断言上游 checkout 未被产品改动污染。
 * @param root - deepseek-harness 的 checkout 根。
 * @throws 有已跟踪改动，或 apps/ packages/ 下出现未跟踪且未被 gitignore 排除的文件。
 */
export function assertPristineProductSource(root) {
  const tracked = git(root, ['status', '--porcelain', '--untracked-files=no']).trim()
  if (tracked !== '') {
    throw new Error('DeepSeek Harness has tracked modifications. Move product changes to platform overlays before building.\n' + tracked)
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(path =>
      (path.startsWith('apps/') || path.startsWith('packages/')) &&
      !path.split('/').includes('.omc'),
    )
  if (untracked.length > 0) {
    throw new Error('DeepSeek Harness contains generated/product files under apps or packages. Clean them before building.\n' + untracked.join('\n'))
  }
}

export { git }

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: node platform/dsh-overrides/assert-pristine.mjs <source-dsh-root>')
  assertPristineProductSource(resolve(root))
}
