/** First-party text Session surface; its only business API is the owned transport. */
export const ownedChatHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumo · 我的会话</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#17212f;font:15px/1.65 system-ui,sans-serif}header{height:70px;display:flex;align-items:center;justify-content:space-between;padding:0 32px;background:#fff;border-bottom:1px solid #e4e8ef}header strong{font-size:20px;letter-spacing:-.6px}header a{color:#5c6879;text-decoration:none}main{max-width:1260px;margin:28px auto;display:grid;grid-template-columns:270px minmax(0,1fr);gap:22px;padding:0 24px}aside,section{min-width:0;background:white;border:1px solid #e4e8ef;border-radius:12px;padding:20px}h1{font-size:21px;margin:0 0 6px}p{color:#667286;margin:0 0 18px}button{border:1px solid #d8dfe9;border-radius:7px;padding:9px 14px;background:#fff;color:#263b54;cursor:pointer;font:inherit}.model-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 16px}.model-controls select{font:inherit;max-width:260px;padding:8px;border:1px solid #ccd5e2;border-radius:7px;background:white}.model-controls small{width:100%;color:#667286}button.primary{background:#255ac8;border-color:#255ac8;color:#fff}button:disabled{opacity:.5;cursor:default}#sessions{list-style:none;padding:0;margin:18px 0;max-height:60vh;overflow:auto;scrollbar-gutter:stable}#sessions button{width:100%;margin-bottom:8px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}#sessions button.active{background:#edf3ff;border-color:#8eace9}#history{height:52vh;min-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#fafbfd;border:1px solid #eef1f5;border-radius:8px}.message{margin:0 0 18px}.message strong{display:block;font-size:12px;color:#78849a;margin-bottom:4px}.attachments{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.attachment-chip{max-width:100%;overflow-wrap:anywhere;display:inline-flex;gap:8px;align-items:center;padding:5px 9px;border:1px solid #dae3ee;border-radius:7px;background:#f5f8fd;font-size:12px}.attachment-chip>span{min-width:0}.attachment-chip button{flex-shrink:0;padding:0 4px;border:0;background:transparent}.attachment-upload{margin-top:10px;color:#5c6879;font-size:13px}.attachment-upload input{max-width:100%}.attachment-link{display:inline-block;color:#255ac8;text-decoration:underline;font-size:13px}form{margin-top:18px}textarea{width:100%;min-height:90px;padding:12px;border:1px solid #ccd5e2;border-radius:8px;font:inherit;resize:vertical}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:10px}#status{min-width:0;overflow-wrap:anywhere;color:#667286;font-size:13px;flex:1}.approval-panel{margin-top:16px}.approval-card{padding:16px;border:1px solid #d4def0;border-left:3px solid #255ac8;border-radius:9px;margin:12px 0;background:#f8faff}.approval-card h2{font-size:16px;margin:0 0 8px}.approval-card pre{max-height:310px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;background:white;border:1px solid #e4e8ef;border-radius:6px;padding:12px}.approval-card p{font-size:13px;margin:4px 0 10px}.approval-card button{margin-right:8px}.empty{padding:12px 0;color:#667286;font-size:13px}button:focus-visible,select:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid #255ac8;outline-offset:3px}.error{color:#b32932!important}@media(max-width:750px){main{grid-template-columns:1fr;margin:16px auto;padding:0 12px}header{padding:0 18px}aside{padding:14px}#sessions{max-height:140px;overflow:auto}#history{height:42vh}.model-controls select{max-width:100%}.actions #status{flex-basis:100%}.approval-card button{margin-bottom:8px}}</style><script src="/lumo/chat.js" defer></script></head><body><header><strong>Lumo</strong><a href="/auth/logout" id="logout">退出登录</a></header><main><aside><h1>我的会话</h1><p>独立保存的项目对话</p><button id="create" class="primary">新建会话</button><button id="fork" disabled>创建会话分支</button><button id="refresh-list" type="button">刷新会话列表</button><ul id="sessions" aria-label="我的会话列表"></ul><p id="sessions-empty" class="empty" hidden>还没有会话。新建一个会话，开始项目工作。</p><button id="more" hidden>加载更多</button></aside><section><h1 id="title">选择或新建会话</h1><p>在当前项目中继续对话</p><div class="model-controls"><label for="model-choice">会话模型</label><select id="model-choice" disabled aria-label="会话模型"></select><button id="apply-model" type="button" disabled>切换模型</button><button id="reload" type="button" disabled>重新读取</button><small id="model-state">选择会话后查看当前模型</small></div><div id="history" aria-live="polite"><p class="empty">选择左侧会话，或新建会话开始对话。</p></div><div id="interactions" class="approval-panel" role="region" aria-label="待确认的外部操作"></div><form id="prompt"><textarea id="text" aria-label="消息" placeholder="输入消息，继续你的工作…"></textarea><div id="attachment-controls" class="attachment-upload" hidden><label>添加附件 <input id="attachment-files" type="file" multiple accept=".txt,.md,.csv,.json,image/png,image/jpeg,image/webp,image/gif"></label><button id="cancel-upload" type="button" hidden>取消上传</button><small> UTF-8 文本与常用图片 · 每条消息最多 4 个</small></div><div id="attachments" class="attachments"></div><div class="actions"><span id="status" role="status"></span><button id="cancel" type="button">停止</button><button id="send" class="primary">发送</button></div></form></section></main></body></html>`
export const ownedChatScript = String.raw`(() => {
const $ = id => document.getElementById(id);
let selected = '', cursor = '', generation = 0, modelView = null, modelSaving = false, promptBusy = false, uploadBusy = false, stagedAttachments = [], viewController = new AbortController(), uploadController = null, listing = false;
const answering = new Set();
const current = (id, revision) => selected === id && generation === revision && !viewController.signal.aborted;
const status = (text, error = false) => { $('status').textContent = text; $('status').className = error ? 'error' : ''; };
function report(error) { if (error.name !== 'AbortError') status(error.message || '连接失败，请重新读取。', true); }
async function responseError(res) {
  const body = await res.json().catch(() => ({}));
  const messages = { session_fork_unavailable:'此会话尚无已完成的轮次，暂时无法创建分支。', session_model_busy:'请等待当前轮次和待发送消息完成后再切换模型。', session_model_changed:'模型选择已变化，已重新读取当前配置，请核对后再次选择。', session_model_unavailable:'模型未获批准或费率不可用，请联系管理员。', session_connector_denied:'外部操作未获当前权限授权，请检查项目与连接器权限。', session_connector_changed:'审批已变化或已过期，请重新读取并核对操作审计。', session_connector_unavailable:'连接器服务暂不可用，请稍后重新读取。', session_connector_busy:'连接器请求较多，请稍后重试。', connector_outcome_unknown:'外部操作结果未知，请先核对操作审计，勿直接重试。', storage_quota_exceeded:'项目存储配额已用尽，请清理文件或联系管理员调整配额后再上传。', session_attachment_invalid:'附件名称或内容无效，请检查文件后上传。', session_attachment_unsupported:'文件类型或编码不受支持，请使用 UTF-8 文本或常用图片。', session_attachment_too_large:'附件超过上传大小限制，请缩小文件后上传。', session_attachment_busy:'附件传输较多，请稍后重试。', session_attachment_denied:'当前会话无附件访问权限，请检查登录状态与项目权限。', session_attachment_unavailable:'附件存储服务暂不可用，请稍后重试。', session_pending_input:'此会话有中断后待确认的消息，请先核对历史；未自动重放。', session_execution_unavailable:'会话执行节点暂不可用，请稍后重新读取。' };
  const code = body && typeof body.error === 'string' ? body.error : '';
  let message = Object.hasOwn(messages,code) ? messages[code] : res.status === 401 ? '登录已失效，请重新登录。' : res.status === 403 ? '操作未获授权，请检查登录状态与项目权限。' : '请求失败，请重新读取后重试。';
  const retry = res.headers.get('retry-after'); if (res.status === 429 && /^\d{1,2}$/.test(retry || '') && Number(retry) >= 1 && Number(retry) <= 60) message += '建议等待 ' + retry + ' 秒。';
  return Object.assign(Error(message), { code });
}
async function api(action, request, signal) {
  const res = await fetch('/lumo/sessions/' + action, { method:'POST', headers:{'content-type':'application/json','x-lumo-auth-request':'1'}, body:JSON.stringify(request), signal });
  if (res.status === 401) { location.href = '/auth/login'; throw Error('登录已失效'); }
  if (!res.ok) {
    throw await responseError(res);
  }
  return res.json();
}
function render(events) {
  const root = $('history'), nearEnd = root.scrollHeight - root.scrollTop - root.clientHeight < 80, previous = root.scrollTop;
  root.replaceChildren();
  for (const item of events) {
    const event = item.event || item, data = event.data || {};
    if (!['user/message','assistant/message'].includes(event.type)) continue;
    const content = data.content || (data.message && data.message.content) || [];
    const text = typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => p.text).join('');
    if (!text) continue;
    const div = document.createElement('div'); div.className = 'message';
    const label = document.createElement('strong'); label.textContent = event.type === 'user/message' ? '你' : 'Lumo'; div.append(label);
    let at = 0;
    for (const match of text.matchAll(/\[lumo-attachment:(att_[a-f0-9]{48})\]/g)) {
      div.append(document.createTextNode(text.slice(at,match.index)));
      const link = document.createElement('a'); link.className = 'attachment-link'; link.textContent = '附件 · 下载'; link.href = '/lumo/session-attachments/' + selected + '/' + match[1]; link.setAttribute('download',''); div.append(link); at = match.index + match[0].length;
    }
    div.append(document.createTextNode(text.slice(at))); root.append(div);
  }
  if (!root.childElementCount) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有消息。发送第一条消息，开始这个项目会话。'; root.append(empty); }
  root.dataset.loaded = 'true'; root.scrollTop = nearEnd ? root.scrollHeight : previous;
}
function modelControls() {
  const ready = Boolean(selected && modelView && modelView.can_select && !modelSaving && !promptBusy);
  $('model-choice').disabled = !ready; $('apply-model').disabled = !ready;
  $('send').disabled = !selected || modelSaving || promptBusy || uploadBusy; $('text').disabled = promptBusy; $('cancel').disabled = !selected;
  $('reload').disabled = !selected; $('attachment-files').disabled = !selected || uploadBusy || promptBusy;
  $('attachment-controls').hidden = !(modelView && modelView.attachment_policy); $('cancel-upload').hidden = !uploadBusy;
}
async function refreshModels(id = selected, revision = generation) {
  if (!id) return;
  const view = await api('models',{sessionId:id},viewController.signal);
  if (!current(id,revision)) return;
  const draft = $('model-choice').value, wasDirty = modelView && draft !== modelView.selected_choice_id;
  modelView = view; $('model-choice').replaceChildren();
  for (const choice of view.choices || []) { const option = document.createElement('option'); option.value = choice.id; option.textContent = choice.label; $('model-choice').append(option); }
  $('model-choice').value = wasDirty && (view.choices || []).some(choice => choice.id === draft) ? draft : view.selected_choice_id;
  const choice = (view.choices || []).find(choice => choice.id === view.selected_choice_id);
  $('model-state').textContent = '当前模型：' + (choice ? choice.label : '不可用') + (view.can_select ? ' · 仅对后续轮次生效' : ' · 固定模型或当前轮次尚未结束'); modelControls();
}
$('apply-model').onclick = async () => {
  if (!selected || !modelView || !modelView.can_select || modelSaving || promptBusy) return;
  const id = selected, revision = generation, view = modelView, choice = $('model-choice').value;
  modelSaving = true; modelControls();
  try { await api('selectModel',{sessionId:id,choice_id:choice,expected_revision:view.selection_revision,policy_digest:view.policy_digest},viewController.signal); if (current(id,revision)) status('模型已保存，将用于后续轮次'); }
  catch(e) { if (current(id,revision)) report(e); }
  finally { if (current(id,revision)) { modelSaving = false; await refreshModels(id,revision).catch(e => { modelView = null; report(e); }); modelControls(); } }
};
async function refreshInteractions(id = selected, revision = generation) {
  if (!id) return;
  const view = await api('interactionList',{sessionId:id},viewController.signal);
  if (!current(id,revision)) return;
  const root = $('interactions'); root.replaceChildren();
  for (const pending of view.questions || []) {
    const question = pending.questions && pending.questions[0]; if (!question) continue;
    const card = document.createElement('div'); card.className = 'approval-card';
    const title = document.createElement('h2'); title.textContent = '确认外部操作';
    const summary = document.createElement('p'); summary.textContent = question.question;
    const detail = document.createElement('pre'); detail.textContent = question.detail || '';
    const expiry = document.createElement('p'), expired = Date.parse(pending.expiresAt) <= Date.now();
    expiry.textContent = expired ? '审批已过期，无法执行；请重新读取操作状态。' : '有效期至 ' + new Date(pending.expiresAt).toLocaleString() + ' · 仅执行一次';
    card.append(title,summary,detail,expiry);
    for (const decision of ['approve','reject']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = decision === 'approve' ? '确认并执行一次' : '拒绝';
      if (decision === 'approve') button.className = 'primary'; button.disabled = answering.has(pending.questionId) || expired;
      button.onclick = async () => {
        if (!current(id,revision) || answering.has(pending.questionId) || Date.parse(pending.expiresAt) <= Date.now()) return;
        answering.add(pending.questionId); for (const control of card.querySelectorAll('button')) control.disabled = true;
        try { await api('interactionAnswer',{sessionId:id,answer:{questionId:pending.questionId,receiptId:pending.receiptId,digest:pending.digest,revision:pending.revision,decision}},viewController.signal); if (current(id,revision)) status(decision === 'approve' ? '已确认，请等待操作结果；确认不代表外部操作已完成。' : '已拒绝外部操作'); }
        catch(e) { if (current(id,revision)) { if (e.name !== 'AbortError' && !e.code) status('审批提交结果尚未确认，请重新读取审批与操作审计，勿重复执行。',true); else report(e); } }
        finally { answering.delete(pending.questionId); if (current(id,revision)) await refreshInteractions(id,revision).catch(report); }
      };
      card.append(button);
    }
    root.append(card);
  }
}
async function refresh(id = selected, revision = generation) {
  const results = await Promise.allSettled([
    api('events',{address:{kind:'session',sessionId:id},maxMessages:100},viewController.signal).then(data => { if (current(id,revision)) render(data.records || data.events || []); }),
    refreshInteractions(id,revision), refreshModels(id,revision),
  ]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
async function open(id, preserveDraft = false) {
  viewController.abort(); uploadController?.abort(); viewController = new AbortController();
  uploadController = null; uploadBusy = false; promptBusy = false; modelSaving = false;
  $('interactions').replaceChildren();
  if (!preserveDraft && selected !== id) { stagedAttachments = []; $('text').value = ''; renderAttachments(); }
  selected = id; modelView = null; const revision = ++generation; modelControls();
  $('history').replaceChildren(); $('history').dataset.loaded = 'false'; $('history').textContent = '正在读取会话…'; $('history').setAttribute('aria-busy','true');
  $('fork').disabled = false; $('title').textContent = '项目会话';
  for (const el of $('sessions').querySelectorAll('button')) el.classList.toggle('active',el.dataset.id === id);
  status('加载中…');
  try { await refresh(id,revision); if (!current(id,revision)) return; if ($('status').textContent === '加载中…') status(''); }
  catch(e) { if (current(id,revision)) { if ($('history').dataset.loaded !== 'true') $('history').textContent = '会话读取未完成。可点击“重新读取”恢复；已输入的消息会保留。'; report(e); } return; }
  finally { if (current(id,revision)) $('history').setAttribute('aria-busy','false'); }
  while (current(id,revision)) {
    let running = false;
    try { const result = await api('wait',{sessionId:id,timeoutMs:2000,maxMessages:20},viewController.signal); running = Boolean(result.state && result.state.running); if (!current(id,revision)) return; await refresh(id,revision); }
    catch(e) { if (current(id,revision)) report(e); return; }
    await new Promise(resolve => setTimeout(resolve,running ? 500 : 2000));
  }
}
async function list(after = '') {
  if (listing) return; listing = true; $('more').disabled = true; $('refresh-list').disabled = true; $('sessions').setAttribute('aria-busy','true');
  try {
    const result = await api('list',after ? {after} : {});
    if (!after) $('sessions').replaceChildren();
    for (const row of result.owners || []) {
      if ([...$('sessions').querySelectorAll('button')].some(button => button.dataset.id === row.session_ref)) continue;
      const button = document.createElement('button'); button.textContent = (row.parent_session_ref ? '分支 · ' : '') + new Date(row.created_at).toLocaleString(); button.dataset.id = row.session_ref;
      button.onclick = () => { void open(row.session_ref); }; const li = document.createElement('li'); li.append(button); $('sessions').append(li);
    }
    $('sessions-empty').hidden = Boolean($('sessions').childElementCount); cursor = result.next_cursor; $('more').hidden = !cursor;
  } finally { listing = false; $('more').disabled = false; $('refresh-list').disabled = false; $('sessions').setAttribute('aria-busy','false'); }
}
$('refresh-list').onclick = () => { void list().catch(report); };
$('reload').onclick = () => { if (selected) void open(selected,true); };
$('create').onclick = async () => {
  const revision = generation; $('create').disabled = true;
  try { const result = await api('create',{}); if (generation === revision) void open(result.sessionId); await list().catch(() => { if (selected === result.sessionId) status('会话已创建，列表刷新失败；可继续对话，或刷新会话列表。',true); }); }
  catch(e) { if (generation === revision) report(e); }
  finally { $('create').disabled = false; }
};
$('fork').onclick = async () => {
  if (!selected || $('fork').disabled) return;
  const source = selected, revision = generation; $('fork').disabled = true;
  try { const result = await api('fork',{sessionId:source}); if (current(source,revision)) void open(result.sessionId); await list().catch(() => { if (selected === result.sessionId) status('会话分支已创建，列表刷新失败；可继续对话，或刷新会话列表。',true); }); }
  catch(e) { if (current(source,revision)) report(e); }
  finally { $('fork').disabled = !selected; }
};
$('more').onclick = () => { void list(cursor).catch(report); };
function renderAttachments() {
  $('attachments').replaceChildren();
  for (const receipt of stagedAttachments) {
    const chip = document.createElement('span'); chip.className = 'attachment-chip';
    const name = document.createElement('span'); name.textContent = receipt.name + ' · ' + Math.ceil(receipt.bytes / 1024) + ' KB';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label','移除 ' + receipt.name);
    remove.onclick = () => { stagedAttachments = stagedAttachments.filter(r => r.receipt_id !== receipt.receipt_id); renderAttachments(); }; chip.append(name,remove); $('attachments').append(chip);
  }
}
$('cancel-upload').onclick = () => uploadController?.abort();
$('attachment-files').onchange = async () => {
  if (!selected || !modelView?.attachment_policy || uploadBusy) return;
  const id = selected, revision = generation, files = Array.from($('attachment-files').files || []), policy = modelView.attachment_policy;
  $('attachment-files').value = ''; if (!files.length) return;
  if (files.length + stagedAttachments.length > policy.max_per_message) { status('单条消息的附件数量超限',true); return; }
  const controller = new AbortController(); uploadController = controller; uploadBusy = true; modelControls();
  const signal = AbortSignal.any([controller.signal,viewController.signal]);
  try {
    for (const file of files) {
      signal.throwIfAborted();
      if (file.size > policy.max_upload_bytes || file.size < 1) throw Error('附件为空或超过上传大小限制');
      const mime = file.type || (/\.md$/i.test(file.name) ? 'text/markdown' : /\.csv$/i.test(file.name) ? 'text/csv' : /\.json$/i.test(file.name) ? 'application/json' : /\.txt$/i.test(file.name) ? 'text/plain' : 'application/octet-stream');
      status('正在上传 ' + file.name + '…');
      const response = await fetch('/lumo/session-attachments/' + id,{method:'POST',headers:{'x-lumo-auth-request':'1','content-type':mime,'x-lumo-attachment-name':encodeURIComponent(file.name)},body:file,signal});
      if (!response.ok) throw await responseError(response);
      const receipt = await response.json(); signal.throwIfAborted();
      if (!current(id,revision)) return; stagedAttachments.push(receipt); renderAttachments();
    }
    if (current(id,revision)) status('附件已就绪，发送后可用于本轮对话');
  } catch(e) { if (current(id,revision)) { if (signal.aborted) status('已取消上传，已就绪的附件仍保留。'); else report(e); } }
  finally { if (uploadController === controller) { uploadController = null; uploadBusy = false; modelControls(); } }
};
$('prompt').onsubmit = async event => {
  event.preventDefault();
  if (!selected) { status('请先新建会话',true); return; }
  if (promptBusy || uploadBusy || (!$('text').value.trim() && !stagedAttachments.length)) return;
  const id = selected, revision = generation, content = [{type:'text',text:$('text').value},...stagedAttachments.map(receipt => ({type:'attachment',receipt_id:receipt.receipt_id}))];
  promptBusy = true; modelControls();
  try { await api('prompt',{sessionId:id,requestId:crypto.randomUUID(),content,mode:'queue'},viewController.signal); if (!current(id,revision)) return; $('text').value = ''; stagedAttachments = []; renderAttachments(); status('已发送'); await refresh(id,revision); }
  catch(e) { if (current(id,revision)) report(e); }
  finally { if (current(id,revision)) { promptBusy = false; modelControls(); } }
};
$('cancel').onclick = async () => { if (!selected) return; const id = selected, revision = generation; try { await api('cancel',{sessionId:id},viewController.signal); if (current(id,revision)) status('停止请求已提交'); } catch(e) { if (current(id,revision)) report(e); } };
$('logout').onclick = async e => { e.preventDefault(); viewController.abort(); uploadController?.abort(); await fetch('/auth/logout',{method:'POST',headers:{'x-lumo-auth-request':'1'}}); location.href = '/auth/login'; };
window.addEventListener('pagehide',() => { generation++; viewController.abort(); uploadController?.abort(); },{once:true});
modelControls(); list().catch(report);
})();`
