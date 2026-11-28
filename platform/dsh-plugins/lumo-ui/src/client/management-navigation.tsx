import { BusyButton } from './surface-shell.tsx'
import './management.css'

export function ManagementHeader({ title, description, onClose, loading, refresh }: {
  title: string; description: string; onClose: () => void; loading?: boolean; refresh?: () => void
}) {
  return <header className="lumo-management-header">
    <div className="lumo-management-breadcrumb">
      <button type="button" className="lumo-workspace-back" onClick={onClose}>返回对话</button>
      <span>设置 / 管理工作台</span>
    </div>
    <div className="lumo-management-heading"><div><h1>{title}</h1><p>{description}</p></div>
      {refresh ? <BusyButton className="lumo-secondary" busy={Boolean(loading)} onClick={refresh}>刷新状态</BusyButton> : null}
    </div>
  </header>
}
