//! 设备动作的平台实现：系统权限探测、本机原生确认框、各动作执行。
//!
//! 只有本文件碰操作系统；判定逻辑在 device_actions.rs（纯函数，可单测）。
//! macOS 是主平台；Windows / Linux 只实现打开文件/链接与剪贴板，其余返回明确的「不支持」。

use super::device_actions::Permission;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
        pub fn CGEventCreateMouseEvent(source: *const c_void, kind: u32, point: CGPoint, button: u32) -> *mut c_void;
        pub fn CGEventPost(tap: u32, event: *mut c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFRelease(cf: *const c_void);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }
    // CGEventType / CGMouseButton 常量
    pub const MOUSE_MOVED: u32 = 5;
    pub const LEFT_DOWN: u32 = 1;
    pub const LEFT_UP: u32 = 2;
    pub const RIGHT_DOWN: u32 = 3;
    pub const RIGHT_UP: u32 = 4;
    pub const HID_TAP: u32 = 0;
}

/// 系统权限是否已授予。非 macOS 平台不需要这两项授权，视为已授予。
pub fn granted(permission: Permission) -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return match permission {
            Permission::Accessibility => mac::AXIsProcessTrusted(),
            Permission::ScreenRecording => mac::CGPreflightScreenCaptureAccess(),
        };
    }
    #[allow(unreachable_code)]
    {
        let _ = permission;
        true
    }
}

/// 触发一次系统授权提示（屏幕录制会弹系统对话框；辅助功能只能打开设置页）。
pub fn request(permission: Permission) {
    #[cfg(target_os = "macos")]
    {
        if permission == Permission::ScreenRecording {
            unsafe {
                mac::CGRequestScreenCaptureAccess();
            }
        }
        let _ = Command::new("open").arg(permission.settings_url()).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = permission;
}

/// AppleScript 字符串字面量转义（只保留可见文本，去掉控制字符）。
pub fn applescript_string(text: &str) -> String {
    let cleaned: String = text.chars().map(|c| if c.is_control() && c != '\n' { ' ' } else { c }).take(1500).collect();
    format!("\"{}\"", cleaned.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 生成确认框脚本。按钮固定为「拒绝」「允许」，默认按钮是「拒绝」，超时视为拒绝。
pub fn confirm_script(title: &str, detail: &str) -> String {
    format!(
        "display dialog {body} with title {title} buttons {{\"拒绝\", \"允许\"}} default button \"拒绝\" cancel button \"拒绝\" with icon caution giving up after {secs}",
        body = applescript_string(detail),
        title = applescript_string(title),
        secs = CONFIRM_TIMEOUT.as_secs(),
    )
}

/// 解析 osascript 输出：只有明确点了「允许」且未超时才算同意。
pub fn confirm_approved(stdout: &str, success: bool) -> bool {
    success && stdout.contains("button returned:允许") && !stdout.contains("gave up:true")
}

/// 本机原生确认。阻塞到用户点选或超时。只有本机键鼠能点到这个框，HTTP 调用方无法代答。
pub fn confirm(title: &str, detail: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("osascript")
            .arg("-e")
            .arg(confirm_script(title, detail))
            .output()
            .map_err(|e| format!("无法弹出本机确认框：{e}"))?;
        // 点「拒绝」时 osascript 以 -128 退出，属于正常拒绝
        return Ok(confirm_approved(&String::from_utf8_lossy(&out.stdout), out.status.success()));
    }
    #[allow(unreachable_code)]
    {
        let _ = (title, detail);
        Err("当前平台还没有本机确认框实现，高风险设备动作一律拒绝".into())
    }
}

fn str_arg<'a>(args: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let v = args.get(key).and_then(Value::as_str).ok_or_else(|| format!("缺少参数 {key}"))?;
    if v.is_empty() || v.len() > max {
        return Err(format!("参数 {key} 为空或过长"));
    }
    Ok(v)
}

pub fn validate_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() || raw.chars().any(char::is_control) || raw.split('/').any(|p| p == "..") {
        return Err("path 必须是不含 .. 和控制字符的绝对路径".into());
    }
    Ok(path.to_path_buf())
}

