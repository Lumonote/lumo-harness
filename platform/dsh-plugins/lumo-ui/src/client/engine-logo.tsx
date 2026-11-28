import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { ENGINE_LOGOS } from './engine-logo-assets.ts'
import './engine-logo.css'

/** Decorative: the adjacent engine or Agent name supplies the accessible label. */
export const EngineLogo = ({ engineId, small = false }: { engineId: string; small?: boolean }) => {
  const brand = engineId === 'codex-acp' ? 'codex' : engineId
  const logo = Object.hasOwn(ENGINE_LOGOS, brand) ? ENGINE_LOGOS[brand] : undefined
  return <span className={`lumo-engine-logo${small ? ' lumo-engine-logo-small' : ''}`} data-engine-logo={logo || brand === 'deepseek' ? brand : 'generic'} aria-hidden="true">
    {brand === 'deepseek' ? <FishLogo /> : logo ? logo.monochrome
      ? <span className="lumo-engine-logo-mask" style={{ maskImage: `url("${logo.src}")`, WebkitMaskImage: `url("${logo.src}")` }} />
      : <img src={logo.src} alt="" width={24} height={24} draggable={false} />
      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>}
  </span>
}
