use super::{
    storage::{Operation, Session},
    Ack, Change, Item, View,
};
use serde::Deserialize;
use std::{collections::BTreeSet, future::Future, sync::Mutex};

const PUSH_BATCH: usize = 200;
const PULL_PAGES: usize = 20;
const PULL_PAGE_SIZE: usize = 500;
const FULL_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
static IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

pub(super) struct InFlight(String);
impl InFlight {
    pub fn acquire(workspace: &str) -> Result<Self, String> {
        let mut active = IN_FLIGHT.lock().map_err(|_| "同步状态不可用")?;
        if !active.insert(workspace.into()) {
            return Err("该项目正在同步，请稍后重试".into());
        }
        Ok(Self(workspace.into()))
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut active) = IN_FLIGHT.lock() {
            active.remove(&self.0);
        }
    }
}

#[derive(Deserialize)]
pub(super) struct PushResult {
    id: String,
    outcome: String,
    #[serde(default)]
    seq: i64,
    #[serde(default)]
    current: Option<Item>,
}
#[derive(Deserialize)]
pub(super) struct PushReply {
    pub results: Vec<PushResult>,
}
#[derive(Deserialize)]
struct PullReply {
    items: Vec<Item>,
    cursor: i64,
    more: bool,
}

pub(super) fn acks_for(batch: &[Change], results: Vec<PushResult>) -> Result<Vec<Ack>, String> {
    if results.len() != batch.len() {
        return Err("push_invalid_response".into());
    }
    let mut seen = BTreeSet::new();
    results
        .into_iter()
        .map(|r| {
            let sent = batch
                .iter()
                .find(|c| c.id == r.id)
                .ok_or("push_invalid_response")?;
            if !seen.insert(r.id.clone())
                || !matches!(r.outcome.as_str(), "accepted" | "duplicate" | "conflict")
                || r.seq < 0
            {
                return Err("push_invalid_response".into());
            }
            Ok(Ack {
                id: r.id,
                outcome: r.outcome,
                seq: r.seq,
                current: r.current,
                payload: sent.payload.clone(),
                deleted: sent.deleted,
            })
        })
        .collect()
}

async fn pull<F, Fut>(
    step: &mut F,
    remote: &super::http::Remote,
    session: &Session,
    mut cursor: i64,
) -> Result<(), String>
where
    F: FnMut(Operation) -> Fut,
    Fut: Future<Output = Result<View, String>>,
{
    for _ in 0..PULL_PAGES {
        step(Operation::Check(session.clone())).await?;
        let body: PullReply = remote.pull(&session.scope.project, cursor).await?;
        if body.more && body.cursor <= cursor {
            return Err("pull_invalid_cursor".into());
        }
        let next = step(Operation::Apply {
            session: session.clone(),
            items: body.items,
            cursor: body.cursor,
        })
        .await?;
        cursor = next.cursor;
        if !body.more {
            return Ok(());
        }
    }
    Err("同步变更较多，本轮进度已保存，请继续同步".into())
}

async fn full_pull<F, Fut>(
    step: &mut F,
    remote: &super::http::Remote,
    session: &Session,
) -> Result<(), String>
where
    F: FnMut(Operation) -> Fut,
    Fut: Future<Output = Result<View, String>>,
{
    let mut cursor = 0;
    let mut items = Vec::new();
    for _ in 0..PULL_PAGES {
        step(Operation::Check(session.clone())).await?;
        let body: PullReply = remote.pull(&session.scope.project, cursor).await?;
        if body.items.len() > PULL_PAGE_SIZE
            || body.cursor < cursor
            || (body.more && body.cursor <= cursor)
            || body
                .items
                .iter()
                .any(|i| i.seq <= cursor || i.seq > body.cursor)
        {
            return Err("pull_invalid_cursor".into());
        }
        cursor = body.cursor;
        items.extend(body.items);
        if !body.more {
            // Until the final page arrives, no local state/cursor or absence decisions change.
            step(Operation::Reconcile {
                session: session.clone(),
                items,
                cursor,
            })
            .await?;
            return Ok(());
        }
    }
    Err("完整对齐超过 20 页，本轮未应用；请缩小云端项目数据量后重试".into())
}

/// Read and authenticate before selecting a persisted scope. Pull before pushing so deferred
/// items see new tombstones/updates before they can be replayed into the local library.
pub(super) async fn run<F, Fut>(full: bool, mut step: F) -> Result<View, String>
where
    F: FnMut(Operation) -> Fut,
    Fut: Future<Output = Result<View, String>>,
{
    let captured = step(Operation::Capture).await?;
    let snapshot = captured.snapshot.ok_or("同步配置不可用")?;
    let remote = super::http::Remote::new(&snapshot.config.server, &snapshot.config.token)?;
    let identity = remote.identity().await?;
    let bound = step(Operation::Bind { snapshot, identity }).await?;
    let session = bound.session.ok_or("同步身份不可用")?;
    let full = full
        || bound.last_full_sync_ms == 0
        || super::now_ms().saturating_sub(bound.last_full_sync_ms) >= FULL_INTERVAL_MS;
    if full {
        full_pull(&mut step, &remote, &session).await?;
    } else {
        pull(&mut step, &remote, &session, bound.cursor).await?;
    }
    let prepared = step(Operation::Prepare(session.clone())).await?;
    for batch in prepared.changes.unwrap_or_default().chunks(PUSH_BATCH) {
        step(Operation::Check(session.clone())).await?;
        let body = serde_json::json!({ "workspace": session.scope.project, "device": session.snapshot.config.device, "changes": batch });
        let reply: PushReply = remote.push(&body).await?;
        step(Operation::Ack {
            session: session.clone(),
            results: acks_for(batch, reply.results)?,
        })
        .await?;
    }
    step(Operation::Finish { session, full }).await
}
