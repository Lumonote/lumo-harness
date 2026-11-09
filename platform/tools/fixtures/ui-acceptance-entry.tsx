import { createRoot } from 'react-dom/client'
import { LumoOverlay } from '../../dsh-plugins/lumo-ui/src/client/index.tsx'

// The real workbench source and stylesheet run in a browser. Only the host shell,
// API data and PDF/Excel viewer boundary are fixtures; no model or service runs.
createRoot(document.getElementById('root')!).render(<>
  <main aria-label="隔离验收宿主"><h1>Lumo UI acceptance fixture</h1><p>Self-owned, read-only browser fixture.</p></main>
  <LumoOverlay {...({} as Parameters<typeof LumoOverlay>[0])} />
</>)
