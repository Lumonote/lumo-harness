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
    collections::{BTreeMap, BTreeSet},
    time::{SystemTime, UNIX_EPOCH},
};

use super::dev_memory::Card;

mod http;
mod reconciliation;
mod runner;
mod storage;
#[cfg(test)]
mod storage_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transport_tests;

use storage::Operation;
pub use storage::{Request, View};
use tauri::{AppHandle, WebviewWindow};

const MAX_CARDS: usize = 64;

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
    /// Full reconciliation may find the previously observed cloud version missing.
    #[serde(default)]
    pub remote_missing: bool,
    /// Previously received versions retained across a server rollback until the user chooses.
    #[serde(default)]
    pub alternatives: Vec<Item>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingResolution {
    /// The user's chosen payload (None means deletion), retained until its submission succeeds.
    pub selected: Option<String>,
    /// Actual reviewed cloud fingerprint and CAS sequence; None means confirmed absence.
    pub expected_remote: Option<Synced>,
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
    #[serde(default)]
    pub last_full_sync_ms: u64,
    #[serde(default)]
    pub deferred: BTreeMap<String, Item>,
    #[serde(default)]
    pub pending_resolutions: BTreeMap<String, PendingResolution>,
    // Legacy state had no authenticated scope. Retain only deletion intent until a fresh pull.
    #[serde(default)]
    pub legacy_missing: BTreeSet<String>,
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
        if in_conflict(state, &card.id) || state.deferred.contains_key(&card.id) {
            continue;
        }
        let body = payload(card);
        let hash = digest(&body);
        let base = if let Some(choice) = state.pending_resolutions.get(&card.id) {
            choice
                .expected_remote
                .as_ref()
                .map_or(0, |remote| remote.seq)
        } else {
            match state.synced.get(&card.id) {
                Some(s) if !s.deleted && s.hash == hash => continue,
                Some(s) => s.seq,
                None => 0,
            }
        };
        let hlc = tick(state, device, physical);
        out.push(Change {
            id: card.id.clone(),
            kind: "card".into(),
            payload: body,
            hlc,
            deleted: false,
            base_seq: base,
        });
    }
    let mut ids: BTreeMap<String, i64> = state
        .synced
        .iter()
        .filter(|(id, s)| !s.deleted && !cards.iter().any(|c| &c.id == *id))
        .map(|(id, s)| (id.clone(), s.seq))
        .collect();
    for (id, choice) in &state.pending_resolutions {
        if cards.iter().all(|card| &card.id != id) {
            ids.insert(
                id.clone(),
                choice
                    .expected_remote
                    .as_ref()
                    .map_or(0, |remote| remote.seq),
            );
        }
    }
    for (id, seq) in ids {
        if in_conflict(state, &id) || state.deferred.contains_key(&id) {
            continue;
        }
        let hlc = tick(state, device, physical);
        out.push(Change {
            id,
            kind: "card".into(),
            payload: String::new(),
            hlc,
            deleted: true,
            base_seq: seq,
        });
    }
    out
}

fn local_payload(cards: &[Card], id: &str) -> Option<String> {
    cards.iter().find(|c| c.id == id).map(payload)
}

