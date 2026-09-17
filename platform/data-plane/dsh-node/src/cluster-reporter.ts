/**
 * 集群存活自报（联邦注册表的客户端侧）。
 *
 * ## 为什么要有这个文件
 *
 * 注册表端点（`PUT /v1/clusters/{id}`）与两段式失联判定此前只有调度实例一侧在用：
 * `LUMO_SCHEDULER_CLUSTER_ID` 一个进程只有一个值，所以**一个服务多个集群的调度实例
 * 只能替其中一个集群宣称存活**，其余集群没有任何上报方 → 它们会在 down 阈值后一起
 * 变成 down，而闸门随即拒掉它们的新放置（设计稿 §7.2 点名的「半开注册表 = 自伤」）。
 * 真实拓扑就是这个形状：`compose.cluster.yml` 里一个 `scheduler-0` 服务 cluster-a
 * 与 cluster-b 两组节点。集群侧自报是让**每个**集群都有自己的上报方的机制。
 *
 * ## 为什么这不违反「存活列只能有一个写入方」
 *
 * 调度器侧的 `store.RegisterCluster` 注释立了一条规矩：`last_seen_at` 只能有一个
 * 写入方，并明确否掉了「节点注册时顺手 touch 集群行」的旁证方案（§8.1 第 2 条）。
 * 那条规矩针对的是**被动、流量驱动**的写入：节点注册只在有放置时才发生，空转集群
 * 恰恰没有流量，于是「刚注册过」会被冒充成「集群还活着」。
 *
 * 本文件是另一回事：它是一个**主动的、定时器的**自报循环，与调度实例的
 * `RunClusterReporter` 同一种东西、同一个接口、同一个含义（「某个代表该集群的实例
 * 说它还活着」）。空转集群照样报，所以它不是流量驱动的信号。差别只在**谁**在报，
 * 而注册表本来就该接受多个上报方——这与「一个写入方」说的是两层意思，不冲突。
 *
 * ## 不做什么
 *
 * - **不在关闭时注销自己。** 注册表没有删除端点，也不该有：一个节点优雅退出不代表
 *   它所在的集群没了（还有别的节点），而「没人再报」正是 down 的判定方式。顺手清掉
 *   `last_seen_at` 会把「进程退出」伪装成「集群从来不存在」。
 * - **不声明集群能力。** 节点的能力（`LUMO_NODE_CAPABILITIES`）是**节点**的属性，
 *   不是**集群**的属性；把它当集群能力报上去是范畴错误。所以自报体默认是一份纯心跳，
 *   `namespace` / `version` 只在运维显式给出时才附带（服务端对空值是「保持原值」，
 *   见 `store.RegisterCluster`）。
 */
type Environment = Record<string, string | undefined>

/** 兜底 suspect 阈值，与调度器 `domain.DefaultClusterThresholds()` 同源。 */
const defaultSuspectMs = 30_000
/**
 * 自报周期下限。调度器侧派生值是 suspect/3（默认 10s），理论上最小 ~333ms；
 * 这里再抬到 1s 只是为了让「阈值被配成极小值」不会把自报退化成忙循环。
 */
const minReportIntervalMs = 1_000
/** 单次请求超时。与 `nacos.ts` 同一量级：自报是尽力而为的短请求，卡住不如丢掉等下一轮。 */
const requestTimeoutMs = 2_000

export interface ClusterReportTarget {
  readonly schedulerUrl: string
  readonly token: string
  readonly realm: string
  readonly clusterId: string
  /** 集群的命名空间声明。空字符串=不声明（服务端保持原值）。 */
  readonly namespace: string
  /** 集群的版本声明。空字符串=不声明。**目前无消费者**（版本一致性前置未落地）。 */
  readonly version: string
  /** 本地派生的 suspect 阈值，仅在读不到控制面阈值时使用。 */
  readonly suspectMs: number
}

export interface ClusterReporterPlanEnabled {
  readonly enabled: true
  readonly target: ClusterReportTarget
  /** 启动时就该说出来的提醒（例如 cluster_id 来自默认值）。 */
  readonly notes: readonly string[]
}

export interface ClusterReporterPlanDisabled {
  readonly enabled: false
  /** 为什么没开。必须是**可处置**的说法：点名环境变量，并说清后果。 */
  readonly reason: string
}

export type ClusterReporterPlan = ClusterReporterPlanEnabled | ClusterReporterPlanDisabled

export interface ClusterReporter {
  close(): Promise<void>
}

/**
 * 只用到这三个级别，所以按结构化接口收（而不是 `Pick<Console, ...>`）：
 * 测试要能传一个**只记录调用**的替身进来断言「失败只打一次」，而 Console 那套
 * 可选参数签名会让替身写起来需要类型断言。
 */
type ReporterLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

function disabled(reason: string): ClusterReporterPlanDisabled {
  return { enabled: false, reason }
}

/**
 * 自报周期，由 suspect 阈值派生（取 1/3，与调度器 `ClusterThresholds.ReportInterval()`
 * 同一规则：连丢三次自报才被判成可疑）。
 *
 * 做成独立可配项会引入一个必然被配错的失败模式——周期比 suspect 还长时，本集群会在
 * 两次自报之间被判成可疑，**自己把自己挡在放置之外**。
 */
export function clusterReportIntervalMs(suspectMs: number): number {
  const basis = Number.isFinite(suspectMs) && suspectMs > 0 ? suspectMs : defaultSuspectMs
  return Math.max(minReportIntervalMs, Math.floor(basis / 3))
}

/**
 * 判断本进程要不要开自报，并算出目标。
 *
 * 关闭原因一律返回而不是抛异常：自报是**可选能力**，配置缺失时拒绝启动会让一个
 * 与集群判定无关的部署直接起不来。但调用方必须把 `reason` 打出来——判定开着而
 * 没有上报方是自伤，而「没开」与「开着但没人看」在面板上长得一样。
 *
 * ## 为什么上报方必须是 `LUMO_ROLE=node` 的承载节点
 *
 * 自报宣称的是「**这个集群还能接新放置**」。这句话只有该集群的**放置承载节点**能让
 * 它成真：只有承载节点活着、空着，放置才真的能落下去。
 *
 * 反过来说，让别的进程代报会把最危险的那种错报做出来：`dsh-web`（控制台）与
 * 父节点（`LUMO_ROLE=agent`，只负责把子代理**路由**到承载节点）都配着
 * `LUMO_SCHEDULER_URL` 与 `LUMO_CLUSTER_ID`，如果按「配了地址就报」推导，那么一个
 * **承载节点全挂、只剩控制台**的集群会一直显示健康，而调度器会把新任务放进去、
 * 然后卡在无人执行——正是这张注册表本来要回答的那个问题（「它是挂了还是没部署」）
 * 被一个错误的写入方重新糊上。同 §8.1 第 2 条否掉「节点注册顺手 touch」的判据：
 * 写入方错了，比没有写入方更糟。
 *
 * 因此这里**不推导**、只认显式的角色：`role === 'node'` 才是承载节点。控制台与
 * 父节点一律关闭，并在日志里说明为什么——它们的 `LUMO_CLUSTER_ID` 是给别的用途
 * （见 index.ts 的 subagent-remote 配置）准备的，不代表它们能替集群宣称存活。
 */
