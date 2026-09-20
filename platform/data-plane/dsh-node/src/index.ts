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
 *
 * 双角色（LUMO_ROLE=node|agent，默认 node —— 行 5 装配面）：
 *   node  承载节点 —— patch 追加 lumo-subagent-host（放置面，子代理落本节点执行）
 *   agent 父节点   —— patch 追加 lumo-subagent-remote（子代理经 Scheduler 放置到承载节点）
 */
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { spawn } from 'node:child_process'
import { localStorageRows, localVaultRows, profileLifetimeOverlay, profileStorageRows, workflowEngineOverlay } from './workflow.ts'
import { localSkillSnapshotAssembly, skillSnapshotSource, waitForSkillSnapshotFile } from './skills.ts'
import { startNacosRegistration } from './nacos.ts'
import { planClusterReporter, startClusterReporter } from './cluster-reporter.ts'
import { clusterWiring, workerBindingFromEnv } from './cluster.ts'
import {
  ensureProfilePlugins,
  failedProfilePluginNames,
  profileBundleNames,
  quarantineProfilePlugins,
  PLATFORM_PLUGIN_MODULES,
} from './plugins.ts'
import { assertLocalStoragePath, resolveDeploymentProfile, withClusterStatus } from './deployment.ts'
import { FAKE_IP_PROVIDER_ID } from '@lumo/web-fetch-fakeip'

const here = dirname(fileURLToPath(import.meta.url))
const packagedRuntimeRoot = process.env['LUMO_RUNTIME_ROOT']
  ? resolve(process.env['LUMO_RUNTIME_ROOT']!)
  : undefined
// 桌面单机的可写状态一律放进系统应用数据目录（Rust 壳注入 LUMO_RUNTIME_STATE_DIR，
// 即 ~/Library/Application Support/<AppId>/runtime）。runtime 包本体在应用捆绑内，
// **每次重装都会被替换**——生成/安装的技能、SkillHub 目录与快照必须落在这里，
// 绝不可以落 runtime 里（CWD 相对的 .lumo/* 正是重装即丢的根因）。
const desktopStateDir = process.env['LUMO_RUNTIME_STATE_DIR']
  ? resolve(process.env['LUMO_RUNTIME_STATE_DIR']!)
  : resolve(process.env['DSH_HOME'] ?? join(homedir(), 'Library', 'Application Support', 'Lumo', 'dsh'), 'runtime')
const platformRoot = packagedRuntimeRoot ?? resolve(here, '..', '..', '..')
const dshRoot = process.env['LUMO_DSH_ROOT']
  ? resolve(process.env['LUMO_DSH_ROOT']!)
  : resolve(platformRoot, '..', 'deepseek-harness')

const {
  agentTeams: agentTeamsEntry,
  knowledge: knowledgeEntry,
  metering: meteringEntry,
  control: controlEntry,
  project: projectEntry,
  connector: connectorEntry,
  webGateway: webGatewayEntry,
  webFetchFakeIp: webFetchFakeIpEntry,
  recovery: recoveryEntry,
  sessionLog: sessionLogEntry,
  jobControl: jobControlEntry,
  mailbox: mailboxEntry,
  subagentHost: subagentHostEntry,
  subagentRemote: subagentRemoteEntry,
  seamHost: seamHostEntry,
  seamProxy: seamProxyEntry,
  skillLocal: skillLocalEntry,
  objectStore: objectStoreEntry,
  attachments: attachmentsEntry,
  provenance: provenanceEntry,
  storage: storageEntry,
  platformUi: platformUiEntry,
  userAuth: userAuthEntry,
  openDesign: openDesignEntry,
  archify: archifyEntry,
  creativeSkills: creativeSkillsEntry,
  rufloOrchestration: rufloOrchestrationEntry,
} = PLATFORM_PLUGIN_MODULES
const patchPath = process.env['LUMO_PATCH_PATH']
  ? resolve(process.env['LUMO_PATCH_PATH']!)
  : resolve(here, '..', 'lumo.patch.yml')
const deployment = withClusterStatus(resolveDeploymentProfile(), process.env['LUMO_CLUSTER_STATUS'])
const localMode = deployment.mode === 'local'
const sqlitePath = assertLocalStoragePath(process.env['LUMO_SQLITE_PATH'] ?? resolve(platformRoot, '.lumo', 'lumo.sqlite'))
if (localMode) mkdirSync(dirname(sqlitePath), { recursive: true })

// 节点标识：必须能区分同机重启，否则重启后的进程会被租约当成「本人续租」，
// 白捡走上一代进程的写权（§A1 fencing 的前提是持有者身份唯一）。
const nodeHolder = process.env['LUMO_NODE_ID']
  ?? `${hostname()}:${process.pid}:${Date.now().toString(36)}`
// Job control addresses the Scheduler's stable node id, not the session-log
// lease holder (which intentionally changes on every restart).
const jobControlNodeId = process.env['LUMO_NODE_ID'] ?? hostname()

// 双角色（行 5 装配面）：node = 承载节点（挂 lumo-subagent-host,子代理放这里执行）；
// agent = 父节点（挂 lumo-subagent-remote,子代理经 Scheduler 放置到承载节点执行）。
// 默认 node —— 兼容既有「单机全插件」用法,不改变既有行为。
const role = process.env['LUMO_ROLE'] ?? 'node'
if (role !== 'node' && role !== 'agent') {
  console.error(`dsh-node: LUMO_ROLE 只能是 node|agent,收到 ${JSON.stringify(role)}`)
  process.exit(1)
}