pub fn ack(cards: &[Card], state: &mut State, results: Vec<Ack>) {
    for r in results {
        let snapshot = Synced {
            seq: r.seq,
            hash: if r.deleted {
                String::new()
            } else {
                digest(&r.payload)
            },
            deleted: r.deleted,
        };
        match (r.outcome.as_str(), r.current) {
            ("accepted", _) => {
                state.pending_resolutions.remove(&r.id);
                state.synced.insert(r.id, snapshot);
            }
            ("duplicate", cur) => {
                state.pending_resolutions.remove(&r.id);
                let seq = cur.map(|c| c.seq).unwrap_or(r.seq);
                state.synced.insert(r.id, Synced { seq, ..snapshot });
            }
            // 服务端没有这条却声称有基线：服务端数据丢失或换了服务器 → 当作新建重推
            ("conflict", None) => {
                if reconciliation::observe_resolution(
                    state,
                    &r.id,
                    local_payload(cards, &r.id),
                    None,
                ) {
                    continue;
                }
                if r.deleted {
                    state.synced.insert(
                        r.id,
                        Synced {
                            seq: 0,
                            hash: "\u{0}".into(),
                            deleted: false,
                        },
                    );
                } else {
                    state.synced.remove(&r.id);
                }
            }
            ("conflict", Some(remote)) => {
                if reconciliation::observe_resolution(
                    state,
                    &r.id,
                    local_payload(cards, &r.id),
                    Some(remote.clone()),
                ) {
                    continue;
                }
                if !in_conflict(state, &r.id) {
                    let local = local_payload(cards, &r.id);
                    state.conflicts.push(Conflict {
                        id: r.id,
                        local,
                        remote,
                        remote_missing: false,
                        alternatives: vec![],
                    });
                }
            }
            _ => {}
        }
    }
}

fn parse(item: &Item) -> Option<CardData> {
    let data: CardData = serde_json::from_str(&item.payload).ok()?;
    let ok = !data.title.trim().is_empty()
        && data.title.chars().count() <= 80
        && !data.body.trim().is_empty()
        && data.body.len() <= 4000;
    ok.then_some(data)
}

/// 把云端版本写进本地卡片；返回 false 表示内容不可用（格式错误或已满 64 条）。
fn write_remote(cards: &mut Vec<Card>, item: &Item) -> bool {
    if item.deleted {
        cards.retain(|c| c.id != item.id);
        return true;
    }
    let Some(data) = parse(item) else {
        return false;
    };
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
    cards.push(Card {
        id: item.id.clone(),
        category: data.category,
        title: data.title,
        body: data.body,
        revision: 1,
    });
    true
}

fn remote_snapshot(item: &Item) -> Synced {
    Synced {
        seq: item.seq,
        hash: if item.deleted {
            String::new()
        } else {
            digest(&item.payload)
        },
        deleted: item.deleted,
    }
}

/// 应用拉取结果。返回是否改动了本地卡片。
pub fn apply(cards: &mut Vec<Card>, state: &mut State, items: Vec<Item>, cursor: i64) -> bool {
    // Merge before replay: an incoming tombstone/new version must supersede a queued old value.
    let mut pending = std::mem::take(&mut state.deferred);
    for item in items {
        if item.kind != "card" {
            continue;
        }
        if pending.get(&item.id).is_none_or(|old| old.seq < item.seq) {
            pending.insert(item.id.clone(), item);
        }
    }
    let mut ordered: Vec<Item> = pending.into_values().collect();
    ordered.sort_by_key(|item| item.seq);
    let mut changed = false;
    for item in ordered {
        let latest = state.synced.get(&item.id).map_or(0, |v| v.seq).max(
            state
                .conflicts
                .iter()
                .find(|v| v.id == item.id)
                .map_or(0, |v| v.remote.seq),
        );
        if item.seq < latest {
            continue;
        }
        let local = local_payload(cards, &item.id);
        if reconciliation::observe_resolution(state, &item.id, local.clone(), Some(item.clone())) {
            continue;
        }
        if let Some(existing) = state
            .conflicts
            .iter_mut()
            .find(|c| c.id == item.id && (c.remote_missing || !c.alternatives.is_empty()))
        {
            reconciliation::update_conflict(existing, local, Some(item));
            continue;
        }
        let local_hash = local.as_deref().map(digest);
        let base = state.synced.get(&item.id).cloned();
        let remote = remote_snapshot(&item);
        if base.as_ref() == Some(&remote) && !in_conflict(state, &item.id) {
            continue; // Our own acknowledged record does not invalidate a later local edit.
        }
        if local_hash.as_deref().unwrap_or("") == remote.hash && local.is_some() != item.deleted {
            state.synced.insert(item.id.clone(), remote);
            state.legacy_missing.remove(&item.id);
            state.conflicts.retain(|c| c.id != item.id);
            continue;
        }
        let untouched = match (&base, &local_hash) {
            (Some(b), Some(h)) => !b.deleted && &b.hash == h,
            (Some(b), None) => b.deleted,
            (None, None) => !state.legacy_missing.contains(&item.id),
            (None, Some(_)) => false,
        };
        if untouched && !in_conflict(state, &item.id) {
            if write_remote(cards, &item) {
                changed = true;
                state.synced.insert(item.id.clone(), remote);
                state.legacy_missing.remove(&item.id);
            } else {
                state.deferred.insert(item.id.clone(), item);
            }
        } else if let Some(existing) = state.conflicts.iter_mut().find(|c| c.id == item.id) {
            existing.local = local;
            existing.remote = item;
        } else {
            state.conflicts.push(Conflict {
                id: item.id.clone(),
                local,
                remote: item,
                remote_missing: false,
                alternatives: vec![],
            });
        }
    }
    state.skipped = state.deferred.len().try_into().unwrap_or(u32::MAX);
    state.cursor = state.cursor.max(cursor);
    changed
}

