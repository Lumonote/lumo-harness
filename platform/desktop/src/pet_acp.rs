//! 桌宠 dev_action 的 ACP 接入（P1）：新建会话默认交给工作台走 ACP（见 acp_launch.rs）；
//! 拿不到主窗口时 acp_launch 自动回退终端。从 pet.rs 挪出以控制文件大小，行为不变。
use std::path::Path;

use tauri::AppHandle;

pub(crate) fn launcher(
    app: &AppHandle,
) -> impl FnOnce(&str, &Path, Option<&str>, bool) -> Result<(), String> {
    let acp_main = super::pet::connected_main(app).ok();
    move |provider: &str, path: &Path, session: Option<&str>, resume: bool| {
        super::acp_launch::launch(provider, path, session, resume, |script| {
            acp_main
                .as_ref()
                .ok_or_else(|| "主窗口未连接".to_string())
                .and_then(|main| super::pet::evaluate(main, script))
        })
    }
}
