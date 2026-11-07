/** Self-contained, motion-free login styles; captcha tiles match loginScript's 64px slicing. */
export const loginStyles = `
  :root {
    --bg: #0b0e11; --panel: #11161c; --input: #0b0e11;
    --ink: #eef3f6; --muted: #a4b1bb; --dim: #87949f;
    --line: #2b333c; --accent: #ff914d; --accent-bright: #ffb37c;
    --accent-soft: #ff914d18; color-scheme: dark;
  }
  :root[data-lumo-theme="ember-foundry"] { --accent: #ffa46f; --accent-bright: #ffd1a0; --accent-soft: #ffa46f18; }
  :root[data-lumo-theme="orbital-glass"] { --accent: #91b7ff; --accent-bright: #c5d8ff; --accent-soft: #91b7ff18; }
  :root[data-lumo-theme="infrared-grid"] { --accent: #ff7799; --accent-bright: #ffc0cf; --accent-soft: #ff779918; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 14px/1.6 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  button, input { font: inherit; }
  button, a { -webkit-tap-highlight-color: transparent; }
  button { cursor: pointer; }
  .shell { display: grid; grid-template-columns: minmax(0, 1fr) minmax(420px, 1fr); min-height: 100svh; max-width: 1440px; margin: auto; }
  .manifest { display: flex; flex-direction: column; justify-content: space-between; gap: 48px; min-width: 0; padding: 48px clamp(32px, 5vw, 80px); border-right: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 17px; font-weight: 600; }
  .brand-mark { width: 36px; height: 36px; flex: none; border-radius: 10px; background: var(--panel) url('/branding/logo.png') center/cover no-repeat; border: 1px solid var(--line); }
  .brand small { display: block; color: var(--dim); font-size: 12px; font-weight: 400; margin-top: 1px; }
  .copy { margin-block: auto; padding-block: 40px; }
  .kicker { color: var(--accent); font-size: 12px; letter-spacing: .08em; }
  h1 { font-size: clamp(32px, 3.4vw, 48px); line-height: 1.4; letter-spacing: -.035em; font-weight: 600; margin: 20px 0; }
  h1 em { color: var(--ink); font-style: normal; }
  .copy p { max-width: 32em; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.9; }
  .system-note { display: flex; align-items: center; gap: 9px; color: var(--dim); font-size: 12px; }
  .system-note i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .entry { display: grid; align-items: center; justify-items: center; min-width: 0; padding: 40px 32px; }
  .card { width: min(100%, 380px); }
  .card-head { margin-bottom: 28px; }
  .card-head small { color: var(--dim); font-size: 11px; letter-spacing: .08em; }
  h2 { margin: 8px 0 4px; font-size: 26px; line-height: 1.4; letter-spacing: -.025em; font-weight: 600; }
  .card-subtitle { margin: 0; color: var(--muted); font-size: 13px; }
  form { display: grid; gap: 18px; }
  .field { display: grid; gap: 7px; min-width: 0; }
  label { font-size: 13px; font-weight: 500; }
  label small { color: var(--dim); font-size: 12px; font-weight: 400; margin-left: 5px; }
  input:not([type="hidden"]) { width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--input); color: var(--ink); transition: border-color .15s; }
  input::placeholder { color: var(--dim); }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .captcha-prompt { margin: 0 0 3px; color: var(--muted); font-size: 13px; }
  .captcha-prompt b { color: var(--ink); margin-left: 8px; letter-spacing: .06em; }
  .captcha-grid { display: grid; grid-template-columns: repeat(3, 64px); gap: 5px; width: fit-content; padding: 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .tile { position: relative; width: 64px; height: 64px; padding: 0; border: 0; border-radius: 4px; background-color: var(--input); }
  .tile:hover { outline: 1px solid var(--accent); outline-offset: 1px; }
  .tile.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
  .tile.selected::after { position: absolute; right: 3px; bottom: 3px; content: attr(data-order); display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: var(--bg); background: var(--accent); font-size: 12px; font-weight: 700; }
  .captcha-tools { display: flex; align-items: center; gap: 18px; font-size: 12px; color: var(--dim); }
  .captcha-refresh { min-height: 32px; border: 0; padding: 4px 0; background: transparent; color: var(--accent); font-size: 12px; }
  .hint { margin-top: -13px; color: var(--dim); font-size: 12px; }
  .submit, .passkey-submit, .oidc-login { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; min-height: 44px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; font-size: 14px; font-weight: 500; text-decoration: none; transition: background .15s; }
  .submit { justify-content: space-between; border-color: var(--accent); background: var(--accent); color: var(--bg); }
  .submit:hover { background: var(--accent-bright); }
  .submit:disabled, .passkey-submit:disabled { opacity: .6; cursor: wait; }
  .passkey-submit, .oidc-login { background: var(--panel); color: var(--ink); }
  .passkey-submit:hover, .oidc-login:hover { background: var(--line); }
  .passkey-submit { margin-top: -8px; }
  .oidc-login { margin-top: 10px; }
  .alert { display: flex; align-items: flex-start; gap: 10px; padding: 12px; margin-bottom: 20px; border: 1px solid #ff6b7240; border-radius: 8px; background: #ff6b7210; color: #ffb1b5; font-size: 13px; }
  .alert > span { font-weight: 700; }
  .alert p { margin: 0; }
  .trust { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; border-top: 1px solid var(--line); margin-top: 24px; padding-top: 16px; color: var(--dim); font-size: 11px; }
  .trust b { font-weight: 500; }
  @media (max-width: 800px) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    .manifest { padding: 24px; border-right: 0; border-bottom: 1px solid var(--line); }
    .copy, .system-note { display: none; }
    .entry { padding: 32px 24px; }
  }
  @media (max-width: 440px) {
    .manifest { padding: 20px 24px; }
    .entry { padding: 28px 24px; }
    input:not([type="hidden"]) { font-size: 16px; }
  }
`
