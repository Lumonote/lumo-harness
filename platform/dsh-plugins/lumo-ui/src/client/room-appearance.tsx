import type { RoomAppearance } from '../../../acp-engines/src/role-room-model.ts'
import { EngineLogo } from './engine-logo.tsx'

export const DEFAULT_APPEARANCE: RoomAppearance = { logo: 'auto', color: '#5078d4' }
const colors = [['蓝色', '#5078d4'], ['绿色', '#33856d'], ['橙色', '#dd7b28'], ['紫色', '#8c61c6'], ['玫红', '#c45778']] as const
const icons = {
  team: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3m1-15a3 3 0 0 1 0 6m3 9v-3a6 6 0 0 0-2-4" /></>,
  bolt: <path d="m14 2-10 12h7l-1 8 10-12h-7z" />,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />,
  spark: <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z" />,
  bot: <><rect x="3" y="7" width="18" height="14" rx="4" /><path d="M12 7V3m-2 0h4M8 12v3m8-3v3m-7 3h6" /></>,
}
export const RoomLogo = ({ appearance = DEFAULT_APPEARANCE, engines = [] }: { appearance?: RoomAppearance | undefined; engines?: string[] }) => {
  const unique = [...new Set(engines)].slice(0, 3)
  const logo = appearance.logo === 'auto' && !unique.length ? 'team' : appearance.logo
  return <span className="lumo-room-logo" style={{ color: appearance.color, backgroundColor: `${appearance.color}18` }} aria-hidden="true" data-room-logo={logo}>
    {logo.startsWith('engine:') ? <EngineLogo engineId={logo.slice(7)} /> : logo === 'auto'
      ? <span className="lumo-room-logo-stack">{unique.map(id => <EngineLogo key={id} engineId={id} small />)}</span>
      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icons[logo as keyof typeof icons] ?? icons.team}</svg>}
  </span>
}
export const RoomAppearanceFields = ({ value, onChange, engines, disabled = false }: { value: RoomAppearance; onChange(value: RoomAppearance): void; engines: string[]; disabled?: boolean }) => <div className="lumo-room-appearance-editor"><div className="lumo-room-appearance">
  <RoomLogo appearance={value} engines={engines} />
  <label>群组 Logo<select aria-label="群组 Logo" value={value.logo} disabled={disabled} onChange={e => onChange({ ...value, logo: e.target.value })}>
    <option value="auto">自动 · 成员工具 Logo</option><option value="team">团队</option><option value="bot">Bot</option><option value="bolt">闪电</option><option value="code">代码</option><option value="spark">星光</option>
    {[...new Set(engines)].map(id => <option key={id} value={`engine:${id}`}>{id}</option>)}
  </select></label>
  <label>群组颜色<input type="color" aria-label="群组颜色" value={value.color} disabled={disabled} onInput={e => onChange({ ...value, color: e.currentTarget.value })} onChange={e => onChange({ ...value, color: e.target.value })} /></label>
</div><div className="lumo-room-colors" aria-label="群组预设颜色">{colors.map(([name, color]) => <button key={color} type="button" aria-label={name} aria-pressed={value.color === color} title={name} disabled={disabled} style={{ backgroundColor: color }} onClick={() => onChange({ ...value, color })} />)}</div></div>