pub fn validate_url(raw: &str) -> Result<&str, String> {
    let lower = raw.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || raw.chars().any(|c| c.is_control() || c == ' ') {
        return Err("只允许打开 http(s) 链接".into());
    }
    Ok(raw)
}

pub fn validate_app(raw: &str) -> Result<&str, String> {
    if raw.len() > 120 || raw.starts_with('-') || raw.contains('/') || raw.chars().any(char::is_control) {
        return Err("app 只能是应用名（不能含路径或以 - 开头）".into());
    }
    Ok(raw)
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let status = cmd.status().map_err(|e| format!("无法执行系统命令：{e}"))?;
    status.success().then_some(()).ok_or_else(|| format!("系统命令失败：{status}"))
}

fn opener() -> Command {
    if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(target_os = "windows") {
        Command::new("explorer")
    } else {
        Command::new("xdg-open")
    }
}

static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> Result<T, String> {
    let mut guard = CLIPBOARD.lock().map_err(|_| "剪贴板不可用")?;
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(|e| format!("无法打开系统剪贴板：{e}"))?);
    }
    f(guard.as_mut().unwrap()).map_err(|e| format!("剪贴板操作失败：{e}"))
}

fn unsupported() -> Result<Value, String> {
    Err("当前平台暂不支持该设备动作".into())
}

/// 执行已经过判定（且必要时已在本机确认）的动作。返回给调用方的结果；大块数据只给路径不给内容。
pub fn execute(action: &str, args: &Value, data_dir: &Path) -> Result<Value, String> {
    match action {
        "open.path" => {
            let path = validate_path(str_arg(args, "path", 4096)?)?;
            if !path.exists() {
                return Err("文件不存在".into());
            }
            run(opener().arg(&path))?;
            Ok(json!({ "opened": path }))
        }
        "open.url" => {
            let url = validate_url(str_arg(args, "url", 4096)?)?;
            run(opener().arg(url))?;
            Ok(json!({ "opened": url }))
        }
        "open.app" => {
            let app = validate_app(str_arg(args, "app", 120)?)?;
            if cfg!(target_os = "macos") {
                run(Command::new("open").arg("-a").arg(app))?;
                Ok(json!({ "launched": app }))
            } else {
                unsupported()
            }
        }
        "clipboard.write" => {
            let text = str_arg(args, "text", 1 << 20)?.to_owned();
            with_clipboard(|c| c.set_text(text))?;
            Ok(json!({ "written": true }))
        }
        "clipboard.read" => {
            let text = with_clipboard(|c| c.get_text())?;
            let truncated = text.len() > 100_000;
            let text: String = if truncated { text.chars().take(100_000).collect() } else { text };
            Ok(json!({ "text": text, "truncated": truncated }))
        }
        "system.notify" => {
            let title = str_arg(args, "title", 200)?;
            let body = args.get("body").and_then(Value::as_str).unwrap_or("");
            if cfg!(target_os = "macos") {
                let script = format!("display notification {} with title {}", applescript_string(body), applescript_string(title));
                run(Command::new("osascript").arg("-e").arg(script))?;
                Ok(json!({ "notified": true }))
            } else {
                unsupported()
            }
        }
        "screen.capture" => {
            if !cfg!(target_os = "macos") {
                return unsupported();
            }
            let dir = data_dir.join("device-actions").join("captures");
            std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建截图目录：{e}"))?;
            let file = dir.join(format!("capture-{}.png", uuid::Uuid::new_v4()));
            run(Command::new("screencapture").arg("-x").arg("-t").arg("png").arg(&file))?;
            Ok(json!({ "path": file }))
        }
        "input.keyboard" => {
            let text = str_arg(args, "text", 2000)?;
            if !cfg!(target_os = "macos") {
                return unsupported();
            }
            let script = format!("tell application \"System Events\" to keystroke {}", applescript_string(text));
            run(Command::new("osascript").arg("-e").arg(script))?;
            Ok(json!({ "typed": text.chars().count() }))
        }
        "input.mouse" => {
            let x = args.get("x").and_then(Value::as_f64).ok_or("缺少参数 x")?;
            let y = args.get("y").and_then(Value::as_f64).ok_or("缺少参数 y")?;
            if !(0.0..=20000.0).contains(&x) || !(0.0..=20000.0).contains(&y) {
                return Err("坐标超出范围".into());
            }
            let click = args.get("click").and_then(Value::as_str).unwrap_or("left");
            mouse(x, y, click)?;
            Ok(json!({ "x": x, "y": y, "click": click }))
        }
        _ => Err(format!("未实现的设备动作：{action}")),
    }
}

