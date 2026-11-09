import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import type { Surface } from './surface-types.ts'
import { surfaceMeta } from './surface-navigation.ts'

export function Glyph({ surface }: { surface: Surface }) {
  const paths: Record<Surface, ReactNode> = {
    computer: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4m-1-12 4 3-3 1-1 3z" /></>,
    collaboration: <><circle cx="12" cy="12" r="2.6" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15" /><path d="M12 4.5a7.5 7.5 0 0 0 0 15" /><circle cx="12" cy="3" r="1.1" /><circle cx="19.5" cy="16.5" r="1.1" /><circle cx="4.5" cy="16.5" r="1.1" /></>,
    knowledge: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v14H6.5A2.5 2.5 0 0 0 4 19.5z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v14h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></>,
    skills: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" /><path d="m18.5 15 .75 2.25L21.5 18l-2.25.75L18.5 21l-.75-2.25L15.5 18z" /></>,
    connectors: <><path d="M8 7V4M16 7V4M6 7h12v4a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
    operations: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
    design: <><path d="m4 20 4.5-1 9.8-9.8a2.1 2.1 0 0 0-3-3L5.5 16z" /><path d="m13.8 7.7 2.5 2.5" /></>,
    presentation: <><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M8 20h8M12 16v4M8 8h8M8 11h5" /></>,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
    market: <><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" /><path d="m8 9 4 2.25L16 9M12 11.25V17" /></>,
    skillhub: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 9h16M9 4v16M4 14h16" /></>,
  }
  return <svg className="lumo-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[surface]}</svg>
}

export function MagneticButton({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`lumo-button ${className}`} {...props}>{children}</button>
}

export function BusyButton({ busy, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <MagneticButton className={className} {...props} disabled={busy || props.disabled} aria-busy={busy || undefined}>{busy ? <span className="lumo-spinner" aria-hidden="true" /> : null}{children}</MagneticButton>
}

export function ConfirmButton({ children, confirmLabel = '确认', className = 'lumo-danger lumo-small', busy = false, onConfirm }: {
  children: ReactNode
  confirmLabel?: string
  className?: string
  busy?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  if (!armed) return <button type="button" className={'lumo-button ' + className} disabled={busy} onClick={() => setArmed(true)}>{children}</button>
  return <span className="lumo-confirm" role="group" aria-label="确认操作">
    <BusyButton className={className} busy={busy} onClick={() => { setArmed(false); void onConfirm() }}>{confirmLabel}</BusyButton>
    <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy} onClick={() => setArmed(false)}>取消</button>
  </span>
}

export function SpotlightCard({ className = '', index = 0, children, onClick }: { className?: string; index?: number; children: ReactNode; onClick?: () => void }) {
  return <article className={`lumo-spotlight ${className}`} onClick={onClick} style={{ '--lumo-order': String(index) } as CSSProperties}>{children}</article>
}

export function ClickSpark({ children }: { children: ReactNode }) {
  return <div className="lumo-click-spark">{children}</div>
}

export function Section({ title, meta, actions, children, className = '' }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`lumo-section ${className}`}><div className="lumo-section-title"><div><b>{title}</b>{meta === undefined ? null : <span>{meta}</span>}</div>{actions}</div>{children}</section>
}

export function Empty({ children }: { children: ReactNode }) { return <p className="lumo-muted lumo-empty">{children}</p> }

export function Notice({ error, children, close }: { error?: boolean; children: ReactNode; close?: () => void }) { return <div className={`lumo-alert ${error ? 'error' : 'notice'}`} role={error ? 'alert' : 'status'}><span>{children}</span>{close ? <button type="button" onClick={close} aria-label="关闭提示">×</button> : null}</div> }

export function formatSync(value: string): string { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未同步' }

export function WorkspaceHero({
  surface, onClose, statement, description, children,
}: {
  surface: 'operations' | 'market' | 'knowledge' | 'skillhub' | 'account' | 'skills' | 'connectors' | 'design' | 'presentation'
  onClose: () => void
  statement: string
  description: string
  children: ReactNode
}) {
  const meta = surfaceMeta[surface]
  return <header className={`lumo-workspace-hero ${surface}`}>
    <div className="lumo-workspace-hero-copy">
      <div className="lumo-workspace-hero-topline">
        <button type="button" className="lumo-workspace-back" onClick={onClose} aria-label="返回对话">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5.5 5.5 5.5 5.5" /><path d="M7.5 10H17" /></svg>
          返回对话
        </button>
        <span className="lumo-workspace-kicker"><i aria-hidden="true" />{meta.eyebrow}</span>
      </div>
      <h1>{meta.label}</h1>
      <strong>{statement}</strong>
      <p>{description}</p>
    </div>
    <aside className="lumo-workspace-hero-panel">{children}</aside>
  </header>
}

export function DomainTabs<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: ReadonlyArray<{ id: T; title: string; description: string }>; onChange: (next: T) => void }) {
  return <nav className="lumo-domain-tabs" aria-label={label}>
    {items.map(item => <button type="button" key={item.id} title={item.description} className={value === item.id ? 'active' : ''} aria-current={value === item.id ? 'page' : undefined} onClick={() => onChange(item.id)}>
      <b>{item.title}</b><span>{item.description}</span>
    </button>)}
  </nav>
}

export function Metric({ label, value, note, tone = '' }: { label: string; value: string; note: string; tone?: string }) {
  return <SpotlightCard className={`lumo-metric ${tone}`}><small>{label}</small><strong>{value}</strong><span>{note}</span></SpotlightCard>
}
