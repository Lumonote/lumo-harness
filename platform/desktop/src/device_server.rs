//! 设备动作的本机调用面：只监听 127.0.0.1 随机端口 + 每进程随机 bearer token。
//!
//! 端点文件 `<data>/runtime/device-actions.json` = `{url, token, pid}`（0600），路径通过
//! `LUMO_DEVICE_ACTIONS_FILE` 传给 DSH worker；lumo-ui 读它后把能力暴露给平台 Agent / ACP 会话。
//!
//!   GET  /v1/device-actions                 注册表 + 当前判定（含系统权限缺失提示）
//!   POST /v1/device-actions/invoke          {call_id, action, args, caller:{session_ref,run_id,agent}}
//!                                           ask 时阻塞到本机确认框返回（≤120s）
//!   GET  /v1/device-actions/calls           调用账本（最新在前）
//!   POST /v1/device-actions/calls/{id}/cancel  确认中的调用撤回（确认框返回后也不会执行）
//!   POST /v1/device-actions/permissions/{accessibility|screen-recording}/request  打开系统授权
//!   POST /v1/device-actions/confirm         {title, detail} 通用本机确认（remote-broker 用），返回 {approved}
//!
//! HTTP 解析是手写的最小子集（一请求一连接、Content-Length、≤2MB），不引入新依赖。

use super::device_actions::{self as da, CallRecord, CallState, Caller, Decision, Ledger, Permission, Switches};
use super::device_exec;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_BODY: usize = 2 << 20;

struct State {
    token: String,
    data_dir: PathBuf,
    switches: Switches,
    ledger: Mutex<Ledger>,
    /// 同一时刻只弹一个确认框，避免叠窗诱导误点
    confirm_lock: Mutex<()>,
    connections: Arc<Mutex<super::desktop_connections::Connections>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

static ENDPOINT: OnceLock<Result<PathBuf, String>> = OnceLock::new();

/// 启动一次（重复调用返回同一端点文件）。失败不影响桌面其他功能，返回错误由调用方记日志。
pub fn start(data_dir: &Path, state_dir: &Path, agent_binary: Option<PathBuf>) -> Result<PathBuf, String> {
    ENDPOINT
        .get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("设备动作端口绑定失败：{e}"))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let file = state_dir.join("device-actions.json");
            write_endpoint(&file, &json!({ "url": format!("http://127.0.0.1:{port}"), "token": token, "pid": std::process::id() }))?;
            let connections = super::desktop_connections::service(data_dir, agent_binary);
            let state = Arc::new(State { token, data_dir: data_dir.to_path_buf(), switches: Switches::from_env(), ledger: Mutex::new(Ledger::default()), confirm_lock: Mutex::new(()), connections });
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let state = state.clone();
                    std::thread::spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                        let _ = handle(stream, &state);
                    });
                }
            });
            Ok(file)
        })
        .clone()
}

fn write_endpoint(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| format!("无法写设备动作端点文件：{e}"))?;
    f.write_all(value.to_string().as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub auth: Option<String>,
    pub origin: Option<String>,
    pub body: Vec<u8>,
}

pub fn read_request(reader: &mut impl BufRead) -> Result<Request, String> {
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let mut parts = line.split_whitespace();
    let method = parts.next().ok_or("bad request")?.to_owned();
    let path = parts.next().ok_or("bad request")?.split('?').next().unwrap_or("").to_owned();
    let (mut len, mut auth, mut origin) = (0usize, None, None);
    for _ in 0..100 {
        let mut h = String::new();
        reader.read_line(&mut h).map_err(|e| e.to_string())?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else { continue };
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().map_err(|_| "bad length")?,
            "authorization" => auth = Some(v.trim().to_owned()),
            "origin" => origin = Some(v.trim().to_owned()),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return Err("body too large".into());
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(Request { method, path, auth, origin, body })
}

/// 常量时间比较 token；任何带 Origin 头的请求（浏览器跨站）一律拒绝。
pub fn authorized(req: &Request, token: &str) -> bool {
    if req.origin.is_some() {
        return false;
    }
    let Some(given) = req.auth.as_deref().and_then(|a| a.strip_prefix("Bearer ")) else { return false };
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let text = body.to_string();
    write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len())
}

fn handle(mut stream: TcpStream, state: &State) -> std::io::Result<()> {
    let req = match read_request(&mut BufReader::new(stream.try_clone()?)) {
        Ok(r) => r,
        Err(e) => return respond(&mut stream, 400, &json!({ "error": e })),
    };
    if !authorized(&req, &state.token) {
        return respond(&mut stream, 401, &json!({ "error": "unauthorized" }));
    }
    let body: Value = if req.body.is_empty() { json!({}) } else {
        match serde_json::from_slice(&req.body) { Ok(v) => v, Err(_) => return respond(&mut stream, 400, &json!({ "error": "invalid_json" })) }
    };
    let (status, out) = route(state, &req.method, &req.path, &body);
    respond(&mut stream, status, &out)
}

