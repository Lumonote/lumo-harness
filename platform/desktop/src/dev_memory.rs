use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const NOTES: &str = "开发笔记.md";
const CONTEXT: &str = "项目上下文.md";
const EMPTY_NOTES: &str = "# 开发笔记\n\n[当前目标与最近记录](项目上下文.md)\n\n";
const EDIT_LIMIT: usize = 256 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct Entry {
    pub kind: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub text: String,
    pub at: u64,
}

#[derive(Default, Debug, Serialize)]
pub struct Memory {
    pub entries: Vec<Entry>,
    pub library: Library,
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct Library {
    pub cards: Vec<Card>,
    pub aliases: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub sessions: std::collections::BTreeMap<String, SessionState>,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub pinned: bool,
    pub archived: bool,
    pub revision: u64,
}

pub fn session_state(memory: &Memory, provider: &str, session: &str) -> SessionState {
    memory
        .library
        .sessions
        .get(&format!("{provider}:{}", session.to_ascii_lowercase()))
        .cloned()
        .unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    pub category: String,
    pub title: String,
    pub body: String,
    pub revision: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CardSelection {
    pub id: String,
    pub revision: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSelection {
    pub provider: String,
    pub session: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffSelection {
    pub goal: bool,
    pub cards: Vec<CardSelection>,
    pub transcript: Option<SessionSelection>,
}

#[derive(Serialize)]
pub struct MemoryHandoff {
    pub text: String,
    pub digest: String,
}

/// Export only explicit selections. The digest binds a reviewed preview to the
/// exact current contents, including goals and imported transcripts.
pub fn selected_handoff(
    root: &Path,
    workspace_id: &str,
    selection: HandoffSelection,
    expected: Option<&str>,
) -> Result<MemoryHandoff, String> {
    with_project(root, workspace_id, |_, memory| {
        if selection.cards.len() > 64
            || (!selection.goal && selection.cards.is_empty() && selection.transcript.is_none())
        {
            return Err(invalid("请选择需要交接的目标、记忆或会话记录"));
        }
        let mut text = String::from("# 项目交接\n\n来源：Lumo 本地项目记忆，由用户选择导出。\n");
        if selection.goal {
            let goal = memory
                .entries
                .iter()
                .rev()
                .find(|e| e.kind == "goal")
                .ok_or_else(|| invalid("当前项目尚未保存目标"))?;
            text.push_str(&format!("\n## 当前目标\n\n{}\n", goal.text));
        }
        let mut seen = std::collections::HashSet::new();
        for chosen in selection.cards {
            if !seen.insert(chosen.id.clone()) {
                return Err(invalid("不能重复选择同一条记忆"));
            }
            let card = memory
                .library
                .cards
                .iter()
                .find(|c| c.id == chosen.id && c.revision == chosen.revision)
                .ok_or_else(|| invalid("所选记忆已变化，请刷新记录后重新预览"))?;
            let category = CATEGORIES
                .iter()
                .find(|(kind, _)| *kind == card.category)
                .map_or("记忆", |(_, label)| *label);
            text.push_str(&format!(
                "\n## {category}：{}\n\n{}\n",
                card.title, card.body
            ));
        }
        if let Some(session) = selection.transcript {
            if !super::dev_catalog::is_agent(&session.provider)
                || !session_id_valid(&session.session)
                || !linked(&memory, &session.provider, &session.session)
            {
                return Err(invalid("请选择本项目中已关联的编码助手会话"));
            }
            let entry = memory
                .entries
                .iter()
                .rev()
                .find(|e| {
                    e.kind == "transcript"
                        && e.tool == session.provider
                        && e.session
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&session.session))
                })
                .ok_or_else(|| invalid("所选会话尚未导入记录"))?;
            text.push_str(&format!(
                "\n## 用户导入的会话记录\n\n来源：{} · {}\n\n{}\n",
                session.provider, session.session, entry.text
            ));
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("{workspace_id}\0{text}").as_bytes())
        );
        if expected.is_some_and(|value| value != digest) {
            return Err(invalid("交接内容已变化，请重新预览后复制"));
        }
        Ok(MemoryHandoff { text, digest })
    })
}

const CATEGORIES: [(&str, &str); 4] = [
    ("preference", "协作偏好"),
    ("feedback", "反馈"),
    ("project", "项目约定"),
    ("reference", "参考资料"),
];

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum LibraryEdit {
    Create {
        category: String,
        title: String,
        body: String,
    },
    Update {
        id: String,
        revision: u64,
        category: String,
        title: String,
        body: String,
    },
    Remove {
        id: String,
        revision: u64,
    },
    SessionState {
        provider: String,
        session: String,
        revision: u64,
        pinned: bool,
        archived: bool,
    },
    Alias {
        provider: String,
        session: String,
        title: String,
    },
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg)
}