#[cfg(target_os = "macos")]
fn mouse(x: f64, y: f64, click: &str) -> Result<(), String> {
    use mac::*;
    let kinds: &[u32] = match click {
        "none" => &[MOUSE_MOVED],
        "left" => &[MOUSE_MOVED, LEFT_DOWN, LEFT_UP],
        "right" => &[MOUSE_MOVED, RIGHT_DOWN, RIGHT_UP],
        _ => return Err("click 只能是 left / right / none".into()),
    };
    let button = if click == "right" { 1 } else { 0 };
    for kind in kinds {
        unsafe {
            let event = CGEventCreateMouseEvent(std::ptr::null(), *kind, CGPoint { x, y }, button);
            if event.is_null() {
                return Err("无法创建鼠标事件".into());
            }
            CGEventPost(HID_TAP, event);
            CFRelease(event);
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn mouse(_x: f64, _y: f64, _click: &str) -> Result<(), String> {
    Err("当前平台暂不支持该设备动作".into())
}

/// 结果摘要（写进账本 / 运行树；不含剪贴板正文等敏感内容）。
pub fn summarize(action: &str, result: &Value) -> String {
    match action {
        "clipboard.read" => format!("读取剪贴板 {} 字", result.get("text").and_then(Value::as_str).map(|t| t.chars().count()).unwrap_or(0)),
        "screen.capture" => "已截图".into(),
        "input.keyboard" => format!("输入 {} 字", result.get("typed").and_then(Value::as_u64).unwrap_or(0)),
        _ => "完成".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_escaping() {
        assert_eq!(applescript_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(applescript_string("x\u{7}y"), "\"x y\"");
        let s = confirm_script("t", "d");
        assert!(s.contains("default button \"拒绝\"") && s.contains("giving up after 120"));
    }

    #[test]
    fn confirm_output_parsing() {
        assert!(confirm_approved("button returned:允许, gave up:false", true));
        assert!(!confirm_approved("button returned:允许, gave up:true", true));
        assert!(!confirm_approved("", false));
        assert!(!confirm_approved("button returned:拒绝", true));
    }

    #[test]
    fn argument_validation() {
        assert!(validate_path("/tmp/a.txt").is_ok());
        assert!(validate_path("tmp/a").is_err());
        assert!(validate_path("/tmp/../etc").is_err());
        assert!(validate_url("https://x.dev").is_ok());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_app("Safari").is_ok());
        assert!(validate_app("-n").is_err());
        assert!(validate_app("/Applications/X.app").is_err());
    }

    #[test]
    fn execute_rejects_bad_input_without_side_effects() {
        let dir = std::env::temp_dir();
        assert!(execute("open.path", &json!({}), &dir).is_err());
        assert!(execute("open.url", &json!({"url": "ftp://x"}), &dir).is_err());
        assert!(execute("input.mouse", &json!({"x": -1, "y": 2}), &dir).is_err());
        assert!(execute("nope", &json!({}), &dir).is_err());
    }

    #[test]
    fn summary_hides_clipboard_text() {
        let s = summarize("clipboard.read", &json!({"text": "secret"}));
        assert!(!s.contains("secret"));
    }
}
