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
import { hostname } from 'node:os'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '..', '..', '..')
const dshRoot = resolve(platformRoot, '..', 'deepseek-harness')

const knowledgeEntry = resolve(platformRoot, 'dsh-plugins/knowledge/src/index.ts')
const meteringEntry = resolve(platformRoot, 'dsh-plugins/metering/src/index.ts')
const controlEntry = resolve(platformRoot, 'dsh-plugins/control/src/index.ts')
const projectEntry = resolve(platformRoot, 'dsh-plugins/project/src/index.ts')
const connectorEntry = resolve(platformRoot, 'dsh-plugins/connector/src/index.ts')
const webGatewayEntry = resolve(platformRoot, 'dsh-plugins/web-gateway/src/index.ts')
const recoveryEntry = resolve(platformRoot, 'dsh-plugins/recovery/src/index.ts')
const sessionLogEntry = resolve(platformRoot, 'dsh-plugins/session-log/src/index.ts')
const mailboxEntry = resolve(platformRoot, 'dsh-plugins/mailbox/src/index.ts')
const patchPath = resolve(here, '..', 'lumo.patch.yml')

// 节点标识：必须能区分同机重启，否则重启后的进程会被租约当成「本人续租」，
// 白捡走上一代进程的写权（§A1 fencing 的前提是持有者身份唯一）。
const nodeHolder = process.env['LUMO_NODE_ID']
  ?? `${hostname()}:${process.pid}:${Date.now().toString(36)}`

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
        graph:
          depth: 1
          maxNodes: 50
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
    - id: lumo-session-log
      name: ${JSON.stringify(sessionLogEntry)}
      inject: [tools]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
        holder: ${JSON.stringify(nodeHolder)}
        leaseTtlMs: 30000
        # 热层（§4.2 只读热缓存）：本机 Redis；realm 与身份一致（键身份段）
        hotCache:
          url: redis://localhost:6379
          realm: dev
    - id: lumo-mailbox
      name: ${JSON.stringify(mailboxEntry)}
      inject: [tools]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
        realm: dev
    - id: lumo-recovery
      name: ${JSON.stringify(recoveryEntry)}
      inject: [tools]
      config:
        connectionString: postgres://lumo:lumo@localhost:55432/lumo
        prefixes:
          # 连接器工具一律外部写：未显式声明幂等键的按非幂等处理（R2 fail closed）
          - prefix: connector_
            idempotency: non-idempotent
    - id: lumo-connector
      name: ${JSON.stringify(connectorEntry)}
      inject: [tools]
      config:
        gatewayUrl: http://localhost:58082
        realm: dev
        userId: dev-user
        roles: [operator, admin]
        projectId: dev-project
    - id: lumo-web-gateway
      name: ${JSON.stringify(webGatewayEntry)}
      inject: [web]
      config:
        gatewayUrl: http://localhost:58082
        realm: dev
        userId: dev-user
        roles: [operator, admin]
        projectId: dev-project
        deptId: dev-dept
        agentId: dev-agent
        componentId: dev-component
        feature: web.fetch
`,
)

// 附加 CLI 参数（默认 headless 任务形；可经 `--` 覆盖）。
// `pnpm --filter … start -- <args>` 会把分隔符 `--` 原样带进 argv，
// 若原样转发给官方 CLI，commander 会把其后的选项当成操作数 —— 这里剥掉。
const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--')
const args = ['run', 'dsh', '--profile', 'headless', '--patch', patchPath, ...extraArgs]

// pnpm 经 corepack 调用（Node ≥22 自带 corepack；避免依赖外壳 PATH）
const result = spawnSync('corepack', ['pnpm', ...args], {
  cwd: dshRoot,
  stdio: 'inherit',
  env: { ...process.env },
})

rmSync(patchPath, { force: true })
process.exit(result.status ?? 1)
