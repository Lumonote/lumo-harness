//! P1 跨设备记忆同步——桌面端同步引擎（纯逻辑 + 一个 Tauri 命令）。
//!
//! 网络请求由 Rust 侧发出（`memory_sync/http.rs`，命令 `pet_memory_sync_run`），页面只调 invoke，
//! 令牌不再经过 JS。本模块负责：差量计算（离线队列即「本地卡片 vs 上次同步快照」之差，天然持久）、
//! 混合逻辑时钟、应用拉取结果、冲突登记与解决。全部在 dev_memory 的项目锁内完成。
//!
//! 同步范围（MVP）：长期记忆卡片（library.cards）。目标/补记/会话整理暂不同步。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, WebviewWindow};

use super::dev_memory::Card;

mod http;

const STATE: &str = "sync.json";
const CONFIG: &str = "memory-sync.json";
const MAX_CARDS: usize = 64;

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub enabled: bool,
    pub server: String,
    #[serde(default)]
    pub token: String,
    pub device: String,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Synced {
    pub seq: i64,
    pub hash: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub payload: String,
    pub hlc: String,
    pub device: String,
    pub deleted: bool,
    pub seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    /// 本机当前内容（None = 本机已删除）
    pub local: Option<String>,
    /// 云端现值（deleted=true 为云端删除）
    pub remote: Item,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub cursor: i64,
    pub hlc_ms: u64,
    pub hlc_counter: u32,
    pub synced: BTreeMap<String, Synced>,
    pub conflicts: Vec<Conflict>,
    #[serde(default)]
    pub skipped: u32,
    #[serde(default)]
    pub last_sync_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub kind: String,
    pub payload: String,
    pub hlc: String,
    pub deleted: bool,
    pub base_seq: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ack {
    pub id: String,
    pub outcome: String,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub current: Option<Item>,
    /// 页面原样回传 prepare 时的 payload/deleted，用于记录「已同步快照」
    pub payload: String,
    pub deleted: bool,
}

#[derive(Serialize, Deserialize)]
struct CardData {
    category: String,
    title: String,
    body: String,
}

fn payload(card: &Card) -> String {
    serde_json::to_string(&CardData {
        category: card.category.clone(),
        title: card.title.clone(),
        body: card.body.clone(),
    })
    .expect("card payload")
}

pub fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 混合逻辑时钟：物理毫秒不回退；同毫秒内计数递增，计数溢出则借下一毫秒。
pub fn tick(state: &mut State, device: &str, physical: u64) -> String {
    if physical > state.hlc_ms {
        state.hlc_ms = physical;
        state.hlc_counter = 0;
    } else if state.hlc_counter >= 9999 {
        state.hlc_ms += 1;
        state.hlc_counter = 0;
    } else {
        state.hlc_counter += 1;
    }
    format!("{:013}-{:04}-{device}", state.hlc_ms, state.hlc_counter)
}

fn in_conflict(state: &State, id: &str) -> bool {
    state.conflicts.iter().any(|c| c.id == id)
}

/// 待推送变更 = 本地卡片相对上次同步快照的差。冲突中的条目不推送。
pub fn prepare(cards: &[Card], state: &mut State, device: &str, physical: u64) -> Vec<Change> {
    let mut out = Vec::new();
    for card in cards {
        if in_conflict(state, &card.id) {
            continue;
        }
        let body = payload(card);
        let hash = digest(&body);
        let base = match state.synced.get(&card.id) {
            Some(s) if !s.deleted && s.hash == hash => continue,
            Some(s) => s.seq,
            None => 0,
        };
        let hlc = tick(state, device, physical);
        out.push(Change { id: card.id.clone(), kind: "card".into(), payload: body, hlc, deleted: false, base_seq: base });
    }
    let ids: Vec<(String, i64)> = state
        .synced
        .iter()
        .filter(|(id, s)| !s.deleted && !cards.iter().any(|c| &c.id == *id))
        .map(|(id, s)| (id.clone(), s.seq))
        .collect();
    for (id, seq) in ids {
        if in_conflict(state, &id) {
            continue;
        }
        let hlc = tick(state, device, physical);
        out.push(Change { id, kind: "card".into(), payload: String::new(), hlc, deleted: true, base_seq: seq });
    }
    out
}

fn local_payload(cards: &[Card], id: &str) -> Option<String> {
    cards.iter().find(|c| c.id == id).map(payload)
}

pub fn ack(cards: &[Card], state: &mut State, results: Vec<Ack>) {
    for r in results {
        let snapshot = Synced { seq: r.seq, hash: if r.deleted { String::new() } else { digest(&r.payload) }, deleted: r.deleted };
        match (r.outcome.as_str(), r.current) {
            ("accepted", _) => {
                state.synced.insert(r.id, snapshot);
            }
            ("duplicate", cur) => {
                let seq = cur.map(|c| c.seq).unwrap_or(r.seq);
                state.synced.insert(r.id, Synced { seq, ..snapshot });
            }
            // 服务端没有这条却声称有基线：服务端数据丢失或换了服务器 → 当作新建重推
            ("conflict", None) => {
                state.synced.remove(&r.id);
            }
            ("conflict", Some(remote)) => {
                if !in_conflict(state, &r.id) {
                    let local = local_payload(cards, &r.id);
                    state.conflicts.push(Conflict { id: r.id, local, remote });
                }
            }
            _ => {}
        }
    }
}

fn parse(item: &Item) -> Option<CardData> {
    let data: CardData = serde_json::from_str(&item.payload).ok()?;
    let ok = !data.title.trim().is_empty() && data.title.chars().count() <= 80 && !data.body.trim().is_empty() && data.body.len() <= 4000;
    ok.then_some(data)
}

/// 把云端版本写进本地卡片；返回 false 表示内容不可用（格式错误或已满 64 条）。
fn write_remote(cards: &mut Vec<Card>, item: &Item) -> bool {
    if item.deleted {
        cards.retain(|c| c.id != item.id);
        return true;
    }
    let Some(data) = parse(item) else { return false };
    if let Some(card) = cards.iter_mut().find(|c| c.id == item.id) {
        card.category = data.category;
        card.title = data.title;
        card.body = data.body;
        card.revision += 1;
        return true;
    }
    if cards.len() >= MAX_CARDS {
        return false;
    }
    cards.push(Card { id: item.id.clone(), category: data.category, title: data.title, body: data.body, revision: 1 });
    true
}

fn remote_snapshot(item: &Item) -> Synced {
    Synced { seq: item.seq, hash: if item.deleted { String::new() } else { digest(&item.payload) }, deleted: item.deleted }
}

/// 应用拉取结果。返回是否改动了本地卡片。
pub fn apply(cards: &mut Vec<Card>, state: &mut State, items: Vec<Item>, cursor: i64) -> bool {
    let mut changed = false;
    for item in items {
        if item.kind != "card" {
            continue;
        }
        let local = local_payload(cards, &item.id);
        let local_hash = local.as_deref().map(digest);
        let base = state.synced.get(&item.id).cloned();
        let remote = remote_snapshot(&item);
        // 两端内容已经一致（含自己刚推上去的）：只推进基线
        if local_hash.as_deref().unwrap_or("") == remote.hash && local.is_some() != item.deleted {
            state.synced.insert(item.id.clone(), remote);
            continue;
        }
        let untouched = match (&base, &local_hash) {
            (Some(b), Some(h)) => !b.deleted && &b.hash == h,
            (Some(b), None) => b.deleted,
            (None, None) => true,
            (None, Some(_)) => false,
        };
        if untouched && !in_conflict(state, &item.id) {
            if write_remote(cards, &item) {
                changed = true;
                state.synced.insert(item.id.clone(), remote);
            } else {
                state.skipped += 1;
            }
        } else if let Some(existing) = state.conflicts.iter_mut().find(|c| c.id == item.id) {
            existing.remote = item;
        } else {
            state.conflicts.push(Conflict { id: item.id.clone(), local, remote: item });
        }
    }
    state.cursor = state.cursor.max(cursor);
    state.last_sync_ms = now_ms();
    changed
}

/// choice = "local"：保留本机，下次推送以云端 seq 为基线覆盖；"remote"：采用云端。
pub fn resolve(cards: &mut Vec<Card>, state: &mut State, id: &str, choice: &str) -> Result<bool, String> {
    let index = state.conflicts.iter().position(|c| c.id == id).ok_or("冲突已处理，请刷新")?;
    let conflict = state.conflicts.remove(index);
    match choice {
        "local" => {
            let mut base = remote_snapshot(&conflict.remote);
            base.hash = "\u{0}".into(); // 强制与本地不同 → 下次必推
            base.deleted = false;
            if cards.iter().all(|c| c.id != id) && conflict.remote.deleted {
                // 两边都删：直接采纳墓碑
                state.synced.insert(id.into(), remote_snapshot(&conflict.remote));
            } else {
                state.synced.insert(id.into(), base);
            }
            Ok(false)
        }
        "remote" => {
            if !write_remote(cards, &conflict.remote) {
                state.conflicts.insert(index, conflict);
                return Err("云端内容无法写入本机（格式无效或已满 64 条）".into());
            }
            state.synced.insert(id.into(), remote_snapshot(&conflict.remote));
            Ok(true)
        }
        _ => {
            state.conflicts.insert(index, conflict);
            Err("未知的冲突处理方式".into())
        }
    }
}

fn read_json<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> io::Result<T> {
    match File::open(path) {
        Ok(f) => Ok(serde_json::from_reader(f)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let tmp = path.with_extension("syncing");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(&serde_json::to_vec(value)?)?;
    f.sync_all()?;
    fs::rename(tmp, path)
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Status,
    Configure { enabled: bool, server: String, token: Option<String> },
    Prepare,
    Ack { results: Vec<Ack> },
    Apply { items: Vec<Item>, cursor: i64 },
    Resolve { id: String, choice: String },
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    pub server: String,
    pub has_token: bool,
    pub device: String,
    pub workspace: String,
    pub cursor: i64,
    pub pending: usize,
    pub skipped: u32,
    pub last_sync_ms: u64,
    pub conflicts: Vec<Conflict>,
    /// 仅 prepare 返回
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<Change>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

fn valid_server(server: &str) -> bool {
    server.is_empty() || http::parse_server(server).is_ok()
}

pub fn handle(root: &Path, workspace_id: &str, request: Request) -> Result<View, String> {
    let config_path = root.parent().ok_or("数据目录无效")?.join(CONFIG);
    let mut config: Config = read_json(&config_path).map_err(|e| e.to_string())?;
    if config.device.is_empty() {
        config.device = uuid::Uuid::new_v4().to_string();
        write_json(&config_path, &config).map_err(|e| e.to_string())?;
    }
    if let Request::Configure { enabled, server, token } = &request {
        let server = server.trim().trim_end_matches('/').to_string();
        if !valid_server(&server) || (*enabled && server.is_empty()) {
            return Err("同步服务器须为 https:// 地址".into());
        }
        config.enabled = *enabled;
        config.server = server;
        if let Some(t) = token {
            if t.len() > 4096 || t.contains(char::is_control) {
                return Err("访问令牌无效".into());
            }
            config.token = t.trim().to_string();
        }
        write_json(&config_path, &config).map_err(|e| e.to_string())?;
    }
    if !config.enabled && !matches!(request, Request::Status | Request::Configure { .. }) {
        return Err("跨设备同步未开启".into());
    }
    let device = config.device.clone();
    super::dev_memory::with_cards(root, workspace_id, move |dir, cards| {
        let path = dir.join(STATE);
        let mut state: State = read_json(&path)?;
        let workspace = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let mut changes = None;
        let mut changed = false;
        let fail = |m: String| io::Error::new(io::ErrorKind::InvalidInput, m);
        match request {
            Request::Status | Request::Configure { .. } => {}
            Request::Prepare => changes = Some(prepare(cards, &mut state, &device, now_ms())),
            Request::Ack { results } => ack(cards, &mut state, results),
            Request::Apply { items, cursor } => changed = apply(cards, &mut state, items, cursor),
            Request::Resolve { id, choice } => changed = resolve(cards, &mut state, &id, &choice).map_err(fail)?,
        }
        let pending = {
            let mut probe = state.clone();
            prepare(cards, &mut probe, &device, 0).len()
        };
        write_json(&path, &state)?;
        let token = changes.as_ref().map(|_| config.token.clone());
        Ok((
            View {
                enabled: config.enabled,
                server: config.server.clone(),
                has_token: !config.token.is_empty(),
                device: device.clone(),
                workspace,
                cursor: state.cursor,
                pending,
                skipped: state.skipped,
                last_sync_ms: state.last_sync_ms,
                conflicts: state.conflicts.clone(),
                changes,
                token,
            },
            changed,
        ))
    })
}

/// 页面只能发 status / configure / resolve；prepare/ack/apply 只在 Rust 同步流程内部使用。
fn page_allowed(request: &Request) -> bool {
    matches!(request, Request::Status | Request::Configure { .. } | Request::Resolve { .. })
}

fn for_page(mut view: View) -> View {
    view.token = None;
    view.changes = None;
    view
}

#[tauri::command]
pub async fn pet_memory_sync(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    request: Request,
) -> Result<View, String> {
    if !page_allowed(&request) {
        return Err("不支持的同步操作".into());
    }
    super::pet::with_dev_workspace(window, app, workspace_id, move |root, id, _| handle(root, id, request)).await.map(for_page)
}

const PUSH_BATCH: usize = 200;
const PULL_PAGES: usize = 20;

#[derive(Deserialize)]
struct PushResult {
    id: String,
    outcome: String,
    #[serde(default)]
    seq: i64,
    #[serde(default)]
    current: Option<Item>,
}

#[derive(Deserialize)]
struct PushReply {
    #[serde(default)]
    results: Vec<PushResult>,
}

#[derive(Deserialize)]
struct PullReply {
    #[serde(default)]
    items: Vec<Item>,
    cursor: Option<i64>,
    #[serde(default)]
    more: bool,
}

/// 把服务端 push 结果对回本批次已发送的变更（只认本批次里的 id）。
fn acks_for(batch: &[Change], results: Vec<PushResult>) -> Vec<Ack> {
    results
        .into_iter()
        .filter_map(|r| {
            let sent = batch.iter().find(|c| c.id == r.id)?;
            Some(Ack { id: r.id, outcome: r.outcome, seq: r.seq, current: r.current, payload: sent.payload.clone(), deleted: sent.deleted })
        })
        .collect()
}

/// 一次完整同步：先推后拉。离线/失败时在 ack 之前返回错误，待推送内容仍是本地差量，下次自动补推。
#[tauri::command]
pub async fn pet_memory_sync_run(window: WebviewWindow, app: AppHandle, workspace_id: String) -> Result<View, String> {
    let step = |request: Request| {
        let (w, a, id) = (window.clone(), app.clone(), workspace_id.clone());
        super::pet::with_dev_workspace(w, a, id, move |root, id, _| handle(root, id, request))
    };
    let prepared = step(Request::Prepare).await?;
    let remote = http::Remote::new(&prepared.server, prepared.token.as_deref().unwrap_or_default())?;
    let changes = prepared.changes.clone().unwrap_or_default();
    for batch in changes.chunks(PUSH_BATCH) {
        let body = serde_json::json!({ "workspace": prepared.workspace, "device": prepared.device, "changes": batch });
        let reply: PushReply = remote.push(&body).await?;
        step(Request::Ack { results: acks_for(batch, reply.results) }).await?;
    }
    let mut cursor = prepared.cursor;
    let mut view = None;
    for _ in 0..PULL_PAGES {
        let body: PullReply = remote.pull(&prepared.workspace, cursor).await?;
        let next = step(Request::Apply { items: body.items, cursor: body.cursor.unwrap_or(cursor) }).await?;
        cursor = next.cursor;
        view = Some(next);
        if !body.more {
            break;
        }
    }
    Ok(for_page(view.unwrap_or(prepared)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, title: &str) -> Card {
        Card { id: id.into(), category: "project".into(), title: title.into(), body: "正文".into(), revision: 1 }
    }
    fn item(id: &str, title: &str, seq: i64, deleted: bool) -> Item {
        let payload = if deleted { String::new() } else { payload(&card(id, title)) };
        Item { id: id.into(), kind: "card".into(), payload, hlc: "0000000000001-0000-x".into(), device: "other".into(), deleted, seq }
    }
    fn accept_all(cards: &[Card], state: &mut State, changes: &[Change], seq0: i64) {
        let acks = changes
            .iter()
            .enumerate()
            .map(|(i, c)| Ack { id: c.id.clone(), outcome: "accepted".into(), seq: seq0 + i as i64, current: None, payload: c.payload.clone(), deleted: c.deleted })
            .collect();
        ack(cards, state, acks);
    }

    #[test]
    fn hlc_is_monotonic_even_when_clock_goes_back() {
        let mut s = State::default();
        let a = tick(&mut s, "d", 2000);
        let b = tick(&mut s, "d", 1000);
        let c = tick(&mut s, "d", 3000);
        assert!(a < b && b < c, "{a} {b} {c}");
    }

    #[test]
    fn offline_edits_queue_until_acked_then_tombstone_on_delete() {
        let mut s = State::default();
        let mut cards = vec![card("a", "一"), card("b", "二")];
        let first = prepare(&cards, &mut s, "d", 1);
        assert_eq!(first.len(), 2);
        // 离线：未 ack，再次 prepare 仍然是同样两条（队列持久）
        assert_eq!(prepare(&cards, &mut s, "d", 2).len(), 2);
        accept_all(&cards, &mut s, &first, 1);
        assert!(prepare(&cards, &mut s, "d", 3).is_empty());
        cards.retain(|c| c.id != "a");
        let del = prepare(&cards, &mut s, "d", 4);
        assert_eq!(del.len(), 1);
        assert!(del[0].deleted && del[0].base_seq == 1 && del[0].payload.is_empty());
    }

    #[test]
    fn pull_applies_untouched_and_flags_concurrent_edits() {
        let mut s = State::default();
        let mut cards = vec![card("a", "一"), card("b", "二")];
        let ch = prepare(&cards, &mut s, "d", 1);
        accept_all(&cards, &mut s, &ch, 1);
        cards[1].title = "本机改".into(); // b 本地有未推修改
        let changed = apply(&mut cards, &mut s, vec![item("a", "云端改", 10, false), item("b", "云端也改", 11, false), item("c", "新条目", 12, false)], 12);
        assert!(changed);
        assert_eq!(cards.iter().find(|c| c.id == "a").unwrap().title, "云端改");
        assert_eq!(cards.iter().find(|c| c.id == "a").unwrap().revision, 2);
        assert!(cards.iter().any(|c| c.id == "c"));
        assert_eq!(cards.iter().find(|c| c.id == "b").unwrap().title, "本机改");
        assert_eq!(s.conflicts.len(), 1);
        assert_eq!(s.cursor, 12);
        // 冲突条目不被推送
        assert!(prepare(&cards, &mut s, "d", 5).iter().all(|c| c.id != "b"));
    }

    #[test]
    fn resolve_local_forces_overwrite_and_remote_adopts_cloud() {
        let mut s = State::default();
        let mut cards = vec![card("a", "一"), card("b", "二")];
        let ch = prepare(&cards, &mut s, "d", 1);
        accept_all(&cards, &mut s, &ch, 1);
        cards[0].title = "本机A".into();
        cards[1].title = "本机B".into();
        apply(&mut cards, &mut s, vec![item("a", "云A", 7, false), item("b", "云B", 8, true)], 8);
        assert_eq!(s.conflicts.len(), 2);
        resolve(&mut cards, &mut s, "a", "local").unwrap();
        let next = prepare(&cards, &mut s, "d", 9);
        let a = next.iter().find(|c| c.id == "a").unwrap();
        assert_eq!(a.base_seq, 7);
        assert!(resolve(&mut cards, &mut s, "b", "remote").unwrap());
        assert!(cards.iter().all(|c| c.id != "b"), "采用云端删除");
        assert!(resolve(&mut cards, &mut s, "b", "remote").is_err());
    }

    #[test]
    fn server_conflict_from_push_registers_and_lost_server_rebases() {
        let mut s = State::default();
        let cards = vec![card("a", "一"), card("b", "二")];
        let acks = vec![
            Ack { id: "a".into(), outcome: "conflict".into(), seq: 4, current: Some(item("a", "云", 4, false)), payload: String::new(), deleted: false },
            Ack { id: "b".into(), outcome: "conflict".into(), seq: 0, current: None, payload: String::new(), deleted: false },
        ];
        s.synced.insert("b".into(), Synced { seq: 3, hash: "x".into(), deleted: false });
        ack(&cards, &mut s, acks);
        assert_eq!(s.conflicts.len(), 1);
        assert!(!s.synced.contains_key("b"));
        assert_eq!(prepare(&cards, &mut s, "d", 1).iter().find(|c| c.id == "b").unwrap().base_seq, 0);
    }

    #[test]
    fn invalid_or_overflow_remote_items_are_skipped_without_loss() {
        let mut s = State::default();
        let mut cards: Vec<Card> = (0..MAX_CARDS).map(|i| card(&format!("k{i}"), "t")).collect();
        let mut bad = item("z", "t", 3, false);
        bad.payload = "不是 JSON（可能是另一台设备开了端到端加密）".into();
        apply(&mut cards, &mut s, vec![item("new", "满了", 2, false), bad], 3);
        assert_eq!(cards.len(), MAX_CARDS);
        assert_eq!(s.skipped, 2);
        assert_eq!(s.cursor, 3);
    }

    #[test]
    fn server_must_be_https_or_loopback() {
        assert!(valid_server("https://lumo.example.com"));
        assert!(valid_server("http://127.0.0.1:8086"));
        assert!(!valid_server("http://lumo.example.com"));
        assert!(!valid_server("https://a b"));
        assert!(!valid_server("http://127.0.0.1.evil.com"));
        assert!(valid_server(""));
    }

    #[test]
    fn page_cannot_drive_internal_ops_or_see_token() {
        assert!(page_allowed(&Request::Status));
        assert!(!page_allowed(&Request::Prepare));
        assert!(!page_allowed(&Request::Apply { items: vec![], cursor: 0 }));
        let view = for_page(View { token: Some("secret".into()), changes: Some(vec![]), ..View::default() });
        assert!(view.token.is_none() && view.changes.is_none());
        assert!(!serde_json::to_string(&view).unwrap().contains("secret"));
    }

    #[test]
    fn push_results_only_ack_sent_ids_with_sent_payload() {
        let batch = vec![Change { id: "c1".into(), kind: "card".into(), payload: "p".into(), hlc: "h".into(), deleted: false, base_seq: 0 }];
        let reply: PushReply = serde_json::from_str(r#"{"results":[{"id":"c1","outcome":"accepted","seq":7},{"id":"zz","outcome":"accepted"}]}"#).unwrap();
        let acks = acks_for(&batch, reply.results);
        assert_eq!(acks.len(), 1);
        assert_eq!((acks[0].seq, acks[0].payload.as_str(), acks[0].deleted), (7, "p", false));
    }
}
