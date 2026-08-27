/**
 * Seam 可远程化分级表（评审 R1 的落点）。
 *
 * §4.1 从 dsh 的一个事实——把 filesystem/subprocess 的 Provider 指向远程沙箱，
 * Bash/PTY/LSP 会一并迁移——推广出「任意 seam 都可远程化」。前提为真，结论过宽：
 * dsh 能远程化那两个 seam，是因为它专门造了 `ctx.e2b` 这个共享远端句柄的所有者，
 * 让 `fs-e2b` 与 `subprocess-e2b` 落在同一个远端 Linux 运行时里。这是特例路径，
 * 不是 seam 抽象自带的能力。
 *
 * 本表是**准入判据的唯一真相源**，不是文档附录：
 * - 未定级 = 拒绝（fail closed）。默认可远程时，一个漏定级的句柄型 seam 会静默过网，
 *   故障出现在离原因很远的地方（用户按 Ctrl-C、resume 后句柄失效）。
 * - 幂等性也住在这里。曾经 `remote.ts` 有第二张 `IDEMPOTENT_METHODS`，两张表加方法时
 *   只会改一处，另一处静默过期。
 *
 * 本模块**不 import remote.ts**（单向依赖，反向会成环），因此 {@link assertRemotable}
 * 抛普通 Error，由 host 侧负责转成 `forbidden`。
 */

/**
 * 定级。`never` 与 `needs-design` 的区别不是难度，是**是否存在一个正确的远程形态**：
 * `ctx.sandbox` 隔网执法等于不执法，投入多少工程量都不成立；`ctx.llm` 有正确形态
 * （服务端流），只是不是一元代理。
 */
export type SeamClass = 'remotable' | 'never' | 'needs-design'

/**
 * 调用形状。`handle` 是「Consumer 零改动」承诺失效的地方：句柄型 seam 交出的是
 * 有生命周期的引用，远程化后它会在网络中断时失效，而本地形态下这个分支不存在。
 */
export type CallShape =
  | 'unary'
  | 'server-stream'
  | 'handle'
  | 'waterfall'
  | 'registry'
  | 'transport'
  | 'local-state'

export interface MethodGrade {
  /** 契约上幂等（upsert / last-wins / delete）才可以为 true——这是重试的正确性边界。 */
  idempotent: boolean
}

export interface SeamGrade {
  class: SeamClass
  shape: CallShape
  /** 仅 remotable：逐方法幂等性。 */
  methods?: Readonly<Record<string, MethodGrade>>
  /** 仅 remotable：一个 turn 内允许的调用次数。粗粒度硬规矩的量化形式。 */
  perTurnCallBudget?: number
  /** 仅 remotable：单次调用 p95 预算。 */
  latencyBudgetMs?: number
  /** never / needs-design 必填。写进错误信息，所以要写原因本身，不写「见文档」。 */
  why?: string
  /** needs-design 必填：正确归属。缺了就等于「以后再说」。 */
  belongsTo?: string
}

/**
 * 单 turn 可接受的 seam 网络开销上限。
 *
 * 数字来自评审 R1 的算式的反向使用：评审算「几十次调用 × 20ms 跨 AZ = +600ms/turn」，
 * 这里先定 turn 级上限，再倒推允许的调用次数与单次预算。
 */
export const TURN_NETWORK_BUDGET_MS = 6_400

/**
 * 分级表。
 *
 * 平台自定义 seam 用裸名（`knowledge`）——它们是线协议上的 seam 名；
 * dsh 原生 seam 用 `ctx.` 前缀，与上游 `capability-seams.md` 的写法一致。
 */
