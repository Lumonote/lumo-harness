use std::{
    fs,
    path::{Path, PathBuf},
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
const EXPANDED_SIZE: (f64, f64) = (360.0, 500.0);
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
    workbenches: Vec<CloudWorkbench>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            always_on_top: true,
            launch_on_start: true,
            anchor: None,
            workbenches: Vec::new(),
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
    workbenches: Vec<CloudWorkbench>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct CloudWorkbench {
    label: String,
    origin: String,
}

fn cloud_origin(raw: &str) -> Result<tauri::Url, String> {
    let err = "请输入 HTTPS 服务器地址，仅含域名或 IP 和可选端口";
    if raw.len() > 512
        || raw.contains(['?', '#', '@', '\\'])
        || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(err.into());
    }
    let rest = raw.strip_prefix("https://").ok_or(err)?;
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() || authority.contains('/') || authority.chars().any(char::is_control) {
        return Err(err.into());
    }
    let url: tauri::Url = raw.parse().map_err(|_| err)?;
    if !is_external_web_link(&url) || url.path() != "/" {
        return Err(err.into());
    }
    Ok(url)
}

fn change_workbenches(
    current: &[CloudWorkbench],
    change: &str,
    origin: &str,
    label: &str,
) -> Result<Vec<CloudWorkbench>, String> {
    let origin = cloud_origin(origin)?.to_string();
    let mut items = current.to_vec();
    let index = items.iter().position(|item| item.origin == origin);
    match change {
        "save" => {
            let label = label.trim();
            if label.is_empty() || label.chars().count() > 60 || label.chars().any(char::is_control)
            {
                return Err("请填写 60 字以内的服务器名称".into());
            }
            let item = CloudWorkbench {
                label: label.to_owned(),
                origin,
            };
            if let Some(i) = index {
                items[i] = item;
            } else if items.len() < 12 {
                items.push(item);
            } else {
                return Err("最多保存 12 个云工作台".into());
            }
        }
        "remove" => {
            items.remove(index.ok_or("此云工作台已被移除")?);
        }
        _ => return Err("未知的云工作台操作".into()),
    }
    Ok(items)
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
        "/dev-tools.mjs" => (
            "text/javascript; charset=utf-8",
            include_bytes!("../../desktop-assets/dev-tools.mjs"),
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
        workbenches: data.preferences.workbenches.clone(),
    })
}

#[tauri::command]
pub fn pet_cloud_workbench(
    window: WebviewWindow,
    action: String,
    origin: String,
    label: String,
) -> Result<Vec<CloudWorkbench>, String> {
    authorize(&window)?;
    let state = window.app_handle().state::<PetState>();
    let mut data = state.data.lock().map_err(|_| "桌宠设置暂不可用")?;
    if action == "open" {
        let saved = data
            .preferences
            .workbenches
            .iter()
            .find(|item| item.origin == origin)
            .ok_or("请先保存云工作台地址")?;
        let url = cloud_origin(&saved.origin)?;
        let items = data.preferences.workbenches.clone();
        drop(data);
        open_external_link(&url)?;
        return Ok(items);
    }
    let next = change_workbenches(&data.preferences.workbenches, &action, &origin, &label)?;
    let previous = std::mem::replace(&mut data.preferences.workbenches, next);
    if let Err(err) = save(&state, &data) {
        data.preferences.workbenches = previous;
        return Err(err);
    }
    Ok(data.preferences.workbenches.clone())
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PetAttachment {
    name: String,
    mime_type: String,
    base64: String,
}

const PET_MAX_FILES: usize = 4;
const PET_FILE_BYTES: usize = 8 * 1024 * 1024;
const PET_TOTAL_BYTES: usize = 16 * 1024 * 1024;

fn attachment_bytes(file: &PetAttachment) -> Result<usize, String> {
    let raw = file.base64.as_bytes();
    if file.name.is_empty()
        || file.name.chars().count() > 255
        || file
            .name
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
        || file.mime_type.len() > 255
        || file.mime_type.chars().any(char::is_control)
        || raw.is_empty()
        || raw.len() > (PET_FILE_BYTES + 2) / 3 * 4
        || raw.len() % 4 != 0
    {
        return Err("附件名称、类型或大小无效".into());
    }
    let padding = raw.iter().rev().take_while(|&&ch| ch == b'=').count();
    if padding > 2
        || raw[..raw.len() - padding]
            .iter()
            .any(|ch| !ch.is_ascii_alphanumeric() && *ch != b'+' && *ch != b'/')
    {
        return Err("附件编码无效".into());
    }
    let bytes = raw.len() / 4 * 3 - padding;
    if bytes > PET_FILE_BYTES {
        return Err("单个附件不能超过 8 MB".into());
    }
    Ok(bytes)
}

fn validate_pet_request(
    target: &str,
    draft: &str,
    workspace_id: Option<&str>,
    request_id: Option<&str>,
    attachments: &[PetAttachment],
) -> Result<bool, String> {
    if !["home", "chat", "tasks"].contains(&target)
        || draft.encode_utf16().count() > 12000
        || (target != "chat"
            && (!draft.is_empty() || !attachments.is_empty() || workspace_id.is_some()))
    {
        return Err("无效的桌宠请求".into());
    }
    if let Some(id) = workspace_id {
        if id.trim().is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
            return Err("请选择有效的工作空间".into());
        }
    }
    if let Some(id) = request_id {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-')
        {
            return Err("发送标识无效".into());
        }
    }
    let submitting = target == "chat" && (!draft.trim().is_empty() || !attachments.is_empty());
    if submitting && (workspace_id.is_none() || request_id.is_none()) {
        return Err("发送需要工作空间和请求标识".into());
    }
    if attachments.len() > PET_MAX_FILES {
        return Err("最多添加 4 个附件".into());
    }
    let mut total = 0;
    for file in attachments {
        total += attachment_bytes(file)?;
    }
    if total > PET_TOTAL_BYTES {
        return Err("附件总大小不能超过 16 MB".into());
    }
    Ok(submitting)
}