const subagentRealm = process.env['LUMO_SUBAGENT_REALM'] ?? process.env['LUMO_REALM'] ?? 'dev'
/** 承载侧放置面与会话日志 holder(§A1 同训:重启换号)。 */
const hostToken = process.env['LUMO_SUBAGENT_HOST_TOKEN'] ?? 'dev-subagent-token'
// Container deployments need to bind on the overlay network while local
// development should remain loopback-only by default.
const hostBind = process.env['LUMO_SUBAGENT_HOST_BIND'] ?? '127.0.0.1'
const callbackBind = process.env['LUMO_SUBAGENT_CALLBACK_BIND_HOST'] ?? '127.0.0.1'
const hostPort = integerEnv('LUMO_SUBAGENT_HOST_PORT', 8091)
const callbackPort = integerEnv('LUMO_SUBAGENT_CALLBACK_PORT', 8092)
const callbackOrigins = (process.env['LUMO_SUBAGENT_CALLBACK_ALLOWED_ORIGINS'] ?? `http://127.0.0.1:${callbackPort}`)
  .split(',').map((value) => value.trim()).filter(Boolean)

// All platform plugin wiring is deployment configuration. `local` is handled
// by the SQLite-only branch below; server shapes provide these values through
// LUMO_* environment variables. No URL is used to infer the deployment mode.
const platformRealm = process.env['LUMO_REALM'] ?? subagentRealm
const pgDSN = process.env['LUMO_PG_DSN'] ?? 'postgres://lumo:lumo@localhost:55432/lumo'
const redisURL = process.env['LUMO_REDIS_URL'] ?? 'redis://localhost:6379'
const embeddingBaseURL = process.env['LUMO_EMBEDDING_BASE_URL'] ?? 'http://localhost:55433'
const embeddingModel = process.env['LUMO_EMBEDDING_MODEL'] ?? 'BAAI/bge-m3'
const embeddingDimension = integerEnv('LUMO_EMBEDDING_DIMENSION', 1024)
const connectorGatewayURL = process.env['LUMO_CONNECTOR_GATEWAY_URL'] ?? 'http://localhost:58082'
const governanceURL = process.env['LUMO_GOVERNANCE_URL'] ?? 'http://localhost:58089'
// 控制面地址**故意没有缺省值**，与上面两个不同。
//
// 有缺省时，一个没配这个变量的部署会去连 localhost:8092，症状是「控制面连不上」——
// 于是排查方向是网络、防火墙、容器名，而真实原因是「这个部署没有接线」。空值时
// `dispatch` 抛的是 ControlCommandRoutingError（明说本实例没接控制面），这个区别
// 值得用一次显式配置来换。
//
// local 形态本来就没有 session-control 这个服务（compose.local.yml 不启它），所以
// 空值在那里的含义是准确的，不是漏配。
const sessionControlURL = process.env['LUMO_SESSION_CONTROL_URL'] ?? ''
const userID = process.env['LUMO_USER_ID'] ?? 'dev-user'
const deptID = process.env['LUMO_DEPT_ID'] ?? 'dev-dept'
const userRole = process.env['LUMO_USER_ROLE'] ?? 'operator'
const projectID = process.env['LUMO_PROJECT_ID'] ?? 'dev-project'
const agentID = process.env['LUMO_AGENT_ID'] ?? 'dev-agent'
const componentID = process.env['LUMO_COMPONENT_ID'] ?? 'dev-component'
const feature = process.env['LUMO_FEATURE'] ?? 'kb:qa'
const defaultBudget = integerEnv('LUMO_DEFAULT_BUDGET', 1000000)
const minioEndpoint = process.env['LUMO_MINIO_ENDPOINT'] ?? 'localhost'
const minioPort = integerEnv('LUMO_MINIO_PORT', 9000)
const minioAccessKey = process.env['LUMO_MINIO_ACCESS_KEY'] ?? 'lumo'
const minioSecretKey = process.env['LUMO_MINIO_SECRET_KEY'] ?? 'lumo-minio-123'
const minioBucket = process.env['LUMO_MINIO_BUCKET'] ?? 'lumo-objects'
const dshProfile = process.env['LUMO_DSH_PROFILE'] ?? 'headless'
const isWebProfile = dshProfile === 'web'
const webPort = integerEnv('LUMO_WEB_PORT', 3080)
const authPort = integerEnv('LUMO_AUTH_PORT', webPort)
const controlPlaneToken = process.env['LUMO_CONTROL_PLANE_TOKEN'] ?? ''
const identityAssertionSecret = process.env['LUMO_IDENTITY_ASSERTION_SECRET'] || controlPlaneToken
const cluster = clusterWiring(process.env, deployment.mode, role)
const workerBinding = deployment.mode === 'cluster' && role === 'node'
  ? workerBindingFromEnv(process.env, { agentId: agentID, userId: userID, projectId: projectID }) : undefined
const seamToken = process.env['LUMO_SEAM_TOKEN'] || controlPlaneToken
const seamRows = cluster.seamMode === 'disabled' ? '' : `    - id: lumo-seam-${cluster.seamMode}
      name: ${JSON.stringify(cluster.seamMode === 'proxy' ? seamProxyEntry : seamHostEntry)}
      config: ${JSON.stringify(cluster.seamMode === 'proxy' ? {
        mode: 'remote', endpoints: cluster.endpoints, realm: platformRealm, userId: userID,
        roles: [userRole], token: seamToken, identityAssertionSecret, tls: cluster.tls,
      } : {
        host: cluster.seamHost, port: cluster.port, tokens: { [platformRealm]: seamToken },
        identityAssertionSecret, tls: cluster.tls,
      })}
`
// `pnpm --filter ... start -- <args>` keeps the separator in argv. The DSH
// launcher must see only the app arguments that follow it.
const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--')

ensureProfilePlugins({ profile: dshProfile, platformRoot, dshRoot, deploymentMode: deployment.mode })