fn checked_card(category: &str, title: &str, body: &str) -> io::Result<()> {
    if !CATEGORIES.iter().any(|(key, _)| *key == category)
        || title.trim().is_empty()
        || title.chars().count() > 80
        || title.chars().any(char::is_control)
        || body.trim().is_empty()
        || body.len() > 4000
        || body.contains('\0')
    {
        return Err(invalid(
            "请选择记忆分类，填写 80 字以内的标题和 4000 字节以内的正文",
        ));
    }
    Ok(())
}

pub fn edit_library(root: &Path, project: &str, edit: LibraryEdit) -> Result<Memory, String> {
    use LibraryEdit::*;
    with_project(root, project, |dir, mut memory| {
        match edit {
            Create {
                category,
                title,
                body,
            } => {
                checked_card(&category, &title, &body)?;
                if memory.library.cards.len() >= 64 {
                    return Err(invalid("最多保存 64 条长期记忆"));
                }
                memory.library.cards.push(Card {
                    id: uuid::Uuid::new_v4().to_string(),
                    category,
                    title,
                    body,
                    revision: 1,
                });
            }
            Update {
                id,
                revision,
                category,
                title,
                body,
            } => {
                checked_card(&category, &title, &body)?;
                let card = memory
                    .library
                    .cards
                    .iter_mut()
                    .find(|c| c.id == id && c.revision == revision)
                    .ok_or_else(|| invalid("记忆已变化，请刷新后重试"))?;
                card.category = category;
                card.title = title;
                card.body = body;
                card.revision += 1;
            }
            Remove { id, revision } => {
                let index = memory
                    .library
                    .cards
                    .iter()
                    .position(|c| c.id == id && c.revision == revision)
                    .ok_or_else(|| invalid("记忆已变化，请刷新后重试"))?;
                memory.library.cards.remove(index);
            }
            SessionState {
                provider,
                session,
                revision,
                pinned,
                archived,
            } => {
                if !super::dev_catalog::is_agent(&provider)
                    || !session_id_valid(&session)
                    || !linked(&memory, &provider, &session)
                {
                    return Err(invalid("请选择当前项目中已关联的会话"));
                }
                let current = session_state(&memory, &provider, &session);
                if current.revision != revision {
                    return Err(invalid("会话整理状态已变化，请刷新记录后重试"));
                }
                memory.library.sessions.insert(
                    format!("{provider}:{}", session.to_ascii_lowercase()),
                    self::SessionState {
                        pinned,
                        archived,
                        revision: revision + 1,
                    },
                );
            }
            Alias {
                provider,
                session,
                title,
            } => {
                if !super::dev_catalog::is_agent(&provider)
                    || !session_id_valid(&session)
                    || !linked(&memory, &provider, &session)
                {
                    return Err(invalid("请选择当前项目中已关联的会话"));
                }
                if title.chars().count() > 80 || title.chars().any(char::is_control) {
                    return Err(invalid("会话备注名最多 80 字且不能换行"));
                }
                let key = format!("{provider}:{}", session.to_ascii_lowercase());
                if title.trim().is_empty() {
                    memory.library.aliases.remove(&key);
                } else {
                    memory.library.aliases.insert(key, title.trim().to_owned());
                }
            }
        }
        replace(
            &dir.join("library.json"),
            &serde_json::to_vec(&memory.library)?,
        )?;
        Ok(memory)
    })
}