fn route(state: &State, method: &str, path: &str, body: &Value) -> (u16, Value) {
    if path == "/v1/environment/servers" {
        let out = match method { "GET" => super::server_book::read(&state.data_dir), "POST" => super::server_book::update(&state.data_dir,body), _ => return (405,json!({"error":"method_not_allowed"})) };
        return match out { Ok(items) => (200,json!({"servers":items})),Err(e)=>(400,json!({"error":e})) };
    }
    if path == "/v1/environment/device" || path.starts_with("/v1/environment/device/") {
        let Ok(mut connections) = state.connections.lock() else {return (503,json!({"error":"设备管理暂不可用"}));};
        let out = if method == "GET" && path == "/v1/environment/device" { connections.snapshot() }
            else if method == "POST" { connections.action(path.trim_start_matches("/v1/environment/device/"),body,|detail| { let _guard=state.confirm_lock.lock().map_err(|_|"本机确认暂不可用")?; device_exec::confirm("Lumo 本机设备接入",detail) }) }
            else {return (405,json!({"error":"method_not_allowed"}));};
        return match out { Ok(out)=>(200,out),Err(e)=>(400,json!({"error":e})) };
    }
    match (method, path) {
        ("GET", "/v1/device-actions") => (200, da::catalog_json(&state.switches, device_exec::granted)),
        ("GET", "/v1/device-actions/calls") => (200, json!({ "calls": state.ledger.lock().map(|l| l.list()).unwrap_or_default() })),
        ("POST", "/v1/device-actions/invoke") => invoke(state, body),
        ("POST", "/v1/device-actions/confirm") => {
            let title = body.get("title").and_then(Value::as_str).unwrap_or("Lumo 需要你确认");
            let detail = body.get("detail").and_then(Value::as_str).unwrap_or("");
            let _guard = state.confirm_lock.lock();
            match device_exec::confirm(title, detail) {
                Ok(approved) => (200, json!({ "approved": approved })),
                Err(e) => (200, json!({ "approved": false, "error": e })),
            }
        }
        _ => {
            if let Some(id) = path.strip_prefix("/v1/device-actions/calls/").and_then(|r| r.strip_suffix("/cancel")) {
                if method != "POST" || !da::valid_call_id(id) {
                    return (400, json!({ "error": "invalid_call" }));
                }
                let ok = state.ledger.lock().map(|mut l| l.get(id).map(|r| r.state == CallState::Confirming).unwrap_or(false) && l.update(id, CallState::Cancelled, None, None, now())).unwrap_or(false);
                return (if ok { 200 } else { 409 }, json!({ "cancelled": ok }));
            }
            if let Some(name) = path.strip_prefix("/v1/device-actions/permissions/").and_then(|r| r.strip_suffix("/request")) {
                let p = match name { "accessibility" => Permission::Accessibility, "screen-recording" => Permission::ScreenRecording, _ => return (404, json!({ "error": "unknown_permission" })) };
                device_exec::request(p);
                return (200, json!({ "requested": name, "hint": p.hint() }));
            }
            (404, json!({ "error": "unknown_endpoint" }))
        }
    }
}

