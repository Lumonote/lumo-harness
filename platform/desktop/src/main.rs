use std::{
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "lumo-tray";
const MENU_SHOW: &str = "show";
const MENU_LOG: &str = "log";
const MENU_QUIT: &str = "quit";
// 冷启动要加载 800+ 个包的模块图，慢机器上首启动可到 40 秒以上；30 秒的旧上限会把
// 一个还在正常加载的 runtime 误判成失败。窗口已经不再被阻塞，这个上限只决定何时放弃。
const BOOT_DEADLINE: Duration = Duration::from_secs(120);

struct LocalRuntime(Mutex<Option<Child>>);

struct RuntimeLogPath(PathBuf);

struct ShellStarted(Instant);

/// 把壳自身的阶段时间写进 runtime.log：用户机器上“打开很久才显示”时，
/// 这是唯一能区分“壳没起来”“runtime 没起来”“端口没就绪”的证据。
fn log_stage(app: &AppHandle, stage: &str) {
    let elapsed = app
        .try_state::<ShellStarted>()
        .map(|started| started.0.elapsed().as_millis())
        .unwrap_or(0);
    let line = format!("lumo-desktop: [+{elapsed} ms] {stage}\n");
    eprint!("{line}");
    if let Some(path) = app.try_state::<RuntimeLogPath>() {
        if let Some(parent) = path.0.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path.0) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn workspace_runtime() -> Option<String> {
    let mut directory = env::current_exe().ok()?.parent()?.to_path_buf();
    // Support both target/{debug,release}/bundle/macos/Lumo.app and a copied
    // dist/Lumo.app while keeping the release shell independent of a fixed
    // checkout path.
    for _ in 0..12 {
        let runtime = directory.join("local-runtime.sh");
        if runtime.is_file() {
            return Some(runtime.to_string_lossy().into_owned());
        }
        directory = directory.parent()?.to_path_buf();
    }
    None
}

fn bundled_runtime(app: &AppHandle) -> Option<String> {
    let resource_dir = app.path().resource_dir().ok()?;
    let executable_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    let contents_dir = executable_dir.parent().map(|path| path.to_path_buf());
    let mut candidates = vec![
        resource_dir.join("runtime").join("lumo-runtime.sh"),
        resource_dir.join("lumo-runtime.sh"),
        resource_dir
            .join("_up_")
            .join("runtime")
            .join("lumo-runtime.sh"),
        resource_dir
            .join("_up_")
            .join("desktop-runtime")
            .join("lumo-runtime.sh"),
    ];
    if let Some(contents) = contents_dir {
        candidates.push(
            contents
                .join("Resources")
                .join("runtime")
                .join("lumo-runtime.sh"),
        );
        candidates.push(contents.join("Resources").join("lumo-runtime.sh"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn runtime_binary(app: &AppHandle) -> String {
    env::var("LUMO_LOCAL_RUNTIME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| bundled_runtime(app))
        .or_else(workspace_runtime)
        .or_else(compiled_workspace_runtime)
        .unwrap_or_else(|| "lumo-dsh-node".to_string())
}

#[cfg(debug_assertions)]
fn compiled_workspace_runtime() -> Option<String> {
    let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("local-runtime.sh");
    runtime
        .is_file()
        .then(|| runtime.to_string_lossy().into_owned())
}

#[cfg(not(debug_assertions))]
fn compiled_workspace_runtime() -> Option<String> {
    None
}

/// Poll the local Web port until it answers, the child exits, or the deadline
/// passes. `on_tick` gets the elapsed seconds so the boot page can show progress.
fn wait_for_web_server(
    app: &AppHandle,
    port: &str,
    mut on_tick: impl FnMut(u64),
) -> Result<(), String> {
    let port = port
        .parse::<u16>()
        .map_err(|error| format!("本地 Web 端口无效 `{port}`：{error}"))?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let started = Instant::now();
    let deadline = started + BOOT_DEADLINE;
    let mut last_tick = 0;

    loop {
        if let Some(status) = runtime_exit_status(app)? {
            return Err(format!("本地 DSH runtime 提前退出：{status}"));
        }

        let last_error = match probe_web_server(address) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "本地 DSH Web 服务在 {} 秒内未就绪（127.0.0.1:{port}）：{last_error}",
                BOOT_DEADLINE.as_secs()
            ));
        }
        let elapsed = now.duration_since(started).as_secs();
        if elapsed != last_tick {
            last_tick = elapsed;
            on_tick(elapsed);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn runtime_exit_status(app: &AppHandle) -> Result<Option<std::process::ExitStatus>, String> {
    let runtime = app.state::<LocalRuntime>();
    let mut guard = runtime
        .0
        .lock()
        .map_err(|_| "本地 DSH runtime 状态锁已损坏".to_string())?;
    match guard.as_mut() {
        None => Ok(None),
        Some(child) => child
            .try_wait()
            .map_err(|error| format!("无法检查本地 DSH runtime：{error}")),
    }
}

fn probe_web_server(address: SocketAddr) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(250))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| error.to_string())?;
    let mut response = [0; 1024];
    let size = stream
        .read(&mut response)
        .map_err(|error| error.to_string())?;
    let status = String::from_utf8_lossy(&response[..size]);
    let status_line = status.lines().next().unwrap_or("无 HTTP 状态");
    // A listening DSH Web server is ready even when the root route answers
    // with a redirect or an auth/status response. Requiring exactly 200 here
    // incorrectly sent a healthy packaged runtime to the startup diagnostic.
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok());
    if status_code.is_some_and(|code| (100..600).contains(&code)) {
        Ok(())
    } else {
        Err(status_line.to_string())
    }
}

/// Spawn the bundled runtime and record the child in managed state. Returns the
/// local Web URL to navigate to once the port answers.
fn spawn_runtime(app: &AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析应用数据目录：{error}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建应用数据目录 {}：{error}", data_dir.display()))?;
    let sqlite_path = data_dir.join("lumo.sqlite");
    let runtime_log_path = app.state::<RuntimeLogPath>().0.clone();
    let port = env::var("LUMO_LOCAL_WEB_PORT").unwrap_or_else(|_| "3080".to_string());
    let state_dir = data_dir.join("runtime");
    // dsh web 的浏览器鉴权靠每个进程随机的 launch token；桌面产品不打印 URL，
    // 由 lumo-platform-ui 插件在装配完成后把带 token 的入口写到这个文件。
    // 上一进程留下的旧 token 对新进程无效，spawn 前先清掉。
    let handoff_file = state_dir.join("web-url");
    let _ = fs::remove_file(&handoff_file);

    // The desktop worker is deliberately a child process rather than a second
    // copy of the control plane. It owns one SQLite file and never receives
    // RocketMQ, Nacos, MinIO, PostgreSQL or Redis URLs.
    let runtime = runtime_binary(app);
    log_stage(app, &format!("准备启动 runtime：{runtime}"));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&runtime_log_path)
        .map_err(|error| format!("无法创建 runtime 日志 {}：{error}", runtime_log_path.display()))?;
    let stderr = log_file
        .try_clone()
        .map_err(|error| format!("无法准备 runtime 日志：{error}"))?;
    let mut command = Command::new(&runtime);
    command
        .env("LUMO_DEPLOYMENT_MODE", "local")
        .env("LUMO_DSH_PROFILE", "web")
        .env("LUMO_WEB_PORT", &port)
        .env("LUMO_SQLITE_PATH", &sqlite_path)
        .env("DSH_HOME", data_dir.join("dsh"))
        .env("LUMO_RUNTIME_STATE_DIR", &state_dir)
        .env("LUMO_DESKTOP_HANDOFF_FILE", &handoff_file)
        .env_remove("LUMO_PG_DSN")
        .env_remove("LUMO_REDIS_URL")
        .env_remove("LUMO_NACOS_ADDR")
        .env_remove("LUMO_MINIO_ENDPOINT")
        .env_remove("LUMO_CONNECTOR_GATEWAY_URL")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr));
    // lumo-runtime.sh exec 成 dsh-node，dsh-node 再 spawn 真正的 dsh Web 进程。给整棵树
    // 一个独立进程组，退出时才能一次性收干净，不会留下占着 3080 端口的孤儿。
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动本地 DSH runtime `{runtime}`：{error}"))?;
    log_stage(app, &format!("runtime 已 spawn（pid {}）", child.id()));
    if let Ok(mut guard) = app.state::<LocalRuntime>().0.lock() {
        *guard = Some(child);
    }

    let log_display = runtime_log_path.display().to_string();
    boot_eval(app, &format!("window.__lumoBoot.logPath({})", js_string(&log_display)));
    wait_for_web_server(app, &port, |elapsed| {
        boot_eval(
            app,
            &format!(
                "window.__lumoBoot.status({})",
                js_string(&format!("等待 127.0.0.1:{port} 就绪…（已 {elapsed} 秒）"))
            ),
        );
    })?;
    log_stage(app, &format!("127.0.0.1:{port} 已就绪"));
    let base_url = format!("http://127.0.0.1:{port}");
    boot_eval(app, "window.__lumoBoot.status(\"等待工作台入口…\")");
    match wait_for_handoff(app, &handoff_file, &base_url) {
        Ok(url) => {
            log_stage(app, "已取得带 token 的工作台入口");
            Ok(url)
        }
        Err(message) => {
            // 没拿到 token 就退回裸 URL：上一次会话的签名 cookie 仍在 30 天有效期内时
            // 依然能进；真的进不去，dsh 的 401 页会说明原因，日志里也留有这一行。
            log_stage(app, &format!("{message}；改用裸地址 {base_url}"));
            Ok(base_url)
        }
    }
}

