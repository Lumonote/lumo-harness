use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

/// Use the editor's bundled CLI so opening a folder and a document works even
/// when the GUI is already running. Neither PATH nor the project selects a binary.
fn editor_cli(tool: &str) -> Result<(PathBuf, PathBuf), String> {
    if !super::dev_catalog::is_editor(tool) || tool == "zed" {
        return Err("不支持的开发工具".into());
    }
    #[cfg(target_os = "macos")]
    let installations = {
        let bundle = match tool {
            "vscode" => "Visual Studio Code.app",
            "vscode-insiders" => "Visual Studio Code - Insiders.app",
            "cursor" => "Cursor.app",
            "trae-cn" => "Trae CN.app",
            _ => return Err("不支持的开发工具".into()),
        };
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            roots.push(home.join("Applications"));
        }
        let mut candidates = Vec::new();
        for root in roots {
            let contents = root.join(bundle).join("Contents");
            for exe in ["Electron", bundle.trim_end_matches(".app")] {
                candidates.push((
                    contents.join("MacOS").join(exe),
                    contents.join("Resources/app/out/cli.js"),
                ));
            }
        }
        candidates
    };
    #[cfg(target_os = "windows")]
    let installations = {
        let (folder, exe) = match tool {
            "vscode" => ("Microsoft VS Code", "Code.exe"),
            "vscode-insiders" => ("Microsoft VS Code Insiders", "Code - Insiders.exe"),
            "cursor" => ("cursor", "Cursor.exe"),
            _ => return Err("此系统暂不支持 Trae CN".into()),
        };
        let mut roots = Vec::new();
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(root).join("Programs"));
        }
        roots.extend(
            ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
                .iter()
                .filter_map(|var| std::env::var_os(var).map(PathBuf::from)),
        );
        roots
            .into_iter()
            .filter(|p| p.is_absolute())
            .map(|root| {
                let app = root.join(folder);
                (app.join(exe), app.join("resources/app/out/cli.js"))
            })
            .collect::<Vec<_>>()
    };
    #[cfg(target_os = "linux")]
    let installations = {
        let (exe, roots): (_, &[&str]) = match tool {
            "vscode" => ("code", &["/usr/share/code", "/opt/visual-studio-code"]),
            "vscode-insiders" => (
                "code-insiders",
                &[
                    "/usr/share/code-insiders",
                    "/opt/visual-studio-code-insiders",
                ],
            ),
            "cursor" => (
                "cursor",
                &["/usr/share/cursor", "/opt/Cursor", "/opt/cursor"],
            ),
            _ => return Err("此系统暂不支持 Trae CN".into()),
        };
        roots
            .iter()
            .map(|root| {
                let root = Path::new(root);
                (root.join(exe), root.join("resources/app/out/cli.js"))
            })
            .collect::<Vec<_>>()
    };
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    let installations: Vec<(PathBuf, PathBuf)> = vec![];
    installations
        .into_iter()
        .find(|(exe, cli)| super::dev_catalog::executable(exe) && cli.is_file())
        .ok_or_else(|| "未在标准安装目录找到所选开发工具或其命令行组件".into())
}

fn zed_cli() -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") {
        return Err("此系统暂未接入 Zed 的启动功能".into());
    }
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        roots.push(home.join("Applications"));
    }
    roots
        .into_iter()
        .map(|root| root.join("Zed.app/Contents/MacOS/cli"))
        .find(|path| {
            super::dev_catalog::executable(path)
                && path
                    .parent()
                    .is_some_and(|dir| super::dev_catalog::executable(&dir.join("zed")))
        })
        .ok_or_else(|| "未在标准安装目录找到 Zed 或其命令行组件".into())
}

pub fn detect(tool: &str) -> Result<(), String> {
    if tool == "zed" {
        zed_cli().map(|_| ())
    } else {
        editor_cli(tool).map(|_| ())
    }
}

fn local_path(path: &Path) -> Result<PathBuf, String> {
    fn validate(path: &Path) -> Result<(), String> {
        let name = path.to_str().ok_or("路径需要有效的 Unicode 字符")?;
        if !path.is_absolute() || name.starts_with("//") || name.chars().any(char::is_control) {
            return Err("需要有效的本机绝对路径".into());
        }
        #[cfg(windows)]
        if !matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
        {
            return Err("只支持本机磁盘路径".into());
        }
        Ok(())
    }
    validate(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("无法读取本机路径：{e}"))?;
    validate(&canonical)?;
    #[cfg(windows)]
    if let Some(dos) = canonical.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        return Ok(PathBuf::from(dos));
    }
    Ok(canonical)
}

fn workspace_path(path: &Path) -> Result<PathBuf, String> {
    let path = local_path(path)?;
    if !path.is_dir() {
        return Err("工作区必须是本机目录".into());
    }
    Ok(path)
}

