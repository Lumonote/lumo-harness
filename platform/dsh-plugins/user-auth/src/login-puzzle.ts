/** Included in the same-origin login.js; the browser never receives a target coordinate. */
export const puzzleScript = `
  const el = id => document.getElementById(id);
  const dialog = el('puzzle'), board = el('board'), piece = el('piece'), scene = el('scene');
  const confirm = el('confirm'), refresh = el('refresh'), hint = el('puzzle-status');
  const form = el('login-form'), submit = el('submit'), passkeySubmit = el('passkey-submit'), status = el('login-status');
  let mode, pending, timer, busy = false, x, y, drag;
  function reset() {
    pending?.abort(); pending = undefined; clearTimeout(timer); drag = undefined;
    confirm.disabled = piece.disabled = true; el('captcha').value = ''; scene.removeAttribute('src');
    x = 2; y = 13; position(x,y);
  }
  function position(col,row) {
    x = Math.max(2,Math.min(40,col)); y = Math.max(2,Math.min(24,row));
    piece.style.left = x*100/42+'%'; piece.style.top = y*100/26+'%';
  }
  async function load() {
    reset(); const request = pending = new AbortController();
    refresh.disabled = true; hint.textContent = '正在加载拼图…';
    try {
      const result = await fetch('/auth/captcha?kind=puzzle', { cache:'no-store', signal:request.signal });
      if (!result.ok) throw Error();
      const data = await result.json();
      if (request !== pending) return;
      if (data.prompt !== 'puzzle-v1' || !data.image || !(data.expires_in > 0)) throw Error();
      scene.src = 'data:image/png;base64,'+data.image; await scene.decode();
      if (request !== pending) return;
      piece.disabled = false; hint.textContent = '将菱形拼块拖到图中的缺口。'; piece.focus();
      timer = setTimeout(() => { reset(); hint.textContent = '拼图已过期，请换一张。'; }, data.expires_in*1000);
    } catch { if (request === pending) hint.textContent = '拼图加载失败，请换一张重试。'; }
    finally { if (request === pending) refresh.disabled = false; }
  }
  function openPuzzle(next) {
    if (busy || dialog.open) return;
    mode = next; status.textContent = ''; dialog.showModal(); void load();
  }
  form.addEventListener('submit', event => { event.preventDefault(); openPuzzle('password'); });
  passkeySubmit.addEventListener('click', () => {
    if (!window.PublicKeyCredential) {status.textContent = '当前浏览器不支持 Passkey。'; return;}
    if (el('username').reportValidity()) openPuzzle('passkey');
  });
  el('puzzle-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  refresh.onclick = load;
  piece.addEventListener('pointerdown', e => {
    if (piece.disabled || drag || e.button !== 0) return;
    const b=board.getBoundingClientRect();
    drag={ id:e.pointerId, dx:(e.clientX-b.left)*42/b.width-x, dy:(e.clientY-b.top)*26/b.height-y };
    piece.setPointerCapture(e.pointerId);
  });
  piece.addEventListener('pointermove', e => {
    if (drag?.id !== e.pointerId) return;
    const b=board.getBoundingClientRect();
    position(Math.round((e.clientX-b.left)*42/b.width-drag.dx),Math.round((e.clientY-b.top)*26/b.height-drag.dy));
    confirm.disabled = (x === 2 && y === 13);
  });
  piece.addEventListener('lostpointercapture', () => { drag=undefined; });
  piece.addEventListener('keydown', e => {
    const delta = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if (delta) { e.preventDefault(); position(x+delta[0], y+delta[1]); confirm.disabled = (x === 2 && y === 13); }
  });
  confirm.onclick = () => {
    if (busy || piece.disabled || confirm.disabled) return;
    const answer = 'p:'+x+':'+y; dialog.close();
    if (mode === 'password' && !form.reportValidity()) return;
    busy = true; submit.disabled = passkeySubmit.disabled = true; status.textContent = '正在验证…';
    if (mode === 'passkey') void passkeyLogin(answer);
    else { el('captcha').value = answer; HTMLFormElement.prototype.submit.call(form); }
  };
  window.addEventListener('pageshow', e => { if(e.persisted){busy=false; submit.disabled=passkeySubmit.disabled=false; status.textContent=''; if(dialog.open)dialog.close(); reset();} });
`
