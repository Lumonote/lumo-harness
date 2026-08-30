use std::{
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct LocalRuntime(Mutex<Option<Child>>);

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

fn bundled_runtime(app: &tauri::App) -> Option<String> {
    let resource_dir = app.path().resource_dir().ok()?;
    let executable_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    let contents_dir = executable_dir.parent().map(|path| path.to_path_buf());
    let mut candidates = vec![
        resource_dir.join("runtime").join("lumo-runtime.sh"),
        resource_dir.join("lumo-runtime.sh"),
        resource_dir.join("_up_").join("runtime").join("lumo-runtime.sh"),
        resource_dir
            .join("_up_")
            .join("desktop-runtime")
            .join("lumo-runtime.sh"),
    ];
    if let Some(contents) = contents_dir {
        candidates.push(contents.join("Resources").join("runtime").join("lumo-runtime.sh"));
        candidates.push(contents.join("Resources").join("lumo-runtime.sh"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn runtime_binary(app: &tauri::App) -> String {
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
    let runtime = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("local-runtime.sh");
    runtime
        .is_file()
        .then(|| runtime.to_string_lossy().into_owned())
}

#[cfg(not(debug_assertions))]
fn compiled_workspace_runtime() -> Option<String> {
    None
}

fn wait_for_web_server(child: &mut Child, port: &str) -> Result<(), String> {
    let port = port
        .parse::<u16>()
        .map_err(|error| format!("本地 Web 端口无效 `{port}`：{error}"))?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(30);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("本地 DSH runtime 提前退出：{status}"));
            }
            Ok(None) => {}
            Err(error) => return Err(format!("无法检查本地 DSH runtime：{error}")),
        }

        let last_error = match probe_web_server(address) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "本地 DSH Web 服务在 30 秒内未就绪（127.0.0.1:{port}）：{last_error}"
            ));
        }
        thread::sleep(Duration::from_millis(100));
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
    let status_code = status_line.split_whitespace().nth(1).and_then(|value| value.parse::<u16>().ok());
    if status_code.is_some_and(|code| (100..600).contains(&code)) {
        Ok(())
    } else {
        Err(status_line.to_string())
    }
}

fn startup_error_window(app: &tauri::App, message: &str) {
    eprintln!("lumo-desktop: {message}");
    let url = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|dir| {
            [
                dir.join("startup-error.html"),
                dir.join("_up_")
                    .join("desktop-assets")
                    .join("startup-error.html"),
            ]
            .into_iter()
            .find(|path| path.is_file())
        })
        .and_then(|path| tauri::Url::from_file_path(path).ok())
        .unwrap_or_else(|| tauri::Url::parse("about:blank").expect("valid blank URL"));
    let result = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Lumo — 本地运行时未启动")
        .inner_size(900.0, 620.0)
        .min_inner_size(680.0, 460.0)
        .resizable(true)
        .build();
    if let Err(error) = result {
        eprintln!("lumo-desktop: failed to create startup diagnostic window: {error}");
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let mut child = None;
            let mut startup_error = None;
            let mut web_url = None;

            match app.path().app_data_dir() {
                Ok(data_dir) => {
                    if let Err(error) = fs::create_dir_all(&data_dir) {
                        startup_error = Some(format!(
                            "无法创建应用数据目录 {}：{error}",
                            data_dir.display()
                        ));
                    } else {
                        let sqlite_path = data_dir.join("lumo.sqlite");
                        let port =
                            env::var("LUMO_LOCAL_WEB_PORT").unwrap_or_else(|_| "3080".to_string());

                        // The desktop worker is deliberately a child process rather than
                        // a second copy of the control plane. It owns one SQLite file and
                        // never receives RocketMQ, Nacos, MinIO, PostgreSQL or Redis URLs.
                        let runtime = runtime_binary(app);
                        match Command::new(&runtime)
                            .env("LUMO_DEPLOYMENT_MODE", "local")
                            .env("LUMO_DSH_PROFILE", "web")
                            .env("LUMO_WEB_PORT", &port)
                            .env("LUMO_SQLITE_PATH", &sqlite_path)
                            .env("DSH_HOME", data_dir.join("dsh"))
                            .env("LUMO_RUNTIME_STATE_DIR", data_dir.join("runtime"))
                            .env_remove("LUMO_PG_DSN")
                            .env_remove("LUMO_REDIS_URL")
                            .env_remove("LUMO_NACOS_ADDR")
                            .env_remove("LUMO_MINIO_ENDPOINT")
                            .env_remove("LUMO_CONNECTOR_GATEWAY_URL")
                            .stdin(Stdio::null())
                            .stdout(Stdio::inherit())
                            .stderr(Stdio::inherit())
                            .spawn()
                        {
                            Ok(process) => {
                                child = Some(process);
                                if let Some(process) = child.as_mut() {
                                    match wait_for_web_server(process, &port) {
                                        Ok(()) => {
                                            web_url = Some(format!("http://127.0.0.1:{port}"));
                                        }
                                        Err(error) => startup_error = Some(error),
                                    }
                                }
                            }
                            Err(error) => {
                                startup_error =
                                    Some(format!("无法启动本地 DSH runtime `{runtime}`：{error}"));
                            }
                        }
                    }
                }
                Err(error) => {
                    startup_error = Some(format!("无法解析应用数据目录：{error}"));
                }
            }

            app.manage(LocalRuntime(Mutex::new(child)));
            if let Some(message) = startup_error {
                startup_error_window(app, &message);
            } else if let Some(url) = web_url {
                let parsed = match url.parse() {
                    Ok(value) => value,
                    Err(error) => {
                        startup_error_window(app, &format!("本地 Web 地址无效：{error}"));
                        return Ok(());
                    }
                };
                let result = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                    .title("Lumo")
                    .inner_size(1440.0, 920.0)
                    .min_inner_size(980.0, 680.0)
                    .resizable(true)
                    .build();
                if let Err(error) = result {
                    eprintln!("lumo-desktop: failed to create main window: {error}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(runtime) = window.app_handle().try_state::<LocalRuntime>() {
                    if let Ok(mut child) = runtime.0.lock() {
                        if let Some(process) = child.as_mut() {
                            let _ = process.kill();
                        }
                        *child = None;
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lumo desktop");
}
