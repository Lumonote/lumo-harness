//! Authenticated scope persistence. No network I/O while the file locks are held.
use super::{digest, now_ms, prepare, Card, Change, Conflict, Item, State};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const CONFIG: &str = "memory-sync.json";
const PROJECT: &str = "sync-project.json";
const LEGACY_STATE: &str = "sync.json";
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct Config {
    pub enabled: bool,
    pub server: String,
    #[serde(default)]
    pub token: String,
    pub device: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
struct Project {
    id: String,
    revision: u64,
    active: Option<Binding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    pub realm: String,
    pub user_id: String,
}

impl Identity {
    pub fn validate(&self) -> Result<(), String> {
        let valid = |v: &str| {
            !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
        };
        if valid(&self.realm) && valid(&self.user_id) {
            Ok(())
        } else {
            Err("identity_invalid_response".into())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct Scope {
    pub server: String,
    pub identity: Identity,
    pub project: String,
}

impl Scope {
    pub fn key(&self) -> String {
        digest(&serde_json::to_string(self).expect("scope"))
    }
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
struct Binding {
    scope: Option<Scope>,
    config_revision: u64,
    project_revision: u64,
}

#[derive(Clone)]
pub(super) struct Snapshot {
    pub config: Config,
    project: Project,
}

#[derive(Clone)]
pub(super) struct Session {
    pub snapshot: Snapshot,
    pub scope: Scope,
}

#[derive(Serialize, Deserialize)]
struct ScopedState {
    scope: Scope,
    state: State,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Status,
    Configure {
        enabled: bool,
        server: String,
        token: Option<String>,
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Resolve {
        id: String,
        choice: String,
        scope: String,
    },
}

pub(super) enum Operation {
    Page(Request),
    Capture,
    Bind {
        snapshot: Snapshot,
        identity: Identity,
    },
    Check(Session),
    Prepare(Session),
    Ack {
        session: Session,
        results: Vec<super::Ack>,
    },
    Apply {
        session: Session,
        items: Vec<Item>,
        cursor: i64,
    },
    Reconcile {
        session: Session,
        items: Vec<Item>,
        cursor: i64,
    },
    Finish {
        session: Session,
        full: bool,
    },
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    pub server: String,
    pub has_token: bool,
    pub device: String,
    pub workspace: String,
    pub project_id: String,
    pub scope: Option<String>,
    pub(super) identity: Option<Identity>,
    pub cursor: i64,
    pub pending: usize,
    pub deferred: usize,
    pub last_sync_ms: u64,
    pub last_full_sync_ms: u64,
    pub conflicts: Vec<Conflict>,
    #[serde(skip)]
    pub(super) changes: Option<Vec<Change>>,
    #[serde(skip)]
    pub(super) snapshot: Option<Snapshot>,
    #[serde(skip)]
    pub(super) session: Option<Session>,
}

pub(super) fn read_json<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> io::Result<T> {
    match File::open(path) {
        Ok(f) => Ok(serde_json::from_reader(f)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
pub(super) fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    write_bytes(path, &serde_json::to_vec(value)?)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("syncing");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(tmp, path)
}

fn normalized_server(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Ok(String::new());
    }
    Ok(super::http::parse_server(raw)?
        .to_string()
        .trim_end_matches('/')
        .to_string())
}

fn project_id(raw: &str) -> Result<String, String> {
    let id = raw.trim().to_ascii_lowercase();
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("同步项目标识必须是 64 位十六进制字符".into());
    }
    Ok(id)
}

fn fail(error: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.into())
}
fn bump(revision: u64) -> io::Result<u64> {
    revision
        .checked_add(1)
        .ok_or_else(|| fail("同步配置版本已超限"))
}

fn validate_snapshot(config: &Config, project: &Project, snapshot: &Snapshot) -> io::Result<()> {
    // Compare both generations and values: an externally edited file cannot impersonate the old scope.
    if !config.enabled
        || config != &snapshot.config
        || project.id != snapshot.project.id
        || project.revision != snapshot.project.revision
    {
        return Err(fail("同步设置已变更，请重新同步"));
    }
    Ok(())
}

fn active_scope(config: &Config, project: &Project) -> Option<Scope> {
    project
        .active
        .as_ref()
        .filter(|b| b.config_revision == config.revision && b.project_revision == project.revision)
        .and_then(|b| b.scope.clone())
        .filter(|s| s.server == config.server && s.project == project.id)
}

fn state_path(dir: &Path, scope: &Scope) -> PathBuf {
    dir.join("sync-states")
        .join(format!("{}.json", scope.key()))
}

fn load_state(
    dir: &Path,
    scope: &Scope,
    cards: &[Card],
    legacy_project: &str,
) -> io::Result<State> {
    let path = state_path(dir, scope);
    match File::open(&path) {
        Ok(f) => {
            let saved: ScopedState = serde_json::from_reader(f)?;
            if &saved.scope != scope {
                return Err(fail("同步状态范围不匹配"));
            }
            Ok(saved.state)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let mut state = State::default();
            // Never attach an unauthenticated legacy cursor/baseline to a newly verified account.
            // Preserve the old file and only protect local deletion intent during the fresh pull.
            if scope.project == legacy_project {
                let old: State = read_json(&dir.join(LEGACY_STATE))?;
                for (id, _) in old.synced {
                    if cards.iter().all(|c| c.id != id) {
                        state.legacy_missing.insert(id);
                    }
                }
                for conflict in old.conflicts {
                    if conflict.local.is_none() {
                        state.legacy_missing.insert(conflict.id);
                    }
                }
            }
            Ok(state)
        }
        Err(e) => Err(e),
    }
}

/// Serializes configuration edits across all projects, then takes the existing project file lock.
/// The callback commit runs only after library.json has been persisted successfully.
pub(super) fn handle(
    root: &Path,
    workspace_id: &str,
    operation: Operation,
) -> Result<View, String> {
    let _lock = CONFIG_LOCK.lock().map_err(|_| "同步配置不可用")?;
    let config_path = root.parent().ok_or("数据目录无效")?.join(CONFIG);
    let mut config: Config = read_json(&config_path).map_err(|e| e.to_string())?;
    let old_config = config.clone();
    if config.device.is_empty() {
        config.device = uuid::Uuid::new_v4().to_string();
    }
    config.server = normalized_server(&config.server)?;
    let legacy_project = digest(workspace_id);
    super::super::dev_memory::with_cards(root, workspace_id, move |dir, cards| {
        let project_path = dir.join(PROJECT);
        let mut project: Project = read_json(&project_path)?;
        let old_project = project.clone();
        if project.id.is_empty() {
            project.id = if dir.join(LEGACY_STATE).exists() {
                legacy_project.clone()
            } else {
                digest(&uuid::Uuid::new_v4().to_string())
            };
        }
        if let Operation::Page(Request::Configure {
            enabled,
            server,
            token,
            project_id: id,
        }) = &operation
        {
            let server = normalized_server(server).map_err(fail)?;
            if *enabled && server.is_empty() {
                return Err(fail("同步服务器须为 https:// 地址"));
            }
            let id = project_id(id).map_err(fail)?;
            if let Some(token) = token {
                if token.len() > 4096 || token.contains(char::is_control) {
                    return Err(fail("访问令牌无效"));
                }
                config.token = token.trim().into();
            }
            // A credential must never be forwarded automatically to a different server.
            if server != config.server && token.is_none() {
                config.token.clear();
            }
            config.enabled = *enabled;
            config.server = server;
            if config != old_config {
                config.revision = bump(config.revision)?;
            }
            if project.id != id {
                project.id = id;
                project.revision = bump(project.revision)?;
            }
        }
        let snapshot = Snapshot {
            config: config.clone(),
            project: project.clone(),
        };
        let mut scope = active_scope(&config, &project);
        let mut session = None;
        let mut changes = None;
        let mut changed = false;
        let internal = match &operation {
            Operation::Check(s)
            | Operation::Prepare(s)
            | Operation::Finish { session: s, .. }
            | Operation::Ack { session: s, .. }
            | Operation::Apply { session: s, .. }
            | Operation::Reconcile { session: s, .. } => Some(s),
            _ => None,
        };
        if let Some(s) = internal {
            validate_snapshot(&config, &project, &s.snapshot)?;
            if scope.as_ref() != Some(&s.scope) {
                return Err(fail("同步账户已变更，请重新同步"));
            }
        }
        if let Operation::Bind {
            snapshot: expected,
            identity,
        } = &operation
        {
            validate_snapshot(&config, &project, expected)?;
            identity.validate().map_err(fail)?;
            let bound = Scope {
                server: config.server.clone(),
                identity: identity.clone(),
                project: project.id.clone(),
            };
            project.active = Some(Binding {
                scope: Some(bound.clone()),
                config_revision: config.revision,
                project_revision: project.revision,
            });
            session = Some(Session {
                snapshot: snapshot.clone(),
                scope: bound.clone(),
            });
            scope = Some(bound);
        }
        if matches!(operation, Operation::Capture) && !config.enabled {
            return Err(fail("跨设备同步未开启"));
        }
        let mut state = match &scope {
            Some(s) => load_state(dir, s, cards, &legacy_project)?,
            None => State::default(),
        };
        let mut persist_state = matches!(operation, Operation::Bind { .. });
        match operation {
            Operation::Prepare(_) => {
                changes = Some(prepare(cards, &mut state, &config.device, now_ms()));
                persist_state = true;
            }
            Operation::Ack { results, .. } => {
                super::ack(cards, &mut state, results);
                persist_state = true;
            }
            Operation::Apply { items, cursor, .. } => {
                if cursor < state.cursor || items.iter().any(|i| i.seq < 0 || i.seq > cursor) {
                    return Err(fail("pull_invalid_cursor"));
                }
                changed = super::apply(cards, &mut state, items, cursor);
                persist_state = true;
            }
            Operation::Reconcile { items, cursor, .. } => {
                if cursor < 0 || items.iter().any(|i| i.seq <= 0 || i.seq > cursor) {
                    return Err(fail("pull_invalid_cursor"));
                }
                changed = super::reconciliation::reconcile(cards, &mut state, items, cursor);
                persist_state = true;
            }
            Operation::Finish { full, .. } => {
                state.last_sync_ms = now_ms();
                if full {
                    state.last_full_sync_ms = state.last_sync_ms;
                }
                persist_state = true;
            }
            Operation::Page(Request::Resolve {
                id,
                choice,
                scope: expected,
            }) => {
                if !config.enabled
                    || scope.as_ref().map(Scope::key).as_deref() != Some(expected.as_str())
                {
                    return Err(fail("同步账户已变更，请先重新同步再处理冲突"));
                }
                changed = super::resolve(cards, &mut state, &id, &choice).map_err(fail)?;
                persist_state = true;
            }
            _ => {}
        }
        let pending = prepare(cards, &mut state.clone(), &config.device, 0).len();
        let view = View {
            enabled: config.enabled,
            server: config.server.clone(),
            has_token: !config.token.is_empty(),
            device: config.device.clone(),
            workspace: project.id.clone(),
            project_id: project.id.clone(),
            scope: scope.as_ref().map(Scope::key),
            identity: scope.as_ref().map(|s| s.identity.clone()),
            cursor: state.cursor,
            pending,
            deferred: state.deferred.len(),
            last_sync_ms: state.last_sync_ms,
            last_full_sync_ms: state.last_full_sync_ms,
            conflicts: state.conflicts.clone(),
            changes,
            snapshot: Some(snapshot),
            session,
        };
        let mut writes: Vec<(PathBuf, Vec<u8>)> = Vec::new();
        if config != old_config {
            writes.push((config_path, serde_json::to_vec(&config)?));
        }
        if persist_state {
            let scope = scope.ok_or_else(|| fail("同步身份尚未验证"))?;
            let parent = dir.join("sync-states");
            fs::create_dir_all(&parent)?;
            writes.push((
                state_path(dir, &scope),
                serde_json::to_vec(&ScopedState { scope, state })?,
            ));
        }
        if project != old_project {
            writes.push((project_path, serde_json::to_vec(&project)?));
        }
        Ok((view, changed, move || {
            for (path, bytes) in writes {
                write_bytes(&path, &bytes)?;
            }
            Ok(())
        }))
    })
}
