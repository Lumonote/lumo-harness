import { AUTHENTICATED_APP_HOME } from './app-home.ts'
import { loginStyles } from './login-styles.ts'
import { puzzleScript } from './login-puzzle.ts'

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
    <header class="mast"><svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#edb37d"/><path d="M9 7v17h15v-5H14V7z" fill="#23251f"/></svg><b>Lumo Harness</b><span class="mast-divider"></span><span>工作台</span></header>
    <section class="entry">
      <div class="card">
        <header class="card-head"><h1>登录工作台</h1><p>使用你的 Lumo 账号继续。</p></header>
        ${message}
        <form method="post" action="/auth/login" id="login-form">
          <div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" maxlength="128" placeholder="输入用户名" required autofocus></div>
          <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" placeholder="输入密码" required></div>
          <div class="field"><label for="mfa">动态验证码 <small>启用 MFA 时填写</small></label><input id="mfa" name="mfa" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="输入 6 位验证码"></div>
          <input type="hidden" id="captcha" name="captcha" autocomplete="off">
          <button class="submit" id="submit" type="submit">登录</button>
          <button class="passkey-submit" id="passkey-submit" type="button">使用 Passkey 登录</button>
        </form>
        ${options.oidcEnabled ? '<a class="oidc-login" href="/auth/oidc/start">使用企业账号登录</a>' : ''}
        <p id="login-status" role="status" aria-live="polite"></p>
        <noscript>请启用 JavaScript 以完成登录验证。</noscript>
      </div>
    </section>
  </main>
  <dialog id="puzzle" aria-labelledby="puzzle-title" aria-describedby="puzzle-status">
    <header class="dialog-head"><h2 id="puzzle-title">拖动验证</h2><button type="button" id="puzzle-close" aria-label="取消验证" title="取消验证">×</button></header>
    <p id="puzzle-status" role="status"></p>
    <div id="board"><img id="scene" alt="带菱形缺口的图案"><button id="piece" type="button" aria-label="移动拼块，方向键微调后确认" disabled><span></span></button></div>
    <footer><button type="button" id="refresh">换一张</button><button type="button" class="submit" id="confirm" disabled>确认并登录</button></footer>
  </dialog>
</body>
</html>`
}

export const loginScript = `(() => {
  ${puzzleScript}
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
  async function passkeyLogin(answer) {
    const username = document.getElementById('username').value.trim();
    try {
      const optionsResponse = await fetch('/auth/passkey/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, captcha_code: answer }) });
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
      status.textContent = error instanceof Error ? error.message : 'Passkey 登录失败，请重试';
    } finally { busy = false; submit.disabled = passkeySubmit.disabled = false; }
  }
})();`