/// 等插件写出握手文件并校验它确实指向本地回环端口。端口已应答后装配通常在几秒内完成；
/// 这里的上限只覆盖极慢机器，且失败后还有裸地址兜底。
fn wait_for_handoff(app: &AppHandle, file: &PathBuf, base_url: &str) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let expected_prefix = format!("{base_url}/");
    loop {
        if let Some(status) = runtime_exit_status(app)? {
            return Err(format!("本地 DSH runtime 提前退出：{status}"));
        }
        if let Ok(content) = fs::read_to_string(file) {
            let url = content.trim();
            if url.starts_with(&expected_prefix) {
                return Ok(url.to_string());
            }
            if !url.is_empty() {
                return Err(format!("握手文件 {} 指向了非本地地址：{url}", file.display()));
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("30 秒内未取得工作台入口（{}）", file.display()));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Run the boot sequence on a worker thread so the window shows immediately
/// instead of the app sitting invisible in the Dock for the whole cold start.
fn boot_runtime_in_background(app: AppHandle) {
    thread::spawn(move || match spawn_runtime(&app) {
        Ok(url) => match url.parse::<tauri::Url>() {
            Ok(parsed) => {
                log_stage(&app, "切换到工作台");
                if let Some(window) = main_window(&app) {
                    if let Err(error) = window.navigate(parsed) {
                        report_boot_failure(&app, &format!("无法打开本地 Web 地址：{error}"));
                    }
                }
            }
            Err(error) => report_boot_failure(&app, &format!("本地 Web 地址无效：{error}")),
        },
        Err(message) => report_boot_failure(&app, &message),
    });
}

fn report_boot_failure(app: &AppHandle, message: &str) {
    eprintln!("lumo-desktop: {message}");
    let log_path = app.state::<RuntimeLogPath>().0.display().to_string();
    boot_eval(
        app,
        &format!(
            "window.__lumoBoot.fail({}, {})",
            js_string(message),
            js_string(&log_path)
        ),
    );
    if let Some(window) = main_window(app) {
        let _ = window.set_title("Lumo — 本地运行时未启动");
    }
}

fn boot_eval(app: &AppHandle, script: &str) {
    if let Some(window) = main_window(app) {
        let _ = window.eval(script);
    }
}

/// JSON-encode a string for safe interpolation into `eval`. The boot page only
/// ever puts it into `textContent`, so escaping the JS literal is all that is needed.
fn js_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            '<' => out.push_str("\\u003c"),
            character if (character as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", character as u32))
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn kill_runtime(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<LocalRuntime>() {
        if let Ok(mut child) = runtime.0.lock() {
            if let Some(process) = child.as_mut() {
                terminate_process_tree(process);
            }
            *child = None;
        }
    }
}

/// dsh-node 只把 SIGTERM/SIGINT 转发给它拉起的 dsh 进程；`Child::kill` 发的是 SIGKILL，
/// 父进程立即消失而孙进程活下来。先给整个进程组 SIGTERM，留几秒优雅退出，再 SIGKILL 兜底。
#[cfg(unix)]
fn terminate_process_tree(process: &mut Child) {
    let group = -(process.id() as i32);
    unsafe {
        libc::kill(group, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match process.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    unsafe {
        libc::kill(group, libc::SIGKILL);
    }
    let _ = process.wait();
}

#[cfg(not(unix))]
fn terminate_process_tree(process: &mut Child) {
    let _ = process.kill();
    let _ = process.wait();
}

fn reveal_runtime_log(app: &AppHandle) {
    let path = app.state::<RuntimeLogPath>().0.clone();
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(&path).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("lumo-desktop: runtime log at {}", path.display());
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "显示 Lumo").build(app)?;
    let log = MenuItemBuilder::with_id(MENU_LOG, "查看运行时日志").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出 Lumo").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&log)
        .separator()
        .item(&quit)
        .build()?;
    // 菜单栏用单色模板图标：macOS 会按亮/暗菜单栏自动着色，和系统图标一致。
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Lumo")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_LOG => reveal_runtime_log(app),
            MENU_QUIT => {
                kill_runtime(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let shell_started = Instant::now();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let log_path = handle
                .path()
                .app_data_dir()
                .map(|dir| dir.join("runtime.log"))
                .unwrap_or_else(|_| PathBuf::from("runtime.log"));
            app.manage(ShellStarted(shell_started));
            app.manage(RuntimeLogPath(log_path));
            app.manage(LocalRuntime(Mutex::new(None)));
            log_stage(&handle, "壳进入 setup");

            // The window comes up on the bundled boot page first; the worker
            // thread swaps it for the real workbench once the port answers.
            // 标题栏跟随产品主题：Lumo 的四套主题（见 dsh-plugins/lumo-ui/src/theme-catalog.ts）
            // 目前全是深色，所以窗口外观固定为 Dark，底色取默认主题 obsidian-signal 的
            // 基色 #0b0e11——启动页、切换到工作台之间以及窗口尺寸变化露出的边缘都不会
            // 再闪出系统浅灰标题栏。
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("boot.html".into()))
                .title("Lumo")
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(0x0b, 0x0e, 0x11, 0xff))
                .inner_size(1440.0, 920.0)
                .min_inner_size(980.0, 680.0)
                .resizable(true)
                .build()?;
            log_stage(&handle, "主窗口已创建（启动页）");
            if let Err(error) = build_tray(&handle) {
                eprintln!("lumo-desktop: failed to create tray icon: {error}");
            }
            log_stage(&handle, "菜单栏图标已创建");
            boot_runtime_in_background(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗口 = 收进菜单栏，runtime 继续跑；真正退出走托盘菜单或 ⌘Q。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Lumo desktop");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => kill_runtime(app),
        _ => {}
    });
}
