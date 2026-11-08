use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const WINDOW: &str = "pet";
const SCHEME: &str = "lumo-pet";
const COMPACT_SIZE: (f64, f64) = (320.0, 280.0);
const EXPANDED_SIZE: (f64, f64) = (380.0, 560.0);
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

// Navigation callbacks do not expose whether the navigation came from a user
// gesture. Only trusted anchor clicks are forwarded; scripts and redirects to
// external origins remain blocked by the native navigation policy.
pub const EXTERNAL_LINKS_SCRIPT: &str = r#"(() => {
  document.addEventListener('click', event => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!link || link.hasAttribute('download')) return;
    let url;
    try { url = new URL(link.href, location.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin || url.username || url.password) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = 'lumo-external://open/?url=' + encodeURIComponent(url.href);
  }, true);
})();"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
struct Preferences {
    always_on_top: bool,
    launch_on_start: bool,
    anchor: Option<(i32, i32)>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            always_on_top: true,
            launch_on_start: true,
            anchor: None,
        }
    }
}

#[derive(Default)]
struct PetData {
    preferences: Preferences,
    expanded: bool,
    runtime_url: Option<tauri::Url>,
    failed: bool,
}

pub struct PetState {
    file: PathBuf,
    data: Mutex<PetData>,
}

#[derive(Serialize)]
pub struct Snapshot {
    runtime: &'static str,
    always_on_top: bool,
    launch_on_start: bool,
    compact: bool,
}

/// Assets use a dedicated native protocol in both dev and release. The runtime's
/// loopback web server never gets permission to invoke desktop-pet commands.
pub fn asset(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let (mime, bytes): (&str, &[u8]) = match request.uri().path() {
        "/pet.html" => (
            "text/html; charset=utf-8",
            include_bytes!("../../desktop-assets/pet.html"),
        ),
        "/pet.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../desktop-assets/pet.css"),
        ),
        "/pet.mjs" => (
            "text/javascript; charset=utf-8",
            include_bytes!("../../desktop-assets/pet.mjs"),
        ),
        "/pet-motion.mjs" => (
            "text/javascript; charset=utf-8",
            include_bytes!("../../desktop-assets/pet-motion.mjs"),
        ),
        "/pet-whale.svg" => (
            "image/svg+xml",
            include_bytes!("../../desktop-assets/pet-whale.svg"),
        ),
        "/pet-breach-atlas.webp" => (
            "image/webp",
            include_bytes!("../../desktop-assets/pet-breach-atlas.webp"),
        ),
        "/pet-artwork.NOTICE" => (
            "text/plain; charset=utf-8",
            include_bytes!("../../desktop-assets/pet-artwork.NOTICE"),
        ),
        _ => {
            return tauri::http::Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap()
        }
    };
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ipc: http://ipc.localhost")
        .body(bytes.to_vec()).unwrap()
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let file = app.path().app_data_dir()?.join("desktop-pet.json");
    let preferences = fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
        .unwrap_or_default();
    let visible = preferences.launch_on_start;
    let always_on_top = preferences.always_on_top;
    app.manage(PetState {
        file,
        data: Mutex::new(PetData {
            preferences,
            ..Default::default()
        }),
    });
    let url = format!("{SCHEME}://localhost/pet.html").parse()?;
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::CustomProtocol(url))
        .title("DeepSeek · 桌面伙伴")
        .inner_size(COMPACT_SIZE.0, COMPACT_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(always_on_top)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .visible(false)
        .accept_first_mouse(true)
        .on_navigation(|url| is_pet_url(url))
        .build()?;
    resize(&window, false)?;
    if visible {
        window.show()?;
    }
    Ok(())
}

fn is_pet_url(url: &tauri::Url) -> bool {
    let native_origin =
        url.scheme() == SCHEME && url.host_str() == Some("localhost") && url.port().is_none();
    let windows_origin = url.scheme() == "http"
        && url.host_str() == Some("lumo-pet.localhost")
        && url.port().is_none();
    (native_origin || windows_origin)
        && url.path() == "/pet.html"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == WINDOW && window.url().is_ok_and(|url| is_pet_url(&url)) {
        Ok(())
    } else {
        Err("桌宠操作只允许由本地桌宠窗口发起".into())
    }
}