export function planClusterReporter(env: Environment, mode: string, role: string): ClusterReporterPlan {
  if (mode !== 'cluster') {
    // 只在 cluster 形态自报。注册表的全部用途是回答「哪个集群还活着」以便跨集群
    // 放置时准入；local（SQLite、无跨集群放置）与 standalone（只有一个集群）
    // 都没有这个消费者，报上去只会多出一行没人判定的记录。按形态关闭并说清楚，
    // 好过「报了但没有任何人看」——后者看起来像功能已经生效。
    return disabled(
      `部署形态 ${mode} 没有联邦注册表的消费者（注册表服务于跨集群放置准入，只在 cluster 形态下存在）`)
  }
  if (role !== 'node') {
    return disabled(
      `本进程 LUMO_ROLE=${role} 不是放置承载节点：只有承载节点才能代表集群宣称「还能接放置」，` +
      '代报会把「承载节点全挂」伪装成健康')
  }
  const schedulerUrl = (env['LUMO_SCHEDULER_URL'] ?? env['LUMO_SCHEDULER_API_URL'] ?? '')
    .trim().replace(/\/+$/, '')
  if (schedulerUrl === '') {
    return disabled('未设 LUMO_SCHEDULER_URL（或 LUMO_SCHEDULER_API_URL）：不知道该向哪个控制面自报')
  }
  // 只接受干净的 http/https base URL。带查询串或片段的「base URL」多半是把完整
  // 端点粘了过来，拼上 /v1/clusters/... 会得到一个静默 404 的地址。
  try {
    const url = new URL(schedulerUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return disabled(`LUMO_SCHEDULER_URL 非法（只接受 http/https，且不得带凭证/查询/片段）：${schedulerUrl}`)
    }
  } catch {
    return disabled(`LUMO_SCHEDULER_URL 不是合法 URL：${schedulerUrl}`)
  }
  const token = (env['LUMO_CONTROL_PLANE_TOKEN'] ?? '').trim()
  if (token === '') {
    // 注册端点整体在控制面令牌之后：不带令牌自报只会拿到 503，那既不是「报到了」
    // 也不是「权限不足」，而是一条会每轮刷屏的假故障。
    return disabled('未设 LUMO_CONTROL_PLANE_TOKEN：注册端点要求控制面令牌，不带凭证自报只会拿到 503')
  }

  const notes: string[] = []
  const declaredClusterId = (env['LUMO_CLUSTER_ID'] ?? '').trim()
  // 与 Nacos 注册（`index.ts` 的 startNacosRegistration）**同源**：闸门是按节点在
  // 目录里的 cluster_id 匹配的，自报用 A 值、注册用 B 值，注册表里就会多出一行
  // 永远匹配不到任何节点的集群，而真正被拦的那个反而显示 unregistered。
  const clusterId = declaredClusterId === '' ? 'default' : declaredClusterId
  if (declaredClusterId === '') {
    notes.push('未设 LUMO_CLUSTER_ID，按 "default" 自报（与 Nacos 注册使用的 cluster_id 同源）')
  }

  const suspectRaw = Number(env['LUMO_CLUSTER_SUSPECT_MS'])
  const suspectMs = Number.isFinite(suspectRaw) && suspectRaw > 0 ? suspectRaw : defaultSuspectMs
  if (env['LUMO_CLUSTER_SUSPECT_MS'] !== undefined && suspectMs === defaultSuspectMs) {
    notes.push(`LUMO_CLUSTER_SUSPECT_MS 非法（${env['LUMO_CLUSTER_SUSPECT_MS']}），暂按 ${defaultSuspectMs}ms 派生周期`)
  }

  return {
    enabled: true,
    notes,
    target: {
      schedulerUrl, token, clusterId,
      realm: (env['LUMO_REALM'] ?? 'dev').trim() || 'dev',
      namespace: (env['LUMO_CLUSTER_NAMESPACE'] ?? '').trim(),
      version: (env['LUMO_CLUSTER_VERSION'] ?? '').trim(),
      suspectMs,
    },
  }
}

interface RegistryFacts {
  suspectMs?: number
  enforced?: boolean
}

