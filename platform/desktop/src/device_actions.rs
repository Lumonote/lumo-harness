//! 本机设备动作框架（P1）：注册表、风险等级、权限判定与调用账本。
//!
//! 参考 gugu `electron/device-actions/families/*` + `grants-store.ts` 的思路（按能力族注册、
//! 每个动作声明风险与所需系统权限），实现是自己写的精简版：
//!
//! * 注册表 [`catalog`]：每个动作声明 `risk`（low/high）与 `permissions`（macOS 辅助功能 / 屏幕录制）。
//! * 判定 [`decide`]：三值 allow/deny/ask，与 P1-12 `Decide` 同语义——
//!   未知动作 deny；被开关关闭 deny；系统权限缺失 deny（附明确提示）；高风险 ask；
//!   单机桌面默认放行低风险（`LUMO_DEVICE_ACTIONS_ALWAYS_ASK=1` 时低风险也 ask）。
//! * ask 只能由**本机原生确认框**放行（见 device_exec::confirm），HTTP 调用方（DSH worker、Agent、
//!   ACP 会话）无法替用户点「允许」；工作台里看到的 Ask 只是投影，可撤回、不可代答。
//! * 账本 [`Ledger`]：最近 200 次调用，含调用方 session_ref / run_id，供运行树与审计。
//!
//! 开关（环境变量，桌面进程读取）：
//! * `LUMO_DEVICE_ACTIONS=off` 整体关闭（接口仍在，全部 deny）。
//! * `LUMO_DEVICE_ACTIONS_INPUT=on` 打开鼠标键盘操控（默认关闭，属可选能力）。
//! * `LUMO_DEVICE_ACTIONS_ALWAYS_ASK=1` 所有动作都要本机确认。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    /// macOS「隐私与安全性 → 辅助功能」：合成鼠标键盘事件需要。
    Accessibility,
    /// macOS「隐私与安全性 → 屏幕录制」：截图需要。
    ScreenRecording,
}

impl Permission {
    pub fn hint(self) -> &'static str {
        match self {
            Permission::Accessibility => "缺少 macOS「辅助功能」权限：请打开 系统设置 → 隐私与安全性 → 辅助功能，勾选 Lumo（或 Lumo Desktop）后重启应用。",
            Permission::ScreenRecording => "缺少 macOS「屏幕录制」权限：请打开 系统设置 → 隐私与安全性 → 屏幕与系统录音，勾选 Lumo 后重启应用。",
        }
    }
    pub fn settings_url(self) -> &'static str {
        match self {
            Permission::Accessibility => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            Permission::ScreenRecording => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Family {
    Files,
    Clipboard,
    System,
    Screen,
    Input,
}

#[derive(Clone, Debug, Serialize)]
pub struct ActionSpec {
    pub id: &'static str,
    pub family: Family,
    pub title: &'static str,
    pub risk: Risk,
    pub permissions: &'static [Permission],
    /// 可选能力：需要额外开关才启用。
    pub optional: bool,
    /// 参数说明（给模型看的简短 schema 描述）。
    pub args: &'static str,
}

pub const CATALOG: &[ActionSpec] = &[
    ActionSpec { id: "open.path", family: Family::Files, title: "用默认应用打开本机文件或文件夹", risk: Risk::Low, permissions: &[], optional: false, args: "{path: 绝对路径}" },
    ActionSpec { id: "open.url", family: Family::Files, title: "用默认浏览器打开 http(s) 链接", risk: Risk::Low, permissions: &[], optional: false, args: "{url: http(s) 地址}" },
    ActionSpec { id: "open.app", family: Family::Files, title: "启动本机应用", risk: Risk::Low, permissions: &[], optional: false, args: "{app: 应用名，如 Safari}" },
    ActionSpec { id: "clipboard.write", family: Family::Clipboard, title: "写入剪贴板文本", risk: Risk::Low, permissions: &[], optional: false, args: "{text: 文本，≤1MB}" },
    ActionSpec { id: "clipboard.read", family: Family::Clipboard, title: "读取剪贴板文本", risk: Risk::High, permissions: &[], optional: false, args: "{}" },
    ActionSpec { id: "system.notify", family: Family::System, title: "发送系统通知", risk: Risk::Low, permissions: &[], optional: false, args: "{title: 标题, body?: 正文}" },
    ActionSpec { id: "screen.capture", family: Family::Screen, title: "截取整个屏幕（PNG 保存到应用数据目录）", risk: Risk::High, permissions: &[Permission::ScreenRecording], optional: false, args: "{}" },
    ActionSpec { id: "input.mouse", family: Family::Input, title: "移动鼠标 / 点击指定坐标", risk: Risk::High, permissions: &[Permission::Accessibility], optional: true, args: "{x: 数字, y: 数字, click?: 'left'|'right'|'none'}" },
    ActionSpec { id: "input.keyboard", family: Family::Input, title: "向前台应用输入文本", risk: Risk::High, permissions: &[Permission::Accessibility], optional: true, args: "{text: 文本，≤2000 字}" },
];

pub fn catalog() -> &'static [ActionSpec] {
    CATALOG
}

