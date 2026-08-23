/**
 * 端点池：客户端负载均衡 + 每端点熔断（评审建议的 SeamProxy 形态）。
 *
 * 为什么熔断按**端点**而不是按 seam：一个 3 副本的知识库节点挂了 1 个，
 * 按 seam 熔断会把另外 2 个健康副本一起停掉。故障是节点粒度的，闸门也该是。
 */

export interface EndpointHealth {
  url: string
  state: 'closed' | 'open' | 'half-open'
  failures: number
  openedAt: number
}

export interface BalancerConfig {
  endpoints: string[]
  /** 连续失败多少次打开熔断 */
  failureThreshold?: number
  /** 打开后多久转半开试探（ms） */
  openForMs?: number
  /** 注入时钟（测试用） */
  now?: () => number
}

interface Slot {
  url: string
  failures: number
  openedAt: number
  halfOpen: boolean
}

export class Balancer {
  private readonly slots: Slot[]
  private readonly threshold: number
  private readonly openForMs: number
  private readonly now: () => number
  private cursor = 0

  constructor(config: BalancerConfig) {
    if (config.endpoints.length === 0) {
      throw new Error('SeamProxy: endpoints 不能为空')
    }
    this.slots = config.endpoints.map((url) => ({
      url: url.replace(/\/+$/, ''),
      failures: 0,
      openedAt: 0,
      halfOpen: false,
    }))
    this.threshold = Math.max(config.failureThreshold ?? 5, 1)
    this.openForMs = Math.max(config.openForMs ?? 10_000, 100)
    this.now = config.now ?? Date.now
  }

  /**
   * 按轮转取下一个可用端点。全部熔断时返回 null ——
   * 此时**不做「反正都坏了就随便挑一个」的兜底**：那会在故障期继续制造超时堆积。
   */
  next(): string | null {
    const n = this.slots.length
    for (let i = 0; i < n; i++) {
      const slot = this.slots[(this.cursor + i) % n]!
      if (this.usable(slot)) {
        this.cursor = (this.cursor + i + 1) % n
        return slot.url
      }
    }
    return null
  }

  /** 取所有当前可用端点（重试时用，避免重复挑到同一个坏点）。 */
  candidates(limit: number): string[] {
    const out: string[] = []
    for (let i = 0; i < this.slots.length && out.length < limit; i++) {
      const url = this.next()
      if (!url) break
      if (!out.includes(url)) out.push(url)
    }
    return out
  }

  private usable(slot: Slot): boolean {
    if (slot.failures < this.threshold) return true
    if (this.now() - slot.openedAt >= this.openForMs) {
      slot.halfOpen = true // 放一个探针过去
      return true
    }
    return false
  }

  succeed(url: string): void {
    const slot = this.find(url)
    if (!slot) return
    slot.failures = 0
    slot.openedAt = 0
    slot.halfOpen = false
  }

  fail(url: string): void {
    const slot = this.find(url)
    if (!slot) return
    if (slot.halfOpen) {
      // 半开探针失败：直接重新计时，不给它慢慢累加的机会
      slot.failures = this.threshold
      slot.openedAt = this.now()
      slot.halfOpen = false
      return
    }
    slot.failures++
    if (slot.failures >= this.threshold) slot.openedAt = this.now()
  }

  private find(url: string): Slot | undefined {
    return this.slots.find((s) => s.url === url)
  }

  health(): EndpointHealth[] {
    return this.slots.map((s) => ({
      url: s.url,
      state: !this.usable(s) ? 'open' : s.halfOpen ? 'half-open' : 'closed',
      failures: s.failures,
      openedAt: s.openedAt,
    }))
  }

  /** 热更新端点列表（Nacos watch 下发时调用）。已知端点的健康状态保留。 */
  setEndpoints(urls: string[]): void {
    const normalized = urls.map((u) => u.replace(/\/+$/, ''))
    if (normalized.length === 0) return
    const kept = new Map(this.slots.map((s) => [s.url, s]))
    this.slots.length = 0
    for (const url of normalized) {
      this.slots.push(kept.get(url) ?? { url, failures: 0, openedAt: 0, halfOpen: false })
    }
    this.cursor = 0
  }
}
