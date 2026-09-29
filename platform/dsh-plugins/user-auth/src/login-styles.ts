/** Self-contained CSS for the unauthenticated login page. */
export const loginStyles = `
  :root {
    --bg: #060c15;
    --panel: #101b29;
    --panel-raised: #152335;
    --ink: #f2f8ff;
    --muted: #a3b6c6;
    --dim: #71899d;
    --line: rgba(149, 191, 216, .18);
    --accent: #70ddf4;
    --accent-bright: #a9f4ff;
    --accent-soft: rgba(80, 210, 239, .26);
    --accent-rgb: 80, 210, 239;
    --paper: #d9d2bd;
    color-scheme: dark;
  }
  :root[data-lumo-theme="ember-foundry"] {
    --accent: #ffa46f; --accent-bright: #ffd1a0;
    --accent-soft: rgba(255, 159, 105, .24); --accent-rgb: 255, 159, 105;
  }
  :root[data-lumo-theme="orbital-glass"] {
    --accent: #91b7ff; --accent-bright: #c5d8ff;
    --accent-soft: rgba(130, 171, 255, .25); --accent-rgb: 130, 171, 255;
  }
  :root[data-lumo-theme="infrared-grid"] {
    --accent: #ff7799; --accent-bright: #ffc0cf;
    --accent-soft: rgba(255, 100, 143, .25); --accent-rgb: 255, 100, 143;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body {
    overflow-x: hidden;
    background: var(--bg);
    color: var(--ink);
    font-family: "Avenir Next", "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  button, input { font: inherit; }
  .shell {
    display: grid;
    grid-template-columns: minmax(0, 1.06fr) minmax(500px, .94fr);
    min-height: 100vh;
    min-height: 100svh;
  }
  .manifest {
    position: sticky;
    top: 0;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 100vh;
    height: 100svh;
    min-height: 680px;
    padding: 38px clamp(32px, 5vw, 84px) 35px;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 55% 37%, rgba(var(--accent-rgb), .11), transparent 39%),
      radial-gradient(ellipse at -20% 100%, rgba(58, 93, 192, .16), transparent 56%),
      #06101b;
  }
  .manifest:before {
    content: "";
    position: absolute;
    z-index: -1;
    inset: 0;
    background: linear-gradient(90deg, transparent 92%, rgba(var(--accent-rgb), .09) 100%);
    pointer-events: none;
  }
  .scene {
    position: absolute;
    z-index: 0;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .scene-grid {
    position: absolute;
    inset: -10%;
    opacity: .48;
    background-image:
      linear-gradient(rgba(112, 184, 220, .07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(112, 184, 220, .07) 1px, transparent 1px);
    background-size: 54px 54px;
    transform: perspective(600px) rotateX(13deg) scale(1.12);
    mask-image: radial-gradient(circle at 54% 44%, #000 3%, transparent 71%);
  }
  .scene-wires {
    position: absolute;
    top: 2%; left: -3%;
    width: 110%; height: 93%;
    overflow: visible;
    opacity: .7;
  }
  .scene-wires path {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1;
    stroke-dasharray: 3 10;
    opacity: .39;
    animation: wire-flow 24s linear infinite;
  }
  .scene-wires path:nth-child(2) { animation-duration: 30s; animation-direction: reverse; opacity: .25; }
  .scene-wires path:nth-child(3) { animation-duration: 18s; opacity: .18; }
  .scene-wires circle { fill: var(--accent-bright); filter: drop-shadow(0 0 9px var(--accent)); }
  .orbit {
    position: absolute;
    top: 45%; left: 54%;
    translate: -50% -50%;
    border: 1px solid rgba(var(--accent-rgb), .27);
    border-radius: 50%;
    box-shadow: 0 0 45px rgba(var(--accent-rgb), .045), inset 0 0 38px rgba(var(--accent-rgb), .035);
  }
  .orbit:before, .orbit:after {
    content: "";
    position: absolute;
    border-radius: 50%;
  }
  .orbit:before {
    top: -4px; left: 50%;
    width: 7px; height: 7px;
    background: var(--accent-bright);
    box-shadow: 0 0 8px 3px rgba(var(--accent-rgb), .65), 0 0 32px 9px rgba(var(--accent-rgb), .23);
  }
  .orbit:after {
    inset: 8px;
    border: 1px dashed rgba(var(--accent-rgb), .15);
  }
  .orbit-outer {
    width: min(74vw, 620px); height: min(74vw, 620px);
    border-color: rgba(var(--accent-rgb), .18);
    animation: orbit-clockwise 34s linear infinite;
  }
  .orbit-mid {
    width: min(58vw, 475px); height: min(58vw, 475px);
    border-color: rgba(var(--accent-rgb), .42);
    animation: orbit-counter 21s linear infinite;
  }
  .orbit-inner {
    width: min(42vw, 340px); height: min(42vw, 340px);
    border-color: rgba(var(--accent-rgb), .25);
    animation: orbit-clockwise 15s linear infinite;
  }
  .orbit-mid:before { width: 5px; height: 5px; }
  .orbit-inner:before { width: 4px; height: 4px; }
  .core-halo {
    position: absolute;
    top: 45%; left: 54%;
    width: 310px; height: 310px;
    translate: -50% -50%;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(var(--accent-rgb), .19), rgba(var(--accent-rgb), .055) 36%, transparent 68%);
    filter: blur(14px);
    animation: halo-breathe 6s ease-in-out infinite;
  }
  .core {
    position: absolute;
    top: 45%; left: 54%;
    display: grid;
    place-items: center;
    width: 224px; height: 224px;
    translate: -50% -50%;
    border: 1px solid rgba(var(--accent-rgb), .56);
    border-radius: 50%;
    background:
      radial-gradient(circle at 43% 39%, rgba(231, 253, 255, .42), transparent 9%),
      radial-gradient(circle at 51% 53%, rgba(var(--accent-rgb), .55), rgba(29, 93, 128, .24) 28%, rgba(4, 22, 42, .84) 57%, rgba(5, 13, 28, .94) 72%),
      conic-gradient(from 35deg, transparent, rgba(var(--accent-rgb), .65), transparent 42%, rgba(var(--accent-rgb), .24), transparent 80%);
    box-shadow: 0 0 70px rgba(var(--accent-rgb), .2), inset 0 0 35px rgba(var(--accent-rgb), .25);
    animation: core-breathe 5.5s ease-in-out infinite;
  }
  .core:before, .core:after { content: ""; position: absolute; border-radius: 50%; }
  .core:before {
    inset: 14px;
    border: 1px solid rgba(var(--accent-rgb), .28);
    border-top-color: var(--accent-bright);
    border-bottom-color: rgba(var(--accent-rgb), .03);
    animation: orbit-clockwise 8s linear infinite;
  }
  .core:after {
    inset: 32px;
    border: 1px dashed rgba(var(--accent-rgb), .22);
    animation: orbit-counter 13s linear infinite;
  }
  .core-mark {
    position: relative;
    width: 47px; height: 47px;
    border: 1px solid rgba(209, 249, 255, .7);
    border-radius: 15px;
    transform: rotate(45deg);
    box-shadow: 0 0 20px rgba(var(--accent-rgb), .72), inset 0 0 22px rgba(var(--accent-rgb), .37);
  }
  .core-mark:before, .core-mark:after {
    content: "";
    position: absolute;
    inset: 10px;
    border: 1px solid rgba(230, 253, 255, .78);
    border-radius: 7px;
  }
  .core-mark:after { inset: 18px; border: 0; background: #eaffff; box-shadow: 0 0 15px 7px var(--accent); }
  .scanner {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 0%, transparent 47%, rgba(var(--accent-rgb), .08) 50%, transparent 53%, transparent 100%);
    background-size: 100% 180%;
    animation: scan 11s linear infinite;
  }
  .brand { position: relative; z-index: 2; display: flex; align-items: center; gap: 13px; font-size: 17px; font-weight: 700; letter-spacing: -.02em; }
  .brand-mark { display: block; width: 42px; height: 42px; border-radius: 50%; background: #4969fb url('/branding/logo.png') center / cover no-repeat; box-shadow: 0 0 0 1px rgba(231, 248, 255, .35), 0 0 30px rgba(67, 101, 245, .32); font-size: 0; }
  .brand small { display: block; margin-top: 3px; color: var(--dim); font: 10px/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .15em; text-transform: uppercase; }
  .copy { position: relative; z-index: 2; margin: auto 0 48px; max-width: 620px; }
  .kicker { display: inline-flex; align-items: center; gap: 10px; color: var(--accent-bright); font: 600 11px/1.3 "SFMono-Regular", Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; }
  .kicker:before { content: ""; width: 27px; height: 1px; background: var(--accent); box-shadow: 0 0 13px var(--accent); }
  h1 { margin: 20px 0 19px; font-size: clamp(45px, 5vw, 78px); font-weight: 650; line-height: 1.16; letter-spacing: -.065em; text-shadow: 0 2px 34px rgba(0, 0, 0, .22); }
  h1 em { color: var(--accent-bright); font-style: normal; }
  .copy > p { max-width: 480px; margin: 0; color: #bbccda; font-size: 15px; line-height: 1.85; }
  .system-note { position: relative; z-index: 2; display: flex; align-items: center; gap: 9px; padding-top: 15px; border-top: 1px solid rgba(148, 194, 219, .17); color: #839db0; font: 11px/1.5 "SFMono-Regular", Consolas, monospace; letter-spacing: .04em; }
  .system-note i { width: 6px; height: 6px; border-radius: 50%; background: #9be9cc; box-shadow: 0 0 12px #9be9cc; animation: status-pulse 2.5s ease-in-out infinite; }
  .entry { position: relative; display: grid; place-items: center; min-width: 0; min-height: 100vh; min-height: 100svh; padding: 40px clamp(34px, 5.5vw, 92px); background: radial-gradient(ellipse at 80% 0, rgba(70, 118, 157, .08), transparent 45%), #0a121d; }
  .entry:before { content: ""; position: absolute; inset: 0 auto 0 0; width: 1px; background: linear-gradient(transparent, rgba(var(--accent-rgb), .31) 37%, rgba(var(--accent-rgb), .08) 72%, transparent); }
  .card { width: min(100%, 460px); animation: card-arrive .7s cubic-bezier(.16, 1, .3, 1) both; }
  .card-head { margin-bottom: 21px; }
  .card-head small { display: block; margin-bottom: 10px; color: var(--accent); font: 650 11px/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .16em; }
  .card-head h2 { margin: 0; font-size: 31px; font-weight: 650; line-height: 1.2; letter-spacing: -.05em; }
  .card-subtitle { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
  form { position: relative; padding: 27px 29px 25px; overflow: hidden; border: 1px solid rgba(122, 182, 214, .22); border-radius: 20px; background: linear-gradient(150deg, rgba(25, 43, 60, .93), rgba(13, 25, 40, .97)); box-shadow: 0 30px 75px rgba(0, 0, 0, .28), inset 0 1px rgba(215, 245, 255, .065); }
  form:before { content: ""; position: absolute; top: 0; left: 20%; width: 60%; height: 1px; background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb), .75), transparent); box-shadow: 0 0 22px rgba(var(--accent-rgb), .5); }
  label { display: block; margin-bottom: 8px; color: #d9e6ef; font-size: 12px; font-weight: 650; line-height: 1.4; }
  label small { margin-left: 6px; color: #899db0; font-size: 10px; font-weight: 450; }
  .field { position: relative; margin-bottom: 16px; }
  input { width: 100%; height: 47px; padding: 0 14px; outline: none; border: 1px solid rgba(147, 185, 211, .22); border-radius: 9px; background: rgba(4, 14, 26, .61); color: var(--ink); font-size: 14px; transition: border-color .18s, box-shadow .18s, background .18s; }
  input::placeholder { color: #6b8295; }
  input:focus { border-color: var(--accent); background: rgba(5, 20, 34, .9); box-shadow: 0 0 0 3px var(--accent-soft); }
  .captcha-prompt { margin: 0 0 10px; color: #c4d5e2; font-size: 13px; line-height: 1.5; }
  .captcha-prompt b { margin-left: 5px; color: var(--accent-bright); font-variant-numeric: tabular-nums; letter-spacing: .08em; }
  .captcha-grid { display: grid; grid-template-columns: repeat(3, 64px); grid-template-rows: repeat(3, 64px); gap: 5px; width: max-content; margin: 0 auto 11px; }
  .captcha-grid .tile { position: relative; width: 64px; height: 64px; padding: 0; border: 1px solid rgba(193, 221, 233, .25); border-radius: 8px; background-color: var(--paper); cursor: pointer; transition: border-color .16s, box-shadow .16s, transform .16s; }
  .captcha-grid .tile:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 0 17px rgba(var(--accent-rgb), .27); }
  .captcha-grid .tile.selected { border: 2px solid var(--accent-bright); box-shadow: 0 0 0 2px var(--accent-soft), 0 0 16px rgba(var(--accent-rgb), .25); }
  .captcha-grid .tile:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 2px; }
  .captcha-grid .tile[data-order]::after { content: attr(data-order); position: absolute; top: -7px; right: -7px; display: grid; place-items: center; width: 20px; height: 20px; border: 2px solid #122338; border-radius: 50%; background: var(--accent-bright); color: #081925; font-size: 10px; font-weight: 750; box-shadow: 0 0 10px rgba(var(--accent-rgb), .6); }
  .captcha-tools { display: flex; align-items: center; justify-content: space-between; color: var(--dim); font-size: 11px; }
  .captcha-refresh { min-height: 30px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 7px; background: rgba(10, 28, 43, .5); color: #c9dbe8; cursor: pointer; font-size: 11px; }
  .captcha-refresh:hover { border-color: var(--accent); color: var(--accent-bright); }
  .hint { margin: -4px 0 15px; color: #879bad; font-size: 10px; line-height: 1.5; }
  .submit { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 49px; padding: 0 17px; border: 1px solid var(--accent-bright); border-radius: 9px; background: var(--accent-bright); color: #08202a; cursor: pointer; font-size: 13px; font-weight: 750; transition: transform .17s, box-shadow .17s, filter .17s; }
  .submit:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(var(--accent-rgb), .27); filter: brightness(1.08); }
  .submit:disabled { cursor: wait; opacity: .62; transform: none; }
  .submit span:last-child { font-size: 18px; font-weight: 400; }
  .passkey-submit { width: 100%; height: 42px; margin-top: 9px; border: 1px solid var(--line); border-radius: 9px; background: rgba(6, 20, 33, .35); color: #d8e9f1; cursor: pointer; font-size: 12px; font-weight: 600; }
  .passkey-submit:hover { border-color: var(--accent); color: var(--accent-bright); }
  .passkey-submit:disabled { cursor: wait; opacity: .55; }
  .submit:focus-visible, .passkey-submit:focus-visible, .captcha-refresh:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 3px; }
  .alert { display: grid; grid-template-columns: 20px 1fr; align-items: start; gap: 9px; margin: 0 0 14px; padding: 11px 12px; border: 1px solid rgba(255, 188, 126, .25); border-radius: 9px; background: rgba(152, 90, 45, .14); color: #ffd5ad; }
  .alert span { display: grid; place-items: center; width: 19px; height: 19px; border: 1px solid currentColor; border-radius: 50%; font-size: 11px; font-weight: 700; }
  .alert p { margin: 1px 0 0; font-size: 12px; line-height: 1.5; }
  .trust { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 15px; color: #738ca0; font-size: 10px; line-height: 1.5; }
  .trust b { color: #9db5c8; font-weight: 500; }
  .oidc-login { display: flex; align-items: center; justify-content: center; min-height: 44px; margin-top: 12px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 9px; color: #d7e6f0; font-size: 13px; text-align: center; text-decoration: none; }
  .oidc-login:hover { border-color: var(--accent); color: var(--accent-bright); }
  .oidc-login:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 3px; }
  @keyframes orbit-clockwise { to { transform: rotate(360deg); } }
  @keyframes orbit-counter { to { transform: rotate(-360deg); } }
  @keyframes wire-flow { to { stroke-dashoffset: -260; } }
  @keyframes halo-breathe { 50% { transform: scale(1.13); opacity: .75; } }
  @keyframes core-breathe { 50% { box-shadow: 0 0 100px rgba(var(--accent-rgb), .31), inset 0 0 49px rgba(var(--accent-rgb), .37); } }
  @keyframes scan { to { background-position: 0 180%; } }
  @keyframes status-pulse { 50% { opacity: .4; box-shadow: 0 0 4px #9be9cc; } }
  @keyframes card-arrive { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: none; } }
  @media (max-width: 1120px) {
    .shell { grid-template-columns: minmax(0, .92fr) minmax(470px, 1.08fr); }
    .manifest { padding-inline: 32px; }
    .orbit-outer { width: 500px; height: 500px; }
    .orbit-mid { width: 390px; height: 390px; }
    .orbit-inner { width: 285px; height: 285px; }
  }
  @media (max-width: 900px) {
    .shell { grid-template-columns: 1fr; }
    .manifest { position: relative; height: 360px; min-height: 360px; padding: 20px 26px; }
    .scene { opacity: .65; }
    .scene-grid { opacity: .28; }
    .scene-wires { top: -35%; left: 25%; width: 90%; height: 170%; }
    .orbit, .core, .core-halo { top: 52%; left: 78%; }
    .orbit-outer { width: 370px; height: 370px; }
    .orbit-mid { width: 285px; height: 285px; }
    .orbit-inner { width: 210px; height: 210px; }
    .core { width: 145px; height: 145px; }
    .core-halo { width: 220px; height: 220px; }
    .core-mark { transform: rotate(45deg) scale(.7); }
    .copy { margin: auto 0 12px; max-width: 520px; }
    h1 { font-size: clamp(39px, 6vw, 56px); }
    .copy > p { font-size: 13px; }
    .system-note { display: none; }
    .entry { min-height: auto; padding: 30px 20px 45px; }
  }
  @media (max-width: 580px) {
    .manifest { height: 228px; min-height: 228px; padding: 16px 19px; }
    .brand { font-size: 14px; }
    .brand-mark { width: 34px; height: 34px; }
    .brand small { font-size: 8px; }
    .scene { opacity: .5; }
    .orbit, .core, .core-halo { left: 85%; top: 55%; }
    .orbit-outer { width: 260px; height: 260px; }
    .orbit-mid { width: 205px; height: 205px; }
    .orbit-inner { width: 155px; height: 155px; }
    .core { width: 110px; height: 110px; }
    .core-halo { width: 160px; height: 160px; }
    .core-mark { transform: rotate(45deg) scale(.55); }
    .kicker { font-size: 9px; }
    h1 { margin: 11px 0 8px; font-size: 36px; }
    .copy > p { max-width: 300px; font-size: 11px; line-height: 1.6; }
    .entry { padding: 23px 13px 35px; }
    .card-head { margin: 0 4px 15px; }
    .card-head h2 { font-size: 27px; }
    form { padding: 22px 18px 20px; }
    .field { margin-bottom: 13px; }
    .trust { align-items: flex-start; flex-direction: column; gap: 3px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .orbit, .core, .core:before, .core:after, .core-halo,
    .scene-wires path, .scanner, .system-note i, .card { animation: none !important; }
    *, *:before, *:after { scroll-behavior: auto !important; transition-duration: .01ms !important; }
  }
`