fn handoff_args(workspace: &Path, handoff: &Path) -> Result<Vec<OsString>, String> {
    let workspace = workspace_path(workspace)?;
    let handoff = local_path(handoff)?;
    if !handoff.is_file()
        || !handoff
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return Err("交接记录必须是已有的 Markdown 文件".into());
    }
    Ok(vec![workspace.into_os_string(), handoff.into_os_string()])
}

fn file_args(
    tool: &str,
    workspace: &Path,
    relative: &str,
    line: u32,
) -> Result<Vec<OsString>, String> {
    if !super::dev_catalog::is_editor(tool) {
        return Err("不支持的开发工具".into());
    }
    let workspace = workspace_path(workspace)?;
    let rel = Path::new(relative);
    if relative.is_empty()
        || relative.contains(':')
        || relative.chars().any(char::is_control)
        || line == 0
        || rel
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("请输入项目内的相对文件路径和大于零的行号".into());
    }
    let file = local_path(&workspace.join(rel))?;
    if !file.starts_with(&workspace) || !file.is_file() {
        return Err("只能定位工作区内已有的普通文件".into());
    }
    // --goto treats colons as line/column separators, except for a drive letter.
    if file
        .components()
        .chain(workspace.components())
        .any(|part| matches!(part, Component::Normal(name) if name.to_string_lossy().contains(':')))
    {
        return Err("编辑器无法定位路径中带冒号的文件".into());
    }
    let mut location = file.into_os_string();
    location.push(format!(":{line}:1"));
    // Zed accepts file:line:column directly. VS Code's CLI needs --goto.
    let mut args = Vec::with_capacity(3);
    if tool != "zed" {
        args.push("--goto".into());
    }
    args.extend([workspace.into_os_string(), location]);
    Ok(args)
}

fn editor_command(tool: &str, arguments: Vec<OsString>) -> Result<Command, String> {
    let mut command = if tool == "zed" {
        Command::new(zed_cli()?)
    } else {
        let (exe, cli) = editor_cli(tool)?;
        let mut command = Command::new(exe);
        command.env("ELECTRON_RUN_AS_NODE", "1").arg(cli);
        command
    };
    for key in [
        "NODE_OPTIONS",
        "NODE_REPL_EXTERNAL_MODULE",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_NODE_OPTIONS",
        "VSCODE_NODE_REPL_EXTERNAL_MODULE",
    ] {
        command.env_remove(key);
    }
    command.args(arguments);
    Ok(command)
}

fn launch(tool: &str, arguments: Vec<OsString>) -> Result<(), String> {
    let mut child = editor_command(tool, arguments)?
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动开发工具失败：{e}"))?;
    let deadline = Instant::now() + Duration::from_millis(600);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("检查开发工具失败：{e}"))?
        {
            return if status.success() {
                Ok(())
            } else {
                Err(format!("编辑器命令行返回错误：{status}"))
            };
        }
        if Instant::now() >= deadline {
            thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub fn open_workspace(tool: &str, workspace: &Path, handoff: &Path) -> Result<(), String> {
    launch(tool, handoff_args(workspace, handoff)?)
}

pub fn open_project_file(
    tool: &str,
    workspace: &Path,
    relative: &str,
    line: u32,
) -> Result<(), String> {
    launch(tool, file_args(tool, workspace, relative, line)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn validates_real_targets_and_passes_separate_editor_arguments() {
        let temp = std::env::temp_dir().join(format!(
            "lumo-dev-tools-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = temp.join("project space");
        fs::create_dir_all(&workspace).unwrap();
        let handoff = temp.join("handoff.md");
        let source = workspace.join("-main file.rs");
        fs::write(&handoff, "context").unwrap();
        fs::write(&source, "code").unwrap();
        let canonical = local_path(&workspace).unwrap().into_os_string();
        assert_eq!(
            handoff_args(&workspace, &handoff).unwrap(),
            vec![
                canonical.clone(),
                local_path(&handoff).unwrap().into_os_string()
            ]
        );
        let mut location = local_path(&source).unwrap().into_os_string();
        location.push(":42:1");
        assert_eq!(
            file_args("zed", &workspace, "-main file.rs", 42).unwrap(),
            vec![canonical.clone(), location.clone()]
        );
        assert_eq!(
            file_args("vscode-insiders", &workspace, "-main file.rs", 42).unwrap(),
            vec![OsString::from("--goto"), canonical, location]
        );
        for invalid in [
            "",
            "../handoff.md",
            "--unknown",
            "https://example.org",
            "/etc/hosts",
            "a\nb",
            "missing",
        ] {
            assert!(
                file_args("zed", &workspace, invalid, 1).is_err(),
                "{invalid}"
            );
        }
        assert!(file_args("vscode", &workspace, "-main file.rs", 0).is_err());
        assert!(handoff_args(Path::new("."), &handoff).is_err());
        assert!(handoff_args(&workspace, &source).is_err());
        assert!(editor_cli("shell").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&handoff, workspace.join("external.md")).unwrap();
            assert!(file_args("zed", &workspace, "external.md", 1).is_err());
        }
        fs::remove_dir_all(&temp).unwrap();
    }
}