pub fn runtime_ready(app: &AppHandle, url: tauri::Url) {
    if let Some(state) = app.try_state::<PetState>() {
        if let Ok(mut data) = state.data.lock() {
            data.runtime_url = Some(url);
            data.failed = false;
        }
    }
}

pub fn runtime_failed(app: &AppHandle) {
    if let Some(state) = app.try_state::<PetState>() {
        if let Ok(mut data) = state.data.lock() {
            data.failed = true;
            data.runtime_url = None;
        }
    }
}

pub fn allow_main_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    let bundled_boot = ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
        && url.path() == "/boot.html";
    let development_boot = app.config().build.dev_url.as_ref().is_some_and(|base| {
        cfg!(debug_assertions) && url.origin() == base.origin() && url.path() == "/boot.html"
    });
    if bundled_boot || development_boot {
        return true;
    }
    app.try_state::<PetState>().is_some_and(|state| {
        state.data.lock().ok().is_some_and(|data| {
            data.runtime_url
                .as_ref()
                .is_some_and(|expected| expected.origin() == url.origin())
        })
    })
}

fn remember_position(window: &WebviewWindow, data: &mut PetData) {
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
        data.preferences.anchor = Some((
            position.x.saturating_add_unsigned(size.width),
            position.y.saturating_add_unsigned(size.height),
        ));
    }
}

fn save(state: &PetState, data: &PetData) -> Result<(), String> {
    if let Some(parent) = state.file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建桌宠配置目录：{error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&data.preferences).map_err(|error| error.to_string())?;
    let staging = state
        .file
        .with_extension(format!("json.{}.tmp", std::process::id()));
    // std::fs::rename uses MOVEFILE_REPLACE_EXISTING on Windows. Never remove the
    // committed file first: readers must see either the old or the new settings.
    let result = fs::write(&staging, bytes).and_then(|_| fs::rename(&staging, &state.file));
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result.map_err(|error| format!("无法保存桌宠设置：{error}"))
}

