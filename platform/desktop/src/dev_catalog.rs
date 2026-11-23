use serde::Serialize;
use std::path::Path;

pub const EDITORS: &[(&str, &str)] = &[
    ("vscode", "VS Code"),
    ("vscode-insiders", "VS Code Insiders"),
    ("cursor", "Cursor"),
    ("trae-cn", "Trae CN"),
    ("zed", "Zed"),
];
pub const AGENTS: &[(&str, &str)] = &[
    ("claude-code", "Claude Code"),
    ("codex", "Codex"),
    ("gemini", "Gemini CLI"),
];

pub fn is_editor(id: &str) -> bool {
    EDITORS.iter().any(|(key, _)| *key == id)
}

pub fn is_agent(id: &str) -> bool {
    AGENTS.iter().any(|(key, _)| *key == id)
}

pub fn supported(id: &str) -> bool {
    if is_agent(id) || matches!(id, "zed" | "trae-cn") {
        cfg!(target_os = "macos")
    } else {
        is_editor(id)
            && cfg!(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            ))
    }
}

pub fn executable(path: &Path) -> bool {
    path.metadata().is_ok_and(|metadata| {
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        true
    })
}

#[derive(Debug, Serialize)]
pub struct ToolStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub status: &'static str,
    pub detail: String,
}

/// Detection only inspects standard installation paths. It never runs a CLI,
/// reads credentials, or treats a detected binary as an authenticated session.
pub fn detect() -> Vec<ToolStatus> {
    EDITORS
        .iter()
        .chain(AGENTS)
        .map(|&(id, label)| {
            let editor = is_editor(id);
            let (status, detail) = if !supported(id) {
                ("unsupported", "此系统暂未接入该工具的启动功能".into())
            } else {
                let result = if editor {
                    super::dev_tools::detect(id)
                } else {
                    super::dev_agents::detect(id)
                };
                match result {
                    Ok(()) => (
                        "available",
                        if editor {
                            "已检测到本机程序，可打开项目和定位文件"
                        } else {
                            "已检测到本机 CLI；登录和会话状态请在原生终端确认"
                        }
                        .into(),
                    ),
                    Err(error) => ("missing", error),
                }
            };
            ToolStatus {
                id,
                label,
                kind: if editor { "editor" } else { "agent" },
                status,
                detail,
            }
        })
        .collect()
}