export const SEAM_GRADES: Readonly<Record<string, SeamGrade>> = {
  // ---- remotable：平台新增的能力 seam ----
  //
  // 白名单里没有一个 dsh 原生 seam，这是结论不是遗漏。§4.1 的杠杆来自平台新增的
  // 能力 seam（知识库、图、分析、GPU 推理），不来自把 dsh 原有 seam 搬到网上。
  knowledge: {
    class: 'remotable',
    shape: 'unary',
    methods: {
      query: { idempotent: true },
      ingest: { idempotent: true },
      remove: { idempotent: true },
      rebuild: { idempotent: true },
    },
    perTurnCallBudget: 8,
    latencyBudgetMs: 800,
    why: '一元、无 OS 句柄、无节点亲和；检索与写入均按 realm 过滤，远程与本地判定一致',
  },
  knowledgeGraph: {
    class: 'remotable',
    shape: 'unary',
    methods: {
      neighborhood: { idempotent: true },
      upsertNodes: { idempotent: true },
      upsertEdges: { idempotent: true },
      removeNode: { idempotent: true },
    },
    perTurnCallBudget: 8,
    latencyBudgetMs: 800,
    why: '同 knowledge；upsert 为 last-wins，故可重试',
  },

  // ---- never：远程化会破坏语义正确性或安全边界 ----
  'ctx.terminals': {
    class: 'never',
    shape: 'handle',
    why: '长驻 PTY。registry 拥有 exact-Agent 会话身份与清理，backend 拥有终端机械细节——终端机械细节就是 OS 句柄',
  },
  'ctx.subprocess': {
    class: 'never',
    shape: 'handle',
    why: '进程树、stdio 处置、kill 升级都依赖同一个 OS；bash-local/terminal-bash/lsp-stdio 与三个 out-of-process subagent 后端全部经它 spawn',
  },
  'ctx.shell': {
    class: 'never',
    shape: 'handle',
    why: '执行器经 ctx.subprocess spawn，沙箱形态要与 ctx.sandbox 同机；远程 shell 是 E2B 式专用路径，不是通用代理',
  },
  'ctx.sandbox': {
    class: 'never',
    shape: 'handle',
    why: '强制点必须与被约束进程同机。Consumer 交出即将 spawn 的 argv，隔网执法等于不执法——沙箱会退化成建议',
  },
  'ctx.codeRuntime': {
    class: 'never',
    shape: 'handle',
    why: '跑模型写的程序并绑定 host 侧异步 binding，binding 是进程内引用',
  },
  'ctx.fs': {
    class: 'never',
    shape: 'handle',
    why: 'fd 与 watch。此处判 never 指「通用 SeamProxy 不得代理 fs」；fs-e2b 走 ctx.e2b 持有的专用远端句柄依然合法，那是特例路径不是本表授权的通用能力',
  },
  'ctx.fileReferences': {
    class: 'never',
    shape: 'unary',
    why: '返回的是 Agent cwd 下的路径，节点亲和随 fs 而定；单独远程化会给出另一台机器的路径',
  },
  'ctx.approval': {
    class: 'never',
    shape: 'waterfall',
    why: '走 approval/request 瀑布且缺席时 fail closed 到 unavailable；远程化切断 next() 同步链，而「远程不可达即拒绝」会把审批变成拒绝服务',
  },
  'ctx.userQuestions': {
    class: 'never',
    shape: 'waterfall',
    why: '人在环：UI 前端提供活跃的应答 Provider，工具调用挂在 ask() 的 promise 上；提问者与应答者必须在同一个交互会话里',
  },
  'ctx.directoryPicker': {
    class: 'never',
    shape: 'waterfall',
    why: '在宿主显示器上开 OS 选择器或服务应用内浏览器；人在环 + 宿主 UI 亲和',
  },
  'ctx.credentials': {
    class: 'never',
    shape: 'local-state',
    why: '配置里只有引用，值住在 Provider 侧；远程化等于让凭证值跨节点传输，与「凭证只在 Vault、不出边界」冲突',
  },
  'ctx.authorization': {
    class: 'never',
    shape: 'waterfall',
    why: '拥有取得一份凭证的对话与「每 key 一次尝试」生命周期；远程化会把凭证获取流程搬到网上',
  },
  'ctx.settings': {
    class: 'never',
    shape: 'local-state',
    why: '设置是本节点的装配输入；远程化会让「本节点的配置」由另一节点决定，插件加载顺序与配置来源都不可推理',
  },
  'ctx.compaction': {
    class: 'never',
    shape: 'waterfall',
    why: '消费 post-step 压力与请求错误恢复事件（事件瀑布），且需要完整会话历史；远程化等于每次把全量历史过网',
  },
  'ctx.sessionTelemetry': {
    class: 'never',
    shape: 'transport',
    why: '它的输出本就离开进程走遥测后端；再套一层 SeamProxy 是两条出网路径，遥测该走可观测性通道',
  },

  // ---- never：进程内注册面与传输载体，远程化在概念上不成立 ----
  'ctx.tools': {
    class: 'never',
    shape: 'registry',
    why: '注册表是装配结果不是可远程化的能力；远程化注册面等于远程化插件图。它还拥有 Code Mode 传输与 around-dispatch 守卫链',
  },
  'ctx.systemPrompt': {
    class: 'never',
    shape: 'registry',
    why: '逐步收集提示段与模型可见的工具 schema，是装配结果',
  },
  'ctx.invariants': {
    class: 'never',
    shape: 'registry',
    why: '包自有的运行时不变量检查，按包归属报错；跨节点的「本包不变量」无意义',
  },
  'ctx.sandboxPolicy': {
    class: 'never',
    shape: 'local-state',
    why: '部署默认模式 + 工作区根的唯一归属；bash 与 fs 两个执法族都读它，远程化会让它们约束到不同的根',
  },
  'ctx.shellEnv': {
    class: 'never',
    shape: 'local-state',
    why: '每次执行收一份可信快照、由 executor 重建命名空间；跨节点的「可信快照」不可信',
  },
  'ctx.webServer': {
    class: 'never',
    shape: 'transport',
    why: '它是网络面本身，不是网络面的消费者',
  },
  'ctx.clientModules': {
    class: 'never',
    shape: 'transport',
    why: '同 ctx.webServer：组装并服务浏览器侧插件图，是传输载体',
  },
  'ctx.apiProxy': {
    class: 'never',
    shape: 'transport',
    why: '同 ctx.webServer：宿主 API 派发面',
  },

  // ---- needs-design：有正确的远程形态，但不是通用一元代理 ----
  'ctx.llm': {
    class: 'needs-design',
    shape: 'server-stream',
    why: '服务端流（llm/stream、assistant/chunk）。一元代理形状不匹配，需流控与背压，否则首 token 延迟与内存都会失控',
    belongsTo: 'LLM 网关（§6.4 计量单截面在此，必须过网关而非 SeamProxy——否则计量与远程化各走一条路，单截面就破了）',
  },
  'ctx.sessionPersistence': {
    class: 'needs-design',
    shape: 'unary',
    why: '持久化的是同一套 SessionEvent 词汇，跨节点问题是复制与一致性，不是调用转发',
    belongsTo: '复制式 SessionEvent 日志（§4.2）',
  },
  'ctx.sessionQuery': {
    class: 'needs-design',
    shape: 'unary',
    why: '读的是会话日志；查询面必须与日志复制同源，否则会查到本节点尚未收到的段',
    belongsTo: '复制式 SessionEvent 日志（§4.2）',
  },
  'ctx.sessionTitle': {
    class: 'needs-design',
    shape: 'unary',
    why: '其唯一的异步 Provider 是一次 LLM 调用，计量必须落在 ctx.llm 单截面',
    belongsTo: 'LLM 网关（随 ctx.llm 一起）',
  },
  'ctx.subagents': {
    class: 'needs-design',
    shape: 'handle',
    why: '跨节点委派要解决放置与 continuation 迁移，不是把 spawn 转发出去',
    belongsTo: 'Scheduler（§6.2）+ 复制日志',
  },
  'ctx.jobs': {
    class: 'needs-design',
    shape: 'handle',
    why: '句柄型：kill 一个远端 job 需要句柄虚拟化与重连语义',
    belongsTo: '控制信号通道（§7.4）+ Scheduler；恢复语义（超时重派/resume 到何节点）随 R2 turn 级恢复契约',
  },
  'ctx.lsp': {
    class: 'needs-design',
    shape: 'unary',
    why: '语言服务索引与工作区同机亲和；远程化需连同 fs 与 subprocess 整体搬走工作区',
    belongsTo: 'E2B 式专用沙箱路径（连同 ctx.fs / ctx.subprocess 一起搬）',
  },
  'ctx.web': {
    class: 'needs-design',
    shape: 'unary',
    why: '技术上完全可远程化（一元、无句柄、幂等），判 needs-design 是**治理决定不是技术决定**：出平台流量必须过网关做 PII 与配额，绕开网关的远程 web 是治理漏洞',
    belongsTo: '连接器网关（§12）',
  },
  'ctx.skills': {
    class: 'needs-design',
    shape: 'unary',
    why: '运行期取技能会让「模型可见即日志」的可重放性依赖远端当时的目录状态；技能应当安装到本地再读',
    belongsTo: '制品注册表 + provisioner（§6.1）',
  },
  'ctx.attachments': {
    class: 'needs-design',
    shape: 'unary',
    why: '附件是进入模型上下文的二进制；逐次代理会与平台已有的对象存储 seam 形成两条真相源',
    belongsTo: 'ctx.datastore.object（MinIO，§5.1）',
  },
  'ctx.spillStore': {
    class: 'needs-design',
    shape: 'unary',
    why: '溢出内容必须在跨节点 resume 后仍可取回，因此该落共享对象存储，而不是逐次代理到某个节点',
    belongsTo: 'ctx.datastore.object（MinIO，§5.1）',
  },
  'ctx.storage': {
    class: 'needs-design',
    shape: 'unary',
    why: 'dsh 自己的非会话 KV 面；远程化它等于绕开平台的数据 seam 分层（组件不得直连数据库，必须过 seam）',
    belongsTo: 'ctx.datastore.sql（PG，§5.1）',
  },
  'ctx.workflowEngine': {
    class: 'needs-design',
    shape: 'handle',
    why: '工作线程引擎本身是进程内的，其 agent() 调用经 ctx.subagents 扇出；跨节点工作流是另一件事',
    belongsTo: 'FlowEngine（§9.2）+ Scheduler',
  },
}