fn is_external_web_link(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

#[derive(Debug, PartialEq)]
enum PopupPolicy {
    Preopen,
    External,
    Deny,
}

fn popup_policy(url: &tauri::Url) -> PopupPolicy {
    if url.as_str() == "about:blank" {
        PopupPolicy::Preopen
    } else if is_external_web_link(url) {
        PopupPolicy::External
    } else {
        PopupPolicy::Deny
    }
}

/// BrowserLogin preopens about:blank during the click, then replaces the popup
/// URL after its authenticated RPC finishes. Returning a real related webview
/// preserves that WindowProxy; its eventual web URL opens in the system browser.
pub fn open_workbench_popup(
    app: &AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    use tauri::webview::NewWindowResponse;
    match popup_policy(&url) {
        PopupPolicy::External => {
            if let Err(error) = open_external_link(&url) {
                super::log_stage(app, &error);
            }
            NewWindowResponse::Deny
        }
        PopupPolicy::Deny => NewWindowResponse::Deny,
        PopupPolicy::Preopen => {
            let label = format!(
                "browser-login-{}",
                NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
            );
            let navigation_app = app.clone();
            let navigation_label = label.clone();
            let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
                .window_features(features)
                .title("正在打开系统浏览器…")
                .visible(false)
                // WKWebView's opener configuration can carry the main window's
                // user scripts. This auxiliary view never owns a desktop bridge.
                .initialization_script(
                    "delete window.__LUMO_DESKTOP__; delete window.__lumoDesktopPet;",
                )
                .on_navigation(move |next| match popup_policy(next) {
                    PopupPolicy::Preopen => true,
                    PopupPolicy::Deny => false,
                    PopupPolicy::External => {
                        if let Err(error) = open_external_link(next) {
                            super::log_stage(&navigation_app, &error);
                        }
                        let close_app = navigation_app.clone();
                        let close_label = navigation_label.clone();
                        let _ = navigation_app.run_on_main_thread(move || {
                            if let Some(window) = close_app.get_webview_window(&close_label) {
                                let _ = window.close();
                            }
                        });
                        false
                    }
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build();
            match window {
                Ok(window) => NewWindowResponse::Create { window },
                Err(error) => {
                    super::log_stage(app, &format!("无法准备浏览器登录窗口：{error}"));
                    NewWindowResponse::Deny
                }
            }
        }
    }
}

fn external_link_request(url: &tauri::Url) -> Option<tauri::Url> {
    if url.scheme() != "lumo-external"
        || url.host_str() != Some("open")
        || url.path() != "/"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 1 || pairs[0].0 != "url" {
        return None;
    }
    let destination = pairs[0].1.parse::<tauri::Url>().ok()?;
    is_external_web_link(&destination).then_some(destination)
}

pub fn handle_external_link_request(url: &tauri::Url) -> Result<(), String> {
    let destination = external_link_request(url).ok_or("不支持的外部链接请求")?;
    open_external_link(&destination)
}

/// External pages stay in the user's browser; they never replace the webview
/// where a queued native handoff may still be evaluated.
fn open_external_link(url: &tauri::Url) -> Result<(), String> {
    if !is_external_web_link(url) {
        return Err("不支持的外部链接".into());
    }
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url.as_str())
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = Command::new("xdg-open").arg(url.as_str()).spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("无法打开系统浏览器：{error}"))
}

// All geometry is physical pixels, including saved anchors and monitor work areas.
// This remains valid for monitors with different scale factors and negative origins.
fn bounded_rect(
    anchor: (i32, i32),
    requested: (u32, u32),
    area: (i32, i32, u32, u32),
) -> (i32, i32, u32, u32) {
    let (left, top, width, height) = area;
    let area = (left, top, width.max(1), height.max(1));
    let width = requested.0.min(area.2).max(1);
    let height = requested.1.min(area.3).max(1);
    let x = (i64::from(anchor.0) - i64::from(width)).clamp(
        i64::from(left),
        i64::from(left) + i64::from(area.2) - i64::from(width),
    );
    let y = (i64::from(anchor.1) - i64::from(height)).clamp(
        i64::from(top),
        i64::from(top) + i64::from(area.3) - i64::from(height),
    );
    (x as i32, y as i32, width, height)
}

fn resize(window: &WebviewWindow, expanded: bool) -> Result<(), String> {
    let state = window.app_handle().state::<PetState>();
    let mut data = state
        .data
        .lock()
        .map_err(|_| "桌宠状态暂不可用".to_string())?;
    let anchor = data.preferences.anchor;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let monitor = anchor
        .and_then(|(x, y)| {
            monitors
                .iter()
                .find(|monitor| {
                    let area = monitor.work_area();
                    i64::from(x) > i64::from(area.position.x)
                        && i64::from(x) <= i64::from(area.position.x) + i64::from(area.size.width)
                        && i64::from(y) > i64::from(area.position.y)
                        && i64::from(y) <= i64::from(area.position.y) + i64::from(area.size.height)
                })
                .cloned()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let requested = if expanded {
            EXPANDED_SIZE
        } else {
            COMPACT_SIZE
        };
        let anchor = anchor.unwrap_or((
            area.position
                .x
                .saturating_add_unsigned(area.size.width)
                .saturating_sub((24.0 * scale) as i32),
            area.position
                .y
                .saturating_add_unsigned(area.size.height)
                .saturating_sub((24.0 * scale) as i32),
        ));
        let (x, y, width, height) = bounded_rect(
            anchor,
            ((requested.0 * scale) as u32, (requested.1 * scale) as u32),
            (
                area.position.x,
                area.position.y,
                area.size.width,
                area.size.height,
            ),
        );
        window
            .set_size(PhysicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        data.preferences.anchor = Some((
            x.saturating_add_unsigned(width),
            y.saturating_add_unsigned(height),
        ));
    }
    data.expanded = expanded;
    Ok(())
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(WINDOW).ok_or("桌宠窗口未创建")?;
    let state = app.state::<PetState>();
    let expanded = {
        let mut data = state.data.lock().map_err(|_| "桌宠状态暂不可用")?;
        if window.is_visible().unwrap_or(false) {
            remember_position(&window, &mut data);
        }
        data.expanded
    };
    resize(&window, expanded)?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| error.to_string())
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(WINDOW).ok_or("桌宠窗口未创建")?;
    window.hide().map_err(|error| error.to_string())?;
    persist(app)
}

pub fn persist(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<PetState>() else {
        return Ok(());
    };
    let mut data = state.data.lock().map_err(|_| "桌宠状态暂不可用")?;
    if let Some(window) = app.get_webview_window(WINDOW) {
        remember_position(&window, &mut data);
    }
    save(&state, &data)
}

#[tauri::command]
pub fn pet_snapshot(window: WebviewWindow, app: AppHandle) -> Result<Snapshot, String> {
    authorize(&window)?;
    if matches!(super::runtime_exit_status(&app), Ok(Some(_)) | Err(_)) {
        runtime_failed(&app);
    }
    let state = app.state::<PetState>();
    let data = state.data.lock().map_err(|_| "桌宠状态暂不可用")?;
    Ok(Snapshot {
        runtime: if data.failed {
            "failed"
        } else if data.runtime_url.is_some() {
            "ready"
        } else {
            "starting"
        },
        always_on_top: data.preferences.always_on_top,
        launch_on_start: data.preferences.launch_on_start,
        compact: !data.expanded,
    })
}

#[tauri::command]
pub fn pet_set_expanded(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    authorize(&window)?;
    {
        let state = window.app_handle().state::<PetState>();
        let mut data = state.data.lock().map_err(|_| "桌宠状态暂不可用")?;
        remember_position(&window, &mut data);
    }
    resize(&window, expanded)
}

#[tauri::command]
pub fn pet_start_drag(window: WebviewWindow) -> Result<(), String> {
    authorize(&window)?;
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pet_hide(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    authorize(&window)?;
    hide(&app)
}

#[tauri::command]
pub fn pet_set_preferences(
    window: WebviewWindow,
    always_on_top: bool,
    launch_on_start: bool,
) -> Result<(), String> {
    authorize(&window)?;
    let state = window.app_handle().state::<PetState>();
    let mut data = state.data.lock().map_err(|_| "桌宠状态暂不可用")?;
    let previous = data.preferences.clone();
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| error.to_string())?;
    data.preferences.always_on_top = always_on_top;
    data.preferences.launch_on_start = launch_on_start;
    remember_position(&window, &mut data);
    if let Err(error) = save(&state, &data) {
        data.preferences = previous;
        let _ = window.set_always_on_top(data.preferences.always_on_top);
        return Err(error);
    }
    Ok(())
}

fn evaluate(window: &WebviewWindow, script: String) -> Result<serde_json::Value, String> {
    let (send, receive) = mpsc::sync_channel(1);
    window
        .eval_with_callback(script, move |result| {
            let _ = send.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    let result = receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "工作台暂未响应，请稍后重试".to_string())?;
    serde_json::from_str(&result).map_err(|_| "工作台返回了无效状态".to_string())
}

fn cancellation_result(result: serde_json::Value, failure: String) -> Result<(), String> {
    // A slow evaluation callback may arrive after the client already applied the
    // draft. Acknowledging that success avoids encouraging a duplicate retry.
    if result["state"] == "accepted" {
        Ok(())
    } else {
        Err(failure)
    }
}

fn cancel_handoff(window: &WebviewWindow, id: &str, failure: String) -> Result<(), String> {
    match evaluate(
        window,
        format!("window.__lumoDesktopPet?.cancel({id}) ?? {{state:'rejected'}}"),
    ) {
        Ok(result) => cancellation_result(result, failure),
        Err(_) => Err(failure),
    }
}

fn handoff(window: WebviewWindow, target: String, draft: String) -> Result<(), String> {
    let id = format!("desktop-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
    let id_literal = super::js_string(&id);
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        + 8000;
    let request = serde_json::json!({ "id": id, "target": target, "draft": draft, "expiresAt": expires_at as u64 })
        .to_string()
        .replace('<', "\\u003c");
    let opened = match evaluate(&window, format!("(() => {{ try {{ return window.__lumoDesktopPet?.open({request}) ?? {{accepted:false,error:'工作台正在加载，请稍后重试'}} }} catch {{ return {{accepted:false,error:'工作台入口暂不可用'}} }} }})()")) {
        Ok(result) => result,
        Err(error) => {
            return cancel_handoff(&window, &id_literal, error);
        }
    };
    if opened["accepted"] != true {
        return Err(opened["error"]
            .as_str()
            .unwrap_or("工作台尚未就绪")
            .to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let result = evaluate(&window, format!("window.__lumoDesktopPet?.result({id_literal}) ?? {{state:'rejected',error:'工作台连接已中断'}}"));
        match result {
            Ok(result) if result["state"] == "accepted" => return Ok(()),
            Ok(result) if result["state"] == "rejected" => {
                return Err(result["error"]
                    .as_str()
                    .unwrap_or("工作台未接收请求")
                    .to_string())
            }
            Err(error) => {
                return cancel_handoff(&window, &id_literal, error);
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return cancel_handoff(
                &window,
                &id_literal,
                "工作台未及时接收，草稿已保留，请重试".into(),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub async fn pet_open_workbench(
    window: WebviewWindow,
    app: AppHandle,
    target: String,
    draft: String,
) -> Result<(), String> {
    authorize(&window)?;
    if !["home", "chat", "tasks"].contains(&target.as_str())
        || draft.encode_utf16().count() > 12000
        || (target != "chat" && !draft.is_empty())
    {
        return Err("无效的工作台请求".into());
    }
    let main = super::main_window(&app).ok_or("主窗口未创建")?;
    let expected = app
        .state::<PetState>()
        .data
        .lock()
        .map_err(|_| "桌宠状态暂不可用")?
        .runtime_url
        .clone();
    let Some(expected) = expected else {
        if target == "home" {
            super::show_main_window(&app);
            return Ok(());
        }
        return Err("请等待本地工作台启动".into());
    };
    let current = main.url().map_err(|error| error.to_string())?;
    if current.origin() != expected.origin() {
        return Err("工作台连接已变化，请重新打开应用".into());
    }
    super::show_main_window(&app);
    tauri::async_runtime::spawn_blocking(move || handoff(main, target, draft))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_policy_preserves_login_preopen_and_plain_web_links() {
        assert_eq!(
            popup_policy(&"about:blank".parse().unwrap()),
            PopupPolicy::Preopen
        );
        for url in [
            "https://example.com/login?state=opaque",
            "http://127.0.0.1:4185/callback",
            "https://example.com/docs#intro",
        ] {
            assert_eq!(
                popup_policy(&url.parse().unwrap()),
                PopupPolicy::External,
                "{url}"
            );
        }
        for url in [
            "about:blank#fragment",
            "about:config",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,x",
            "vscode://file/etc/passwd",
            "https://user:password@example.com/login",
        ] {
            assert_eq!(
                popup_policy(&url.parse().unwrap()),
                PopupPolicy::Deny,
                "{url}"
            );
        }
    }

    #[test]
    fn standalone_assets_include_every_pet_module_and_original_artwork() {
        for (path, mime) in [
            ("/pet.html", "text/html; charset=utf-8"),
            ("/pet.css", "text/css; charset=utf-8"),
            ("/pet.mjs", "text/javascript; charset=utf-8"),
            ("/pet-motion.mjs", "text/javascript; charset=utf-8"),
            ("/pet-whale.svg", "image/svg+xml"),
            ("/pet-breach-atlas.webp", "image/webp"),
            ("/pet-artwork.NOTICE", "text/plain; charset=utf-8"),
        ] {
            let response = asset(
                tauri::http::Request::builder()
                    .uri(path)
                    .body(Vec::new())
                    .unwrap(),
            );
            assert_eq!(response.status(), 200, "{path}");
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                mime,
                "{path}"
            );
            assert!(!response.body().is_empty(), "{path}");
        }
        let atlas = asset(
            tauri::http::Request::builder()
                .uri("/pet-breach-atlas.webp")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(
            atlas.body().as_slice(),
            include_bytes!("../../desktop-assets/pet-breach-atlas.webp").as_slice()
        );
        for path in ["/missing.mjs", "/../pet.html", "/runtime.log"] {
            let response = asset(
                tauri::http::Request::builder()
                    .uri(path)
                    .body(Vec::new())
                    .unwrap(),
            );
            assert_eq!(response.status(), 404, "{path}");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn preferences_replace_existing_file_and_preserve_unrelated_data() {
        let folder = std::env::temp_dir().join(format!(
            "lumo-pet-preferences-{}-{}",
            std::process::id(),
            NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&folder).unwrap();
        let state = PetState {
            file: folder.join("desktop-pet.json"),
            data: Mutex::new(PetData::default()),
        };
        let mut data = PetData::default();
        save(&state, &data).unwrap();
        data.preferences.launch_on_start = false;
        data.preferences.anchor = Some((-50, 1800));
        save(&state, &data).unwrap();
        let saved: Preferences = serde_json::from_slice(&fs::read(&state.file).unwrap()).unwrap();
        assert!(!saved.launch_on_start);
        assert_eq!(saved.anchor, Some((-50, 1800)));
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        fs::remove_file(&state.file).unwrap();
        fs::create_dir(&state.file).unwrap();
        let sentinel = state.file.join("keep");
        fs::write(&sentinel, "untouched").unwrap();
        assert!(save(&state, &data).is_err());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "untouched");
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn cancellation_ack_preserves_success_when_callback_arrives_late() {
        assert!(
            cancellation_result(serde_json::json!({"state":"accepted"}), "timeout".into()).is_ok()
        );
        assert_eq!(
            cancellation_result(serde_json::json!({"state":"rejected"}), "timeout".into()),
            Err("timeout".into())
        );
        assert_eq!(
            cancellation_result(serde_json::json!(null), "timeout".into()),
            Err("timeout".into())
        );
    }

    #[test]
    fn external_link_requests_only_decode_plain_web_urls() {
        let request: tauri::Url =
            "lumo-external://open/?url=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1%26y%3D2"
                .parse()
                .unwrap();
        assert_eq!(
            external_link_request(&request).unwrap().as_str(),
            "https://example.com/docs?x=1&y=2"
        );
        for value in [
            "https://example.com/",
            "lumo-external://other/?url=https://example.com",
            "lumo-external://open/?url=file:///etc/passwd",
            "lumo-external://open/?url=javascript:alert(1)",
            "lumo-external://open/?url=https://user:password@example.com",
            "lumo-external://open/?url=https://example.com&url=https://other.com",
        ] {
            assert!(
                external_link_request(&value.parse().unwrap()).is_none(),
                "{value}"
            );
        }
    }

    #[test]
    fn only_pet_document_is_authorized() {
        for accepted in [
            "lumo-pet://localhost/pet.html",
            "http://lumo-pet.localhost/pet.html",
        ] {
            assert!(is_pet_url(&accepted.parse().unwrap()));
        }
        for rejected in [
            "http://127.0.0.1:3080/pet.html",
            "lumo-pet://evil/pet.html",
            "http://lumo-pet.localhost:123/pet.html",
            "lumo-pet://localhost/pet.html?x=1",
            "lumo-pet://localhost/pet.html#x",
            "lumo-pet://localhost/other.html",
        ] {
            assert!(!is_pet_url(&rejected.parse().unwrap()));
        }
    }

    #[test]
    fn geometry_recovers_offscreen_and_negative_monitor_positions() {
        assert_eq!(
            bounded_rect((5000, 5000), (380, 520), (0, 25, 1280, 695)),
            (900, 200, 380, 520)
        );
        assert_eq!(
            bounded_rect((-20, 880), (760, 1040), (-1920, -200, 1920, 1080)),
            (-780, -160, 760, 1040)
        );
        assert_eq!(
            bounded_rect((20, 20), (380, 520), (0, 0, 320, 240)),
            (0, 0, 320, 240)
        );
    }

    #[test]
    fn preferences_are_backward_compatible_and_malformed_input_is_rejected() {
        let preferences: Preferences =
            serde_json::from_str(r#"{"launch_on_start":false}"#).unwrap();
        assert!(preferences.always_on_top);
        assert!(!preferences.launch_on_start);
        assert!(serde_json::from_str::<Preferences>(r#"{"anchor":[1,"bad"]}"#).is_err());
    }
}