fn ensure_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn private_file() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

// All writers use the project lock, so an unfinished temporary file belongs to
// an interrupted write. It never replaces the last committed record on restart.
fn stage(path: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let tmp = path.with_extension("pending");
    match fs::remove_file(&tmp) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let mut file = private_file().create_new(true).open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(tmp)
}

fn flush_directory(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::rename(stage(path, bytes)?, path)?;
    flush_directory(path.parent().expect("project directory"))
}

fn read_history(dir: &Path) -> io::Result<Memory> {
    let mut records = Vec::new();
    for item in fs::read_dir(dir.join("history"))? {
        let path = item?.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            records.push(path);
        }
    }
    records.sort_unstable();
    let mut memory = Memory::default();
    for (index, path) in records.iter().enumerate() {
        if path.file_name().and_then(|name| name.to_str()) != Some(&format!("{index:016}.json")) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "项目历史记录的序号不连续",
            ));
        }
        memory
            .entries
            .push(serde_json::from_reader(File::open(path)?)?);
    }
    Ok(memory)
}

fn record(
    dir: &Path,
    memory: &mut Memory,
    kind: &str,
    tool: &str,
    session: Option<&str>,
    text: &str,
) -> io::Result<()> {
    let entry = Entry {
        kind: kind.into(),
        tool: tool.into(),
        session: session.map(str::to_ascii_lowercase),
        text: text.into(),
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    let name = format!("{:016}.json", memory.entries.len());
    replace(
        &dir.join("history").join(name),
        &serde_json::to_vec(&entry)?,
    )?;
    memory.entries.push(entry);
    Ok(())
}

fn latest_note(memory: &Memory) -> &str {
    memory
        .entries
        .iter()
        .rev()
        .find(|e| e.kind == "editor")
        .map_or(EMPTY_NOTES, |e| e.text.as_str())
}

fn import_notes(dir: &Path, memory: &mut Memory) -> io::Result<()> {
    let path = dir.join(NOTES);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => (),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "开发笔记必须是普通文件",
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "开发笔记必须是普通文件",
        ));
    }
    let mut bytes = Vec::new();
    file.take((EDIT_LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > EDIT_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "开发笔记超过 256 KiB，请在编辑器中另存或缩短后重试",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "开发笔记需要保存为 UTF-8"))?;
    if latest_note(memory) != text {
        // An on-disk edit has no reliable editor identity, even if several
        // tools were launched. Keep the complete snapshot and leave tool empty.
        record(dir, memory, "editor", "", None, text)?;
    }
    Ok(())
}

fn with_project<T>(
    root: &Path,
    workspace_id: &str,
    action: impl FnOnce(&Path, Memory) -> io::Result<T>,
) -> Result<T, String> {
    if workspace_id.trim().is_empty() || workspace_id.len() > 8192 {
        return Err("工作区标识无效".into());
    }
    let dir = root.join(format!("{:x}", Sha256::digest(workspace_id.as_bytes())));
    (|| -> io::Result<T> {
        ensure_dir(&dir.join("history"))?;
        let lock = private_file()
            .read(true)
            .create(true)
            .truncate(false)
            .open(dir.join("memory.lock"))?;
        lock.lock()?;
        let mut memory = read_history(&dir)?;
        memory.library = match File::open(dir.join("library.json")) {
            Ok(file) => serde_json::from_reader(file)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Library::default(),
            Err(e) => return Err(e),
        };
        import_notes(&dir, &mut memory)?;
        action(&dir, memory)
    })()
    .map_err(|e| format!("项目开发记忆访问失败：{e}"))
}

