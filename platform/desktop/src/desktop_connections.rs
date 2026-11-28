//! Managed outbound device connection. The private local bridge owns this service;
//! remote webviews never receive Tauri IPC, discovery tokens or device identities.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionConfig {
    pub gateway: String,
    pub realm: String,
    pub node_id: String,
    pub trust_file: String,
    #[serde(default)]
    pub server_ca: String,
    #[serde(default)]
    pub task_runner_socket: String,
    #[serde(default)]
    pub allowed_digests: Vec<String>,
    #[serde(default = "client_version")]
    pub client_version: String,
    #[serde(default)]
    pub paused: bool,
}
fn client_version() -> String {
    "0.1.0".into()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrollment {
    config: ConnectionConfig,
    code: String,
}

pub fn private_json<T: Serialize>(file: &Path, value: &T) -> Result<(), String> {
    let parent = file.parent().ok_or("缺少保存目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut f = options.open(&stage)?;
        f.write_all(&serde_json::to_vec(value)?)?;
        f.sync_all()?;
        fs::rename(&stage, file)
    })();
    let _ = fs::remove_file(stage);
    result.map_err(|e: std::io::Error| format!("保存失败：{e}"))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
fn trusted_path(value: &str, required: bool) -> Result<(), String> {
    if value.is_empty() && !required {
        return Ok(());
    }
    let p = Path::new(value);
    if !p.is_absolute() || p.parent().is_none() || !p.is_file() {
        return Err("请选择已由管理员独立配置的本机绝对文件路径".into());
    }
    Ok(())
}
fn validate(config: &mut ConnectionConfig) -> Result<(), String> {
    config.gateway = crate::server_book::origin(&config.gateway)?;
    if !config.gateway.starts_with("https://") {
        return Err("设备网关必须使用 HTTPS".into());
    }
    if !identifier(&config.realm) || !identifier(&config.node_id) {
        return Err("Realm 与设备 ID 格式错误".into());
    }
    if config.client_version.is_empty()
        || config.client_version.len() > 80
        || !config
            .client_version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_+".contains(&b))
    {
        return Err("客户端版本格式错误".into());
    }
    trusted_path(&config.trust_file, true)?;
    trusted_path(&config.server_ca, false)?;
    let trust: Value =
        serde_json::from_slice(&fs::read(&config.trust_file).map_err(|e| e.to_string())?)
            .map_err(|_| "发布者信任文件不是 JSON")?;
    if !trust
        .get("publishers")
        .and_then(Value::as_array)
        .is_some_and(|p| !p.is_empty())
    {
        return Err("发布者信任文件必须包含已独立批准的 publishers；不能使用空信任表".into());
    }
    if !config.task_runner_socket.is_empty()
        && (!Path::new(&config.task_runner_socket).is_absolute()
            || Path::new(&config.task_runner_socket).parent().is_none())
    {
        return Err("任务运行器须为已配置的绝对 Unix socket 路径".into());
    }
    if config.allowed_digests.len() > 64
        || config.allowed_digests.iter().any(|d| {
            d.len() != 71
                || !d.starts_with("sha256:")
                || !d[7..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err("运行授权须为精确的 sha256 摘要".into());
    }
    Ok(())
}

pub struct Connections {
    root: PathBuf,
    binary: Option<PathBuf>,
    child: Option<Child>,
    last_error: Option<String>,
}
static ACTIVE: OnceLock<Arc<Mutex<Connections>>> = OnceLock::new();

pub fn agent_binary(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "lumo-desktop-agent.exe"
    } else {
        "lumo-desktop-agent"
    };
    let mut candidates = vec![];
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("runtime/bin").join(name));
        candidates.push(resources.join("bin").join(name));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../.build")
                .join(name),
        );
    }
    candidates.into_iter().find(|p| p.is_file())
}
pub fn service(data_dir: &Path, binary: Option<PathBuf>) -> Arc<Mutex<Connections>> {
    ACTIVE
        .get_or_init(|| Arc::new(Mutex::new(Connections::new(data_dir, binary))))
        .clone()
}
pub fn shutdown() {
    if let Some(service) = ACTIVE.get() {
        if let Ok(mut service) = service.lock() {
            service.stop();
        }
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Connections {
    fn new(data_dir: &Path, binary: Option<PathBuf>) -> Self {
        Self {
            root: data_dir.join("managed-device"),
            binary,
            child: None,
            last_error: None,
        }
    }
    fn config_file(&self) -> PathBuf {
        self.root.join("connection.json")
    }
    fn config(&self) -> Result<Option<ConnectionConfig>, String> {
        match fs::read(self.config_file()) {
            Ok(raw) => serde_json::from_slice(&raw)
                .map(Some)
                .map_err(|_| "设备连接配置已损坏，原文件未被覆盖".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn identity_dir(&self, c: &ConnectionConfig) -> PathBuf {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(format!("{}\n{}\n{}", c.gateway, c.realm, c.node_id).as_bytes());
        self.root.join(format!("{:x}", hash)).join("identity")
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            super::terminate_process_tree(&mut child);
        }
        self.clear_activation_input();
    }
    fn clear_activation_input(&self) {
        if let Ok(Some(c)) = self.config() {
            let _ = fs::remove_file(self.identity_dir(&c).join("enrollment-code"));
        }
    }
    fn poll(&mut self) {
        if let Some(child) = &mut self.child {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    self.last_error = Some(format!("设备进程已退出（{exit}），请检查接入配置"));
                    self.child = None;
                    self.clear_activation_input();
                }
                Err(e) => {
                    self.last_error = Some(e.to_string());
                    self.stop();
                }
                _ => {}
            }
        }
    }
    pub fn snapshot(&mut self) -> Result<Value, String> {
        self.poll();
        let config = self.config()?;
        let mut status = json!({"state":"unconfigured","connected":false,"paused":false});
        if let Some(c) = &config {
            let path = self.identity_dir(c);
            let projected: Value = fs::read(path.join("status.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(json!({}));
            let running = self.child.is_some();
            let pid_matches = self
                .child
                .as_ref()
                .is_some_and(|p| projected["pid"].as_u64() == Some(p.id() as u64));
            let fresh = projected["last_gateway_at_ms"]
                .as_u64()
                .is_some_and(|t| t <= now() && now() - t < 30_000);
            let certificate_valid = projected["certificate_expires_ms"]
                .as_u64()
                .is_some_and(|t| t > now());
            let connected = running
                && pid_matches
                && fresh
                && certificate_valid
                && projected["connected"] == true;
            status = json!({"state":if !running {"stopped"} else if connected {"connected"} else {projected["state"].as_str().filter(|_| pid_matches).unwrap_or("starting")},"connected":connected,"process_running":running,"paused":projected["paused"]==true && pid_matches,"desired_paused":c.paused,"gateway_state":projected["gateway_state"],"certificate_expires":projected["certificate_expires"],"certificate_valid":certificate_valid,"last_gateway_at":projected["last_gateway_at"],"active_tasks":if pid_matches {projected["active_tasks"].as_u64().unwrap_or(0)} else {0},"error":self.last_error.as_deref().map(Value::from).unwrap_or_else(||projected["error"].clone())});
        }
        Ok(json!({"available":self.binary.is_some(),"config":config,"status":status}))
    }
    fn spawn(&mut self, config: &ConnectionConfig, code: Option<&str>) -> Result<(), String> {
        self.poll();
        if self.child.is_some() {
            return Err("设备已连接或正在连接".into());
        }
        let binary = self
            .binary
            .as_ref()
            .filter(|p| p.is_file())
            .ok_or("受管设备程序未安装，请更新桌面运行包")?;
        let dir = self.identity_dir(config);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let control = dir.join("control.json");
        private_json(&control, &json!({"paused":config.paused}))?;
        let mut cmd = Command::new(binary);
        cmd.args([
            "-gateway",
            &config.gateway,
            "-realm",
            &config.realm,
            "-node",
            &config.node_id,
            "-trust-file",
            &config.trust_file,
            "-client-version",
            &config.client_version,
        ]);
        cmd.arg("-state-dir")
            .arg(&dir)
            .arg("-install-dir")
            .arg(dir.parent().unwrap().join("artifacts"));
        cmd.arg("-status-file")
            .arg(dir.join("status.json"))
            .arg("-control-file")
            .arg(control);
        if !config.server_ca.is_empty() {
            cmd.arg("-server-ca").arg(&config.server_ca);
        }
        if !config.task_runner_socket.is_empty() {
            cmd.arg("-task-runner-socket")
                .arg(&config.task_runner_socket);
        }
        if !config.allowed_digests.is_empty() {
            cmd.arg("-allow-runtime-digests")
                .arg(config.allowed_digests.join(","));
        }
        let code_file = dir.join("enrollment-code");
        if code.is_some() {
            cmd.arg("-enrollment-code-file").arg(&code_file);
        }
        let mut log_opts = OpenOptions::new();
        log_opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            log_opts.mode(0o600);
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let log = log_opts
            .open(dir.join("agent.log"))
            .map_err(|e| e.to_string())?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        if let Some(code) = code {
            write_code(&code_file, code)?;
        }
        let child = cmd.spawn().map_err(|e| {
            let _ = fs::remove_file(&code_file);
            format!("无法启动受管设备程序：{e}")
        })?;
        if let Err(e) = private_json(&self.config_file(), config) {
            let mut child = child;
            super::terminate_process_tree(&mut child);
            let _ = fs::remove_file(code_file);
            return Err(e);
        }
        self.child = Some(child);
        self.last_error = None;
        Ok(())
    }
    pub fn action(
        &mut self,
        action: &str,
        body: &Value,
        confirm: impl Fn(&str) -> Result<bool, String>,
    ) -> Result<Value, String> {
        self.poll();
        match action {
            "activate" => {
                let mut enrollment: Enrollment =
                    serde_json::from_value(body.clone()).map_err(|_| "接入配置格式错误")?;
                validate(&mut enrollment.config)?;
                if enrollment.code.len() != 43
                    || !enrollment
                        .code
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                {
                    return Err("一次激活码格式错误".into());
                }
                if let Some(existing) = self.config()? {
                    if existing.gateway != enrollment.config.gateway
                        || existing.realm != enrollment.config.realm
                        || existing.node_id != enrollment.config.node_id
                    {
                        return Err("请先退出当前本机接入，避免覆盖设备身份".into());
                    }
                }
                if self.child.is_some() {
                    return Err("设备仍在运行，请等待当前连接结束后更新激活码".into());
                }
                if !confirm(&format!("连接设备网关 {}\nRealm：{}\n设备：{}\n发布者信任：{}\n运行摘要授权：{} 项\n\n此设备将使用已批准的策略接单。",enrollment.config.gateway,enrollment.config.realm,enrollment.config.node_id,enrollment.config.trust_file,enrollment.config.allowed_digests.len()))? {return Err("已取消本机接入".into());}
                self.spawn(&enrollment.config, Some(&enrollment.code))?;
            }
            "pause" => {
                let mut c = self.config()?.ok_or("尚未接入服务器")?;
                c.paused = true;
                self.set_pause(&c)?;
            }
            "resume" => {
                let mut c = self.config()?.ok_or("尚未接入服务器")?;
                validate(&mut c)?;
                c.paused = false;
                if self.child.is_some() {
                    self.set_pause(&c)?;
                } else {
                    self.spawn(&c, None)?;
                }
            }
            "leave" => {
                let c = self.config()?.ok_or("尚未接入服务器")?;
                if !confirm("退出会停止本机接单和当前设备进程，清除本机设备私钥。服务器设备记录需由管理员撤销。")? {return Err("已取消退出".into());}
                self.stop();
                for file in [
                    self.identity_dir(&c).join("identity.json"),
                    self.identity_dir(&c).join("enrollment-code"),
                    self.config_file(),
                ] {
                    match fs::remove_file(file) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.to_string()),
                    }
                }
                self.last_error = None;
            }
            _ => return Err("未知设备连接操作".into()),
        }
        self.snapshot()
    }
    fn set_pause(&self, config: &ConnectionConfig) -> Result<(), String> {
        let previous = self.config()?.ok_or("尚未接入服务器")?;
        private_json(&self.config_file(), config)?;
        if let Err(error) = private_json(
            &self.identity_dir(config).join("control.json"),
            &json!({"paused":config.paused}),
        ) {
            private_json(&self.config_file(), &previous)?;
            return Err(error);
        }
        Ok(())
    }
}

fn write_code(file: &Path, code: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(file)
        .and_then(|mut f| f.write_all(code.as_bytes()))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "desktop_connections_tests.rs"]
mod tests;
