/**
 * @lumo/dsh-node —— 节点启动器（薄包装官方 CLI 的 patch 机制）。
 *
 * 官方 `dsh --profile ... --patch <file>` 的用户 patch 层是官方支持的挂载点
 * （profile-boot.ts:62「Edit cordis.patch.yml」+ `--patch` overlays, in argv
 * order）。本启动器生成 patch 文件（平台插件以绝对路径 + 配置注入），委托
 * 官方 CLI 进程启动完整插件树。零侵入：不改 dsh 任何源码。
 *
 * 用法：pnpm --filter @lumo/dsh-node start  [-- <dsh CLI 附加参数>]
 * 例：  pnpm --filter @lumo/dsh-node start -- --profile headless "测试任务"
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '..', '..', '..')
const dshRoot = resolve(platformRoot, '..', 'deepseek-harness')

const knowledgeEntry = resolve(platformRoot, 'dsh-plugins/knowledge/src/index.ts')
const meteringEntry = resolve(platformRoot, 'dsh-plugins/metering/src/index.ts')
const controlEntry = resolve(platformRoot, 'dsh-plugins/control/src/index.ts')
const projectEntry = resolve(platformRoot, 'dsh-plugins/project/src/index.ts')
const patchPath = resolve(here, '..', 'lumo.patch.yml')

// 平台插件 patch（官方 patch 语法：insert 数组 = 追加条目）
writeFileSync(
  patchPath,
  `- insert:
    - id: lumo-knowledge
      name: ${JSON.stringify(knowledgeEntry)}
      inject: [tools]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
        realm: dev
        roles: [viewer, operator]
        defaultTopK: 5
        embedding:
          baseUrl: http://localhost:55433
          model: BAAI/bge-m3
          dimension: 1024
    - id: lumo-metering
      name: ${JSON.stringify(meteringEntry)}
      inject: [llm]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
        userId: dev-user
        deptId: dev-dept
        role: operator
        projectId: dev-project
        agentId: dev-agent
        componentId: dev-component
        feature: kb:qa
        defaultBudget: 1000000
    - id: lumo-control
      name: ${JSON.stringify(controlEntry)}
      inject: [tools]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
    - id: lumo-project
      name: ${JSON.stringify(projectEntry)}
      inject: [tools]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
        projectId: dev-project
        realm: dev
`,
)

// 附加 CLI 参数（默认 headless 任务形；可经 `--` 覆盖）
const extraArgs = process.argv.slice(2)
const args = ['run', 'dsh', '--profile', 'headless', '--patch', patchPath, ...extraArgs]

// pnpm 经 corepack 调用（Node ≥22 自带 corepack；避免依赖外壳 PATH）
const result = spawnSync('corepack', ['pnpm', ...args], {
  cwd: dshRoot,
  stdio: 'inherit',
  env: { ...process.env },
})

rmSync(patchPath, { force: true })
process.exit(result.status ?? 1)
