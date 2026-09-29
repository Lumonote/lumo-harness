import { AUTHENTICATED_APP_HOME } from './app-home.ts'
import { loginStyles } from './login-styles.ts'

export const LOGIN_THEME_IDS = ['obsidian-signal', 'ember-foundry', 'orbital-glass', 'infrared-grid'] as const
export type LoginTheme = typeof LOGIN_THEME_IDS[number]

/** Accept only the built-in product themes at the unauthenticated boundary. */
export function resolveLoginTheme(value: string | undefined): LoginTheme {
  return LOGIN_THEME_IDS.includes(value as LoginTheme) ? value as LoginTheme : 'obsidian-signal'
}

export interface LoginPageOptions {
  state?: 'invalid' | 'locked' | 'expired' | 'unavailable' | 'password-changed' | 'oidc-failed'
  theme?: LoginTheme
  oidcEnabled?: boolean
}

const messages: Record<NonNullable<LoginPageOptions['state']>, string> = {
  invalid: '账号、密码或验证码不正确，请检查后重试。',
  locked: '登录尝试次数过多，请稍后重试。',
  expired: '登录状态已过期，请重新登录。',
  unavailable: '认证服务暂时不可用，请稍后重试。',
  'password-changed': '密码已更新，旧会话已失效。请使用新密码重新登录。',
  'oidc-failed': '企业账号登录未完成。请重试，或联系管理员确认账号权限。',
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
  <style>${loginStyles}</style>
</head>
<body>
  <main class="shell">
    <section class="manifest" aria-label="Lumo 平台说明">
      <div class="scene" aria-hidden="true">
        <div class="scene-grid"></div>
        <svg class="scene-wires" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice">
          <path d="M-20 533 C115 431 178 488 287 383 S508 270 801 347" />
          <path d="M19 177 C177 293 192 191 344 307 S571 538 828 476" />
          <path d="M124 800 C166 604 350 687 459 536 S684 321 822 151" />
          <circle cx="184" cy="454" r="3" /><circle cx="287" cy="383" r="2" />
          <circle cx="671" cy="332" r="3" /><circle cx="621" cy="470" r="2" />
        </svg>
        <div class="orbit orbit-outer"></div>
        <div class="orbit orbit-mid"></div>
        <div class="orbit orbit-inner"></div>
        <div class="core-halo"></div>
        <div class="core"><span class="core-mark"></span></div>
        <div class="scanner"></div>
      </div>
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Lumo Harness<small>智能协作工作台</small></span></div>
      <div class="copy"><span class="kicker">AGENTIC WORKSPACE / LUMO</span><h1>进入你的<br><em>智能协作空间</em></h1><p>在一个工作台中衔接智能体、任务与产物。使用平台账号登录，继续上次的工作。</p></div>
      <div class="system-note"><i></i><span>智能体 · 任务 · 产物</span></div>
    </section>
    <section class="entry">
      <div class="card">
        <header class="card-head"><div><small>LUMO / ACCOUNT ACCESS</small><h2>欢迎回来</h2><p class="card-subtitle">登录后继续使用你的工作台</p></div></header>
        ${message}
        <form method="post" action="/auth/login" id="login-form">
          <div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" maxlength="128" placeholder="输入用户名" required autofocus></div>
          <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" placeholder="输入密码" required></div>
          <div class="field"><label for="mfa">动态验证码 <small>启用 MFA 时填写</small></label><input id="mfa" name="mfa" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="输入 6 位验证码"></div>
          <div class="field"><label for="captcha">交互验证</label><p class="captcha-prompt" id="captcha-prompt">正在加载验证码…</p><div class="captcha-grid" id="captcha-grid" role="group" aria-label="按提示顺序点击数字"><button type="button" class="tile" data-index="0" aria-label="第 1 格"></button><button type="button" class="tile" data-index="1" aria-label="第 2 格"></button><button type="button" class="tile" data-index="2" aria-label="第 3 格"></button><button type="button" class="tile" data-index="3" aria-label="第 4 格"></button><button type="button" class="tile" data-index="4" aria-label="第 5 格"></button><button type="button" class="tile" data-index="5" aria-label="第 6 格"></button><button type="button" class="tile" data-index="6" aria-label="第 7 格"></button><button type="button" class="tile" data-index="7" aria-label="第 8 格"></button><button type="button" class="tile" data-index="8" aria-label="第 9 格"></button></div><input type="hidden" id="captcha" name="captcha" autocomplete="off" required><div class="captcha-tools"><span id="captcha-count">已选 0 / 3</span><button type="button" class="captcha-refresh" id="captcha-refresh">换一张</button></div></div>
          <div class="hint">按上方提示顺序点击数字</div>
          <button class="submit" id="submit" type="submit"><span>进入工作台</span><span>→</span></button>
          <button class="passkey-submit" id="passkey-submit" type="button">使用 Passkey 登录</button>
        </form>
        ${options.oidcEnabled ? '<a class="oidc-login" href="/auth/oidc/start">使用企业账号登录</a>' : ''}
        <footer class="trust"><span>登录需完成图形验证</span><b>Lumo Harness</b></footer>
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
  const passkeySubmit = document.getElementById('passkey-submit');
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
  const b64url = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let value = '';
    bytes.forEach((byte) => { value += String.fromCharCode(byte); });
    return btoa(value).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  };
  const bytes = (value) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  };
  const passkeyOptions = (source) => ({
    challenge: bytes(source.challenge), rpId: source.rp_id,
    timeout: source.timeout, userVerification: source.user_verification,
    allowCredentials: (source.allow_credentials || []).map((credential) => ({ type: credential.type, id: bytes(credential.id) })),
  });
  passkeySubmit.addEventListener('click', async () => {
    const username = document.getElementById('username').value.trim();
    if (!window.PublicKeyCredential) { if (promptEl) promptEl.textContent = '当前浏览器不支持 Passkey。'; return; }
    if (!username || sequence.length < 3) { if (promptEl) promptEl.textContent = '请输入账号并完成点选验证码后使用 Passkey。'; return; }
    passkeySubmit.disabled = true;
    try {
      const optionsResponse = await fetch('/auth/passkey/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, captcha_code: sequence.join('') }) });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok || !options.public_key) throw new Error(options.message || 'Passkey 登录不可用');
      const credential = await navigator.credentials.get({ publicKey: passkeyOptions(options.public_key) });
      if (!credential || credential.type !== 'public-key') throw new Error('未获得 Passkey 凭据');
      const response = credential.response;
      const finish = await fetch('/auth/passkey/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        challenge: options.public_key.challenge, id: credential.id, raw_id: b64url(credential.rawId), type: credential.type,
        client_data_json: b64url(response.clientDataJSON), authenticator_data: b64url(response.authenticatorData), signature: b64url(response.signature),
      }) });
      const body = await finish.json();
      if (!finish.ok) throw new Error(body.message || 'Passkey 验证失败');
      location.assign(${JSON.stringify(AUTHENTICATED_APP_HOME)});
    } catch (error) {
      if (promptEl) promptEl.textContent = error instanceof Error ? error.message : 'Passkey 登录失败，请重新获取验证码后重试';
      load();
    } finally { passkeySubmit.disabled = false; }
  });
  load();
})();`