/// 跨设备同步（memory_sync.rs）专用：在项目锁内读写长期记忆卡片；回调返回 true 时落盘。
pub fn with_cards<T>(
    root: &Path,
    workspace_id: &str,
    action: impl FnOnce(&Path, &mut Vec<Card>) -> io::Result<(T, bool)>,
) -> Result<T, String> {
    with_project(root, workspace_id, |dir, mut memory| {
        let (value, changed) = action(dir, &mut memory.library.cards)?;
        if changed {
            replace(&dir.join("library.json"), &serde_json::to_vec(&memory.library)?)?;
        }
        Ok(value)
    })
}

pub fn read(root: &Path, workspace_id: &str) -> Result<Memory, String> {
    with_project(root, workspace_id, |_, memory| Ok(memory))
}

fn session_id_valid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn linked(memory: &Memory, tool: &str, session: &str) -> bool {
    memory
        .entries
        .iter()
        .any(|e| e.kind == "session_link" && e.tool == tool && e.text.eq_ignore_ascii_case(session))
}

pub fn append(
    root: &Path,
    workspace_id: &str,
    kind: &str,
    tool: &str,
    text: &str,
) -> Result<Memory, String> {
    if !matches!(
        kind,
        "goal"
            | "note"
            | "opened"
            | "located"
            | "failed"
            | "session_link"
            | "session_open"
            | "session_failed"
    ) || text.trim().is_empty()
        || text.len() > 4000
    {
        return Err("开发记录类型或正文无效，内容最多 4000 字节".into());
    }
    if !tool.is_empty()
        && !super::dev_catalog::is_editor(tool)
        && !super::dev_catalog::is_agent(tool)
    {
        return Err("开发工具标识无效".into());
    }
    if kind.starts_with("session_") && !super::dev_catalog::is_agent(tool) {
        return Err("此工具不支持开发会话".into());
    }
    if kind == "session_link" && !session_id_valid(text) {
        return Err("无效的开发会话 ID".into());
    }
    with_project(root, workspace_id, |dir, mut memory| {
        if kind == "session_link" && linked(&memory, tool, text) {
            return Ok(memory);
        }
        record(dir, &mut memory, kind, tool, None, text)?;
        Ok(memory)
    })
}

pub fn transcript(
    root: &Path,
    workspace_id: &str,
    tool: &str,
    session: &str,
    text: &str,
) -> Result<Memory, String> {
    if !super::dev_catalog::is_agent(tool) || !session_id_valid(session) {
        return Err("工具或会话 ID 无效".into());
    }
    if text.len() > EDIT_LIMIT || text.trim().is_empty() || text.contains('\0') {
        return Err("会话交接需要非空的 UTF-8 文本，最多 256 KiB".into());
    }
    with_project(root, workspace_id, |dir, mut memory| {
        if !linked(&memory, tool, session) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "请先将此工具的会话关联到当前项目",
            ));
        }
        let latest = memory.entries.iter().rev().find(|e| {
            e.kind == "transcript"
                && e.tool == tool
                && e.session
                    .as_deref()
                    .is_some_and(|id| id.eq_ignore_ascii_case(session))
        });
        if latest.is_none_or(|e| e.text != text) {
            record(dir, &mut memory, "transcript", tool, Some(session), text)?;
        }
        Ok(memory)
    })
}

fn context_markdown(memory: &Memory) -> String {
    let goal = memory
        .entries
        .iter()
        .rev()
        .find(|e| e.kind == "goal")
        .map_or("尚未记录", |e| e.text.as_str());
    let mut result = format!("# 项目上下文\n\n## 当前目标\n\n{goal}\n\n");
    if !memory.library.cards.is_empty() {
        result.push_str("## 长期记忆\n\n");
        for (kind, label) in CATEGORIES {
            for card in memory.library.cards.iter().filter(|c| c.category == kind) {
                result.push_str(&format!("### {label}：{}\n\n{}\n\n", card.title, card.body));
            }
        }
    }
    result.push_str("## 最近记录\n\n");
    for entry in memory
        .entries
        .iter()
        .skip(memory.entries.len().saturating_sub(12))
    {
        let label = match entry.kind.as_str() {
            "goal" => "目标",
            "note" => "记录",
            "opened" => "打开工具",
            "located" => "定位文件",
            "failed" => "操作失败",
            "session_link" => "关联会话",
            "session_open" => "打开会话",
            "session_failed" => "会话打开失败",
            "transcript" => "导入会话交接",
            _ => "编辑笔记",
        };
        if entry.kind == "transcript" {
            result.push_str(&format!(
                "- {label} {}：{}（{} 字节）\n",
                entry.tool,
                entry.session.as_deref().unwrap_or(""),
                entry.text.len()
            ));
            continue;
        }
        let mut chars = entry.text.chars();
        let snippet: String = chars.by_ref().take(320).collect();
        result.push_str(&format!(
            "- {label} {}：{}{}\n",
            entry.tool,
            snippet.replace(['\r', '\n'], " "),
            if chars.next().is_some() { "…" } else { "" }
        ));
    }
    result.push_str("\n[编辑开发笔记](开发笔记.md)\n");
    result
}