fn invoke(state: &State, body: &Value) -> (u16, Value) {
    let call_id = body.get("call_id").and_then(Value::as_str).unwrap_or("");
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    if !da::valid_call_id(call_id) {
        return (400, json!({ "error": "invalid call_id" }));
    }
    let args = body.get("args").cloned().unwrap_or(json!({}));
    let caller = Caller::from_json(body.get("caller"));
    let decision = da::decide(action, &state.switches, device_exec::granted);
    let risk = da::find(action).map(|s| s.risk).unwrap_or(da::Risk::High);
    let t = now();
    let initial = match decision { Decision::Allow => CallState::Running, Decision::Ask { .. } => CallState::Confirming, Decision::Deny { .. } => CallState::Denied };
    let record = CallRecord { id: call_id.into(), action: action.into(), risk, state: initial.clone(), caller: caller.clone(), created_at: t, updated_at: t, summary: None, error: None };
    if let Err(e) = state.ledger.lock().map_err(|_| "账本不可用".to_string()).and_then(|mut l| l.begin(record)) {
        return (409, json!({ "error": e }));
    }
    let finish = |st: CallState, summary: Option<String>, error: Option<String>| state.ledger.lock().map(|mut l| l.update(call_id, st, summary, error, now())).unwrap_or(false);
    if let Decision::Deny { .. } = decision {
        return (403, json!({ "call_id": call_id, "state": "denied", "decision": decision }));
    }
    if let Decision::Ask { reason } = &decision {
        let title = da::find(action).map(|s| s.title).unwrap_or(action);
        let who = caller.agent.clone().or(caller.session_ref.clone()).unwrap_or_else(|| "平台 Agent".into());
        let detail = format!("{who} 请求执行设备动作：{title}\n{reason}\n\n参数：{}\n\n只有点「允许」才会执行；120 秒未操作视为拒绝。", truncate(&args.to_string(), 600));
        let approved = {
            let _guard = state.confirm_lock.lock();
            device_exec::confirm("Lumo 设备动作确认", &detail)
        };
        match approved {
            Ok(true) => {
                // 确认期间被撤回：update 会失败（已是终态），不执行
                if !finish(CallState::Running, None, None) {
                    return (409, json!({ "call_id": call_id, "state": "cancelled" }));
                }
            }
            Ok(false) => {
                finish(CallState::Rejected, None, None);
                return (403, json!({ "call_id": call_id, "state": "rejected", "decision": decision }));
            }
            Err(e) => {
                finish(CallState::Rejected, None, Some(e.clone()));
                return (403, json!({ "call_id": call_id, "state": "rejected", "error": e }));
            }
        }
    }
    match device_exec::execute(action, &args, &state.data_dir) {
        Ok(result) => {
            finish(CallState::Succeeded, Some(device_exec::summarize(action, &result)), None);
            (200, json!({ "call_id": call_id, "state": "succeeded", "result": result, "confirmed": matches!(decision, Decision::Ask { .. }) }))
        }
        Err(e) => {
            finish(CallState::Failed, None, Some(e.clone()));
            (422, json!({ "call_id": call_id, "state": "failed", "error": e }))
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_owned() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(raw: &str) -> Request {
        read_request(&mut BufReader::new(raw.as_bytes())).unwrap()
    }

    #[test]
    fn parses_minimal_http() {
        let r = req("POST /v1/device-actions/invoke?x=1 HTTP/1.1\r\nAuthorization: Bearer abc\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/v1/device-actions/invoke");
        assert_eq!(r.body, b"{}");
        assert!(authorized(&r, "abc"));
        assert!(!authorized(&r, "abd"));
    }

    #[test]
    fn rejects_browser_origin_and_missing_token() {
        let r = req("GET /v1/device-actions HTTP/1.1\r\nAuthorization: Bearer abc\r\nOrigin: https://evil.example\r\n\r\n");
        assert!(!authorized(&r, "abc"));
        let r = req("GET /v1/device-actions HTTP/1.1\r\n\r\n");
        assert!(!authorized(&r, "abc"));
        assert!(read_request(&mut BufReader::new("POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n".as_bytes())).is_err());
    }

    fn state(switches: Switches) -> State {
        State { token: "t".into(), data_dir: std::env::temp_dir(), switches, ledger: Mutex::new(Ledger::default()), confirm_lock: Mutex::new(()), connections: super::super::desktop_connections::service(&std::env::temp_dir(),None) }
    }

    #[test]
    fn invoke_denies_and_records() {
        let s = state(Switches { enabled: false, input: false, always_ask: false });
        let (status, out) = route(&s, "POST", "/v1/device-actions/invoke", &json!({"call_id": "c1", "action": "open.url", "args": {"url": "https://x.dev"}, "caller": {"session_ref": "s1"}}));
        assert_eq!(status, 403);
        assert_eq!(out["state"], "denied");
        let (_, calls) = route(&s, "GET", "/v1/device-actions/calls", &json!({}));
        assert_eq!(calls["calls"][0]["state"], "denied");
        assert_eq!(calls["calls"][0]["caller"]["session_ref"], "s1");
        // 同 call_id 重放被拒
        let (status, _) = route(&s, "POST", "/v1/device-actions/invoke", &json!({"call_id": "c1", "action": "open.url"}));
        assert_eq!(status, 409);
        let (status, _) = route(&s, "POST", "/v1/device-actions/invoke", &json!({"call_id": "bad id", "action": "open.url"}));
        assert_eq!(status, 400);
    }

    #[test]
    fn cancel_only_while_confirming() {
        let s = state(Switches { enabled: false, input: false, always_ask: false });
        route(&s, "POST", "/v1/device-actions/invoke", &json!({"call_id": "c2", "action": "open.url"}));
        let (status, _) = route(&s, "POST", "/v1/device-actions/calls/c2/cancel", &json!({}));
        assert_eq!(status, 409);
        let (status, _) = route(&s, "POST", "/v1/device-actions/permissions/camera/request", &json!({}));
        assert_eq!(status, 404);
    }
}
