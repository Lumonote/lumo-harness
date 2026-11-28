import { openSurface } from './surface-navigation.ts'
import { Button, IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { openEnvironment } from './environment-panel.tsx'
import './management.css'

/** The settings shell owns closing its modal before entering management. */
export function SettingsManagement({ close }: { close: () => void }) {
  return <section className="lumo-settings-management lumo-native-content">
    <h2>项目与平台管理</h2>
    <p>集中管理项目与任务、运行环境、能力配置和账户权限。</p>
    <div className="lumo-environment-actions"><Button type="button" onClick={() => { close(); window.setTimeout(() => openSurface('market'), 0) }}>打开管理工作台</Button>
      <Button type="button" onClick={() => { close(); window.setTimeout(openEnvironment, 0) }}><IconGlobeOutlineRegular size={16} />环境与连接</Button></div>
  </section>
}
