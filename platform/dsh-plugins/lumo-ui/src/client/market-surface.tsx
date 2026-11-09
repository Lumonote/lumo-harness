import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { api } from './api.ts'
import { BusyButton, DomainTabs, Empty, Notice, Section, WorkspaceHero } from './surface-shell.tsx'
import { openSurface } from './surface-navigation.ts'
import type { Overview, RegistryArtifact, RegistryArtifactVersions, RegistryCatalog, RegistryInstallPlan, RegistryInstallations, RegistryRolloutSelection, RegistryRolloutSelectionResponse, RegistryRollouts, RegistryShape, Surface } from './surface-types.ts'

export function MarketSurface({ onClose }: { onClose: () => void }) {
  const [area, setArea] = useState<'apps' | 'registry'>('apps')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('全部')
  const [selectedName, setSelectedName] = useState('')
  const [catalog, setCatalog] = useState<RegistryCatalog | null>(null)
  const [installations, setInstallations] = useState<RegistryInstallations | null>(null)
  const [rollouts, setRollouts] = useState<RegistryRollouts | null>(null)
  const [artifactVersions, setArtifactVersions] = useState<RegistryArtifact[]>([])
  const [runtime, setRuntime] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [installShape, setInstallShape] = useState<RegistryShape>({ olap: false, graph: false, vector: false, object: false, gpu: false })
  const [installPlan, setInstallPlan] = useState<RegistryInstallPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState('')
  const [updatingDesired, setUpdatingDesired] = useState(false)
  const [desiredNotice, setDesiredNotice] = useState('')
  const [desiredVersion, setDesiredVersion] = useState('')
  const [desiredPercent, setDesiredPercent] = useState('100')
  const [rolloutSelections, setRolloutSelections] = useState<Record<string, RegistryRolloutSelection>>({})
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const runtimeSnapshot = await api<Overview>('/lumo/api/overview')
      setRuntime(runtimeSnapshot)
      if (runtimeSnapshot.deployment.mode === 'local') {
        setCatalog(null)
        setInstallations(null)
        setRollouts(null)
        setError('')
        return
      }
      const [catalogResult, installationsResult, rolloutsResult] = await Promise.allSettled([
        api<RegistryCatalog>('/lumo/api/registry/artifacts?limit=100'),
        api<RegistryInstallations>('/lumo/api/registry/installations?limit=100'),
        api<RegistryRollouts>('/lumo/api/registry/rollouts'),
      ])
      const failures: string[] = []
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value)
      else { setCatalog(null); failures.push('注册表目录不可用') }
      if (installationsResult.status === 'fulfilled') setInstallations(installationsResult.value)
      else { setInstallations(null); failures.push('节点安装回报不可用') }
      if (rolloutsResult.status === 'fulfilled') setRollouts(rolloutsResult.value)
      else { setRollouts(null); failures.push('Stable 期望状态不可用') }
      setError(failures.join('；'))
    } catch {
      setRuntime(null)
      setCatalog(null)
      setInstallations(null)
      setRollouts(null)
      setError('运行时配置不可用')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const items = catalog?.items ?? []
  const kinds = ['全部', ...Array.from(new Set(items.map(item => item.kind)))]
  const filtered = items.filter(item => {
    const matchesKind = kind === '全部' || item.kind === kind
    const searchable = `${item.name} ${item.version} ${item.kind} ${item.publisher} ${item.scopes.join(' ')}`.toLowerCase()
    return matchesKind && searchable.includes(query.trim().toLowerCase())
  })
  const selected = filtered.find(item => item.name === selectedName) ?? filtered[0]
  const accentFor = (value: RegistryArtifact['kind']) => ({ Component: '#7da9ed', Skill: '#63c9b9', Agent: '#b796e8', Connector: '#e4c66f', Flow: '#f29a62' }[value])
  const requirementLabels = (item: RegistryArtifact) => Object.entries(item.requires ?? {}).filter(([, enabled]) => enabled).map(([name]) => name.toUpperCase())
  const runtimePlugins = runtime?.plugins ?? []
  const installationReports = installations?.items ?? []
  const desiredRollout = selected === undefined ? undefined : rollouts?.items.find(item => item.name === selected.name)
  const rolloutNodeIDs = useMemo(() => Array.from(new Set(installationReports.map(report => report.node_id))).sort(), [installationReports])
  const rolloutNodeKey = rolloutNodeIDs.join('\u0000')
  const selectedInstallations = selected === undefined ? [] : installationReports.filter(report => report.state === 'converged' && report.installed.some(item => item.name === selected.name && item.version === selected.version))
  const selectedFailures = selected === undefined ? [] : installationReports.filter(report => report.state === 'failed' && report.root === `${selected.name}@${selected.version}`)
  useEffect(() => {
    if (selected === undefined) { setArtifactVersions([]); return }
    let active = true
    void api<RegistryArtifactVersions>(`/lumo/api/registry/artifacts/${encodeURIComponent(selected.name)}`)
      .then(result => { if (active) setArtifactVersions(result.items) })
      .catch(() => { if (active) setArtifactVersions([selected]) })
    return () => { active = false }
  }, [selected?.name, selected?.version])
  useEffect(() => {
    setDesiredVersion(desiredRollout?.version ?? selected?.version ?? '')
    setDesiredPercent(String(desiredRollout?.percent ?? 100))
  }, [desiredRollout?.version, desiredRollout?.percent, selected?.name, selected?.version])
  useEffect(() => {
    if (selected === undefined || desiredRollout === undefined || rolloutNodeIDs.length === 0) {
      setRolloutSelections({})
      return
    }
    let active = true
    void Promise.all(rolloutNodeIDs.map(async (nodeID) => {
      const result = await api<RegistryRolloutSelectionResponse>(`/lumo/api/registry/rollouts/${encodeURIComponent(selected.name)}?node_id=${encodeURIComponent(nodeID)}`)
      return result.selection
    })).then(selections => {
      if (!active) return
      setRolloutSelections(Object.fromEntries(selections.filter((selection): selection is RegistryRolloutSelection => selection !== undefined).map(selection => [selection.node_id, selection])))
    }).catch(() => { if (active) setRolloutSelections({}) })
    return () => { active = false }
  }, [selected?.name, desiredRollout?.version, desiredRollout?.percent, rolloutNodeKey])
  useEffect(() => { setInstallPlan(null); setPlanError('') }, [selected?.name, selected?.version])
  const buildPlan = async () => {
    if (selected === undefined) return
    setPlanning(true); setPlanError(''); setInstallPlan(null)
    try {
      setInstallPlan(await api<RegistryInstallPlan>('/lumo/api/registry/plan', { method: 'POST', body: JSON.stringify({ name: selected.name, version: selected.version, shape: installShape }) }))
    } catch (reason) { setPlanError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPlanning(false) }
  }
  const setDesiredTarget = async () => {
    if (selected === undefined || desiredVersion === '') return
    const percent = Number(desiredPercent)
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      setDesiredNotice('灰度比例必须是 0 到 100 的整数。')
      return
    }
    setUpdatingDesired(true); setDesiredNotice('')
    try {
      await api(`/lumo/api/registry/rollouts/${encodeURIComponent(selected.name)}`, { method: 'PUT', body: JSON.stringify({ version: desiredVersion, percent }) })
      setDesiredNotice(percent === 100
        ? `Stable 通道已全量指向 ${selected.name}@${desiredVersion}；节点将在下一次对账时重新验证签名计划。`
        : percent === 0
          ? `Stable 通道已将 ${selected.name}@${desiredVersion} 置为 0% 目标；所有节点继续使用保留版本。`
          : `Stable 通道已将 ${selected.name}@${desiredVersion} 灰度至 ${percent}%；目标 cohort 由稳定节点 ID 确定。`)
      await load()
    } catch (reason) { setDesiredNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setUpdatingDesired(false) }
  }
  const setShape = (capability: keyof RegistryShape, enabled: boolean) => setInstallShape(current => ({ ...current, [capability]: enabled }))
  const localMode = runtime?.deployment.mode === 'local'
  const workspaces: Array<{ title: string; description: string; surface: Surface; domain: string; availability: string }> = [
    { title: '项目运营', description: '管理项目资产、协作执行、集群服务与组织权限。', surface: 'operations', domain: '项目与运营', availability: localMode ? '本地项目与运行状态' : '项目、集群和组织管理' },
    { title: '开放设计', description: '使用当前工作区的设计技能创建可编辑产物。', surface: 'design', domain: '内容创作', availability: '依赖已装配技能' },
    { title: 'PPT 生成', description: '选择样例，交给 PPT 技能生成和审阅。', surface: 'presentation', domain: '内容创作', availability: '依赖已装配技能' },
    { title: '技能管理', description: '管理已有技能的版本与治理状态。', surface: 'skills', domain: '能力配置', availability: '查看治理权限' },
    ...(!localMode && runtime !== null ? [
      { title: '连接器', description: '查看网关目录、调用协议与审批状态。', surface: 'connectors' as Surface, domain: '平台集成', availability: '依赖连接器网关' },
      { title: '用户中心', description: '查看当前身份、安全策略与登录会话。', surface: 'account' as Surface, domain: '账户与安全', availability: '需登录' },
    ] : []),
  ]
  const domains = ['项目与运营', '内容创作', '能力配置', '平台集成', '账户与安全']
  return <div className="lumo-surface lumo-market-surface lumo-workspace-page">
    <WorkspaceHero surface="market" onClose={onClose} statement="按工作领域找到真正可用的入口。" description="项目运营、创作、能力配置和平台集成各有独立工作台；制品发布与安装状态在目录中查看。">
      <div className="lumo-workspace-status">
        <span>工作领域</span>
        <b><i aria-hidden="true" />{workspaces.length} 个独立工作台</b>
        <dl>{domains.filter(domain => workspaces.some(item => item.domain === domain)).map(domain => <div key={domain}><dt>{domain}</dt><dd>{workspaces.filter(item => item.domain === domain).length}</dd></div>)}</dl>
        <small>每个入口会在自己的页面核验技能、权限和服务状态。</small>
      </div>
    </WorkspaceHero>
    <DomainTabs label="工具分类" value={area} onChange={setArea} items={[
      { id: 'apps', title: '工作工具', description: '打开可操作的领域工作台' },
      ...(!localMode ? [{ id: 'registry' as const, title: '制品目录与灰度', description: '可发现版本、节点回报和目标版本' }] : []),
    ]} />
    {area === 'apps' ? <div className="lumo-workspace-directory">
      {domains.filter(domain => workspaces.some(item => item.domain === domain)).map(domain => <section key={domain} className="lumo-directory-domain" aria-label={domain}>
        <header><h2>{domain}</h2><span>{workspaces.filter(item => item.domain === domain).length} 个工作台</span></header>
        <div>{workspaces.filter(item => item.domain === domain).map(item => <button type="button" className="lumo-directory-entry" key={item.surface} onClick={() => openSurface(item.surface)}>
          <span><b>{item.title}</b><small>{item.description}</small></span><em>{item.availability}</em><i aria-hidden="true">↗</i>
        </button>)}</div>
      </section>)}
      <p className="lumo-directory-footnote">启动器配置中的插件声明是技术清单，不代表该功能有独立页面或已经运行。安装计划、灰度目标和节点回报请进入“制品目录与灰度”。</p>
    </div> : null}
    {area === 'registry' ? <>
    <ol className="lumo-truth-rail" aria-label="能力生命周期">
      <li className={catalog === null ? 'muted' : 'active'}><span>01</span><div><b>Registry</b><small>{catalog === null ? '目录未连接' : `${items.length} 个已签名版本可发现`}</small></div></li>
      <li className={installations === null ? 'muted' : 'active'}><span>02</span><div><b>Provisioner</b><small>{installations === null ? '安装回报不可读' : `${installationReports.length} 个节点最近回报`}</small></div></li>
      <li className={runtime === null ? 'muted' : 'active'}><span>03</span><div><b>Runtime</b><small>{runtime === null ? '运行时配置不可读' : `${runtimePlugins.length} 个有效入口`}</small></div></li>
    </ol>
    {error ? <Notice error>{error}</Notice> : null}
    <Section title="注册表制品" meta={loading ? '正在读取目录' : `${filtered.length} / ${items.length} 个可发现版本`} actions={<span className="lumo-surface-actions"><label className="lumo-filter"><span>搜索</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="制品名、发布者或 scope" /></label><BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>刷新</BusyButton></span>}>
      <div className="lumo-market-category-row" role="tablist" aria-label="制品类型">{kinds.map(item => <button type="button" role="tab" aria-selected={kind === item} className={kind === item ? 'active' : ''} key={item} onClick={() => setKind(item)}>{item}</button>)}</div>
      {filtered.length ? <div className="lumo-market-layout"><div className="lumo-market-grid">{filtered.map((item, index) => <button type="button" className={`lumo-market-card ${selected?.name === item.name ? 'selected' : ''}`} style={{ '--market-accent': accentFor(item.kind), '--lumo-order': String(index) } as CSSProperties} key={item.name} onClick={() => setSelectedName(item.name)}><span className="lumo-market-mark">{item.name.slice(0, 1).toUpperCase()}</span><span className="lumo-market-card-main"><span className="lumo-market-card-head"><b>{item.name}</b><i>可发现</i></span><small>{item.kind} · v{item.version}</small><p>发布者 {item.publisher} · {item.scopes.length} 个权限 scope</p><span className="lumo-market-tags">{item.scopes.slice(0, 3).map(scope => <em key={scope}>{scope}</em>)}</span></span><span className="lumo-market-arrow">›</span></button>)}</div><aside className="lumo-market-inspector">{selected ? <><span className="lumo-inspector-label">制品详情</span><div className="lumo-market-detail-title"><span className="lumo-market-mark" style={{ background: accentFor(selected.kind) }}>{selected.name.slice(0, 1).toUpperCase()}</span><div><h3>{selected.name}</h3><small>{selected.kind} · v{selected.version}</small></div></div><p>这个条目来自 Registry 索引，表示 manifest 已验签并发布；它不能证明某个节点已安装、启用或运行。</p><div className="lumo-detail-stack"><div><span>发布者</span><b>{selected.publisher}</b></div><div><span>发现状态</span><b className="lumo-ready-text">已发布 · 可发现</b></div><div><span>部署要求</span><b>{requirementLabels(selected).join('、') || '无额外声明'}</b></div><div><span>依赖</span><b>{selected.deps?.length ? selected.deps.map(dep => `${dep.name}@${dep.version}`).join('、') : '无'}</b></div></div><div className="lumo-market-actions"><BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>重新读取状态</BusyButton></div><code className="lumo-market-command">digest: {selected.digest}</code></> : <Empty>选择一个制品查看 manifest 索引。</Empty>}</aside></div> : <Empty>{loading ? '正在加载注册表目录。' : catalog === null ? '当前没有可用的注册表目录。' : '注册表中没有匹配的制品。'}</Empty>}
    </Section>
    <div className="lumo-market-state-grid">
    <Section title="Stable 通道期望状态" meta={rollouts === null ? '期望状态不可读取' : `${rollouts.items.length} 个制品目标；支持稳定分桶灰度`}>
      {selected === undefined ? <Empty>先选择一个制品设置或查看 Stable 通道的目标版本。</Empty> : <div className="lumo-market-plan"><div><b>{desiredRollout ? `${desiredRollout.name}@${desiredRollout.version} · ${desiredRollout.percent}% 目标 cohort` : '尚未声明目标版本'}</b><small>{desiredRollout ? `最近更新于 ${desiredRollout.updated_at}；比例为 0% 时所有节点使用保留版本，100% 时全量使用目标版本。这不是节点已安装或进程健康的证明。` : '选择下方操作可将一个已发布版本设为目标；Registry 会拒绝未发布版本。'}</small></div><label className="lumo-compact-field"><span>Stable 期望版本</span><select aria-label="Stable 期望版本" value={desiredVersion} onChange={event => setDesiredVersion(event.target.value)}>{(artifactVersions.length ? artifactVersions : [selected]).map(item => <option key={item.version} value={item.version}>{item.version === selected.version ? `${item.version}（最新）` : item.version}</option>)}</select></label><label className="lumo-compact-field"><span>Stable 灰度比例</span><input aria-label="Stable 灰度比例" type="number" min="0" max="100" step="1" value={desiredPercent} onChange={event => setDesiredPercent(event.target.value)} /></label><BusyButton className="lumo-primary" busy={updatingDesired} onClick={() => void setDesiredTarget()}>设为 Stable 期望版本</BusyButton><small>仅 realm_admin、platform_admin 或 admin 可修改。目标 cohort 按稳定节点 ID 分桶；提高比例只会扩大目标 cohort，0% 会使所有节点回到保留版本。设置目标不会在浏览器中安装制品，Provisioner 将于下一周期重新验签、对账并回报事实状态。</small>{desiredNotice ? <Notice close={() => setDesiredNotice('')}>{desiredNotice}</Notice> : null}{desiredRollout && installationReports.length ? <div className="lumo-market-note-grid">{installationReports.map(report => { const selection = rolloutSelections[report.node_id]; const installed = report.installed.find(item => item.name === selected.name); return <div key={report.node_id}><span>{selection?.cohort === 'target' ? '目标 cohort' : selection?.cohort === 'holdback' ? '保留 cohort' : '正在读取 cohort'}</span><b>{report.node_id}</b><small>{selection ? `期望 ${selection.version} · ${selection.cohort === 'target' ? '应收敛至目标版本' : '应保留上一版本'}` : '尚未取得该节点的确定性选择'}{installed ? `；最近回报已安装 ${installed.name}@${installed.version}` : report.state === 'failed' ? '；最近一次对账未收敛' : '；尚无该制品安装回报'}</small></div> })}</div> : null}</div>}
    </Section>
    <Section title="节点实际安装回报" meta={installations === null ? 'Provisioner 状态未接入或不可读取' : `${installationReports.length} 个节点的最近一次对账`}>
      {selected === undefined ? <Empty>先选择一个制品查看节点回报。</Empty> : installations === null ? <Empty>没有可读取的 Provisioner 回报，因此不能将该制品标为已部署。</Empty> : selectedInstallations.length || selectedFailures.length ? <div className="lumo-market-note-grid">{selectedInstallations.map(report => <div key={report.node_id}><span>已原子安装 · 已对账</span><b>{report.node_id}</b><small>{report.root} · {report.installed.length} 个签名制品 · {report.reported_at}</small></div>)}{selectedFailures.map(report => <div key={report.node_id}><span>最近一次对账未收敛</span><b>{report.node_id}</b><small>{report.root} · 该状态不证明任何旧版本仍可用或正在运行。</small></div>)}</div> : <Empty>没有节点回报此制品。它仍只是 Registry 中可发现的签名版本。</Empty>}
    </Section>
    <Section title="签名安装计划" meta="解析依赖、权限范围与目标部署形态；不会修改节点">
      {selected ? <div className="lumo-market-plan"><div><b>{selected.name}@{selected.version}</b><small>先选择目标节点实际具备的能力，再由 Registry 从已签名字节重建闭包。</small></div><fieldset><legend>目标部署能力</legend>{(Object.keys(installShape) as Array<keyof RegistryShape>).map(capability => <label key={capability}><input type="checkbox" checked={installShape[capability]} onChange={event => setShape(capability, event.target.checked)} />{capability.toUpperCase()}</label>)}</fieldset><BusyButton className="lumo-primary" busy={planning} onClick={() => void buildPlan()}>生成签名计划</BusyButton><small>此操作只预览；安装、启用、升级、回滚和卸载仍需由 Provisioner 在目标节点执行并回报真实状态。</small>{planError ? <Notice error>{planError}</Notice> : null}{installPlan ? <div className="lumo-market-plan-result"><b>计划闭包 · {installPlan.items.length} 个制品</b><small>聚合 scope：{installPlan.scopes.join('、') || '无'}</small>{installPlan.items.map(item => <span key={`${item.name}-${item.version}`}><b>{item.name}@{item.version}</b><small>{item.kind} · {item.publisher} · {item.scopes.length} scopes</small></span>)}</div> : null}</div> : <Empty>先从上方选择一个可发现制品。</Empty>}
    </Section>
    </div>
    <details className="lumo-runtime-disclosure"><summary>查看启动器配置声明 · {runtimePlugins.length} 项 <small>仅供排查，不代表已启用或可打开</small></summary><div className="lumo-market-runtime"><Section title="当前运行时配置" meta="来自启动器的有效配置，不等价于进程健康"><div className="lumo-market-note-grid">{runtimePlugins.length ? runtimePlugins.map(plugin => <div key={plugin.id}><span>{plugin.kind === 'governance' ? '治理声明' : '运行时声明'}</span><b>{plugin.label}</b><small>{plugin.description} · 配置 ID: {plugin.id}</small></div>) : <Empty>{runtime === null ? '运行时配置暂不可读取。' : '当前启动配置没有声明额外挂载插件。'}</Empty>}</div></Section></div></details>
    <div className="lumo-market-boundary"><Section title="生命周期边界" meta="状态必须由对应系统证明"><div className="lumo-market-note-grid"><div><span>Registry</span><b>已签名、已发布、可发现</b><small>目录只读取 Registry 索引；scope、摘要和发布者可审计。</small></div><div><span>Provisioner</span><b>已安装与对账结果</b><small>节点回报证明最近一次签名计划已原子落盘；它不等价于启用、健康或请求处理。</small></div><div><span>Runtime</span><b>启用、健康、日志与重启</b><small>启动器配置仅说明已声明入口，不能替代进程健康或实际运行版本。</small></div></div></Section></div>
    </> : null}
  </div>
}
