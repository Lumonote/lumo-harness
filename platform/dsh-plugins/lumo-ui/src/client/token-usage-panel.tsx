import { useEffect, useMemo, useState, type FormEvent } from 'react'

export interface TokenUsagePanelProps {
  /** The parent must derive this from the authenticated account roles. */
  platformAdmin: boolean
}

interface UsageMeasure {
  tokens: number
  cost_usd: number
}

interface DailyUsage extends UsageMeasure {
  day: string
}

interface ModelUsage extends UsageMeasure {
  model: string
}

interface UserUsage extends UsageMeasure {
  user_id: string
}

interface ProjectUsage extends UsageMeasure {
  project_id: string
}

interface TokenUsageResponse {
  from: string
  to: string
  totals: UsageMeasure
  daily: DailyUsage[]
  top_models: ModelUsage[]
  top_users: UserUsage[]
  top_projects: ProjectUsage[]
}

interface DateRange {
  from: string
  to: string
}

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const compactNumberFormat = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const usdFormat = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

function initialRange(): Pick<DateRange, 'from' | 'to'> {
  const now = new Date()
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const from = new Date(to.getTime() - 29 * 86_400_000)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

function validRange(from: string, to: string): string | undefined {
  const parse = (value: string): number | undefined => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year!, month! - 1, day!))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return undefined
    return date.getTime()
  }
  const start = parse(from)
  const end = parse(to)
  if (start === undefined || end === undefined) return '请选择有效的起止日期。'
  if (end < start) return '结束日期不能早于开始日期。'
  if ((end - start) / 86_400_000 + 1 > 90) return '一次最多查询 90 天，请缩短日期范围。'
  return undefined
}

function responseError(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') return body.error
  return fallback
}

function isUsageMeasure(value: unknown): value is UsageMeasure {
  return typeof value === 'object' && value !== null
    && 'tokens' in value && typeof value.tokens === 'number'
    && 'cost_usd' in value && typeof value.cost_usd === 'number'
}

function tokenUsageResponse(body: unknown): TokenUsageResponse | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = body as Partial<TokenUsageResponse>
  if (typeof value.from !== 'string' || typeof value.to !== 'string') return undefined
  if (!isUsageMeasure(value.totals)) return undefined
  if (!Array.isArray(value.daily) || !Array.isArray(value.top_models) || !Array.isArray(value.top_users) || !Array.isArray(value.top_projects)) return undefined
  if (!value.daily.every(row => typeof row?.day === 'string' && isUsageMeasure(row))) return undefined
  if (!value.top_models.every(row => typeof row?.model === 'string' && isUsageMeasure(row))) return undefined
  if (!value.top_users.every(row => typeof row?.user_id === 'string' && isUsageMeasure(row))) return undefined
  if (!value.top_projects.every(row => typeof row?.project_id === 'string' && isUsageMeasure(row))) return undefined
  return value as TokenUsageResponse
}

function formatTokens(value: number): string {
  return numberFormat.format(Number.isFinite(value) ? value : 0)
}

function formatCompact(value: number): string {
  return compactNumberFormat.format(Number.isFinite(value) ? value : 0)
}

function formatUSD(value: number): string {
  return usdFormat.format(Number.isFinite(value) ? value : 0)
}