pub fn context(root: &Path, workspace_id: &str) -> Result<String, String> {
    with_project(root, workspace_id, |_, memory| {
        let mut result = context_markdown(&memory);
        if let Some(entry) = memory.entries.iter().rev().find(|e| e.kind == "editor") {
            result.push_str("\n## 开发笔记全文\n\n");
            result.push_str(&entry.text);
            result.push('\n');
        }
        for &(tool, _) in super::dev_catalog::AGENTS {
            if let Some(entry) = memory
                .entries
                .iter()
                .rev()
                .find(|e| e.kind == "transcript" && e.tool == tool)
            {
                result.push_str(&format!(
                    "\n## {} 会话交接全文（{}）\n\n",
                    tool,
                    entry.session.as_deref().unwrap_or("")
                ));
                result.push_str(&entry.text);
                result.push('\n');
            }
        }
        Ok(result)
    })
}

pub fn handoff(root: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    with_project(root, workspace_id, |dir, memory| {
        replace(&dir.join(CONTEXT), context_markdown(&memory).as_bytes())?;
        let path = dir.join(NOTES);
        // Never truncate a file currently open in an editor. If it was moved
        // away, seed a new copy from the latest imported snapshot instead.
        if !path.try_exists()? {
            let tmp = stage(&path, latest_note(&memory).as_bytes())?;
            let linked = fs::hard_link(&tmp, &path);
            fs::remove_file(&tmp)?;
            match linked {
                Ok(()) => flush_directory(dir)?,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(e),
            }
        }
        Ok(path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let tick = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("lumo-memory-{}-{tick}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn selective_handoff_excludes_unselected_memory_and_rejects_unreviewed_changes() {
        let temp = Temp::new();
        let root = &temp.0;
        append(root, "work", "goal", "", "修复登录").unwrap();
        append(root, "work", "note", "", "私人补记不导出").unwrap();
        let library = edit_library(
            root,
            "work",
            LibraryEdit::Create {
                category: "project".into(),
                title: "验证方式".into(),
                body: "先运行集成测试".into(),
            },
        )
        .unwrap();
        let card = &library.library.cards[0];
        edit_library(
            root,
            "work",
            LibraryEdit::Create {
                category: "preference".into(),
                title: "个人偏好".into(),
                body: "不选择就不导出".into(),
            },
        )
        .unwrap();
        let selection = || HandoffSelection {
            goal: true,
            cards: vec![CardSelection {
                id: card.id.clone(),
                revision: 1,
            }],
            transcript: None,
        };
        let preview = selected_handoff(root, "work", selection(), None).unwrap();
        assert!(preview.text.contains("修复登录") && preview.text.contains("先运行集成测试"));
        assert!(!preview.text.contains("私人补记") && !preview.text.contains("个人偏好"));
        assert!(selected_handoff(root, "elsewhere", selection(), None).is_err());
        assert_eq!(
            selected_handoff(root, "work", selection(), Some(&preview.digest))
                .unwrap()
                .text,
            preview.text
        );
        append(root, "work", "goal", "", "新的未预览目标").unwrap();
        assert!(selected_handoff(root, "work", selection(), Some(&preview.digest)).is_err());
        edit_library(
            root,
            "work",
            LibraryEdit::Remove {
                id: card.id.clone(),
                revision: 1,
            },
        )
        .unwrap();
        assert!(selected_handoff(root, "work", selection(), None).is_err());
    }

    #[test]
    fn selective_transcript_handoff_uses_only_the_chosen_linked_session() {
        let temp = Temp::new();
        let id = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        append(&temp.0, "work", "session_link", "codex", &id).unwrap();
        append(&temp.0, "work", "session_link", "codex", &other).unwrap();
        transcript(&temp.0, "work", "codex", &id, "所选记录全文").unwrap();
        transcript(&temp.0, "work", "codex", &other, "另一会话记录").unwrap();
        let selection = || HandoffSelection {
            goal: false,
            cards: vec![],
            transcript: Some(SessionSelection {
                provider: "codex".into(),
                session: id.clone(),
            }),
        };
        let preview = selected_handoff(&temp.0, "work", selection(), None).unwrap();
        assert!(preview.text.contains("所选记录全文") && !preview.text.contains("另一会话记录"));
        transcript(&temp.0, "work", "codex", &id, "变更后的记录").unwrap();
        assert!(selected_handoff(&temp.0, "work", selection(), Some(&preview.digest)).is_err());
        assert!(selected_handoff(&temp.0, "other", selection(), None).is_err());
    }

    #[test]
    fn curated_memory_survives_history_rollover_and_stale_edits_cannot_restore_removed_text() {
        use LibraryEdit::*;
        let temp = Temp::new();
        let root = &temp.0;
        let act = |edit| edit_library(root, "work", edit);
        for i in 0..15 {
            append(root, "work", "note", "", &format!("日记{i}")).unwrap();
        }
        assert!(read(root, "work").unwrap().library.cards.is_empty());
        let mem = act(Create {
            category: "project".into(),
            title: "版本策略".into(),
            body: "旧约定".into(),
        })
        .unwrap();
        let id = mem.library.cards[0].id.clone();
        act(Update {
            id: id.clone(),
            revision: 1,
            category: "project".into(),
            title: "版本策略".into(),
            body: "保留旧标签".into(),
        })
        .unwrap();
        assert!(act(Remove {
            id: id.clone(),
            revision: 1
        })
        .is_err());
        let copied = context(root, "work").unwrap();
        assert!(
            copied.contains("保留旧标签")
                && !copied.contains("旧约定")
                && !copied.contains("日记0\n")
        );
        let doc = handoff(root, "work").unwrap().with_file_name(CONTEXT);
        assert!(fs::read_to_string(doc).unwrap().contains("保留旧标签"));
        assert!(!context(root, "elsewhere").unwrap().contains("保留旧标签"));
        act(Remove { id, revision: 2 }).unwrap();
        assert!(read(root, "work").unwrap().library.cards.is_empty());
        assert!(!context(root, "work").unwrap().contains("保留旧标签"));
    }

    #[test]
    fn session_alias_is_scoped_to_linked_provider_and_leaves_native_identity_intact() {
        let temp = Temp::new();
        let root = &temp.0;
        let id = uuid::Uuid::new_v4().to_string();
        let edit = |p: &str, tool: &str, title: &str| {
            edit_library(
                root,
                p,
                LibraryEdit::Alias {
                    provider: tool.into(),
                    session: id.to_uppercase(),
                    title: title.into(),
                },
            )
        };
        append(root, "a", "session_link", "codex", &id).unwrap();
        assert!(edit("b", "codex", "同名").is_err());
        assert!(edit("a", "claude-code", "同名").is_err());
        edit("a", "codex", "索引重建").unwrap();
        let snapshot = read(root, "a").unwrap();
        assert_eq!(snapshot.library.aliases[&format!("codex:{id}")], "索引重建");
        assert_eq!(snapshot.entries[0].text, id);
        assert!(edit("a", "codex", "").unwrap().library.aliases.is_empty());
    }

    #[test]
    fn retains_disk_edits_once_in_order_and_refreshes_context_without_overwriting_notes() {
        let temp = Temp::new();
        let root = &temp.0;
        let id = "组/../../alpha";
        append(root, id, "goal", "vscode", "恢复索引").unwrap();
        let path = handoff(root, id).unwrap();
        assert!(path.starts_with(root));
        assert_eq!(read(root, id).unwrap().entries.len(), 1);
        assert!(fs::read_to_string(path.with_file_name(CONTEXT))
            .unwrap()
            .contains("恢复索引"));
        let body = format!("{}\n 已修复 \r\n{}", EMPTY_NOTES, "进展".repeat(3000));
        fs::write(&path, &body).unwrap();
        let memory = append(root, id, "located", "trae-cn", "src/lib.rs:16").unwrap();
        assert_eq!(
            memory
                .entries
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            ["goal", "editor", "located"]
        );
        assert_eq!(memory.entries[1].text, body);
        assert!(memory.entries[1].tool.is_empty());
        assert_eq!(handoff(root, id).unwrap(), path);
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        assert!(
            fs::read_to_string(path.with_file_name(CONTEXT))
                .unwrap()
                .len()
                < 3000
        );
        assert_eq!(read(root, id).unwrap().entries.len(), 3);
        assert!(read(root, "alpha").unwrap().entries.is_empty());
        fs::write(&path, "").unwrap();
        assert_eq!(read(root, id).unwrap().entries.last().unwrap().text, "");
        fs::remove_file(&path).unwrap();
        handoff(root, id).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        assert_eq!(read(root, id).unwrap().entries.len(), 4);
    }

    #[test]
    fn concurrent_calls_keep_every_entry_and_import_one_edit() {
        let temp = Temp::new();
        let root = &temp.0;
        let path = handoff(root, "project").unwrap();
        fs::write(path, "测试通过").unwrap();
        std::thread::scope(|scope| {
            for i in 0..12 {
                scope.spawn(move || append(root, "project", "note", "", &i.to_string()).unwrap());
            }
        });
        let entries = read(root, "project").unwrap().entries;
        assert_eq!(entries.len(), 13);
        assert_eq!(entries[0].kind, "editor");
        assert_eq!(
            entries
                .iter()
                .skip(1)
                .map(|e| &e.text)
                .collect::<HashSet<_>>()
                .len(),
            12
        );
    }

    #[test]
    fn preserves_multiple_session_links_per_tool_and_project() {
        let temp = Temp::new();
        let root = &temp.0;
        let first = "123abc00-0000-4000-8000-100000000000";
        let second = "123abc00-0000-4000-8000-200000000000";
        for (tool, id) in [
            ("claude-code", first),
            ("codex", first),
            ("claude-code", second),
        ] {
            append(root, "p", "session_link", tool, id).unwrap();
        }
        append(
            root,
            "p",
            "session_link",
            "claude-code",
            &first.to_uppercase(),
        )
        .unwrap();
        append(root, "p", "session_open", "claude-code", first).unwrap();
        append(root, "p", "session_failed", "codex", "工具未安装").unwrap();
        assert!(append(root, "p", "session_link", "codex", "--other").is_err());
        assert!(append(root, "p", "session_link", "vscode", first).is_err());
        let memory = read(root, "p").unwrap();
        assert_eq!(memory.entries.len(), 5);
        assert_eq!(
            memory
                .entries
                .iter()
                .filter(|e| e.kind == "session_link" && e.tool == "claude-code")
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>(),
            [first, second]
        );
        assert!(read(root, "other").unwrap().entries.is_empty());
    }

    #[test]
    fn imports_exact_revision_only_for_linked_session_and_exports_latest_from_each_tool() {
        let temp = Temp::new();
        let root = &temp.0;
        let alpha = "ab123456-0000-4000-8000-000000000001";
        let beta = "ab123456-0000-4000-8000-000000000002";
        let first = "过时的决定";
        let final_claude = format!("\r\n{}\r\n", "完整的会话文本。".repeat(3000));
        let final_codex = " Codex 交接\r\n ";
        let notes = format!("{}\r\n[保留缩进]\n", "开发笔记\n".repeat(2000));
        append(root, "p", "session_link", "claude-code", alpha).unwrap();
        assert!(transcript(root, "p", "codex", alpha, final_codex).is_err());
        assert!(transcript(root, "other", "claude-code", alpha, first).is_err());
        assert!(transcript(root, "p", "vscode", alpha, first).is_err());
        assert!(transcript(root, "p", "claude-code", "bad", first).is_err());
        assert!(transcript(root, "p", "claude-code", alpha, &"x".repeat(EDIT_LIMIT + 1)).is_err());
        assert!(transcript(root, "p", "claude-code", alpha, "  ").is_err());
        append(root, "p", "goal", "", "交付目标").unwrap();
        let path = handoff(root, "p").unwrap();
        fs::write(path, &notes).unwrap();
        transcript(root, "p", "claude-code", &alpha.to_uppercase(), first).unwrap();
        append(root, "p", "session_link", "codex", alpha).unwrap();
        transcript(root, "p", "codex", alpha, final_codex).unwrap();
        append(root, "p", "session_link", "claude-code", beta).unwrap();
        transcript(root, "p", "claude-code", beta, first).unwrap();
        transcript(root, "p", "claude-code", beta, &final_claude).unwrap();
        let memory = transcript(
            root,
            "p",
            "claude-code",
            &beta.to_uppercase(),
            &final_claude,
        )
        .unwrap();
        let events: Vec<_> = memory
            .entries
            .iter()
            .filter(|e| e.kind == "transcript")
            .collect();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].session.as_deref(), Some(alpha));
        assert_eq!(events[3].text, final_claude);
        let copied = context(root, "p").unwrap();
        assert!(copied.contains(&notes) && copied.contains("交付目标"));
        assert!(copied.contains(&format!("claude-code 会话交接全文（{beta}）")));
        assert!(copied.contains(&format!("codex 会话交接全文（{alpha}）")));
        assert!(copied.contains(&final_claude) && copied.contains(final_codex));
        assert!(!copied.contains(first));
        assert!(!context(root, "other").unwrap().contains(final_codex));
        assert!(
            serde_json::from_str::<Entry>(r#"{"kind":"goal","tool":"","text":"旧版","at":0}"#)
                .unwrap()
                .session
                .is_none()
        );
    }

    #[test]
    fn oversized_drafts_and_broken_history_are_reported_without_data_loss() {
        let temp = Temp::new();
        let root = &temp.0;
        append(root, "p", "goal", "", "original").unwrap();
        let path = handoff(root, "p").unwrap();
        fs::write(&path, vec![b'x'; EDIT_LIMIT + 1]).unwrap();
        assert!(handoff(root, "p").is_err());
        assert!(append(root, "p", "note", "", "blocked").is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), EDIT_LIMIT as u64 + 1);
        fs::write(&path, EMPTY_NOTES).unwrap();
        assert_eq!(read(root, "p").unwrap().entries.len(), 1);
        let record = path.with_file_name("history").join("0000000000000000.json");
        fs::write(&record, b"truncated").unwrap();
        assert!(append(root, "p", "goal", "", "later").is_err());
        assert_eq!(fs::read(record).unwrap(), b"truncated");
    }

    #[cfg(unix)]
    #[test]
    fn private_workspace_files_and_no_import_of_symlinked_notes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = Temp::new();
        let root = &temp.0;
        append(root, "A", "opened", "cursor", "A").unwrap();
        let path = handoff(root, "A").unwrap();
        let dir = path.parent().unwrap();
        for path in [
            &path,
            &dir.join("memory.lock"),
            &dir.join("history/0000000000000000.json"),
            &dir.join(CONTEXT),
        ] {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
        }
        assert_eq!(fs::metadata(dir).unwrap().permissions().mode() & 0o077, 0);
        fs::remove_file(&path).unwrap();
        let external = root.join("external");
        fs::write(&external, "外部文件").unwrap();
        symlink(&external, &path).unwrap();
        assert!(read(root, "A").is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), "外部文件");
    }
}