// 基线插件（dsh-market/modlens/dsh-context/cost-meter/...）**不在这里挂载**。
// 它们各自在 package.json 里声明 `dsh.bundle.patch`，只能作为 profile 的
// `dsh.profile.bundles` 层加载：官方 profile boot 先套 bundle 层再套本 patch，
// 同一个 loader id 出现两次会被 Loader 直接判重复并拒绝启动（曾经因为
// dsh-context 崩在 `duplicate loader entry id`）。登记由 plugins.ts 的
// ensurePackagedBaselineBundles 完成（开发态则由 `dsh plugin add` 的官方
// reconcile 完成），insert 段只留给 Lumo 自己的覆盖层。

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

// P3: a Provisioner (or a deployment operator during the first slice) pins a
// complete local skill snapshot. The child process only sees verified bytes;
// the stock filesystem provider is disabled below so project/user roots cannot
// silently override that snapshot.
const provisionedArtifactName = process.env['PROVISIONER_ARTIFACT_NAME']?.trim()
const skillSnapshotRoot = process.env['LUMO_SKILL_SNAPSHOT_ROOT']
  ?? (provisionedArtifactName ? '/var/lib/lumo/artifacts/skills' : undefined)
const skillSnapshotFile = process.env['LUMO_SKILL_SNAPSHOT_FILE']
  ?? (provisionedArtifactName ? '/var/lib/lumo/artifacts/skill-snapshot.json' : undefined)