function TrendChart({
  title,
  days,
  valueOf,
  formatValue,
  tone,
}: {
  title: string
  days: DailyUsage[]
  valueOf: (day: DailyUsage) => number
  formatValue: (value: number) => string
  tone: 'tokens' | 'cost'
}) {
  const values = days.map(day => Math.max(0, valueOf(day)))
  const max = Math.max(1, ...values)
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? 380 : 24 + (index / (values.length - 1)) * 712
    const y = 166 - (value / max) * 126
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const current = values.reduce((sum, value) => sum + value, 0)
  const labelIndices = [...new Set(days.length <= 1 ? [0] : [0, Math.floor((days.length - 1) / 2), days.length - 1])]
  const labels = labelIndices.flatMap(index => days[index] === undefined ? [] : [{ day: days[index]!, index }])
  const color = tone === 'tokens' ? '#4267d5' : '#16866b'
  const areaPoints = points.length > 0 ? `24,174 ${points.join(' ')} 736,174` : ''

  return <article className="lumo-token-usage-chart-card">
    <div className="lumo-token-usage-chart-heading"><span>{title}</span><strong>{formatValue(current)}</strong></div>
    {days.length === 0 ? <div className="lumo-token-usage-chart-empty">暂无趋势数据</div> : <>
      <svg className="lumo-token-usage-chart" viewBox="0 0 760 210" role="img" aria-label={`${title}趋势`} preserveAspectRatio="none">
        {[40, 82, 124, 166].map(y => <line key={y} x1="24" x2="736" y1={y} y2={y} stroke="#e9edf3" strokeWidth="1" />)}
        <polygon points={areaPoints} fill={color} fillOpacity="0.09" />
        <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {days.length <= 30 ? points.map((point, index) => {
          const [cx, cy] = point.split(',')
          return <circle key={days[index]!.day} cx={cx} cy={cy} r="3" fill={color} stroke="white" strokeWidth="2" />
        }) : null}
        {labels.map(({ day, index }) => {
          const x = days.length <= 1 ? 380 : 24 + (index / (days.length - 1)) * 712
          const anchor = index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'
          return <text key={`${day.day}-${index}`} x={x} y="199" textAnchor={anchor} fill="#8993a3" fontSize="11">{day.day.slice(5)}</text>
        })}
      </svg>
      <div className="lumo-token-usage-chart-legend"><i style={{ background: color }} />每日合计 · UTC</div>
    </>}
  </article>
}

function TopList<T extends UsageMeasure>({
  title,
  rows,
  labelOf,
}: {
  title: string
  rows: T[]
  labelOf: (row: T) => string
}) {
  const max = Math.max(1, ...rows.map(row => Math.max(0, row.tokens)))
  return <section className="lumo-token-usage-ranking">
    <header><h3>{title}</h3><span>Top 10</span></header>
    {rows.length === 0 ? <p className="lumo-token-usage-empty">暂无 token 用量</p> : <ol>
      {rows.map((row, index) => <li key={`${labelOf(row)}-${index}`}>
        <div className="lumo-token-usage-rank-line">
          <span className="lumo-token-usage-rank">{String(index + 1).padStart(2, '0')}</span>
          <b title={labelOf(row)}>{labelOf(row) || '未命名'}</b>
          <strong>{formatCompact(row.tokens)}</strong>
        </div>
        <div className="lumo-token-usage-rank-track"><i style={{ width: `${Math.max(2, (Math.max(0, row.tokens) / max) * 100)}%` }} /></div>
        <small>{formatTokens(row.tokens)} tokens <span>·</span> {formatUSD(row.cost_usd)}</small>
      </li>)}
    </ol>}
  </section>
}

