/**
 * `ctx.jobs` 句柄虚拟化契约（评审 R2 收口；设计说明 2026-08-26-seam-remote-forms-design 行 6）。
 *
 * 问题：`ctx.jobs` 交出的 job 句柄是**有生命周期、钉在执行节点上的 OS 引用**。
 * 本地 `JobRegistry` 发的 id 是 `<kind>-N`——进程内按 kind 计的计数器，两个节点上
 * 会各自诞生同一个 `<kind>-N`，跨节点后无法寻址。而 kill/timeout/status 必须找到
 * **持有那份 OS 句柄的那个节点**，否则「kill 一个远端 job」无从谈起。
 *
 * 解法：把 job 句柄虚拟化成全局可寻址的 `JobRef = (sessionRef, node, jobId)`：
 * - `sessionRef` 全局唯一 → 授权与关联（谁能动这个 job）；
 * - `node` 定位持有 OS 句柄的执行节点 → 控制指令路由目的地；
 * - `jobId` 保留本地 `<kind>-N` → 节点内回查（执行节点以本地行动为准，§7.4）。
 *
 * 控制（kill/timeout/status）走**全局控制信号通道**（§7.4）：下发与执行分离，
 * 执行集群监听指令并落为本地 `JobRegistry` 动作；job 结果落地为**结果事件流**
 * （append-only，按会话内 `seq` 单调）——它就是跨节点 resume 时重建 job 状态的唯一真相源，
 * 因为 §4.2 的 SessionEvent 日志只记模型可见状态，不记 job 的终态与输出（R2 的核心缺口）。
 *
 * 恢复语义（超时重派 / resume 到何节点）绑定 R2 turn 级恢复契约：`timeout` 的 escalade
 * 不是本契约的职责，它把「该 job 是否还能继续、重派到哪个节点」交给 recovery 裁决。
 * 故本模块**只定形态**（句柄、控制闭集、结果事件闭集、控制通道 seam），不实现状态机。
 */

/** 控制通道分隔符。三个分量（node/sessionRef/jobId）都是平台签发 id，约定不含 `::`。 */
const REF_SEP = '::'

/**
 * 全局可寻址的 job 句柄（句柄虚拟化的映射结果）。
 * `(job) → (sessionRef, node, jobId)`——这就是「句柄虚拟化」的具体形态。
 */
export interface JobRef {
  /** 拥有者会话（授权与关联）。全局唯一。 */
  sessionRef: string
  /** 执行节点：持有该 job 的 OS 句柄（进程/PTY/subprocess）的节点 id。 */
  node: string
  /** 本地 registry 发的 `<kind>-N`，仅在执行节点内唯一。 */
  jobId: string
}

/**
 * job 级控制闭集。
 *
 * 刻意**小于**会话级 `ControlCommand`（pause/resume/stop/abort/approve/reject/replay/degrade）：
 * job 没有「暂停续跑/审批回放」这些会话级语义，它只有三条动作——终止、定时、看状态。
 * 闭集是因为「枚举不出一列自由文本的取值，就无法按命令路由与审计」。
 */
export type JobControlCommand = 'kill' | 'timeout' | 'status'

/** 闭集守卫：仅字面值匹配，未知命令一律拒绝（闭集外不猜）。 */
export function isJobControlCommand(c: string): c is JobControlCommand {
  return c === 'kill' || c === 'timeout' || c === 'status'
}

/** job 生命周期状态（与 dsh `JobStatus` 对齐，但不依赖 dsh 类型，保持契约零依赖）。 */
export type JobLifecycleStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** 终态闭集：job 只能以这三种之一收场。 */
export type TerminalJobStatus = 'completed' | 'killed' | 'failed'

export function isTerminalJobStatus(s: string): s is TerminalJobStatus {
  return s === 'completed' || s === 'killed' || s === 'failed'
}

export function isTerminal(s: JobLifecycleStatus): s is TerminalJobStatus {
  return isTerminalJobStatus(s)
}

/**
 * 结果事件闭集：job 生命周期里**值得跨节点持久**的三个时刻。
 *
 * 刻意不含 `stopping` 与 `running` 的中间态——`stopping` 是「kill 已下发但未落定」
 * 的瞬态，它由「kill 指令已审计」这一个事实体现，不必再为它造一条事件；`running`
 * 则是 `job/started` 之后的默认态，直到终态事件到来。
 *
 * `seq` 是**会话内**单调序号（与 §4.2 复制日志同源口径）：同一会话多个 job 的事件
 * 在一条流里按 seq 有序，`job/finished` 判终态只认同一 `ref` 的最终事件。
 */
export type JobResultEvent =
  | { type: 'job/started'; seq: number; ref: JobRef; kind: string; label: string; startedAt: number }
  | { type: 'job/output'; seq: number; ref: JobRef; text: string }
  | { type: 'job/finished'; seq: number; ref: JobRef; status: TerminalJobStatus; detail?: string; finishedAt: number }