let skillLocalRows = ''
let skillFilesystemOverlay = ''
try {
  if (provisionedArtifactName && skillSnapshotFile) {
    await waitForSkillSnapshotFile(skillSnapshotFile, integerEnv('LUMO_SKILL_SNAPSHOT_WAIT_MS', 120_000))
  }
  const assembled = localSkillSnapshotAssembly(
    skillSnapshotRoot,
    skillSnapshotSource(process.env['LUMO_SKILL_SNAPSHOT'], skillSnapshotFile),
    skillLocalEntry,
  )
  skillLocalRows = assembled.rows
  skillFilesystemOverlay = assembled.filesystemOverlay
} catch (error: unknown) {
  if (skillSnapshotRoot !== undefined) {
    console.error(`dsh-node: 本地技能快照配置非法：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

type PluginSummary = {
  id: string
  label: string
  description: string
  surface: 'knowledge' | 'skills' | 'connectors' | 'operations' | 'account' | 'market'
  kind: 'runtime' | 'governance'
}

// The workbench owns this catalogue: every row routes to the surface that
// actually consumes its service or registry, rather than a generic plugin list.
// Local Desktop is deliberately a smaller product: it exposes the local
// workbench, design/diagram skills and any signed local skill snapshot, while
// server-only control-plane capabilities stay out of the catalogue entirely.
const basePluginRows: PluginSummary[] = [
  { id: 'dshmarket', label: '插件市场', description: '浏览、搜索并管理 DSH 基础插件', surface: 'market', kind: 'runtime' },
  { id: 'modlens', label: '视觉理解', description: '图片读取、OCR 与视觉证据', surface: 'market', kind: 'runtime' },
  { id: 'dsh-context', label: '上下文洞察', description: '查看上下文组成、趋势与注入事件', surface: 'market', kind: 'runtime' },
  { id: 'dsh-cost-meter', label: '费用统计', description: '会话、预算、模型价格与历史费用', surface: 'market', kind: 'runtime' },
  { id: 'dsh-dream-skin', label: '梦幻皮肤', description: '8 套高质感主题、弥散光壁纸与每用户强调色', surface: 'market', kind: 'runtime' },
  { id: 'dsh-task-board', label: '任务看板', description: 'Host 权威任务台帐：看板任务、真实 DSH 会话执行与定时调度', surface: 'market', kind: 'runtime' },
  { id: 'dsh-agent-teams', label: '多智能体团队（社区版）', description: '社区插件：自然语言编排船长/成员、带依赖任务与消息，Web 树状监控。基线未收录（依赖 master 已移除的 continuable API），可从市场安装', surface: 'operations', kind: 'runtime' },
  { id: 'dsh-univer-office', label: 'Univer 办公文档（社区版）', description: '社区插件：DSH × Univer 协作网关与查看器。基线未收录（客户端半边与 master 代差过大，会在 web 启动期失败），可从市场自行安装', surface: 'market', kind: 'runtime' },
  { id: 'gpt-image-2-style-library', label: '图像风格库', description: 'GPT Image 2 模板、风格标签与工业级提示词', surface: 'skills', kind: 'runtime' },
  { id: 'ppt-master', label: '演示文稿生成', description: '生成、编辑和增强原生可编辑 PPTX', surface: 'skills', kind: 'runtime' },
  { id: 'ruflo-orchestration', label: '多智能体编排', description: '在任务运行内组织 Ruflo 智能体拓扑与分工', surface: 'operations', kind: 'runtime' },
]

const mountedPlugins: PluginSummary[] = localMode ? [
  ...basePluginRows,
  { id: 'subagent-local', label: '本机多智能体', description: '官方进程内生成与分叉，多智能体并行执行', surface: 'operations', kind: 'runtime' },
  { id: 'agent-teams', label: '多智能体团队', description: '成员名册 + 任务板(DAG) + 会合面；单机在进程内派单，团队状态落本地 SQLite', surface: 'operations', kind: 'runtime' },
  { id: 'open-design', label: '开放设计', description: '产物优先的原型与视觉工作流', surface: 'skills', kind: 'runtime' },
  { id: 'archify', label: '架构与调度图', description: '可验证的系统图、流程图与多智能体调度视图', surface: 'skills', kind: 'runtime' },
] : [
  ...basePluginRows,
  { id: 'knowledge', label: '知识库', description: '检索与来源引用', surface: 'knowledge', kind: 'runtime' },
  { id: 'project', label: '项目空间', description: '成员、空间与制品边界', surface: 'operations', kind: 'governance' },
  { id: 'control', label: '权限控制', description: '能力与治理闸门', surface: 'operations', kind: 'governance' },
  { id: 'connector', label: '连接器治理', description: '凭证、策略和受控调用', surface: 'connectors', kind: 'governance' },
  { id: 'web-gateway', label: 'Web 出站', description: 'SSRF 与域名策略拦截', surface: 'connectors', kind: 'governance' },
  { id: 'metering', label: '用量计量', description: '额度预留、提交与台账', surface: 'operations', kind: 'governance' },
  { id: 'session-log', label: '会话审计', description: '脱敏轨迹与可回放记录', surface: 'operations', kind: 'runtime' },
  { id: 'mailbox', label: '协作信箱', description: '跨智能体消息与领取确认', surface: 'operations', kind: 'runtime' },
  { id: 'agent-teams', label: '多智能体团队', description: '成员名册 + 任务板(DAG) + 会合面；任务与名册落 PG，成员经 lumo-remote 放置到承载节点', surface: 'operations', kind: 'runtime' },
  { id: 'job-control', label: '作业控制', description: '任务状态与结果回写', surface: 'operations', kind: 'runtime' },
  { id: 'attachments', label: '附件', description: '安全附件引用', surface: 'operations', kind: 'runtime' },
  { id: 'object-store', label: '对象存储', description: '大对象读写边界', surface: 'operations', kind: 'runtime' },
  { id: 'open-design', label: '开放设计', description: '产物优先的原型与视觉工作流', surface: 'skills', kind: 'runtime' },
  { id: 'archify', label: '架构与调度图', description: '可验证的系统图、流程图与多智能体调度视图', surface: 'skills', kind: 'runtime' },
  { id: 'provenance', label: '来源追踪', description: '上下文来源链', surface: 'operations', kind: 'runtime' },
  { id: 'recovery', label: '恢复检查点', description: '失败恢复与幂等', surface: 'operations', kind: 'runtime' },
  { id: 'storage', label: '存储适配', description: 'PostgreSQL 存储后端', surface: 'operations', kind: 'runtime' },
  role === 'node'
    ? { id: 'subagent-host', label: '子智能体承载', description: '受控执行与回调宿主', surface: 'operations', kind: 'runtime' }
    : { id: 'subagent-remote', label: '子智能体路由', description: 'Scheduler 放置与远程回调', surface: 'operations', kind: 'runtime' },
]

if (skillLocalRows !== '') {
  mountedPlugins.push({ id: 'skill-local', label: '技能管理', description: '受签名快照约束的本地技能', surface: 'skills', kind: 'runtime' })
}
if (isWebProfile) {
  mountedPlugins.push(
    { id: 'platform-ui', label: 'Lumo 运营面', description: '原生 DSH 内的能力工作台', surface: 'operations', kind: 'runtime' },
  )
  if (!localMode) mountedPlugins.push({ id: 'auth', label: '用户中心', description: '账号、安全与会话退出', surface: 'account', kind: 'governance' })
}

// 行 5 的下发段:角色不同,只挂对应一侧(承载节点不需要 remote,父节点不需要 host)。
const roleRows = localMode ? '' : role === 'node'
  ? `    - id: lumo-subagent-host
      name: ${JSON.stringify(subagentHostEntry)}
      inject: [agents, jobControl]
      config:
        host: ${JSON.stringify(hostBind)}
        port: ${hostPort}
        tokens:
          ${JSON.stringify(subagentRealm)}: ${JSON.stringify(hostToken)}
        callbackOrigins: ${JSON.stringify(callbackOrigins)}
        connectionString: ${JSON.stringify(pgDSN)}
${workerBinding ? `        runtimeReport: ${JSON.stringify({
  governanceUrl: governanceURL, token: controlPlaneToken, realm: platformRealm, nodeId: jobControlNodeId,
  binding: workerBinding,
  capacity: integerEnv('LUMO_NODE_CAPACITY', 1),
})}\n` : ''}
`
  : `    - id: lumo-subagent-remote
      name: ${JSON.stringify(subagentRemoteEntry)}
      inject: [subagents, jobControl]
      config:
        schedulerUrl: ${JSON.stringify(process.env['LUMO_SCHEDULER_URL'] ?? 'http://localhost:8083')}
        connectionString: ${JSON.stringify(pgDSN)}
        controlPlaneToken: ${JSON.stringify(process.env['LUMO_CONTROL_PLANE_TOKEN'] ?? '')}
        clusterId: ${JSON.stringify(process.env['LUMO_CLUSTER_ID'] ?? '')}
        nodeUrls: ${JSON.stringify(JSON.parse(process.env['LUMO_SUBAGENT_NODE_URLS'] ?? (process.env['LUMO_NACOS_ADDR'] === undefined ? '{"N1":"http://localhost:8091"}' : '{}')))}
        hostTokens: ${JSON.stringify(JSON.parse(process.env['LUMO_SUBAGENT_HOST_TOKENS'] ?? '{}'))}
        nacosUrl: ${JSON.stringify(process.env['LUMO_NACOS_ADDR'] ?? '')}
        nacosService: ${JSON.stringify(process.env['LUMO_NACOS_SERVICE'] ?? 'lumo-dsh-node')}
        nacosGroup: ${JSON.stringify(process.env['LUMO_NACOS_GROUP'] ?? 'DEFAULT_GROUP')}
        defaultHostToken: ${JSON.stringify(process.env['LUMO_SUBAGENT_HOST_TOKEN'] ?? 'dev-subagent-token')}
        realm: ${JSON.stringify(subagentRealm)}
        callbackPort: ${callbackPort}
        callbackHost: ${JSON.stringify(process.env['LUMO_SUBAGENT_CALLBACK_HOST'] ?? '127.0.0.1')}
        callbackBindHost: ${JSON.stringify(callbackBind)}
`


// fake-ip 代理（Surge 增强模式/Clash TUN/sing-box）下 web_fetch 的自动修复（见
// docs/configuration.md）：挂 fake-ip 感知的 fetch 提供者,并把官方 `web` 条目的
// fetchProvider 钉过去。只对打包桌面（local + web profile）生效——服务器形态保留
// 官方严格公网预检,需要出站代理时走官方环境变量机制。放行段可用
// LUMO_WEB_FETCH_FAKEIP_CIDRS（逗号分隔）覆盖,默认 198.18.0.0/15 + fd00::/8。
const fakeIpCidrs = (process.env['LUMO_WEB_FETCH_FAKEIP_CIDRS'] ?? '')
  .split(',').map(value => value.trim()).filter(Boolean)
// insert 数组只放新条目。把 `- id: web` 写进 insert 会变成「追加同 id 条目」——官方
// loader 的 EntryGroup.update 见到重名立刻抛 duplicate loader entry id: web，整棵
// 插件树挂载失败，桌面壳起不来。
const webFetchFakeIpRows = localMode && isWebProfile
  ? `    - id: lumo-web-fetch-fakeip
      name: ${JSON.stringify(webFetchFakeIpEntry)}
      inject: [web]
${fakeIpCidrs.length > 0 ? `      config:
        fakeIpCidrs: ${JSON.stringify(fakeIpCidrs)}
` : ''}`
  : ''
// 钉 fetchProvider 要走顶层 `- id: <已有条目>` 才算「按 id 打补丁」。官方 patch 的语义
// 是整键替换而非深合并（app-boot 的 applyEntryPatches），所以官方 `web` 条目的 config
// 必须整份重述：漏写 searchProvider 会静默抹掉官方检索提供者。上游给该条目新增配置键
// 时，这里要同步补上。
const webFetchFakeIpPatchRow = localMode && isWebProfile
  ? `- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: ${JSON.stringify(FAKE_IP_PROVIDER_ID)}
`
  : ''

// 多智能体团队（`ctx.agentTeams`）：一份插件同时覆盖单机与集群两种形态。
// 形态差异不在装配层分支，而在插件内部按优先级探测成员 provider
// （集群父节点命中 `lumo-remote`，单机回落 `spawn`/`fork`）；团队状态走 dsh
// storage hub（单机 sqlite、集群 PG），会合面在有 mailbox 时自动升级到 PG。
// 故这里只声明 `tools` 一个硬依赖 —— `subagents` 的挂载顺序不由本插件决定。
const agentTeamsRows = `    - id: lumo-agent-teams
      name: ${JSON.stringify(agentTeamsEntry)}
      inject: [tools]
      config:
        realm: ${JSON.stringify(platformRealm)}
`

// 平台插件 patch（官方 patch 语法：insert 数组 = 追加条目）
writeFileSync(
  patchPath,
  `${localMode ? `# Local desktop shape: SQLite only. No PostgreSQL, Redis, MinIO, RocketMQ or Nacos.
# The Rust desktop shell supplies LUMO_SQLITE_PATH in the OS application-data directory.
` : `# Server shape: platform object storage replaces the base local attachment/spill stores.
# The object-store plugin fails loudly on unavailable MinIO instead of quietly
# writing node-local data that another worker cannot resume.
`}
${isWebProfile ? `${localMode ? `# Local desktop serves the native DSH Web shell directly on loopback.
` : `# The first-party auth listener is the only public face. The DSH carrier gets
# an OS-assigned loopback port so unauthenticated traffic cannot bypass it.
`}
- id: webserver
  config:
    host: 127.0.0.1
    port: ${localMode ? webPort : 0}
- id: web-runtime
  config:
    openBrowser: false
    printUrl: false
    surfaceContext: false
    trustedHosts: []
${webFetchFakeIpPatchRow}` : ''}${localMode ? '' : `- id: attachment-local
  disabled: true
- id: spill-local
  disabled: true
`}
- insert:
${localMode ? localStorageRows(dshProfile, sqlitePath) + localVaultRows(sqlitePath, platformRealm) + webFetchFakeIpRows + agentTeamsRows : `    - id: lumo-object-store
      name: ${JSON.stringify(objectStoreEntry)}
      inject: []
      config:
        endPoint: ${JSON.stringify(minioEndpoint)}
        port: ${minioPort}
        useSSL: false
        accessKey: ${JSON.stringify(minioAccessKey)}
        secretKey: ${JSON.stringify(minioSecretKey)}
        bucket: ${JSON.stringify(minioBucket)}
        realm: ${JSON.stringify(platformRealm)}
    - id: lumo-attachments
      name: ${JSON.stringify(attachmentsEntry)}
      inject: [objectStore]
      config:
        realm: ${JSON.stringify(platformRealm)}
${profileStorageRows(dshProfile)}
    - id: lumo-storage-pg
      name: ${JSON.stringify(storageEntry)}
      inject: [storage]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
    - id: lumo-provenance
      name: ${JSON.stringify(provenanceEntry)}
      inject: [tools]
      config:
        prefixes:
          - prefix: connector_
            provenance: external
            effect: write-external
          - prefix: web_
            provenance: external
            effect: read
${seamRows}    - id: lumo-knowledge
      name: ${JSON.stringify(knowledgeEntry)}
      inject: ${JSON.stringify(cluster.seamMode === 'proxy' ? ['tools', 'knowledge', 'knowledgeGraph'] : ['tools'])}
      config:
        providerMode: ${JSON.stringify(cluster.knowledge.providerMode)}
        milvusUrl: ${JSON.stringify(cluster.knowledge.milvusUrl ?? '')}
        milvusCollection: ${JSON.stringify(cluster.knowledge.milvusCollection)}
        milvusRebuildUrl: ${JSON.stringify(cluster.knowledge.milvusRebuildUrl ?? '')}
        nebulaUrl: ${JSON.stringify(cluster.knowledge.nebulaUrl ?? '')}
        remoteApiKey: ${JSON.stringify(cluster.knowledge.remoteApiKey ?? '')}
${cluster.knowledge.rerank ? `        rerank: ${JSON.stringify(cluster.knowledge.rerank)}\n` : ''}
        connectionString: ${JSON.stringify(pgDSN)}
        realm: ${JSON.stringify(platformRealm)}
        roles: [viewer, operator]
        defaultTopK: 5
        embedding:
          baseUrl: ${JSON.stringify(embeddingBaseURL)}
          model: ${JSON.stringify(embeddingModel)}
          dimension: ${embeddingDimension}
        graph:
          depth: 1
          maxNodes: 50
    - id: lumo-metering
      name: ${JSON.stringify(meteringEntry)}
      inject: [llm]
      config:
        ledgerTransport: ${JSON.stringify(cluster.ledgerTransport)}
        connectionString: ${JSON.stringify(pgDSN)}
        userId: ${JSON.stringify(userID)}
        deptId: ${JSON.stringify(deptID)}
        role: ${JSON.stringify(userRole)}
        projectId: ${JSON.stringify(projectID)}
        agentId: ${JSON.stringify(agentID)}
        componentId: ${JSON.stringify(componentID)}
        feature: ${JSON.stringify(feature)}
        defaultBudget: ${defaultBudget}
    - id: lumo-control
      name: ${JSON.stringify(controlEntry)}
      inject: [tools]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
        opaUrl: ${JSON.stringify(cluster.opaUrl)}
        opaToken: ${JSON.stringify(cluster.opaToken)}
        controlPlaneUrl: ${JSON.stringify(sessionControlURL)}
        controlPlaneToken: ${JSON.stringify(controlPlaneToken)}
    - id: lumo-project
      name: ${JSON.stringify(projectEntry)}
      inject: [tools]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
        projectId: ${JSON.stringify(projectID)}
        realm: ${JSON.stringify(platformRealm)}
    - id: lumo-session-log
      name: ${JSON.stringify(sessionLogEntry)}
      inject: [tools]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
        holder: ${JSON.stringify(nodeHolder)}
        leaseTtlMs: 30000
        # 热层（§4.2 只读热缓存）：本机 Redis；realm 与身份一致（键身份段）
        hotCache:
          url: ${JSON.stringify(redisURL)}
          realm: ${JSON.stringify(platformRealm)}
    - id: lumo-job-control
      name: ${JSON.stringify(jobControlEntry)}
      inject: [jobs]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
        nodeId: ${JSON.stringify(jobControlNodeId)}
        pollIntervalMs: ${process.env['LUMO_JOB_CONTROL_POLL_MS'] ?? '250'}
    - id: lumo-mailbox
      name: ${JSON.stringify(mailboxEntry)}
      inject: [tools]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
        realm: ${JSON.stringify(platformRealm)}
${agentTeamsRows}    - id: lumo-recovery
      name: ${JSON.stringify(recoveryEntry)}
      inject: [tools]
      config:
        connectionString: ${JSON.stringify(pgDSN)}
        prefixes:
          # 连接器工具一律外部写：未显式声明幂等键的按非幂等处理（R2 fail closed）
          - prefix: connector_
            idempotency: non-idempotent
    - id: lumo-connector
      name: ${JSON.stringify(connectorEntry)}
      inject: [tools]
      config:
        gatewayUrl: ${JSON.stringify(connectorGatewayURL)}
        controlPlaneToken: ${JSON.stringify(process.env['LUMO_CONTROL_PLANE_TOKEN'] ?? '')}
        realm: ${JSON.stringify(platformRealm)}
        userId: ${JSON.stringify(userID)}
        roles: [${JSON.stringify(userRole)}]
        projectId: ${JSON.stringify(projectID)}
    - id: lumo-web-gateway
      name: ${JSON.stringify(webGatewayEntry)}
      inject: [web]
      config:
        gatewayUrl: ${JSON.stringify(connectorGatewayURL)}
        controlPlaneToken: ${JSON.stringify(process.env['LUMO_CONTROL_PLANE_TOKEN'] ?? '')}
        realm: ${JSON.stringify(platformRealm)}
        userId: ${JSON.stringify(userID)}
        roles: [${JSON.stringify(userRole)}]
        projectId: ${JSON.stringify(projectID)}
        deptId: ${JSON.stringify(deptID)}
        agentId: ${JSON.stringify(agentID)}
        componentId: ${JSON.stringify(componentID)}
        feature: web.fetch
`}
    - id: lumo-open-design
      name: ${JSON.stringify(openDesignEntry)}
      inject: [skills]
    - id: lumo-archify
      name: ${JSON.stringify(archifyEntry)}
      inject: [skills]
    - id: lumo-creative-skills
      name: ${JSON.stringify(creativeSkillsEntry)}
      inject: [skills]
    - id: lumo-ruflo-orchestration
      name: ${JSON.stringify(rufloOrchestrationEntry)}
      inject: [skills]
${roleRows}
${skillLocalRows}
${isWebProfile ? `${localMode ? '' : `    - id: lumo-user-auth
      name: ${JSON.stringify(userAuthEntry)}
      inject: [webServer]
      config:
        host: ${JSON.stringify(process.env['LUMO_AUTH_HOST'] ?? '0.0.0.0')}
        port: ${authPort}
        publicBaseUrl: ${JSON.stringify(process.env['LUMO_AUTH_PUBLIC_URL'] ?? `http://127.0.0.1:${authPort}`)}
        secureCookie: ${process.env['LUMO_AUTH_SECURE_COOKIE'] === 'true'}
        clusterMode: ${deployment.mode === 'cluster'}
        clusterReady: ${deployment.clusterReady}
        governanceUrl: ${JSON.stringify(governanceURL)}
        connectorUrl: ${JSON.stringify(process.env['LUMO_CONNECTOR_GATEWAY_URL'] ?? 'http://localhost:8082')}
        controlPlaneToken: ${JSON.stringify(controlPlaneToken)}
        realm: ${JSON.stringify(platformRealm)}
        projectId: ${JSON.stringify(projectID)}
        identityAssertionSecret: ${JSON.stringify(identityAssertionSecret)}
        timeoutMs: ${integerEnv('LUMO_AUTH_TIMEOUT_MS', 5000)}
`}
    - id: lumo-platform-ui
      name: ${JSON.stringify(platformUiEntry)}
      inject: [webServer]
      config:
        schedulerUrl: ${JSON.stringify(process.env['LUMO_SCHEDULER_API_URL'] ?? process.env['LUMO_SCHEDULER_URL'] ?? 'http://localhost:8083')}
        projectsUrl: ${JSON.stringify(process.env['LUMO_PROJECTS_URL'] ?? 'http://localhost:8086')}
        flowsUrl: ${JSON.stringify(process.env['LUMO_FLOWS_URL'] ?? 'http://localhost:8087')}
        connectorUrl: ${JSON.stringify(process.env['LUMO_CONNECTOR_GATEWAY_URL'] ?? 'http://localhost:8082')}
        governanceUrl: ${JSON.stringify(governanceURL)}
        registryUrl: ${JSON.stringify(process.env['LUMO_REGISTRY_URL'] ?? 'http://localhost:8084')}
        # Empty means "this deployment has no session-control"; no localhost fallback.
        sessionControlUrl: ${JSON.stringify(sessionControlURL)}
        realm: ${JSON.stringify(platformRealm)}
        userId: ${JSON.stringify(userID)}
        roles: ${JSON.stringify([userRole])}
        projectId: ${JSON.stringify(projectID)}
        deptId: ${JSON.stringify(deptID)}
        controlPlaneToken: ${JSON.stringify(controlPlaneToken)}
        identityAssertionSecret: ${JSON.stringify(identityAssertionSecret)}
        timeoutMs: ${integerEnv('LUMO_UI_API_TIMEOUT_MS', 5000)}
        deploymentMode: ${JSON.stringify(deployment.mode)}
        storageBackend: ${JSON.stringify(deployment.storage)}
        middleware: ${JSON.stringify(deployment.middleware)}
        clusterStatus: ${JSON.stringify(deployment.clusterReady ? 'ready' : 'not_ready')}
        plugins: ${JSON.stringify(mountedPlugins)}
        desktopHandoffFile: ${JSON.stringify(localMode ? (process.env['LUMO_DESKTOP_HANDOFF_FILE'] ?? '') : '')}
        # 单机版 SkillHub 状态（目录/安装记录/快照）必须落在应用数据目录：
        # runtime 包体随重装被替换，CWD 相对的 .lumo/* 重装即丢（生成技能丢失事故根因）。
        skillhubCatalogFile: ${JSON.stringify(localMode ? join(desktopStateDir, 'skillhub-catalog.json') : '.lumo/skillhub-catalog.json')}
        skillhubInstallFile: ${JSON.stringify(localMode ? join(desktopStateDir, 'skillhub-installs.json') : '.lumo/skillhub-installs.json')}
        skillhubRoot: ${JSON.stringify(localMode ? join(desktopStateDir, 'skills') : '.lumo/skills')}
        skillhubCommand: ${JSON.stringify(process.env['LUMO_SKILLHUB_COMMAND'] ?? 'skillhub')}
        skillhubSnapshotFile: ${JSON.stringify(localMode ? join(desktopStateDir, 'skill-snapshot.json') : '.lumo/skill-snapshot.json')}
` : ''}
${workflowEngineOverlay(role)}
${skillFilesystemOverlay}
${profileLifetimeOverlay(dshProfile, extraArgs.length > 0)}
`,
)

const dshArgs = [
  '--profile', dshProfile, '--patch', patchPath,
  // The public auth proxy owns LUMO_WEB_PORT. The DSH WebServer stays on the
  // loopback-only, OS-assigned port from the patch above; passing --port here
  // would override that row and race the proxy for the public port.
  ...(isWebProfile ? ['--no-open'] : []),
  ...extraArgs,
]

// Packaged desktop builds carry their own Node and official dsh CLI. Repository
// previews keep the pnpm path so HMR and local workspace development remain
// unchanged.
const nacosRegistration = !localMode && role === 'node' && process.env['LUMO_NACOS_ADDR']
  ? startNacosRegistration({
    baseUrl: process.env['LUMO_NACOS_ADDR'],
    serviceName: process.env['LUMO_NACOS_SERVICE'] ?? 'lumo-dsh-node',
    groupName: process.env['LUMO_NACOS_GROUP'] ?? 'DEFAULT_GROUP',
    nodeId: process.env['LUMO_NODE_ID'] ?? nodeHolder,
    realm: platformRealm,
    clusterId: process.env['LUMO_CLUSTER_ID'] ?? 'default',
    host: process.env['LUMO_NODE_ADVERTISE_HOST'] ?? hostname(),
    port: hostPort,
    capacity: integerEnv('LUMO_NODE_CAPACITY', 1),
    capabilities: (process.env['LUMO_NODE_CAPABILITIES'] ?? 'subagent').split(',').map((value) => value.trim()).filter(Boolean),
    residency: process.env['LUMO_NODE_RESIDENCY'] ?? '',
  })
  : { close: async (): Promise<void> => {} }

// 集群存活自报（联邦注册表的客户端侧，见 cluster-reporter.ts）。与 Nacos 注册是
// **两件不同的事**：Nacos 报的是「本机这个**节点**在服务发现里还活着」，这里报的是
// 「本集群还活着」，后者是跨集群放置闸门的输入。多集群拓扑里一个调度实例只能替一个
// 集群自报，其余集群若无人上报就会一起被判成 down——闸门随即拒掉它们的新放置，
// 而失联的恰恰是「没人报」而不是「真挂了」。
const clusterReporterPlan = planClusterReporter(process.env, deployment.mode, role)
if (!clusterReporterPlan.enabled) {
  // 关闭必须说出来。**但级别取决于形态**：在 cluster 形态下「本集群没有上报方」是
  // 真正的风险（判定一开，本集群会在 down 阈值后被拒新放置，而日志里一片安静，
  // 看起来像闸门自己坏了），所以是 warn；在 local/standalone 下这只是「这个形态
  // 没有消费者」的说明，按 warn 打会在每次启动时制造一条假警报，把真警报淹掉。
  const notice = `dsh-node: 集群存活自报未启用 —— ${clusterReporterPlan.reason}`
  if (deployment.mode === 'cluster') {
    console.warn(
      `${notice}；若该控制面已启用集群失联判定（LUMO_CLUSTER_ENFORCE），本集群会在 down 阈值后被拒新放置`,
    )
  } else {
    console.info(notice)
  }
}
const clusterReporter = clusterReporterPlan.enabled
  ? startClusterReporter(clusterReporterPlan)
  : { close: async (): Promise<void> => {} }

const packagedDshCli = process.env['LUMO_DSH_CLI']
const windowsCorepack = process.platform === 'win32' && packagedDshCli === undefined
const childCommand = packagedDshCli
  ? process.execPath
  : windowsCorepack ? 'cmd.exe' : 'corepack'
const childArgs = packagedDshCli
  ? [packagedDshCli, ...dshArgs]
  : windowsCorepack
    ? ['/d', '/s', '/c', 'corepack.cmd', 'pnpm', 'run', 'dsh', ...dshArgs]
    : ['pnpm', 'run', 'dsh', ...dshArgs]
let stopping = false
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  // The platform package is deliberately outside the ignored DSH source
  // tree. NODE_PATH lets the untouched official profile resolve its package
  // name while the package's own dependencies remain workspace links.
  NODE_PATH: [
    process.env['LUMO_RUNTIME_NODE_MODULES'],
    resolve(platformRoot, 'data-plane/dsh-node/node_modules'),
    process.env['NODE_PATH'],
  ].filter(Boolean).join(delimiter),
}
let child: ReturnType<typeof spawn> | undefined
let recoveryAttempts = 0
const maxRecoveryAttempts = 32
const forwardSignal = (signal: NodeJS.Signals): void => {
  if (stopping) return
  stopping = true
  child?.kill(signal)
}
process.once('SIGTERM', () => forwardSignal('SIGTERM'))
process.once('SIGINT', () => forwardSignal('SIGINT'))

const finish = (code: number): void => {
  // 两个上报循环都要停掉再退出：自报定时器已 unref，单靠它不会拖住进程，但在退出
  // 前取消在途请求可以避免一个必然失败的 PUT 把错误日志留在最后一行。
  void Promise.allSettled([
    nacosRegistration.close(),
    clusterReporter.close(),
  ]).finally(() => {
    rmSync(patchPath, { force: true })
    process.exit(code)
  })
}

/**
 * A third-party bundle is allowed to fail independently. The official loader
 * aborts the whole tree, so remove only the named optional bundle and retry
 * the same invocation. Core Lumo/DSH packages remain fail-loud.
 */
const launchChild = (): void => {
  let stderr = ''
  const handoffFile = childEnv['LUMO_DESKTOP_HANDOFF_FILE']
  if (handoffFile) rmSync(handoffFile, { force: true })
  const nextChild = spawn(childCommand, childArgs, {
    cwd: dshRoot,
    // Keep stdout interactive while teeing stderr for recovery diagnostics.
    stdio: ['inherit', 'inherit', 'pipe'],
    env: childEnv,
  })
  child = nextChild
  nextChild.stderr?.setEncoding('utf8')
  nextChild.stderr?.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    process.stderr.write(text)
    stderr = (stderr + text).slice(-256 * 1024)
  })
  nextChild.once('error', (error) => {
    console.error(`dsh-node: 官方 CLI 启动失败: ${error.message}`)
  })
  nextChild.once('close', (code, signal) => {
    if (nextChild !== child) return
    if (!stopping && signal === null && code !== 0 && recoveryAttempts < maxRecoveryAttempts) {
      const candidates = profileBundleNames(dshProfile, childEnv)
      const failed = failedProfilePluginNames(stderr, candidates)
      const quarantined = quarantineProfilePlugins({
        profile: dshProfile,
        packages: failed,
        reason: 'DSH Loader rejected optional plugin',
        env: childEnv,
      })
      if (quarantined.length > 0) {
        recoveryAttempts += quarantined.length
        console.warn(`dsh-node: 已隔离失败插件并重试启动：${quarantined.join(', ')}`)
        launchChild()
        return
      }
    }
    finish(signal === null ? (code ?? 1) : 1)
  })
}

launchChild()