const styles = `
.lumo-token-usage{--tu-ink:#202938;--tu-muted:#788395;--tu-line:#e8ecf2;--tu-blue:#4267d5;display:grid;gap:18px;color:var(--tu-ink);font:inherit}
.lumo-token-usage *{box-sizing:border-box}
.lumo-token-usage-shell{padding:22px;border:1px solid var(--tu-line);border-radius:18px;background:linear-gradient(145deg,#fff 0%,#fbfcff 100%);box-shadow:0 8px 28px #27344a0b}
.lumo-token-usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.lumo-token-usage-head h2{margin:2px 0 5px;font-size:20px;letter-spacing:-.025em}
.lumo-token-usage-head p{margin:0;color:var(--tu-muted);font-size:12px;line-height:1.55}
.lumo-token-usage-kicker{color:#526fd0;font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
.lumo-token-usage-scope{display:inline-flex;align-items:center;gap:7px;margin-top:11px;color:#526174;font-size:11px}
.lumo-token-usage-scope i{width:7px;height:7px;border-radius:50%;background:#219778;box-shadow:0 0 0 3px #21977818}
.lumo-token-usage-controls{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.lumo-token-usage-controls label{display:grid;gap:5px;color:var(--tu-muted);font-size:10px;font-weight:650}
.lumo-token-usage-controls input{min-height:36px;padding:0 10px;border:1px solid #dfe5ed;border-radius:9px;background:#fff;color:var(--tu-ink);font:inherit;font-size:12px}
.lumo-token-usage-controls button{min-height:36px;padding:0 14px;border:0;border-radius:9px;background:var(--tu-blue);color:white;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.lumo-token-usage-controls button:hover{background:#3457bd}
.lumo-token-usage-controls button:disabled{opacity:.56;cursor:wait}
.lumo-token-usage-alert{padding:11px 13px;border:1px solid #f0d4d1;border-radius:10px;background:#fff8f7;color:#9e3830;font-size:12px}
.lumo-token-usage-alert.info{border-color:#dfe6f1;background:#f7f9fc;color:#657186}
.lumo-token-usage-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}
.lumo-token-usage-metric{min-width:0;padding:16px;border:1px solid var(--tu-line);border-radius:13px;background:#fff}
.lumo-token-usage-metric span{display:block;color:var(--tu-muted);font-size:11px}
.lumo-token-usage-metric strong{display:block;margin:8px 0 4px;font-size:clamp(20px,2.2vw,28px);line-height:1.1;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.lumo-token-usage-metric small{color:#94a0b0;font-size:10px}
.lumo-token-usage-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
.lumo-token-usage-chart-card{min-width:0;padding:15px 16px 11px;border:1px solid var(--tu-line);border-radius:13px;background:#fff}
.lumo-token-usage-chart-heading{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:11px;color:var(--tu-muted)}
.lumo-token-usage-chart-heading strong{color:var(--tu-ink);font-size:15px;font-variant-numeric:tabular-nums}
.lumo-token-usage-chart{display:block;width:100%;height:145px;margin-top:8px;overflow:visible}
.lumo-token-usage-chart-legend{display:flex;align-items:center;gap:6px;color:#8993a3;font-size:10px}
.lumo-token-usage-chart-legend i{width:7px;height:7px;border-radius:50%}
.lumo-token-usage-chart-empty{display:grid;place-items:center;height:145px;color:#a0a9b6;font-size:11px}
.lumo-token-usage-rankings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}
.lumo-token-usage-ranking{min-width:0;padding:15px 16px;border:1px solid var(--tu-line);border-radius:13px;background:#fff}
.lumo-token-usage-ranking header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.lumo-token-usage-ranking h3{margin:0;font-size:12px}
.lumo-token-usage-ranking header span{color:#98a2b0;font-size:10px}
.lumo-token-usage-ranking ol{display:grid;gap:11px;margin:0;padding:0;list-style:none}
.lumo-token-usage-rank-line{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:6px}
.lumo-token-usage-rank{color:#9ba5b3;font-size:9px;font-variant-numeric:tabular-nums}
.lumo-token-usage-rank-line b{overflow:hidden;color:#394456;font-size:11px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.lumo-token-usage-rank-line strong{font-size:11px;font-variant-numeric:tabular-nums}
.lumo-token-usage-rank-track{height:3px;margin:6px 0 4px 30px;overflow:hidden;border-radius:9px;background:#eef1f6}
.lumo-token-usage-rank-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#5576dc,#95a9ed)}
.lumo-token-usage-ranking small{display:block;margin-left:30px;color:#8b95a4;font-size:9px;font-variant-numeric:tabular-nums}
.lumo-token-usage-ranking small span{padding:0 3px;color:#c1c8d2}
.lumo-token-usage-empty{margin:18px 0;color:#98a2b0;font-size:11px;text-align:center}
.lumo-token-usage-foot{color:#929cab;font-size:10px;line-height:1.5}
@media(max-width:900px){.lumo-token-usage-head{flex-direction:column}.lumo-token-usage-controls{width:100%}.lumo-token-usage-rankings{grid-template-columns:1fr 1fr}}
@media(max-width:620px){.lumo-token-usage-shell{padding:15px}.lumo-token-usage-metrics,.lumo-token-usage-charts,.lumo-token-usage-rankings{grid-template-columns:1fr}.lumo-token-usage-controls{display:grid;grid-template-columns:1fr 1fr}.lumo-token-usage-controls button{grid-column:1/-1}.lumo-token-usage-chart{height:125px}}
`