/** job 当前状态的跨节点投影（结果事件流 fold 的结果 / 执行节点本地快照）。 */
export interface JobSnapshotView {
  ref: JobRef
  kind: string
  status: JobLifecycleStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** 控制请求（kill/timeout/status 经同一通道下发；actor+role+reason 是一等审计事件）。 */
export interface JobControlRequest {
  ref: JobRef
  command: JobControlCommand
  actor: string
  role: string
  reason: string
  /** 至少一次投递的幂等去重键（同 correlationId 只生效一次，§8.3）。 */
  correlationId: string
}

export type JobControlDecision =
  | { allowed: true; effect: 'requested' | 'already-terminal' | 'observed' }
  | { allowed: false; reason: 'not-authorized' | 'unknown-job' }

/**
 * 控制通道 seam（§7.4 的 job 级落点）。
 *
 * `dispatch` 只负责「指令经授权 + 幂等 + 审计后下发到目的节点」，**不实现 job 状态机**；
 * 现场的真实状态由执行节点以本地行动为准产出，读侧走 `events`（持久结果）与 `snapshot`
 * （执行节点最新投影）。下发与执行分离，是让「控制面能杀一个远端 job、节点能抗下
 * 一条本地行动」的唯一方式。
 */
export interface JobControlSeam {
  dispatch(request: JobControlRequest): Promise<JobControlDecision>
  /** 读该会话 job 结果事件流（append-only，按 seq 单调；fromSeq 用于续读）。 */
  events(sessionRef: string, fromSeq?: number): Promise<JobResultEvent[]>
  /** 轮询执行节点最新投影；无此 job 返回 undefined。 */
  snapshot(ref: JobRef): Promise<JobSnapshotView | undefined>
}

/** Local execution projection registered by a handle-owning node. */
export interface LocalJobRegistration {
  kind: string
  label: string
  status: JobLifecycleStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

/**
 * Node-local counterpart to JobControlSeam. Only providers that own a local
 * handle receive it; callers can never use it to act on another node.
 */
export interface JobControlRuntime {
  readonly nodeId: string
  register(ref: Omit<JobRef, 'node'>, snapshot: LocalJobRegistration, cancel: (reason?: string) => void): Promise<JobRef>
  settle(ref: JobRef, snapshot: LocalJobRegistration): Promise<void>
}

/** 句柄虚拟化映射：把本地 job 钉回 (sessionRef, node, jobId)。 */
export function jobRefOf(sessionRef: string, node: string, jobId: string): JobRef {
  return { sessionRef, node, jobId }
}

/** 校验 JobRef：三分量非空且不含保留分隔符（否则 format/parse 往返会拆错）。 */
export function assertJobRef(ref: JobRef): void {
  for (const [k, v] of Object.entries(ref)) {
    if (!v) throw new Error(`JobRef 缺 ${k}：句柄虚拟化必须同时给出 sessionRef/node/jobId`)
    if (v.includes(REF_SEP)) throw new Error(`JobRef.${k} 含保留分隔符 ${REF_SEP}：${v}`)
  }
}

/** 稳定字符串形式 `node::sessionRef::jobId`——用于日志、消息路由键、审计关联。 */
export function formatJobRef(ref: JobRef): string {
  assertJobRef(ref)
  return `${ref.node}${REF_SEP}${ref.sessionRef}${REF_SEP}${ref.jobId}`
}

export function parseJobRef(s: string): JobRef {
  const parts = s.split(REF_SEP)
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error(`非法 JobRef 字符串：${s}（期望 node${REF_SEP}sessionRef${REF_SEP}jobId）`)
  }
  const [node, sessionRef, jobId] = parts as [string, string, string]
  return { node, sessionRef, jobId }
}

/**
 * 从结果事件流重建 job 状态（resume 的纯函数核心）。
 *
 * §4.2 会话日志不含 job 终态，跨节点 resume 要回答「这个会话有过哪些 job、现在什么状态」，
 * 唯一答案来自这条结果事件流。reduce 按 `ref` 分组折叠：`job/started` 起一条 running，
 * `job/finished` 落为终态；`job/output` 不影响快照（输出另走消费游标，不在快照里）。
 *
 * 入参约定已按 seq 升序且去重（append-only + 存储侧 (session,seq) 幂等去重）；
 * `job/finished` 判终态只认该 ref 的终态事件，重复投递不改变结果。
 */
export function reduceJobEvents(events: readonly JobResultEvent[]): Map<string, JobSnapshotView> {
  const out = new Map<string, JobSnapshotView>()
  for (const e of events) {
    const key = formatJobRef(e.ref)
    const cur = out.get(key)
    if (e.type === 'job/started') {
      out.set(key, { ref: e.ref, kind: e.kind, status: 'running', startedAt: e.startedAt })
    } else if (e.type === 'job/finished') {
      out.set(key, {
        ref: e.ref,
        kind: cur?.kind ?? '',
        status: e.status,
        detail: e.detail,
        startedAt: cur?.startedAt ?? e.finishedAt,
        finishedAt: e.finishedAt,
      })
    }
  }
  return out
}

/**
 * 契约断言：任何真实控制通道实现（RocketMQ 版等）都必须通过。
 * provider 由测试方构造（授权策略由注入的 stub 模拟）。
 */
export async function assertJobVirtualizationContract(
  seam: JobControlSeam,
  assert: (cond: boolean, msg: string) => void,
): Promise<void> {
  const ref = jobRefOf('s1', 'node-1', 'bash-1')
  const unknownRef = jobRefOf('s1', 'node-1', 'bash-999')

  const kill = (correlationId: string, role: string, r: JobRef) =>
    seam.dispatch({ ref: r, command: 'kill', actor: 'alice', role, reason: '停掉', correlationId })

  // 1. 有权者 kill 在跑 job → 接受并请求本地行动
  const ok = await kill('c1', 'operator', ref)
  assert(ok.allowed && ok.effect === 'requested', '有权者 kill 必须被接受')

  // 2. 无权者被拒
  const no = await kill('c2', 'viewer', ref)
  assert(!no.allowed && no.reason === 'not-authorized', '无权者必须先于存在性被拒')

  // 3. 不存在的 job → unknown-job（不是 not-authorized：job 存在性是另一维判定）
  const none = await kill('c3', 'operator', unknownRef)
  assert(!none.allowed && none.reason === 'unknown-job', 'kill 不存在的 job 必须报 unknown-job')

  // 4. 幂等去重：同 correlationId 重放不产生第二次本地行动
  const dup = await kill('c1', 'operator', ref)
  assert(dup.allowed, '幂等重放不得拒绝')

  // 5. 结果事件流：started → finished（killed），终态为 killed
  const evs = await seam.events('s1')
  const finished = evs
    .filter((e): e is Extract<JobResultEvent, { type: 'job/finished' }> => e.type === 'job/finished')
    .filter((e) => e.ref.jobId === 'bash-1')
  assert(finished.length === 1, `kill 必须恰好产生一条 finished 事件（得 ${finished.length}）`)
  assert(finished.length === 1 && finished[0]!.status === 'killed', 'kill 的终态事件必须是 killed')

  // 6. 事件流按 seq 有序（append-only）
  const seqs = evs.map((e) => e.seq)
  const sorted = [...seqs].sort((a, b) => a - b)
  assert(
    seqs.every((s, i) => s === sorted[i]),
    '结果事件流必须按 seq 有序',
  )

  // 7. 终态后再次 kill → already-terminal（不生成第二条 finished）
  const again = await kill('c4', 'operator', ref)
  assert(again.allowed && again.effect === 'already-terminal', '终态 job 再 kill 应返回 already-terminal')
  assert(
    (await seam.events('s1')).filter((e) => e.type === 'job/finished' && e.ref.jobId === 'bash-1').length === 1,
    '终态再 kill 不得产生第二条 finished 事件',
  )

  // 8. status 轮询：授权 + 审计，但不改变状态；结果从 snapshot 读
  const st = await seam.dispatch({ ref, command: 'status', actor: 'alice', role: 'operator', reason: '看状态', correlationId: 'c5' })
  assert(st.allowed && st.effect === 'observed', 'status 必须被接受且标记为 observed')
  const snap = await seam.snapshot(ref)
  assert(snap?.status === 'killed', 'kill 后 snapshot 必须已是 killed 终态')
  assert((await seam.snapshot(unknownRef)) === undefined, 'snapshot 不存在的 job 必须返回 undefined')

  // 9. reduce 纯函数：从事件流重建出终态快照
  const reduced = reduceJobEvents(evs).get(formatJobRef(ref))
  assert(reduced?.status === 'killed' && reduced.finishedAt !== undefined, 'reduce 必须从事件流重建 killed 终态')

  // 10. format/parse 往返 + 校验
  assert(parseJobRef(formatJobRef(ref)).jobId === 'bash-1', 'format/parse 必须往返一致')
}

/**
 * 结果事件闭集守卫（纯函数，独立验证）。
 * 不在闭集内的事件类型一律拒绝——闭集是所有下游消费者能推理「事件长什么样」的前提。
 */
export function isJobResultEvent(e: unknown): e is JobResultEvent {
  if (typeof e !== 'object' || e === null) return false
  const t = (e as { type?: unknown }).type
  return t === 'job/started' || t === 'job/output' || t === 'job/finished'
}