/// choice = "local"：保留本机，下次推送以云端 seq 为基线覆盖；"remote"：采用云端。
pub fn resolve(
    cards: &mut Vec<Card>,
    state: &mut State,
    id: &str,
    choice: &str,
) -> Result<bool, String> {
    let index = state
        .conflicts
        .iter()
        .position(|c| c.id == id)
        .ok_or("冲突已处理，请刷新")?;
    let conflict = state.conflicts.remove(index);
    let selected = match choice {
        "local" => None,
        "remote" => Some(conflict.remote.clone()),
        choice if choice.starts_with("saved:") => {
            let selected = choice[6..]
                .parse::<usize>()
                .ok()
                .and_then(|i| conflict.alternatives.get(i))
                .cloned();
            if selected.is_none() {
                state.conflicts.insert(index, conflict);
                return Err("已保留版本不存在，请刷新".into());
            }
            selected
        }
        _ => {
            state.conflicts.insert(index, conflict);
            return Err("未知的冲突处理方式".into());
        }
    };
    let changed = if let Some(item) = &selected {
        if !write_remote(cards, item) {
            state.conflicts.insert(index, conflict);
            return Err("所选内容无法写入本机（格式无效或已满 64 条）".into());
        }
        true
    } else {
        false
    };
    state.legacy_missing.remove(id);
    let local = local_payload(cards, id);
    let same_as_remote = !conflict.remote_missing
        && local.as_deref().map(digest).unwrap_or_default()
            == remote_snapshot(&conflict.remote).hash
        && local.is_some() != conflict.remote.deleted;
    let expected_remote = (!conflict.remote_missing).then(|| remote_snapshot(&conflict.remote));
    if let Some(remote) = &expected_remote {
        state.synced.insert(id.into(), remote.clone());
    } else {
        state.synced.remove(id);
    }
    if same_as_remote {
        state.pending_resolutions.remove(id);
    } else {
        state.pending_resolutions.insert(
            id.into(),
            PendingResolution {
                selected: local,
                expected_remote,
            },
        );
    }
    Ok(changed)
}

#[tauri::command]
pub async fn pet_memory_sync(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    request: Request,
) -> Result<View, String> {
    super::pet::with_dev_workspace(window, app, workspace_id, move |root, id, _| {
        storage::handle(root, id, Operation::Page(request))
    })
    .await
}

#[tauri::command]
pub async fn pet_memory_sync_run(
    window: WebviewWindow,
    app: AppHandle,
    workspace_id: String,
    full: Option<bool>,
) -> Result<View, String> {
    let _flight = runner::InFlight::acquire(&workspace_id)?;
    runner::run(full.unwrap_or(false), |operation| {
        let (w, a, id) = (window.clone(), app.clone(), workspace_id.clone());
        super::pet::with_dev_workspace(w, a, id, move |root, id, _| {
            storage::handle(root, id, operation)
        })
    })
    .await
}