export function TokenUsagePanel({ platformAdmin }: TokenUsagePanelProps) {
  const initial = useMemo(initialRange, [])
  const [draftFrom, setDraftFrom] = useState(initial.from)
  const [draftTo, setDraftTo] = useState(initial.to)
  const [requestRange, setRequestRange] = useState<DateRange>(initial)
  const [data, setData] = useState<TokenUsageResponse | null>(null)
  const [loading, setLoading] = useState(platformAdmin)
  const [error, setError] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    if (!platformAdmin) {
      setLoading(false)
      setData(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setData(null)
    const query = new URLSearchParams({ from: requestRange.from, to: requestRange.to })
    void fetch(`/lumo/api/ops/token-usage?${query.toString()}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      const text = await response.text()
      let body: unknown = null
      try { body = text === '' ? null : JSON.parse(text) as unknown } catch { body = text }
      if (!response.ok) throw new Error(responseError(body, `用量查询失败 (${response.status})`))
      const parsed = tokenUsageResponse(body)
      if (parsed === undefined) throw new Error('用量接口返回了无效数据。')
      setData(parsed)
    }).catch(reason => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [platformAdmin, requestRange, refreshVersion])

  const handleRefresh = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const issue = validRange(draftFrom, draftTo)
    setRangeError(issue ?? '')
    if (issue !== undefined) return
    setRequestRange({ from: draftFrom, to: draftTo })
    setRefreshVersion(value => value + 1)
  }

  return <section className="lumo-token-usage lumo-token-usage-shell" aria-labelledby="lumo-token-usage-title">
    <style>{styles}</style>
    <div className="lumo-token-usage-head">
      <div>
        <span className="lumo-token-usage-kicker">平台用量监测</span>
        <h2 id="lumo-token-usage-title">Token 用量</h2>
        <p>按模型、用户和项目查看 LLM token 消耗与估算费用。</p>
        <span className="lumo-token-usage-scope"><i />平台全量统计 · UTC 日 · 最多 90 天</span>
      </div>
      <form className="lumo-token-usage-controls" onSubmit={handleRefresh}>
        <label>开始日期<input type="date" value={draftFrom} max={draftTo} disabled={!platformAdmin} onChange={event => setDraftFrom(event.currentTarget.value)} /></label>
        <label>结束日期<input type="date" value={draftTo} min={draftFrom} disabled={!platformAdmin} onChange={event => setDraftTo(event.currentTarget.value)} /></label>
        <button type="submit" disabled={!platformAdmin || loading}>{loading ? '正在读取…' : '刷新数据'}</button>
      </form>
    </div>

    {!platformAdmin ? <div className="lumo-token-usage-alert info" role="status">此面板展示平台级用量，仅平台管理员可查看。</div> : null}
    {rangeError ? <div className="lumo-token-usage-alert" role="alert">{rangeError}</div> : null}
    {error ? <div className="lumo-token-usage-alert" role="alert">{error}</div> : null}

    {platformAdmin ? <>
      <div className="lumo-token-usage-metrics" aria-live="polite">
        <article className="lumo-token-usage-metric"><span>区间 Tokens</span><strong>{loading && data === null ? '…' : formatTokens(data?.totals.tokens ?? 0)}</strong><small>{requestRange.from} 至 {requestRange.to}</small></article>
        <article className="lumo-token-usage-metric"><span>估算费用</span><strong>{loading && data === null ? '…' : formatUSD(data?.totals.cost_usd ?? 0)}</strong><small>按台账中的模型费率记录</small></article>
        <article className="lumo-token-usage-metric"><span>有用量日期</span><strong>{loading && data === null ? '…' : `${data?.daily.filter(day => day.tokens > 0).length ?? 0} 天`}</strong><small>展示范围内的 UTC 自然日</small></article>
      </div>

      {loading && data === null ? <div className="lumo-token-usage-alert info" role="status">正在载入平台用量…</div> : null}
      {data !== null ? <>
        <div className="lumo-token-usage-charts">
          <TrendChart title="每日 Token" days={data.daily} valueOf={day => day.tokens} formatValue={formatCompact} tone="tokens" />
          <TrendChart title="每日估算费用" days={data.daily} valueOf={day => day.cost_usd} formatValue={formatUSD} tone="cost" />
        </div>
        <div className="lumo-token-usage-rankings">
          <TopList title="模型消耗" rows={data.top_models} labelOf={row => row.model || 'unknown'} />
          <TopList title="用户消耗" rows={data.top_users} labelOf={row => row.user_id} />
          <TopList title="项目消耗" rows={data.top_projects} labelOf={row => row.project_id} />
        </div>
      </> : null}
      <footer className="lumo-token-usage-foot">用户与项目榜单汇总平台全量台账记录；当前数据范围不按 realm 拆分。估算费用来自已入账的 usage_ledger 记录。</footer>
    </> : null}
  </section>
}

export default TokenUsagePanel
