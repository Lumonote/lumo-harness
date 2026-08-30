export const LOGIN_THEME_IDS = ['obsidian-signal', 'ember-foundry', 'orbital-glass', 'infrared-grid'] as const
export type LoginTheme = typeof LOGIN_THEME_IDS[number]

/** Accept only the built-in product themes at the unauthenticated boundary. */
export function resolveLoginTheme(value: string | undefined): LoginTheme {
  return LOGIN_THEME_IDS.includes(value as LoginTheme) ? value as LoginTheme : 'obsidian-signal'
}

export interface LoginPageOptions {
  state?: 'invalid' | 'locked' | 'expired' | 'unavailable' | 'password-changed'
  theme?: LoginTheme
}

const messages: Record<NonNullable<LoginPageOptions['state']>, string> = {
  invalid: '用户名、密码或验证码不正确，请重新完成点选后重试。',
  locked: '连续验证失败次数过多。当前入口已暂时锁定，请稍后再试。',
  expired: '登录状态已失效，请重新验证身份。',
  unavailable: '用户认证服务暂时不可用，请稍后刷新页面。',
  'password-changed': '密码已更新，全部旧会话均已撤销。请使用新密码登录。',
}

/** A standalone, CSP-safe login surface served before the DSH client loads. */
export function loginPage(options: LoginPageOptions = {}): string {
  const message = options.state === undefined ? '' : `<div class="alert" role="alert"><span>!</span><p>${messages[options.state]}</p></div>`
  const theme = resolveLoginTheme(options.theme)
  return `<!doctype html>
<html lang="zh-CN" data-lumo-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Lumo · 身份验证</title>
  <script src="/auth/login.js" defer></script>
  <style>
    :root{--base:#0b0e11;--ink:#eef3f6;--muted:#a4b1bb;--dim:#74818b;--panel:#11161c;--panel-2:#18212a;--line:#2f4656;--mint:#ff914d;--mint-hi:#ffad70;--amber:#f4bd6b;--danger:#ff6b72;--paper:#d9d2bd;color-scheme:dark}
    :root[data-lumo-theme="ember-foundry"]{--base:#100d0b;--ink:#f8eee7;--muted:#c3aaa0;--dim:#89736a;--panel:#181210;--panel-2:#211816;--line:#4e3429;--mint:#f26b3f;--mint-hi:#ff8a61;--amber:#f5bd70;--danger:#ff7474}
    :root[data-lumo-theme="orbital-glass"]{--base:#09111b;--ink:#e8f0fa;--muted:#9fb5c9;--dim:#6f879d;--panel:#0f1b2a;--panel-2:#14263a;--line:#2b4a66;--mint:#69b7ff;--mint-hi:#91ccff;--amber:#f3c46f;--danger:#ff7c86}
    :root[data-lumo-theme="infrared-grid"]{--base:#0e0c12;--ink:#f7edf2;--muted:#c1a9b5;--dim:#8d7180;--panel:#16131b;--panel-2:#201923;--line:#543047;--mint:#ff6685;--mint-hi:#ff8ca2;--amber:#f2bf6d;--danger:#ff7777}
    *{box-sizing:border-box}html,body{min-height:100%;margin:0}body{overflow-x:hidden;background:var(--base);color:var(--ink);font-family:"Avenir Next","Trebuchet MS","Microsoft YaHei",sans-serif}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 74% 9%,color-mix(in srgb,var(--mint) 16%,transparent),transparent 28%),linear-gradient(color-mix(in srgb,var(--mint) 3.5%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--mint) 3.5%,transparent) 1px,transparent 1px);background-size:auto,52px 52px,52px 52px;mask-image:linear-gradient(90deg,transparent,#000 36%,#000)}
    body:after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.22;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.18'/%3E%3C/svg%3E")}
    .shell{position:relative;z-index:1;display:grid;grid-template-columns:minmax(280px,.88fr) minmax(520px,1.12fr);min-height:100vh}
    .manifest{position:relative;display:flex;flex-direction:column;justify-content:space-between;min-height:100vh;padding:42px clamp(34px,6vw,92px);border-right:1px solid var(--line);overflow:hidden}
    .manifest:after{content:"L";position:absolute;right:-28px;bottom:-138px;color:transparent;-webkit-text-stroke:1px rgba(255,145,77,.12);font:440px/.8 Georgia,serif;transform:rotate(-7deg)}
    .brand{display:flex;align-items:center;gap:13px;letter-spacing:.14em;text-transform:uppercase;font:700 11px/1 "SFMono-Regular","Cascadia Mono",monospace}.brand-mark{display:grid;place-items:center;width:38px;height:38px;overflow:hidden;border:1px solid var(--line);border-radius:11px;color:transparent;background:var(--base) url('/branding/logo.png') center/cover no-repeat;box-shadow:0 8px 24px rgba(0,0,0,.24);font-size:0}
    .copy{position:relative;max-width:520px;margin:70px 0}.kicker{display:flex;align-items:center;gap:12px;color:var(--mint);font:700 10px/1 "SFMono-Regular","Cascadia Mono",monospace;letter-spacing:.18em}.kicker:before{content:"";width:38px;height:1px;background:var(--mint)}
    h1{max-width:470px;margin:24px 0 20px;font:400 clamp(48px,6.2vw,92px)/.9 "Bodoni 72","Songti SC","STSong",serif;letter-spacing:-.055em}.copy>p{max-width:440px;margin:0;color:var(--muted);font-size:14px;line-height:1.85}
    .system-note{display:grid;grid-template-columns:auto 1fr;gap:14px;max-width:420px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font:10px/1.7 "SFMono-Regular","Cascadia Mono",monospace}.system-note i{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 5px rgba(255,145,77,.08)}
    .entry{display:grid;place-items:center;min-height:100vh;padding:38px clamp(26px,7vw,112px)}
    .card{width:min(100%,470px);animation:land .7s cubic-bezier(.22,.8,.24,1) both}.card-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.card-head small{display:block;margin-bottom:8px;color:var(--amber);font:700 9px/1 "SFMono-Regular","Cascadia Mono",monospace;letter-spacing:.18em}.card-head h2{margin:0;font:400 34px/1 "Bodoni 72","Songti SC","STSong",serif}.counter{color:var(--dim);font:10px "SFMono-Regular","Cascadia Mono",monospace}
    form{position:relative;padding:30px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(145deg,color-mix(in srgb,var(--panel-2) 96%,transparent),color-mix(in srgb,var(--base) 95%,transparent));box-shadow:0 32px 80px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.025)}
    form:before{content:"";position:absolute;left:-1px;top:30px;width:2px;height:66px;background:linear-gradient(var(--mint),transparent)}
    label{display:block;margin:0 0 9px;color:var(--muted);font:700 10px/1 "SFMono-Regular","Cascadia Mono",monospace;letter-spacing:.08em;text-transform:uppercase}.field{position:relative;margin-bottom:20px}
    input{width:100%;height:48px;border:1px solid #34495a;border-radius:10px;background:#0c1116;color:var(--ink);outline:none;padding:0 14px;font:500 14px "Avenir Next","Trebuchet MS",sans-serif;transition:border-color .2s,box-shadow .2s,background .2s}input::placeholder{color:#667784}input:focus{border-color:var(--mint);background:#111821;box-shadow:0 0 0 3px rgba(255,145,77,.09)}
    .captcha-prompt{margin:0 0 10px;color:var(--ink);font:600 13px/1.6 "Avenir Next","Trebuchet MS",sans-serif}.captcha-prompt b{color:var(--mint);font-variant-numeric:tabular-nums;letter-spacing:.06em}
    .captcha-grid{display:grid;grid-template-columns:repeat(3,64px);grid-template-rows:repeat(3,64px);gap:6px;width:max-content;margin:0 auto 12px}
    .captcha-grid .tile{width:64px;height:64px;padding:0;border:1px solid #45515d;border-radius:10px;background-color:var(--paper);cursor:pointer;transition:border-color .18s,box-shadow .18s,transform .18s}.captcha-grid .tile:hover{border-color:var(--mint)}.captcha-grid .tile.selected{border-color:var(--mint);box-shadow:0 0 0 2px rgba(255,145,77,.35);transform:translateY(-1px)}.captcha-grid .tile:focus-visible{outline:2px solid var(--mint);outline-offset:-3px}
    .captcha-grid .tile[data-order]::after{content:attr(data-order);position:absolute;top:-7px;right:-7px;display:grid;place-items:center;width:19px;height:19px;border-radius:50%;background:var(--mint);color:#0b0e11;font:800 10px/1 "SFMono-Regular","Cascadia Mono",monospace;box-shadow:0 2px 8px rgba(0,0,0,.35)}.captcha-grid .tile{position:relative}
    .captcha-tools{display:flex;align-items:center;justify-content:space-between;margin:-6px 0 0;color:var(--dim);font:10px/1 "SFMono-Regular","Cascadia Mono",monospace}.captcha-refresh{border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);padding:7px 12px;cursor:pointer;font:600 10px/1 "SFMono-Regular","Cascadia Mono",monospace;letter-spacing:.06em}.captcha-refresh:hover{border-color:var(--mint);color:var(--mint)}
    .hint{display:flex;align-items:center;gap:8px;margin:-8px 0 22px;color:var(--dim);font-size:10px}.hint:before{content:"↻";color:var(--amber)}
    .submit{display:flex;align-items:center;justify-content:space-between;width:100%;height:50px;padding:0 17px;border:1px solid var(--mint);border-radius:10px;background:var(--mint);color:#0b0e11;cursor:pointer;font:800 12px "Avenir Next","Trebuchet MS",sans-serif;letter-spacing:.04em;transition:transform .18s,box-shadow .18s,filter .18s}.submit:hover{transform:translateY(-2px);box-shadow:0 12px 26px rgba(255,145,77,.18)}.submit:disabled{cursor:wait;filter:saturate(.45);transform:none}.submit span:last-child{font-size:18px;font-weight:400}
    .alert{display:grid;grid-template-columns:24px 1fr;gap:10px;margin:0 0 14px;padding:12px 13px;border:1px solid rgba(241,153,136,.28);border-radius:10px;background:rgba(130,48,42,.12);color:#efb2a6}.alert span{display:grid;place-items:center;width:20px;height:20px;border:1px solid currentColor;border-radius:50%;font:700 11px Georgia,serif}.alert p{margin:1px 0 0;font-size:11px;line-height:1.55}
    .trust{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:18px;color:var(--dim);font:9px/1.5 "SFMono-Regular","Cascadia Mono",monospace}.trust b{color:var(--muted);font-weight:500}
    @keyframes land{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
    @media(max-width:880px){.shell{grid-template-columns:1fr}.manifest{min-height:auto;padding:26px 24px;border-right:0;border-bottom:1px solid var(--line)}.copy{margin:70px 0 22px}.copy>p,.system-note{display:none}h1{max-width:350px;font-size:54px}.entry{min-height:auto;padding:42px 20px 60px}.card{max-width:500px}}
    @media(max-width:520px){.manifest{padding:22px 18px}.copy{margin:48px 0 10px}h1{font-size:44px}.entry{padding:32px 14px 48px}.card-head{padding:0 5px}form{padding:24px 18px}.trust{align-items:flex-start;flex-direction:column;gap:5px}}
    @media(prefers-reduced-motion:reduce){.card{animation:none}.submit{transition:none}}
  </style>
</head>
<body>
  <main class="shell">
    <section class="manifest" aria-label="Lumo 平台说明">
      <div class="brand"><span class="brand-mark">L</span><span>Lumo Harness</span></div>
      <div class="copy"><span class="kicker">IDENTITY GATE / 01</span><h1>回到你的<br>智能工作台</h1><p>用户身份、组织归属与权限由 Lumo 用户治理组件统一校验。通过验证后，身份会以短期签名断言进入每一次工作台请求。</p></div>
      <div class="system-note"><i></i><span>GOVERNANCE USER AUTHORITY<br>SESSION · RBAC · AUDIT</span></div>
    </section>
    <section class="entry">
      <div class="card">
        <header class="card-head"><div><small>SECURE ACCESS</small><h2>身份验证</h2></div><span class="counter">01 / 01</span></header>
        ${message}
        <form method="post" action="/auth/login" id="login-form">
          <div class="field"><label for="username">用户账号</label><input id="username" name="username" autocomplete="username" maxlength="128" placeholder="输入账号" required autofocus></div>
          <div class="field"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" placeholder="输入密码" required></div>
          <div class="field"><label for="captcha">交互验证</label><p class="captcha-prompt" id="captcha-prompt">正在加载验证码…</p><div class="captcha-grid" id="captcha-grid" role="group" aria-label="按提示顺序点击数字"><button type="button" class="tile" data-index="0" aria-label="第 1 格"></button><button type="button" class="tile" data-index="1" aria-label="第 2 格"></button><button type="button" class="tile" data-index="2" aria-label="第 3 格"></button><button type="button" class="tile" data-index="3" aria-label="第 4 格"></button><button type="button" class="tile" data-index="4" aria-label="第 5 格"></button><button type="button" class="tile" data-index="5" aria-label="第 6 格"></button><button type="button" class="tile" data-index="6" aria-label="第 7 格"></button><button type="button" class="tile" data-index="7" aria-label="第 8 格"></button><button type="button" class="tile" data-index="8" aria-label="第 9 格"></button></div><input type="hidden" id="captcha" name="captcha" autocomplete="off" required><div class="captcha-tools"><span id="captcha-count">已选 0 / 3</span><button type="button" class="captcha-refresh" id="captcha-refresh">换一张</button></div></div>
          <div class="hint">按提示顺序点击数字，每张验证码仅可使用一次</div>
          <button class="submit" id="submit" type="submit"><span>进入 Lumo</span><span>→</span></button>
        </form>
        <footer class="trust"><span>受保护的本地入口</span><b>HTTPONLY · SAMESITE · ONE-TIME CAPTCHA</b></footer>
      </div>
    </section>
  </main>
</body>
</html>`
}

