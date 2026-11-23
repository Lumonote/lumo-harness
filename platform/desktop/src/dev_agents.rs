use std::path::Path;

pub fn launch(
    provider: &str,
    workspace: &Path,
    id: Option<&str>,
    resume: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::launch(provider, workspace, id, resume);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (provider, workspace, id, resume);
        Err("当前系统暂不支持在原生终端启动编码助手".into())
    }
}

pub fn detect(provider: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::detect(provider);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = provider;
        Err("当前系统暂不支持原生终端联动".into())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::{
        ffi::OsString,
        fs::{self, OpenOptions},
        io::Write,
        os::unix::fs::OpenOptionsExt,
        path::{Path, PathBuf},
        process::Command,
    };

    fn arguments<'a>(
        provider: &str,
        id: Option<&'a str>,
        resume: bool,
    ) -> Result<(&'static str, Vec<&'a str>), String> {
        if let Some(value) = id {
            let valid = value.len() == 36
                && value.bytes().enumerate().all(|(i, byte)| {
                    if matches!(i, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                });
            if !valid {
                return Err("原生会话 ID 必须是标准 UUID".into());
            }
        }
        match (provider, resume, id) {
            ("claude-code", false, Some(id)) => Ok(("claude", vec!["--session-id", id])),
            ("claude-code", true, Some(id)) => Ok(("claude", vec!["--resume", id])),
            ("gemini", false, None) => Ok(("gemini", vec![])),
            ("gemini", true, Some(id)) => Ok(("gemini", vec!["--resume", id])),
            ("codex", false, None) => Ok(("codex", vec![])),
            ("codex", true, Some(id)) => Ok(("codex", vec!["resume", id])),
            _ => Err("开发工具或新建、继续会话的参数无效".into()),
        }
    }

    pub(super) fn detect(provider: &str) -> Result<(), String> {
        let binary = match provider {
            "claude-code" => "claude",
            "codex" => "codex",
            "gemini" => "gemini",
            _ => return Err("不支持的编码助手".into()),
        };
        installed(binary).map(|_| ())
    }

    fn installed(binary: &str) -> Result<PathBuf, String> {
        let mut dirs = Vec::new();
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute());
        if let Some(home) = home.as_ref() {
            dirs.push(home.join(".local/bin"));
        }
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
        if let Some(home) = home {
            let root = home.join(".nvm/versions/node");
            // Prefer the active NVM install, then newer installed node versions.
            let mut nvm = Vec::new();
            for entry in root.read_dir().into_iter().flatten().flatten() {
                let version = entry.file_name();
                let Some(version) = version.to_str().and_then(|v| v.strip_prefix('v')) else {
                    continue;
                };
                let Some(parts) = version
                    .split('.')
                    .map(|v| v.parse::<u32>().ok())
                    .collect::<Option<Vec<_>>>()
                else {
                    continue;
                };
                if parts.len() == 3 {
                    nvm.push((parts, entry.path().join("bin")));
                }
            }
            nvm.sort_by(|a, b| b.0.cmp(&a.0));
            let active = std::env::var_os("NVM_BIN").map(PathBuf::from);
            if let Some(active) = active.filter(|d| nvm.iter().any(|(_, dir)| dir == d)) {
                dirs.push(active);
            }
            dirs.extend(nvm.into_iter().map(|(_, path)| path));
        }
        if binary == "codex" {
            dirs.push(PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS"));
            dirs.push(PathBuf::from("/Applications/Codex.app/Contents/Resources"));
        }
        dirs.into_iter()
            .map(|dir| dir.join(binary))
            .find(|file| crate::dev_catalog::executable(file))
            .ok_or_else(|| format!("未在标准安装目录找到可执行的 {binary} CLI"))
    }

    fn quoted(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn path_text(path: &Path) -> Result<&str, String> {
        path.to_str()
            .filter(|s| !s.chars().any(char::is_control))
            .ok_or_else(|| "路径需要有效文字且不能包含控制字符".into())
    }

    fn command_file(bin: &Path, workspace: &Path, args: &[&str]) -> Result<String, String> {
        let bin_dir = path_text(bin.parent().ok_or("CLI 路径无效")?)?;
        if bin_dir.contains(':') {
            return Err("CLI 安装路径不能包含冒号".into());
        }
        let mut script = String::from(
            "#!/bin/sh\nset -eu\n/bin/rm -f -- \"$0\"\n/bin/rmdir -- \"${0%/*}\" || :\n",
        );
        script.push_str(&format!(
            "cd {}\nexport PATH={}:\"$PATH\"\nexec {}",
            quoted(path_text(workspace)?),
            quoted(bin_dir),
            quoted(path_text(bin)?)
        ));
        for arg in args {
            script.push(' ');
            script.push_str(&quoted(arg));
        }
        script.push('\n');
        Ok(script)
    }

    pub(super) fn launch(
        provider: &str,
        workspace: &Path,
        id: Option<&str>,
        resume: bool,
    ) -> Result<(), String> {
        let (binary, args) = arguments(provider, id, resume)?;
        if !workspace.is_absolute() || !workspace.is_dir() {
            return Err("需要已有的本机工作区目录".into());
        }
        let workspace = workspace
            .canonicalize()
            .map_err(|e| format!("读取工作区失败：{e}"))?;
        let script = command_file(&installed(binary)?, &workspace, &args)?;
        // A private directory, not a command injected into a user's running shell.
        let template = std::env::temp_dir().join("lumo-agent-XXXXXXXX");
        let temporary = Command::new("/usr/bin/mktemp")
            .arg("-d")
            .arg(template)
            .output()
            .map_err(|e| format!("无法创建终端启动目录：{e}"))?;
        if !temporary.status.success() {
            return Err("无法创建终端启动目录".into());
        }
        use std::os::unix::ffi::OsStringExt;
        let mut name = temporary.stdout;
        if name.pop() != Some(b'\n') || name.is_empty() {
            return Err("终端启动目录无效".into());
        }
        let dir = PathBuf::from(OsString::from_vec(name));
        let path = dir.join(format!("Lumo-{binary}.command"));
        let open = || -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o700)
                .open(&path)
                .map_err(|e| format!("无法创建终端启动文件：{e}"))?;
            file.write_all(script.as_bytes())
                .map_err(|e| format!("写入终端启动文件失败：{e}"))?;
            drop(file);
            let status = Command::new("/usr/bin/open")
                .args(["-a", "/System/Applications/Utilities/Terminal.app"])
                .arg(&path)
                .status()
                .map_err(|e| format!("打开系统终端失败：{e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("系统终端未接受启动请求：{status}"))
            }
        };
        let result = open();
        if result.is_err() {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_dir(&dir);
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        const ID: &str = "019ad1b4-e75b-7548-84af-d07e2727ae13";
        #[test]
        fn native_session_flags_are_explicit_and_contain_no_prompt() {
            assert_eq!(
                arguments("claude-code", Some(ID), false).unwrap().1,
                ["--session-id", ID]
            );
            assert_eq!(
                arguments("claude-code", Some(ID), true).unwrap().1,
                ["--resume", ID]
            );
            assert!(arguments("codex", None, false).unwrap().1.is_empty());
            assert_eq!(
                arguments("codex", Some(ID), true).unwrap().1,
                ["resume", ID]
            );
            for bad in [None, Some("--last"), Some("$(pwd)")] {
                assert!(arguments("codex", bad, true).is_err());
            }
            assert!(arguments("codex", Some(ID), false).is_err());
            assert!(arguments("gemini", None, false).unwrap().1.is_empty());
            assert_eq!(
                arguments("gemini", Some(ID), true).unwrap(),
                ("gemini", vec!["--resume", ID])
            );
            assert!(arguments("gemini", Some("latest"), true).is_err());
            assert!(arguments("arbitrary", None, false).is_err());
        }

        #[test]
        fn shell_passes_unusual_project_paths_as_one_literal_argument() {
            let dir = std::env::temp_dir()
                .join(format!("lumo-quoted-{} ' $(echo oops)", std::process::id()));
            fs::create_dir(&dir).unwrap();
            let script_dir = dir.join("launcher");
            fs::create_dir(&script_dir).unwrap();
            let path = script_dir.join("launch.command");
            let script = command_file(Path::new("/bin/pwd"), &dir, &[]).unwrap();
            fs::write(&path, script).unwrap();
            let output = Command::new("/bin/sh").arg(&path).output().unwrap();
            assert!(output.status.success(), "{:?}", output.stderr);
            let pwd = String::from_utf8(output.stdout).unwrap();
            assert_eq!(
                Path::new(pwd.trim_end()).canonicalize().unwrap(),
                dir.canonicalize().unwrap()
            );
            assert!(!script_dir.exists());
            fs::remove_dir(dir).unwrap();
        }
    }
}