pub fn find(id: &str) -> Option<&'static ActionSpec> {
    CATALOG.iter().find(|spec| spec.id == id)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Switches {
    pub enabled: bool,
    pub input: bool,
    pub always_ask: bool,
}

fn truthy(value: Option<&str>) -> bool {
    matches!(value.map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("1") | Some("on") | Some("true") | Some("yes"))
}

fn falsy(value: Option<&str>) -> bool {
    matches!(value.map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("0") | Some("off") | Some("false") | Some("no"))
}

impl Switches {
    pub fn parse(enabled: Option<&str>, input: Option<&str>, always_ask: Option<&str>) -> Self {
        Switches { enabled: !falsy(enabled), input: truthy(input), always_ask: truthy(always_ask) }
    }
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok();
        Switches::parse(
            get("LUMO_DEVICE_ACTIONS").as_deref(),
            get("LUMO_DEVICE_ACTIONS_INPUT").as_deref(),
            get("LUMO_DEVICE_ACTIONS_ALWAYS_ASK").as_deref(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "effect", rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Ask { reason: String },
    Deny { code: String, reason: String, #[serde(skip_serializing_if = "Option::is_none")] settings_url: Option<String> },
}

fn deny(code: &str, reason: impl Into<String>) -> Decision {
    Decision::Deny { code: code.into(), reason: reason.into(), settings_url: None }
}

/// 判定顺序固定：开关 → 注册表 → 可选能力 → 系统权限 → 风险。任何一步都不能把 deny 抬成 allow。
pub fn decide(action: &str, switches: &Switches, granted: impl Fn(Permission) -> bool) -> Decision {
    if !switches.enabled {
        return deny("device_actions_disabled", "本机设备动作已关闭（LUMO_DEVICE_ACTIONS=off）");
    }
    let Some(spec) = find(action) else {
        return deny("unknown_action", format!("未知的设备动作：{action}"));
    };
    if spec.optional && spec.family == Family::Input && !switches.input {
        return deny("input_disabled", "鼠标键盘操控默认关闭；需要时设置 LUMO_DEVICE_ACTIONS_INPUT=on 后重启桌面应用");
    }
    if let Some(missing) = spec.permissions.iter().copied().find(|p| !granted(*p)) {
        return Decision::Deny { code: "os_permission_missing".into(), reason: missing.hint().into(), settings_url: Some(missing.settings_url().into()) };
    }
    if spec.risk == Risk::High {
        return Decision::Ask { reason: format!("高风险动作「{}」需要在本机确认", spec.title) };
    }
    if switches.always_ask {
        return Decision::Ask { reason: "已开启「所有设备动作都需确认」".into() };
    }
    Decision::Allow
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Caller {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

fn safe_ref(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    (!s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._:@/-".contains(c))).then(|| s.to_owned())
}

impl Caller {
    pub fn from_json(value: Option<&Value>) -> Caller {
        let v = value.unwrap_or(&Value::Null);
        Caller { session_ref: safe_ref(v.get("session_ref")), run_id: safe_ref(v.get("run_id")), agent: safe_ref(v.get("agent")) }
    }
}

pub fn valid_call_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CallState {
    /// 正在等待本机确认
    Confirming,
    Running,
    Succeeded,
    Failed,
    Denied,
    Rejected,
    Cancelled,
}

impl CallState {
    pub fn terminal(&self) -> bool {
        !matches!(self, CallState::Confirming | CallState::Running)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CallRecord {
    pub id: String,
    pub action: String,
    pub risk: Risk,
    pub state: CallState,
    pub caller: Caller,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub const LEDGER_LIMIT: usize = 200;

#[derive(Default)]
pub struct Ledger {
    rows: VecDeque<CallRecord>,
}

impl Ledger {
    /// 同一 call_id 不能重复登记（防重放）。
    pub fn begin(&mut self, record: CallRecord) -> Result<(), String> {
        if self.rows.iter().any(|r| r.id == record.id) {
            return Err("call_id 已使用".into());
        }
        if self.rows.len() >= LEDGER_LIMIT {
            if let Some(pos) = self.rows.iter().position(|r| r.state.terminal()) {
                self.rows.remove(pos);
            } else {
                return Err("进行中的设备动作过多".into());
            }
        }
        self.rows.push_back(record);
        Ok(())
    }
    /// 终态不可再变；返回是否成功迁移。
    pub fn update(&mut self, id: &str, state: CallState, summary: Option<String>, error: Option<String>, now: u64) -> bool {
        let Some(row) = self.rows.iter_mut().find(|r| r.id == id) else { return false };
        if row.state.terminal() {
            return false;
        }
        row.state = state;
        row.updated_at = now;
        if summary.is_some() {
            row.summary = summary;
        }
        if error.is_some() {
            row.error = error;
        }
        true
    }
    pub fn get(&self, id: &str) -> Option<&CallRecord> {
        self.rows.iter().find(|r| r.id == id)
    }
    pub fn list(&self) -> Vec<CallRecord> {
        self.rows.iter().rev().cloned().collect()
    }
}

pub fn catalog_json(switches: &Switches, granted: impl Fn(Permission) -> bool) -> Value {
    let actions: Vec<Value> = CATALOG
        .iter()
        .map(|spec| {
            let decision = decide(spec.id, switches, &granted);
            json!({ "spec": spec, "decision": decision })
        })
        .collect();
    json!({ "actions": actions, "switches": { "enabled": switches.enabled, "input": switches.input, "always_ask": switches.always_ask } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> Switches {
        Switches { enabled: true, input: false, always_ask: false }
    }

    #[test]
    fn catalog_ids_unique_and_high_risk_marked() {
        let mut ids: Vec<_> = CATALOG.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
        for id in ["clipboard.read", "screen.capture", "input.mouse", "input.keyboard"] {
            assert_eq!(find(id).unwrap().risk, Risk::High, "{id}");
        }
        assert_eq!(find("screen.capture").unwrap().permissions, &[Permission::ScreenRecording]);
    }

    #[test]
    fn low_risk_allowed_on_single_desktop() {
        assert_eq!(decide("open.path", &on(), |_| true), Decision::Allow);
        assert_eq!(decide("clipboard.write", &on(), |_| true), Decision::Allow);
    }

    #[test]
    fn high_risk_asks_and_always_ask_escalates() {
        assert!(matches!(decide("clipboard.read", &on(), |_| true), Decision::Ask { .. }));
        let s = Switches { always_ask: true, ..on() };
        assert!(matches!(decide("system.notify", &s, |_| true), Decision::Ask { .. }));
    }

    #[test]
    fn deny_paths() {
        let off = Switches { enabled: false, ..on() };
        assert!(matches!(decide("open.path", &off, |_| true), Decision::Deny { ref code, .. } if code == "device_actions_disabled"));
        assert!(matches!(decide("rm.rf", &on(), |_| true), Decision::Deny { ref code, .. } if code == "unknown_action"));
        assert!(matches!(decide("input.mouse", &on(), |_| true), Decision::Deny { ref code, .. } if code == "input_disabled"));
        let input = Switches { input: true, ..on() };
        match decide("input.keyboard", &input, |_| false) {
            Decision::Deny { code, reason, settings_url } => {
                assert_eq!(code, "os_permission_missing");
                assert!(reason.contains("辅助功能"));
                assert!(settings_url.unwrap().contains("Privacy_Accessibility"));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(decide("screen.capture", &on(), |_| false), Decision::Deny { ref reason, .. } if reason.contains("屏幕")));
    }

    #[test]
    fn switches_parse() {
        assert_eq!(Switches::parse(None, None, None), Switches { enabled: true, input: false, always_ask: false });
        assert!(!Switches::parse(Some("off"), None, None).enabled);
        assert!(Switches::parse(None, Some("on"), Some("1")).input);
    }

    #[test]
    fn caller_refs_sanitized() {
        let v = json!({"session_ref": "s-1", "run_id": "bad id\n", "agent": "claude-code"});
        let c = Caller::from_json(Some(&v));
        assert_eq!(c.session_ref.as_deref(), Some("s-1"));
        assert_eq!(c.run_id, None);
        assert!(valid_call_id("abc_1-2"));
        assert!(!valid_call_id("a b"));
    }

    #[test]
    fn ledger_rejects_replay_and_terminal_changes() {
        let mut l = Ledger::default();
        let rec = |id: &str| CallRecord { id: id.into(), action: "open.url".into(), risk: Risk::Low, state: CallState::Running, caller: Caller::default(), created_at: 0, updated_at: 0, summary: None, error: None };
        l.begin(rec("a")).unwrap();
        assert!(l.begin(rec("a")).is_err());
        assert!(l.update("a", CallState::Succeeded, Some("ok".into()), None, 1));
        assert!(!l.update("a", CallState::Failed, None, None, 2));
        assert_eq!(l.get("a").unwrap().state, CallState::Succeeded);
        for i in 0..LEDGER_LIMIT + 5 {
            let id = format!("x{i}");
            l.begin(rec(&id)).unwrap();
            l.update(&id, CallState::Succeeded, None, None, 3);
        }
        assert!(l.list().len() <= LEDGER_LIMIT);
    }
}