fn cancellation_result(
    result: serde_json::Value,
    failure: String,
) -> Result<serde_json::Value, String> {
    // The browser keeps submission IDs after admission starts. A late native
    // timeout must never encourage replay as a different conversation.
    if result["state"] == "accepted" {
        Ok(result)
    } else {
        Err(failure)
    }
}

fn cancel_handoff(
    window: &WebviewWindow,
    id: &str,
    failure: String,
) -> Result<serde_json::Value, String> {
    match evaluate(
        window,
        format!("window.__lumoDesktopPet?.cancel({id}) ?? {{state:'rejected'}}"),
    ) {
        Ok(result) => cancellation_result(result, failure),
        Err(_) => Err(failure),
    }
}

fn handoff(window: WebviewWindow, request: serde_json::Value) -> Result<serde_json::Value, String> {
    let id_literal = super::js_string(request["id"].as_str().ok_or("缺少发送标识")?);
    let request = request.to_string().replace('<', "\\u003c");
    let opened = match evaluate(&window, format!("(() => {{ try {{ return window.__lumoDesktopPet?.open({request}) ?? {{accepted:false,error:'工作台正在加载，请稍后重试'}} }} catch {{ return {{accepted:false,error:'桌宠发送入口暂不可用'}} }} }})()")) {
        Ok(result) => result,
        Err(error) => return cancel_handoff(&window, &id_literal, error),
    };
    if opened["accepted"] != true {
        return Err(opened["error"]
            .as_str()
            .unwrap_or("工作台尚未就绪")
            .to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let result = evaluate(&window, format!("window.__lumoDesktopPet?.result({id_literal}) ?? {{state:'rejected',error:'工作台连接已中断'}}"));
        match result {
            Ok(result) if result["state"] == "accepted" => return Ok(result),
            Ok(result) if result["state"] == "rejected" => {
                return Err(result["error"].as_str().unwrap_or("消息未受理").to_string())
            }
            Err(error) => return cancel_handoff(&window, &id_literal, error),
            _ => {}
        }
        if Instant::now() >= deadline {
            return cancel_handoff(
                &window,
                &id_literal,
                "发送回执尚未确认，草稿和附件已保留；重试会核对同一条消息".into(),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn connected_main(app: &AppHandle) -> Result<WebviewWindow, String> {
    let main = super::main_window(app).ok_or("主窗口未创建")?;
    let expected = app
        .state::<PetState>()
        .data
        .lock()
        .map_err(|_| "桌宠状态暂不可用")?
        .runtime_url
        .clone()
        .ok_or("请等待本地工作台启动")?;
    let current = main.url().map_err(|error| error.to_string())?;
    if current.origin() != expected.origin() {
        return Err("工作台连接已变化，请重新打开应用".into());
    }
    Ok(main)
}

#[tauri::command]
pub async fn pet_workspaces(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    authorize(&window)?;
    let main = connected_main(&app)?;
    tauri::async_runtime::spawn_blocking(move || workspace_snapshot(&main))
        .await
        .map_err(|error| error.to_string())?
}

fn workspace_snapshot(main: &WebviewWindow) -> Result<serde_json::Value, String> {
    let result = evaluate(main, "(() => { try { return window.__lumoDesktopPet?.workspaces() ?? {error:'工作空间正在加载'} } catch { return {error:'工作空间暂不可用'} } })()".into())?;
    if let Some(error) = result["error"].as_str() {
        return Err(error.to_string());
    }
    let items = result["workspaces"].as_array().ok_or("工作空间响应无效")?;
    if items.len() > 1000
        || items
            .iter()
            .any(|item| !item["id"].is_string() || !item["label"].is_string())
    {
        return Err("工作空间响应无效".into());
    }
    Ok(result)
}

enum DevAction {
    Read,
    Note(String),
    Goal(String),
    Session {
        provider: String,
        action: String,
        session_id: String,
    },
    Transcript {
        provider: String,
        session_id: String,
        text: String,
    },
    Open {
        tool: String,
        goal: String,
    },
    Locate {
        tool: String,
        relative: String,
        line: u32,
    },
}

fn workspace_item<'a>(
    snapshot: &'a serde_json::Value,
    workspace_id: &str,
) -> Result<&'a serde_json::Value, String> {
    if workspace_id.is_empty() || workspace_id.len() > 4096 {
        return Err("工作区标识无效".into());
    }
    let mut matches = snapshot["workspaces"]
        .as_array()
        .ok_or("工作区列表无效")?
        .iter()
        .filter(|item| item["id"].as_str() == Some(workspace_id));
    let item = matches.next().ok_or("该工作区已移除，请重新选择")?;
    if matches.next().is_some() {
        return Err("工作区标识不唯一".into());
    }
    Ok(item)
}

fn project_directory(item: &serde_json::Value) -> Result<PathBuf, String> {
    let path = PathBuf::from(item["path"].as_str().ok_or("此工作区没有本地目录")?);
    if !path.is_absolute() || !path.is_dir() {
        return Err("工作区目录不在本机或已移除".into());
    }
    Ok(path)
}

static DEV_CONTROL: Mutex<()> = Mutex::new(());

async fn with_dev_workspace<T: Send + 'static>(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    operation: impl FnOnce(&Path, &str, &serde_json::Value) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    authorize(&window)?;
    let main = connected_main(&app)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("development-memory");
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = workspace_snapshot(&main)?;
        let workspace = workspace_item(&snapshot, &workspace_id)?;
        let _control = DEV_CONTROL.lock().map_err(|_| "开发工具状态不可用")?;
        operation(&root, &workspace_id, workspace)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn session_action(
    root: &Path,
    id: &str,
    workspace: &serde_json::Value,
    provider: &str,
    action: &str,
    input: &str,
    launch: impl FnOnce(&str, &Path, Option<&str>, bool) -> Result<(), String>,
) -> Result<super::dev_memory::Memory, String> {
    use super::dev_memory::{append, read};
    if !super::dev_catalog::is_agent(provider) {
        return Err("请选择支持的编码助手".into());
    }
    let session = match action {
        "new" if input.is_empty() => {
            (provider == "claude-code").then(|| uuid::Uuid::new_v4().to_string())
        }
        "link" | "resume" => {
            let uuid = uuid::Uuid::try_parse(input).map_err(|_| "请输入完整的原生会话 UUID")?;
            let canonical = uuid.to_string();
            if !canonical.eq_ignore_ascii_case(input) {
                return Err("请输入带连字符的完整 UUID".into());
            }
            Some(canonical)
        }
        _ => return Err("会话操作参数无效".into()),
    };
    if action == "link" {
        return append(
            root,
            id,
            "session_link",
            provider,
            session.as_deref().unwrap(),
        );
    }
    let memory = read(root, id)?;
    if action == "resume"
        && !memory.entries.iter().any(|e| {
            e.kind == "session_link"
                && e.tool == provider
                && session
                    .as_ref()
                    .is_some_and(|s| e.text.eq_ignore_ascii_case(s))
        })
    {
        return Err("此会话尚未关联到当前项目和工具".into());
    }
    if action == "resume"
        && session
            .as_deref()
            .is_some_and(|s| super::dev_memory::session_state(&memory, provider, s).archived)
    {
        return Err("请先从已归档列表恢复此会话，再继续会话".into());
    }
    let result = project_directory(workspace)
        .and_then(|path| launch(provider, &path, session.as_deref(), action == "resume"));
    if let Err(error) = result {
        let target = session.as_deref().unwrap_or("新会话");
        return append(
            root,
            id,
            "session_failed",
            provider,
            &format!("{target}：{error}"),
        );
    }
    let detail = match session {
        Some(ref session) if action == "new" => {
            append(root, id, "session_link", provider, session)
                .map_err(|e| format!("已请求打开终端，未能保存关联；可手动关联 {session}。{e}"))?;
            format!("已请求在终端中新建会话：{session}")
        }
        Some(session) => format!("已请求在终端中恢复会话：{session}"),
        None if provider == "codex" => {
            "已请求新建 Codex 会话。可在终端用 /status 查看 ID 并关联到此项目。".to_owned()
        }
        None => "已请求新建 Gemini CLI 会话。可用 /stats 查看完整 UUID 并关联到此项目。".to_owned(),
    };
    append(root, id, "session_open", provider, &detail)
        .map_err(|e| format!("{detail}。操作记录未保存：{e}"))
}

async fn dev_action(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    action: DevAction,
) -> Result<super::dev_memory::Memory, String> {
    with_dev_workspace(window, app, workspace_id, move |root, id, workspace| {
        use super::dev_memory::{append, handoff, read};
        let (tool, outcome) = match action {
            DevAction::Read => return read(root, id),
            DevAction::Note(note) => return append(root, id, "note", "", &note),
            DevAction::Goal(goal) => return append(root, id, "goal", "", &goal),
            DevAction::Session {
                provider,
                action,
                session_id,
            } => {
                return session_action(
                    root,
                    id,
                    workspace,
                    &provider,
                    &action,
                    &session_id,
                    super::dev_agents::launch,
                )
            }
            DevAction::Transcript {
                provider,
                session_id,
                text,
            } => return super::dev_memory::transcript(root, id, &provider, &session_id, &text),
            DevAction::Open { tool, goal } => {
                validate_dev_tool(&tool)?;
                let memory = read(root, id)?;
                let previous = memory.entries.iter().rev().find(|e| e.kind == "goal");
                if !goal.trim().is_empty() {
                    if !previous.is_some_and(|e| e.text == goal) {
                        append(root, id, "goal", &tool, &goal)?;
                    }
                } else if previous.is_none() {
                    return Err("请先填写本次开发目标".into());
                }
                let outcome = project_directory(workspace)
                    .and_then(|dir| {
                        super::dev_tools::open_workspace(&tool, &dir, &handoff(root, id)?)
                    })
                    .map(|_| ("opened", "已向编辑器请求打开项目和交接文档。".to_owned()));
                (tool, outcome)
            }
            DevAction::Locate {
                tool,
                relative,
                line,
            } => {
                validate_dev_tool(&tool)?;
                if relative.len() > 2048
                    || relative.trim().is_empty()
                    || relative.chars().any(char::is_control)
                    || !(1..=10_000_000).contains(&line)
                {
                    return Err("请填写项目内相对路径和有效行号".into());
                }
                let outcome = project_directory(workspace)
                    .and_then(|dir| {
                        super::dev_tools::open_project_file(&tool, &dir, &relative, line)
                    })
                    .map(|_| ("located", format!("{relative}:{line}")))
                    .map_err(|e| format!("{relative}:{line} · {e}"));
                (tool, outcome)
            }
        };
        let (kind, text) = outcome.unwrap_or_else(|e| ("failed", e));
        append(root, id, kind, &tool, &text)
            .map_err(|e| format!("工具操作已尝试，记录保存失败；请先核对编辑器状态。{e}"))
    })
    .await
}

fn validate_dev_tool(tool: &str) -> Result<(), String> {
    if super::dev_catalog::is_editor(tool) {
        Ok(())
    } else {
        Err("未知的开发工具".into())
    }
}

#[tauri::command]
pub async fn pet_dev_tools(
    window: WebviewWindow,
) -> Result<Vec<super::dev_catalog::ToolStatus>, String> {
    authorize(&window)?;
    tauri::async_runtime::spawn_blocking(super::dev_catalog::detect)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pet_dev_memory(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(window, app, workspace_id, DevAction::Read).await
}

#[tauri::command]
pub async fn pet_dev_session(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    provider: String,
    action: String,
    session_id: String,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(
        window,
        app,
        workspace_id,
        DevAction::Session {
            provider,
            action,
            session_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn pet_dev_transcript(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    provider: String,
    session_id: String,
    text: String,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(
        window,
        app,
        workspace_id,
        DevAction::Transcript {
            provider,
            session_id,
            text,
        },
    )
    .await
}

#[tauri::command]
pub async fn pet_dev_copy_context(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    with_dev_workspace(window, app, workspace_id, |root, id, _| {
        let text = super::dev_memory::context(root, id)?;
        copy_dev_text(text)
    })
    .await
}

fn copy_dev_text(text: String) -> Result<(), String> {
    // Some window systems keep clipboard contents only while the owner is alive.
    static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
    let mut clipboard = CLIPBOARD.lock().map_err(|_| "剪贴板不可用")?;
    if clipboard.is_none() {
        *clipboard =
            Some(arboard::Clipboard::new().map_err(|e| format!("无法打开系统剪贴板：{e}"))?);
    }
    clipboard
        .as_mut()
        .unwrap()
        .set_text(text)
        .map_err(|e| format!("无法复制项目上下文：{e}"))
}

#[tauri::command]
pub async fn pet_dev_handoff(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    selection: super::dev_memory::HandoffSelection,
    expected_digest: Option<String>,
) -> Result<super::dev_memory::MemoryHandoff, String> {
    with_dev_workspace(window, app, workspace_id, move |root, id, _| {
        let packet =
            super::dev_memory::selected_handoff(root, id, selection, expected_digest.as_deref())?;
        if expected_digest.is_some() {
            copy_dev_text(packet.text.clone())?;
        }
        Ok(packet)
    })
    .await
}

#[tauri::command]
pub async fn pet_dev_library(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    edit: super::dev_memory::LibraryEdit,
) -> Result<super::dev_memory::Memory, String> {
    with_dev_workspace(window, app, workspace_id, move |root, id, _| {
        super::dev_memory::edit_library(root, id, edit)
    })
    .await
}

#[tauri::command]
pub async fn pet_dev_goal(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    text: String,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(window, app, workspace_id, DevAction::Goal(text)).await
}

#[tauri::command]
pub async fn pet_dev_note(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    text: String,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(window, app, workspace_id, DevAction::Note(text)).await
}

#[tauri::command]
pub async fn pet_dev_open(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    tool: String,
    goal: String,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(window, app, workspace_id, DevAction::Open { tool, goal }).await
}

#[tauri::command]
pub async fn pet_dev_locate(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    tool: String,
    relative: String,
    line: u32,
) -> Result<super::dev_memory::Memory, String> {
    dev_action(
        window,
        app,
        workspace_id,
        DevAction::Locate {
            tool,
            relative,
            line,
        },
    )
    .await
}

#[tauri::command]
pub async fn pet_open_workbench(
    window: WebviewWindow,
    app: AppHandle,
    target: String,
    draft: String,
    workspace_id: Option<String>,
    request_id: Option<String>,
    attachments: Option<Vec<PetAttachment>>,
) -> Result<serde_json::Value, String> {
    authorize(&window)?;
    let attachments = attachments.unwrap_or_default();
    let submitting = validate_pet_request(
        &target,
        &draft,
        workspace_id.as_deref(),
        request_id.as_deref(),
        &attachments,
    )?;
    let main = match connected_main(&app) {
        Ok(main) => main,
        Err(_) if target == "home" => {
            super::show_main_window(&app);
            return Ok(serde_json::json!({"state":"accepted"}));
        }
        Err(error) => return Err(error),
    };
    if !submitting {
        super::show_main_window(&app);
    }
    let id = request_id
        .unwrap_or_else(|| format!("desktop-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)));
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        + 65000;
    let mut request = serde_json::json!({"id":id,"target":target,"draft":draft,"attachments":attachments,"expiresAt":expires_at as u64});
    if let Some(id) = workspace_id {
        request["workspaceId"] = id.into();
    }
    tauri::async_runtime::spawn_blocking(move || handoff(main, request))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_servers_persist_as_origins_without_login_secrets() {
        for bad in [
            "https://example.org/?token=secret",
            "https://user:pwd@example.org",
            "http://example.org",
            "file:///tmp",
            "https://example.org/path",
            "https://example.org/a/..",
            "https://example.org/#token",
            "https://good.test\\@other.test",
        ] {
            assert!(cloud_origin(bad).is_err(), "{bad}");
        }
        let old: Preferences = serde_json::from_str(r#"{"launch_on_start":false}"#).unwrap();
        assert!(old.workbenches.is_empty());
        let list = change_workbenches(&[], "save", "https://Team.Example.org:443", "研发").unwrap();
        let list = change_workbenches(&list, "save", "https://team.example.org/", "团队").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "团队");
        let mut prefs = old;
        prefs.workbenches =
            change_workbenches(&list, "save", "https://[::1]:9443", "实验室").unwrap();
        let stored: Preferences =
            serde_json::from_slice(&serde_json::to_vec(&prefs).unwrap()).unwrap();
        assert_eq!(stored.workbenches, prefs.workbenches);
        assert_eq!(
            change_workbenches(&stored.workbenches, "remove", "https://[::1]:9443", "").unwrap(),
            list
        );
    }

    #[test]
    fn dev_workspace_requires_one_registered_id_and_uses_its_path() {
        let dir = std::env::temp_dir();
        let list = serde_json::json!({"workspaces":[{"id":"a","label":"A","path":dir},{"id":"b","label":"B"}]});
        assert_eq!(
            project_directory(workspace_item(&list, "a").unwrap()).unwrap(),
            dir
        );
        assert!(project_directory(workspace_item(&list, "b").unwrap()).is_err());
        assert!(workspace_item(&list, "gone").is_err());
        assert!(workspace_item(
            &serde_json::json!({"workspaces":[{"id":"a"},{"id":"a"}]}),
            "a"
        )
        .is_err());
    }

    #[test]
    fn archived_gemini_link_preserves_handoff_and_requires_restore_before_launch() {
        use crate::dev_memory::{
            append, context, edit_library, session_state, transcript, LibraryEdit,
        };
        let root = std::env::temp_dir().join(format!("lumo-archive-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string();
        let edit = |revision, archived| LibraryEdit::SessionState {
            provider: "gemini".into(),
            session: id.to_uppercase(),
            revision,
            pinned: true,
            archived,
        };
        append(&root, "work", "session_link", "gemini", &id).unwrap();
        append(&root, "work", "session_link", "codex", &id).unwrap();
        transcript(&root, "work", "gemini", &id, "保留的交接记录").unwrap();
        assert!(edit_library(&root, "other", edit(0, true)).is_err());
        let memory = edit_library(&root, "work", edit(0, true)).unwrap();
        assert!(session_state(&memory, "gemini", &id).archived);
        assert!(!session_state(&memory, "codex", &id).archived);
        assert!(edit_library(&root, "work", edit(0, false)).is_err());
        let workspace = serde_json::json!({"path":root});
        let rejected = session_action(
            &root,
            "work",
            &workspace,
            "gemini",
            "resume",
            &id,
            |_, _, _, _| panic!("archived session must not launch"),
        );
        assert!(rejected.unwrap_err().contains("归档"));
        assert!(context(&root, "work").unwrap().contains("保留的交接记录"));
        let restored = edit_library(&root, "work", edit(1, false)).unwrap();
        assert_eq!(restored.entries.len(), memory.entries.len());
        assert!(session_state(&restored, "gemini", &id).pinned);
        session_action(
            &root,
            "work",
            &workspace,
            "gemini",
            "resume",
            &id,
            |provider, _, target, resume| {
                assert_eq!(
                    (provider, target, resume),
                    ("gemini", Some(id.as_str()), true)
                );
                Ok(())
            },
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_session_history_recovers_an_exact_link_and_only_after_accepted_launch() {
        use super::super::dev_memory::read;
        let dir = std::env::temp_dir().join(format!("lumo-pet-session-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let workspace = serde_json::json!({"path":dir});
        let memory = session_action(
            &dir,
            "a",
            &workspace,
            "claude-code",
            "new",
            "",
            |p, path, id, resume| {
                assert_eq!((p, path, resume), ("claude-code", dir.as_path(), false));
                assert!(uuid::Uuid::try_parse(id.unwrap()).is_ok());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            memory
                .entries
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            ["session_link", "session_open"]
        );
        let id = &memory.entries[0].text;
        for (project, provider, target) in [
            ("b", "claude-code", id.as_str()),
            ("a", "codex", id.as_str()),
            ("a", "claude-code", "--last"),
        ] {
            assert!(session_action(
                &dir,
                project,
                &workspace,
                provider,
                "resume",
                target,
                |_, _, _, _| panic!("unlinked launch")
            )
            .is_err());
        }
        session_action(
            &dir,
            "a",
            &workspace,
            "claude-code",
            "resume",
            id,
            |_, _, target, resume| {
                assert!(resume);
                assert_eq!(target, Some(id.as_str()));
                Ok(())
            },
        )
        .unwrap();
        session_action(
            &dir,
            "a",
            &workspace,
            "codex",
            "new",
            "",
            |_, _, target, resume| {
                assert!(!resume && target.is_none());
                Ok(())
            },
        )
        .unwrap();
        session_action(
            &dir,
            "b",
            &workspace,
            "claude-code",
            "new",
            "",
            |_, _, _, _| Err("终端不可用".into()),
        )
        .unwrap();
        let failure = read(&dir, "b").unwrap();
        assert_eq!(failure.entries.len(), 1);
        assert_eq!(failure.entries[0].kind, "session_failed");
        assert!(failure.entries[0].text.contains("终端不可用"));
        assert_eq!(
            read(&dir, "a")
                .unwrap()
                .entries
                .iter()
                .filter(|e| e.kind == "session_link")
                .count(),
            1
        );
        fs::remove_dir_all(dir).unwrap();
    }

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
            ("/dev-tools.mjs", "text/javascript; charset=utf-8"),
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
    fn message_requests_require_workspace_and_stable_identity() {
        assert_eq!(
            validate_pet_request("chat", "hello", Some("workspace-1"), Some("request_1"), &[]),
            Ok(true)
        );
        assert_eq!(
            validate_pet_request("chat", "", Some("workspace-1"), None, &[]),
            Ok(false)
        );
        assert!(validate_pet_request("chat", "hello", None, Some("request-1"), &[]).is_err());
        assert!(validate_pet_request("chat", "hello", Some("workspace-1"), None, &[]).is_err());
        assert!(validate_pet_request(
            "chat",
            "hello",
            Some("workspace-1"),
            Some("bad/request"),
            &[]
        )
        .is_err());
        assert!(validate_pet_request("home", "hello", None, None, &[]).is_err());
        assert!(validate_pet_request("tasks", "", Some("workspace-1"), None, &[]).is_err());
    }

    #[test]
    fn attachments_are_bounded_and_encoded_as_plain_base64() {
        let file = PetAttachment {
            name: "report.txt".into(),
            mime_type: "text/plain".into(),
            base64: "YQ==".into(),
        };
        assert_eq!(attachment_bytes(&file), Ok(1));
        assert_eq!(
            validate_pet_request(
                "chat",
                "",
                Some("workspace-1"),
                Some("request-1"),
                &[file.clone()]
            ),
            Ok(true)
        );
        for encoded in [
            "",
            "=",
            "data:text/plain;base64,YQ==",
            "YQ=",
            "Y===",
            "YQ==AAAA",
        ] {
            assert!(
                attachment_bytes(&PetAttachment {
                    base64: encoded.into(),
                    ..file.clone()
                })
                .is_err(),
                "{encoded}"
            );
        }
        for name in ["../secret", "folder\\report", "bad\nname", ""] {
            assert!(attachment_bytes(&PetAttachment {
                name: name.into(),
                ..file.clone()
            })
            .is_err());
        }
        assert!(validate_pet_request(
            "chat",
            "",
            Some("workspace-1"),
            Some("request-1"),
            &vec![file.clone(); 5]
        )
        .is_err());
        let full = PetAttachment {
            base64: "AAAA".repeat(PET_FILE_BYTES / 3 + 1),
            ..file
        };
        assert!(attachment_bytes(&full).is_err());
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