async function readRegistry(
  target: ClusterReportTarget,
  doFetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<RegistryFacts | undefined> {
  try {
    const response = await doFetch(`${target.schedulerUrl}/v1/clusters`, {
      method: 'GET',
      headers: headersOf(target),
      signal,
    })
    if (!response.ok) return undefined
    const body = await response.json() as { suspect_ms?: unknown; enforced?: unknown }
    const facts: RegistryFacts = {}
    if (typeof body.suspect_ms === 'number' && Number.isFinite(body.suspect_ms) && body.suspect_ms > 0) {
      facts.suspectMs = body.suspect_ms
    }
    if (typeof body.enforced === 'boolean') facts.enforced = body.enforced
    return facts
  } catch {
    return undefined
  }
}

async function reportOnce(
  target: ClusterReportTarget,
  doFetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 只附带**非空**声明：服务端对空值是「保持原值」，所以纯心跳不会抹掉别人声明的
  // namespace / version（见 store.RegisterCluster 的注释）。
  const declares: Record<string, string> = {}
  if (target.namespace !== '') declares['namespace'] = target.namespace
  if (target.version !== '') declares['version'] = target.version
  try {
    const response = await doFetch(
      `${target.schedulerUrl}/v1/clusters/${encodeURIComponent(target.clusterId)}`,
      {
        method: 'PUT',
        headers: { ...headersOf(target), 'Content-Type': 'application/json' },
        body: JSON.stringify(declares),
        signal,
      },
    )
    if (response.ok) return { ok: true }
    // 把服务端的 message 带出来：realm 冲突（409）与权限不足（401）在日志里必须能分开，
    // 否则每一次失败都长得像「网络不通」，而真实处置完全不同。
    const detail = await response.text().catch(() => '')
    const parsed = ((): string => {
      try {
        const body = JSON.parse(detail) as { message?: unknown }
        return typeof body.message === 'string' ? body.message : ''
      } catch {
        return ''
      }
    })()
    return { ok: false, error: `HTTP ${response.status}${parsed === '' ? '' : `: ${parsed}`}` }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function headersOf(target: ClusterReportTarget): Record<string, string> {
  // realm 走网关注入头（服务端 requestRealm）：让请求体自己声明 realm 等于让调用方
  // 自选隔离域。
  return { Authorization: `Bearer ${target.token}`, 'X-Lumo-Realm': target.realm }
}

/**
 * 起一个自报循环。返回的 `close()` 只停自己的定时器与在途请求，**不注销注册表行**
 * （理由见文件头）。
 *
 * 失败只做**状态跃迁**日志（首次失败一条 error、恢复时一条 info），不逐轮刷屏：
 * 周期是秒级的，逐轮打会让真正要看的那条被埋掉，而这条恰恰是「本集群马上会被判成
 * down」的预警。
 */
export function startClusterReporter(
  plan: ClusterReporterPlanEnabled,
  logger: ReporterLogger = console,
  deps: { fetch?: typeof globalThis.fetch } = {},
): ClusterReporter {
  const target = plan.target
  const doFetch = deps.fetch ?? globalThis.fetch
  const abort = new AbortController()
  let closed = false
  let intervalMs = clusterReportIntervalMs(target.suspectMs)
  let intervalLearned = false
  let discoveryWarned = false
  let failing = false
  let unenforcedNoticed = false
  let timer: NodeJS.Timeout | undefined
  let wake: (() => void) | undefined

  for (const note of plan.notes) logger.warn(`dsh-node: 集群自报 — ${note}`)
  logger.info(
    `dsh-node: 集群自报已启用 cluster_id=${target.clusterId} → ${target.schedulerUrl}` +
    `（周期 ${intervalMs}ms，先向控制面确认实际阈值）`,
  )

  // 请求同时受「单次超时」与「进程关闭」约束。用 AbortSignal.any 而不是各自一个
  // signal：两个来源合成一个，调用方不必分辨这个 rejection 是谁引起的。
  const signalOf = (): AbortSignal =>
    AbortSignal.any([abort.signal, AbortSignal.timeout(requestTimeoutMs)])

  const sleep = (): Promise<void> => new Promise<void>((resolve) => {
    wake = resolve
    timer = setTimeout(() => {
      timer = undefined
      wake = undefined
      resolve()
    }, intervalMs)
    // unref：本进程的存活由 DSH 子进程决定，一个自报定时器不该拖住退出。
    timer.unref?.()
  })

  const cycle = async (): Promise<void> => {
    if (!intervalLearned) {
      const facts = await readRegistry(target, doFetch, signalOf())
      if (closed) return
      if (facts?.suspectMs !== undefined) {
        intervalLearned = true
        const next = clusterReportIntervalMs(facts.suspectMs)
        if (next !== intervalMs) {
          logger.info(
            `dsh-node: 集群自报周期改按控制面实际阈值派生 ${intervalMs}ms → ${next}ms（suspect_ms=${facts.suspectMs}）`,
          )
          intervalMs = next
        }
      } else if (!discoveryWarned) {
        // 只提醒一次并继续重试：启动期控制面多半还没起（节点 depends_on 只是
        // service_started），每轮打一遍会让真正的失败被淹掉。
        discoveryWarned = true
        logger.warn(
          `dsh-node: 暂时读不到控制面的 suspect_ms，自报周期先按本地值派生 ${intervalMs}ms` +
          '（LUMO_CLUSTER_SUSPECT_MS）；本地值与控制面真正在用的阈值不一致时，本集群会在两次自报之间被判成可疑',
        )
      }
      // 「控制面收下了自报但没开判定」是一个**必须说出来**的状态：否则运维会以为
      // 闸门在生效，而实际上没有任何集群会被拦下（同样地，也无法解释为什么某个
      // 集群明明挂了却还在接放置）。仍然继续自报——打开判定不需要重启节点。
      if (facts?.enforced === false && !unenforcedNoticed) {
        unenforcedNoticed = true
        logger.warn(
          'dsh-node: 控制面未启用集群失联判定（enforced=false）：自报已被接收，但不会挡下任何放置；' +
          '要在该控制面打开判定，设置 LUMO_CLUSTER_ENFORCE=true（见 domain.ResolveClusterEnforcement）',
        )
      }
    }
    const outcome = await reportOnce(target, doFetch, signalOf())
    if (closed) return
    if (outcome.ok) {
      if (failing) {
        failing = false
        logger.info(`dsh-node: 集群自报已恢复 cluster_id=${target.clusterId}`)
      }
      return
    }
    if (!failing) {
      failing = true
      logger.error(
        `dsh-node: 集群自报失败 —— 本集群将被判成可疑/下线，新放置会被闸门拒绝 cluster_id=${target.clusterId}: ${outcome.error}`,
      )
    }
  }

  const run = async (): Promise<void> => {
    while (!closed) {
      await cycle()
      if (closed) break
      await sleep()
    }
  }
  void run()

  return {
    async close(): Promise<void> {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      // 叫醒正在等周期的那一轮，否则这个 async 循环会一直挂着（定时器已被清掉）。
      wake?.()
      wake = undefined
      // 在途请求一并取消，并与超时共用同一个 signal 源。
      abort.abort()
    },
  }
}