/** 取定级。未登记返回 undefined——调用方必须按 fail closed 处理。 */
export function gradeOf(seam: string): SeamGrade | undefined {
  return Object.prototype.hasOwnProperty.call(SEAM_GRADES, seam)
    ? SEAM_GRADES[seam]
    : undefined
}

export function isRemotable(seam: string): boolean {
  return gradeOf(seam)?.class === 'remotable'
}

/**
 * 准入闸。不可远程化即抛，错误信息带类别与理由——读得到原因的错误才省得下一个人翻文档。
 *
 * 抛普通 Error 而非 RemoteSeamError：本模块不依赖 remote.ts（反向会成环），
 * host 侧负责把它转成 `forbidden`。
 */
export function assertRemotable(seam: string): void {
  const grade = gradeOf(seam)
  if (!grade) {
    throw new Error(
      `seam ${seam} 未定级，拒绝远程化。新 seam 默认不可远程：` +
      `请先在 shared/seam-contracts/remotability.ts 的分级表里定级`,
    )
  }
  if (grade.class === 'remotable') return
  const owner = grade.belongsTo ? `；正确归属：${grade.belongsTo}` : ''
  throw new Error(
    `seam ${seam} 定级为 ${grade.class}，拒绝经 SeamProxy 远程化：${grade.why}${owner}`,
  )
}

/**
 * 方法是否契约幂等——即网络失败后能否自动重试。
 *
 * 未定级 seam 与未声明方法一律 false：「请求已到达但响应丢失」时重试一个非幂等方法
 * 会造成重复副作用，所以不可重试是安全的默认。
 */
export function isIdempotent(seam: string, method: string): boolean {
  const methods = gradeOf(seam)?.methods
  if (!methods) return false
  return Object.prototype.hasOwnProperty.call(methods, method)
    ? methods[method]!.idempotent
    : false
}
