//! 桌面端编码助手启动入口的 ACP 分流（P1）。
//!
//! 旧方式：`dev_agents::launch` 在 Terminal.app 里起 CLI，会话不进工作台。
//! 新方式（默认）：把「新建会话」请求投递给主窗口里的工作台，由 lumo-ui 的
//! `AcpSessionPanel` 通过 `/lumo/api/acp/sessions` 用 ACP 拉起引擎，会话、工具调用、
//! 权限请求都进工作台（运行树 + 统一 Ask）。
//!
//! 开关：环境变量 `LUMO_DESKTOP_AGENT_LAUNCH=terminal` 恢复旧方式；
//! 继续（resume）既有原生会话仍走终端（ACP 引擎的 session/load 能力因引擎而异）；
//! 工作台未就绪或投递失败时自动回退到终端，不让用户点了没反应。

use std::path::Path;

pub const MODE_ENV: &str = "LUMO_DESKTOP_AGENT_LAUNCH";

/// true = 走 ACP（默认）；false = 旧终端方式。
pub fn acp_enabled() -> bool {
    mode_is_acp(std::env::var(MODE_ENV).ok().as_deref())
}

pub fn mode_is_acp(value: Option<&str>) -> bool {
    !matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("terminal") | Some("legacy") | Some("cli") | Some("off")
    )
}

/// dev_catalog 的 provider id → acp-engines 注册表的引擎 id（目前一一对应）。
pub fn engine_id(provider: &str) -> Option<&'static str> {
    match provider {
        "claude-code" => Some("claude-code"),
        "codex" => Some("codex"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

fn js_string(value: &str) -> String {
    serde_json::Value::String(value.to_owned()).to_string()
}

/// 生成投递脚本：写 sessionStorage（面板挂载时消费）并广播事件（面板已挂载时立即响应）。
/// 返回 `{ok:true}`；工作台未加载完成时返回 `{error}`。
pub fn open_script(engine: &str, workspace: &Path) -> Result<String, String> {
    let cwd = workspace
        .to_str()
        .filter(|s| !s.chars().any(char::is_control))
        .ok_or("工作区路径需要有效文字且不能包含控制字符")?;
    Ok(format!(
        "(() => {{ try {{ if (!document.body) return {{error:'工作台正在加载'}}; const detail = {{ engineId: {engine}, cwd: {cwd}, at: Date.now() }}; sessionStorage.setItem('lumo.acpPending', JSON.stringify(detail)); window.dispatchEvent(new CustomEvent('lumo:acp-open', {{ detail }})); return {{ok:true}} }} catch (e) {{ return {{error:String(e && e.message || e)}} }} }})()",
        engine = js_string(engine),
        cwd = js_string(cwd),
    ))
}

/// 与 `dev_agents::launch` 同签名，可直接替换 session_action 的 launch 参数。
/// `deliver` 负责把脚本送进主窗口并返回 JSON 结果（生产里是 pet::evaluate）。
pub fn launch(
    provider: &str,
    workspace: &Path,
    id: Option<&str>,
    resume: bool,
    deliver: impl FnOnce(String) -> Result<serde_json::Value, String>,
) -> Result<(), String> {
    let legacy = || super::dev_agents::launch(provider, workspace, id, resume);
    if resume || !acp_enabled() {
        return legacy();
    }
    let Some(engine) = engine_id(provider) else {
        return legacy();
    };
    let delivered = open_script(engine, workspace)
        .and_then(deliver)
        .and_then(|value| match value["error"].as_str() {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        });
    match delivered {
        Ok(()) => Ok(()),
        Err(_) => legacy(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_switch() {
        assert!(mode_is_acp(None));
        assert!(mode_is_acp(Some("acp")));
        assert!(!mode_is_acp(Some("terminal")));
        assert!(!mode_is_acp(Some(" Legacy ")));
    }

    #[test]
    fn script_escapes_paths() {
        let script = open_script("codex", Path::new("/tmp/a'b\"c")).unwrap();
        assert!(script.contains(r#""/tmp/a'b\"c""#));
        assert!(script.contains("lumo:acp-open"));
        assert!(open_script("codex", Path::new("/tmp/a\nb")).is_err());
    }

    #[test]
    fn engine_mapping() {
        assert_eq!(engine_id("claude-code"), Some("claude-code"));
        assert_eq!(engine_id("vim"), None);
    }
}
