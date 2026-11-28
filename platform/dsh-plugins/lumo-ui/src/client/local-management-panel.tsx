import { AcpSessionSection } from './acp-session-panel.tsx'
import { DeviceActionsPanel } from './device-actions-panel.tsx'
import { RemoteHostsPanel } from './remote-hosts-panel.tsx'
import { Section, Empty } from './surface-shell.tsx'
import type { Plugin } from './surface-types.ts'
import type { OperationsArea } from './operations-navigation.ts'

export function LocalManagementPanel({ area, plugins }: { area: OperationsArea; plugins: Plugin[] }) {
  if (area === 'engines') return <AcpSessionSection />
  if (area === 'hosts') return <Section title="远端机器" meta="SSH 接入、安装升级与隧道"><RemoteHostsPanel /></Section>
  return <div className="lumo-local-mode">
    <Section title="本机状态" meta="本地存储 · SQLite">
      <p>项目与对话数据保存在本机。团队委派和集群治理在服务器模式中管理。</p>
      <details><summary>查看已装配能力 · {plugins.length} 项</summary>
        <div className="lumo-compact-list">{plugins.length ? plugins.map(plugin => <div key={plugin.id}><span><b>{plugin.label}</b><small>{plugin.description}</small></span></div>) : <Empty>当前没有额外的本地能力。</Empty>}</div>
      </details>
    </Section>
    <Section title="本机设备动作" meta="打开、剪贴板、通知与截图"><DeviceActionsPanel /></Section>
  </div>
}
