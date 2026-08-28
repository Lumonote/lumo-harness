const configured = typeof window.LUMO_NATIVE_OPS_URL === 'string' ? window.LUMO_NATIVE_OPS_URL : ''
let target = 'http://127.0.0.1:4173/lumo/ops'
try {
  const candidate = new URL(configured || target, window.location.href)
  if (candidate.protocol === 'http:' || candidate.protocol === 'https:') target = candidate.href
} catch {
  // Keep the documented local native entry when host configuration is invalid.
}

document.title = 'Lumo Console 已迁移'
document.body.innerHTML = `
  <main class="legacy-notice">
    <span class="legacy-kicker">LEGACY CONSOLE RETIRED</span>
    <h1>控制面已迁移到原生 DSH Web</h1>
    <p>此静态页面不再从浏览器直连控制面，也不会发送可伪造的身份头。</p>
    <a href="${target.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">打开 Lumo 运营面 →</a>
    <code>${target.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code>
  </main>
`

const style = document.createElement('style')
style.textContent = `
  body { min-height: 100vh; display: grid; place-items: center; margin: 0; background: #071112; color: #e9f3ef; font-family: Inter, system-ui, sans-serif; }
  .legacy-notice { width: min(620px, calc(100vw - 56px)); padding: 44px; border: 1px solid #274143; border-radius: 18px; background: #0c181a; box-shadow: 0 28px 80px #0008; }
  .legacy-kicker { color: #62d7bd; font: 11px ui-monospace, monospace; letter-spacing: .14em; }
  h1 { margin: 18px 0 12px; font-size: clamp(28px, 5vw, 48px); line-height: 1.05; }
  p { color: #9eb2ae; line-height: 1.7; }
  a { display: inline-block; margin-top: 18px; padding: 12px 18px; border-radius: 9px; background: #62d7bd; color: #06100f; font-weight: 700; text-decoration: none; }
  code { display: block; margin-top: 20px; color: #78938e; overflow-wrap: anywhere; }
`
document.head.append(style)