export const loginScript = `(() => {
  const grid = document.getElementById('captcha-grid');
  const promptEl = document.getElementById('captcha-prompt');
  const countEl = document.getElementById('captcha-count');
  const input = document.getElementById('captcha');
  const refresh = document.getElementById('captcha-refresh');
  const form = document.getElementById('login-form');
  const submit = document.getElementById('submit');
  let sequence = [];
  const renderPrompt = (digits) => {
    if (promptEl) promptEl.innerHTML = '请按顺序点击：<b>' + digits.split('').join(' \u2192 ') + '</b>';
  };
  const renderImage = (imageBase64) => {
    const url = 'data:image/png;base64,' + imageBase64;
    grid.querySelectorAll('.tile').forEach((tile, index) => {
      const col = index % 3, row = Math.floor(index / 3);
      tile.style.backgroundImage = 'url(' + url + ')';
      tile.style.backgroundSize = '192px 192px';
      tile.style.backgroundPosition = (-col * 64) + 'px ' + (-row * 64) + 'px';
    });
  };
  const updateState = () => {
    if (input) input.value = sequence.join('');
    if (countEl) countEl.textContent = '已选 ' + sequence.length + ' / 3';
    grid.querySelectorAll('.tile').forEach((tile, index) => {
      const at = sequence.indexOf(index);
      tile.classList.toggle('selected', at >= 0);
      if (at >= 0) tile.dataset.order = String(at + 1);
      else delete tile.dataset.order;
      tile.setAttribute('aria-pressed', at >= 0 ? 'true' : 'false');
    });
  };
  const load = async () => {
    if (promptEl) promptEl.textContent = '正在加载验证码\u2026';
    try {
      const response = await fetch('/auth/captcha?t=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('captcha ' + response.status);
      const data = await response.json();
      sequence = [];
      renderImage(data.image);
      renderPrompt(data.prompt);
      updateState();
    } catch (error) {
      if (promptEl) promptEl.textContent = '验证码加载失败，请点击「换一张」重试';
    }
  };
  grid.querySelectorAll('.tile').forEach((tile) => tile.addEventListener('click', () => {
    const index = Number(tile.dataset.index);
    const at = sequence.indexOf(index);
    if (at >= 0) sequence.splice(at, 1);
    else if (sequence.length < 3) sequence.push(index);
    updateState();
  }));
  refresh.addEventListener('click', load);
  form.addEventListener('submit', (event) => {
    if (sequence.length < 3) {
      event.preventDefault();
      if (promptEl) promptEl.textContent = '请先按顺序点击验证码中的数字';
      return;
    }
    if (submit) { submit.disabled = true; submit.firstElementChild.textContent = '正在验证\u2026'; }
  });
  load();
})();`
