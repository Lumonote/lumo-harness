/**
 * 行 5 切片 1 双进程冒烟 —— 承载节点进程（carrier）。
 *
 * 教父进程 = 真实 dsh 进程长驻：以用户层自定义 profile「lumo-carrier」boot
 * 真 cordis 树（bundles 只有 @deepseek-ai/dsh-base，无任何 app runner —— 树随
 * subagent-host 的 HTTP 监听而活，profile-boot「leave process lifetime to the
 * mounted plugins」），平台插件行经 `--patch` 挂真装配面：
 *
 *   lumo-smoke-adapter  —— 真树 ctx.llm 上注册 provider='mock'（child 零密钥单 turn）
 *   lumo-object-store   —— session-log 的 objectStore 依赖（§5.1，MinIO）
 *   lumo-session-log    —— PG 真相源（LUMO_SESSION_LOG=0 时不挂，判据相应降级）
 *   lumo-subagent-host  —— 承载体：POST /subagent/start | /subagent/stop（真 HTTP）
 *
 * 为什么不是 `dsh --profile headless`：headless 是一箭终局的 runner——缺任务 =
 * usage error，有任务 = 跑完即 exit（apps/cli → bundle/headless/startup.ts
 * 「a task is required」+ runner 的 io.exit），没有挂起形态；已核验。自定义 profile
 * 是官方支持的用户层拼装（package.json `dsh.profile.bundles` + cordis.patch.yml，
 * bundle 包先按安装锚点解析——dsh-base 在安装内),零 dsh 源码改动。
 *
 * 生命周期：本脚本只做三件事——写 profile/patch → spawn 官方 CLI → 转发终止信号。
 * 子进程意外退出的退出码原样上抛（父侧据此判失败）。
 *
 * 用法（platform 根，由 smoke-parent.ts 拉起；独立调试）：
 *   LUMO_SMOKE_DSH_HOME=/tmp/x LUMO_SMOKE_HOST_PORT=8091 \
 *   ./node_modules/.bin/tsx dsh-plugins/subagent-remote/smoke-node.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '..', '..')
const dshRoot = resolve(platformRoot, '..', 'deepseek-harness')

const home = process.env['LUMO_SMOKE_DSH_HOME'] ?? ''
if (home === '') {
  console.error('smoke-node: 需要 LUMO_SMOKE_DSH_HOME（父侧给的独立临时 dsh 根）')
  process.exit(2)
}

const hostPort = Number(process.env['LUMO_SMOKE_HOST_PORT'] ?? '8091')
const hostToken = process.env['LUMO_SMOKE_HOST_TOKEN'] ?? 'dev-subagent-token'
const realm = process.env['LUMO_SMOKE_REALM'] ?? 'dev'
const pgOn = (process.env['LUMO_SESSION_LOG'] ?? '1') !== '0'
const pgDsn = process.env['LUMO_SMOKE_PG_DSN'] ?? 'postgres://lumo:lumo@127.0.0.1:15432/lumo'
const nodeHolder = `${hostname()}:${Date.now().toString(36)}:${process.pid}`

const adapterEntry = resolve(platformRoot, 'dsh-plugins/subagent-remote/smoke-adapter.ts')
const objectStoreEntry = resolve(platformRoot, 'dsh-plugins/object-store/src/index.ts')
const sessionLogEntry = resolve(platformRoot, 'dsh-plugins/session-log/src/index.ts')
const subagentHostEntry = resolve(platformRoot, 'dsh-plugins/subagent-host/src/index.ts')

// 1. 用户层 profile（loadProfile 先按安装锚点解析 bundle，再回退 profile 内 node_modules；
//    这里只有一个 in-box bundle，零安装零网络）。
const profileDir = join(home, 'profiles', 'lumo-carrier')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'),
  `${JSON.stringify({
    name: 'dsh-profile-lumo-carrier',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2)}\n`,
)
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

// 2. --patch 覆盖层：base 的 JSONL 持久化给冒烟改 plain（父侧可读 header 首行）；
//    插入平台插件行（与 dsh-node 启动器同款：绝对路径 name + YAML 内插配置）。
const sessionLogRow = pgOn
  ? `    - id: lumo-session-log
      name: ${JSON.stringify(sessionLogEntry)}
      inject: [tools, objectStore]
      config:
        connectionString: ${JSON.stringify(pgDsn)}
        holder: ${JSON.stringify(nodeHolder)}
        leaseTtlMs: 30000
`
  : ''
const patchPath = join(home, 'lumo-carrier.patch.yml')
// 排查开关:LUMO_SMOKE_DISABLE_ROWS=goal,web(逗号分隔的 base 行 id)——二分定位
// 真实树里干扰 child 单 turn 驱动的插件行;正常冒烟不设(只设 spill-local,见下)。
const disables = (process.env['LUMO_SMOKE_DISABLE_ROWS'] ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((id) => `- id: ${id}\n  disabled: true\n`)
  .join('')
writeFileSync(patchPath, `${disables}- id: spill-local
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
- insert:
    - id: lumo-smoke-adapter
      name: ${JSON.stringify(adapterEntry)}
      inject: [llm]
      config: {}
    - id: lumo-object-store
      name: ${JSON.stringify(objectStoreEntry)}
      inject: []
      config:
        endPoint: 127.0.0.1
        port: 19000
        useSSL: false
        accessKey: lumo
        secretKey: lumo-minio-123
        bucket: lumo-objects
        realm: ${JSON.stringify(realm)}
${sessionLogRow}    - id: lumo-subagent-host
      name: ${JSON.stringify(subagentHostEntry)}
      # 真 cordis 树的属性代理:不声明即 ctx.agents 冰墙(「cannot get property without inject」)
      inject: [agents]
      config:
        host: 127.0.0.1
        port: ${hostPort}
        tokens:
          ${JSON.stringify(realm)}: ${JSON.stringify(hostToken)}
`)

// 3. 官方 CLI（corepack pnpm；环境只注入 DSH_HOME 与遥测关闭 —— 其余沿用进程环境）。
const args = ['run', 'dsh', '--profile', 'lumo-carrier', '--patch', patchPath]
console.log(`lumo 冒烟承载节点启动（DSH_HOME=${home}, 端口=${hostPort}, PG=${pgOn ? 'on' : 'off [pg-skipped]'}）`)
const child = spawn('corepack', ['pnpm', ...args], {
  cwd: dshRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  },
})

const stop = (signal: NodeJS.Signals): void => {
  // dsh 的 signal 处理应优雅排空（profile-boot 的 signalShutdown），给 5s 后强杀
  console.log(`lumo 冒烟承载节点收到 ${signal}，排空中…`)
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 5000).unref()
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

child.on('exit', (code, signal) => {
  // dsh 被正常终止 / 意外退出：同码上抛（父侧判失败）。
  // DSH_HOME 的清理归父侧（判据失败时数据目录是取证材料），本脚本不作废。
  if (signal !== null) {
    console.error(`lumo 冒烟承载节点因信号 ${signal} 退出`)
    process.exit(1)
  }
  console.log(`lumo 冒烟承载节点退出（code=${code ?? 'null'}）`)
  process.exit(code ?? 1)
})
