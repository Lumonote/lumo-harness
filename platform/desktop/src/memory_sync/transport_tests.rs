use super::{
    storage::{handle, Identity, Operation},
    storage_tests::{card, Fixture},
    *,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
};

#[derive(Default)]
struct Cloud {
    seq: i64,
    rows: BTreeMap<(String, String, String), Item>,
    calls: Vec<String>,
    pulls: Vec<i64>,
    page_size: usize,
    endless: bool,
    before_push: Option<Item>,
}
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
    cloud: Arc<Mutex<Cloud>>,
}
impl Server {
    fn start(hook: impl Fn(&str) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let cloud = Arc::new(Mutex::new(Cloud::default()));
        let state = cloud.clone();
        let task = thread::spawn(move || {
            for stream in listener.incoming() {
                if done.load(Ordering::SeqCst) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut start = String::new();
                reader.read_line(&mut start).unwrap();
                let target = start.split_whitespace().nth(1).unwrap().to_string();
                let mut token = String::new();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        if key.eq_ignore_ascii_case("authorization") {
                            token = value
                                .trim()
                                .strip_prefix("Bearer ")
                                .unwrap_or("")
                                .to_string();
                        }
                        if key.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
                let path = url.path();
                let mut cloud = state.lock().unwrap();
                cloud.calls.push(path.into());
                let (status, body) = if token.is_empty() {
                    (401, json!({"error":"missing token"}))
                } else if path.ends_with("/identity") {
                    (
                        200,
                        json!({"realm":"realm", "userId":if token.starts_with("bob") {"bob"} else {"alice"}}),
                    )
                } else if path.ends_with("/changes") {
                    let q: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
                    let user = if token.starts_with("bob") {
                        "bob"
                    } else {
                        "alice"
                    };
                    let since: i64 = q["since"].parse().unwrap();
                    cloud.pulls.push(since);
                    let mut items: Vec<_> = cloud
                        .rows
                        .iter()
                        .filter(|((u, p, _), item)| {
                            u == user && p == &q["workspace"] && item.seq > since
                        })
                        .map(|(_, v)| v.clone())
                        .collect();
                    items.sort_by_key(|i| i.seq);
                    let limit = if cloud.page_size == 0 {
                        500
                    } else {
                        cloud.page_size
                    };
                    items.truncate(limit);
                    let more = cloud.endless || items.len() == limit;
                    let cursor = items
                        .last()
                        .map_or(if cloud.endless { since + 1 } else { since }, |i| i.seq);
                    (200, json!({"items":items,"cursor":cursor,"more":more}))
                } else if path.ends_with("/push") {
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    let user = if token.starts_with("bob") {
                        "bob"
                    } else {
                        "alice"
                    };
                    let project = body["workspace"].as_str().unwrap();
                    if let Some(mut item) = cloud.before_push.take() {
                        cloud.seq += 1;
                        item.seq = cloud.seq;
                        cloud
                            .rows
                            .insert((user.into(), project.into(), item.id.clone()), item);
                    }
                    let mut results = vec![];
                    for c in body["changes"].as_array().unwrap() {
                        let id = c["id"].as_str().unwrap();
                        let current = cloud.rows.get(&(user.into(), project.into(), id.into()));
                        if let Some(current) = current {
                            if current.deleted == c["deleted"].as_bool().unwrap()
                                && (current.deleted
                                    || current.payload == c["payload"].as_str().unwrap())
                            {
                                results.push(json!({"id":id,"outcome":"duplicate","seq":current.seq,"current":current}));
                                continue;
                            }
                        }
                        if c["baseSeq"].as_i64().unwrap() != current.map_or(0, |i| i.seq) {
                            results.push(json!({"id":id,"outcome":"conflict","current":current}));
                            continue;
                        }
                        cloud.seq += 1;
                        let seq = cloud.seq;
                        cloud.rows.insert(
                            (user.into(), project.into(), id.into()),
                            Item {
                                id: id.into(),
                                kind: "card".into(),
                                payload: c["payload"].as_str().unwrap().into(),
                                hlc: c["hlc"].as_str().unwrap().into(),
                                device: body["device"].as_str().unwrap().into(),
                                deleted: c["deleted"].as_bool().unwrap(),
                                seq,
                            },
                        );
                        results.push(json!({"id":id,"outcome":"accepted","seq":seq}));
                    }
                    (200, json!({"results":results}))
                } else {
                    (404, json!({"error":"not found"}))
                };
                drop(cloud);
                hook(path);
                let body = serde_json::to_vec(&body).unwrap();
                write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        Self {
            url: format!("http://{addr}"),
            stop,
            task: Some(task),
            cloud,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
        self.task.take().unwrap().join().unwrap();
    }
}
fn round(f: &Fixture, workspace: &str) -> Result<View, String> {
    run(f, workspace, false)
}
fn run(f: &Fixture, workspace: &str, full: bool) -> Result<View, String> {
    tauri::async_runtime::block_on(super::runner::run(full, |op| {
        std::future::ready(handle(&f.root, workspace, op))
    }))
}

#[test]
fn real_http_two_devices_share_the_explicit_project_and_verified_subject() {
    let server = Server::start(|_| {});
    let a = Fixture::new();
    let b = Fixture::new();
    let project = "f".repeat(64);
    a.configure(
        "different-local-a",
        &server.url,
        Some("alice-token1"),
        &project,
    );
    b.configure(
        "different-local-b",
        &server.url,
        Some("alice-token2"),
        &project,
    );
    a.cards("different-local-a", |cards| {
        cards.push(card("item", "两端共享"))
    });
    let pushed = round(&a, "different-local-a").unwrap();
    assert_eq!(pushed.pending, 0);
    let pulled = round(&b, "different-local-b").unwrap();
    assert_eq!(pulled.cursor, 1);
    assert_eq!(
        super::super::dev_memory::read(&b.root, "different-local-b")
            .unwrap()
            .library
            .cards[0]
            .title,
        "两端共享"
    );
    a.configure(
        "different-local-a",
        &server.url,
        Some("alice-refreshed"),
        &project,
    );
    assert_eq!(round(&a, "different-local-a").unwrap().pending, 0);
    let calls = &server.cloud.lock().unwrap().calls;
    assert_eq!(
        calls.iter().filter(|c| c.ends_with("/push")).count(),
        1,
        "same-subject refresh must not reupload unchanged cards"
    );
}

#[test]
fn changing_configuration_while_identity_is_in_flight_rejects_the_response() {
    let f = Fixture::new();
    let root = f.root.clone();
    let once = AtomicBool::new(false);
    let server = Server::start(move |path| {
        if path.ends_with("/identity") && !once.swap(true, Ordering::SeqCst) {
            handle(
                &root,
                "w",
                Operation::Page(Request::Configure {
                    enabled: false,
                    server: String::new(),
                    token: None,
                    project_id: "e".repeat(64),
                }),
            )
            .unwrap();
        }
    });
    f.configure("w", &server.url, Some("alice"), &"a".repeat(64));
    assert!(round(&f, "w").err().unwrap().contains("设置已变更"));
    assert_eq!(server.cloud.lock().unwrap().calls.len(), 1);
}

#[test]
fn changing_configuration_before_push_ack_keeps_the_new_scope_clean() {
    let f = Fixture::new();
    let root = f.root.clone();
    let server = Server::start(move |path| {
        if path.ends_with("/push") {
            handle(
                &root,
                "w",
                Operation::Page(Request::Configure {
                    enabled: true,
                    server: "https://new.example.com".into(),
                    token: Some("new-token".into()),
                    project_id: "b".repeat(64),
                }),
            )
            .unwrap();
        }
    });
    f.configure("w", &server.url, Some("alice"), &"a".repeat(64));
    f.cards("w", |cards| cards.push(card("a", "待推送")));
    assert!(round(&f, "w").err().unwrap().contains("设置已变更"));
    let (session, v) = f.bind("w", "realm", "alice");
    assert_eq!(v.cursor, 0);
    assert_eq!(v.pending, 1);
    assert!(session.scope.server.contains("new.example.com"));
}

#[test]
fn invalid_identity_never_binds_state() {
    for identity in [
        Identity {
            realm: "".into(),
            user_id: "a".into(),
        },
        Identity {
            realm: "r".into(),
            user_id: "forged\nvalue".into(),
        },
    ] {
        assert!(identity.validate().is_err());
    }
}

#[test]
fn full_reconciliation_repairs_empty_database_and_preserves_local_deletion() {
    let f = Fixture::new();
    let server = Server::start(|_| {});
    let project = "c".repeat(64);
    f.configure("w", &server.url, Some("alice"), &project);
    f.cards("w", |cards| {
        cards.extend([card("alive", "保留"), card("gone", "删除")])
    });
    round(&f, "w").unwrap();
    f.cards("w", |cards| cards.retain(|c| c.id != "gone"));
    let deleted = round(&f, "w").unwrap();
    assert!(
        deleted.conflicts.is_empty(),
        "an acknowledged baseline must allow a later local delete"
    );
    round(&f, "w").unwrap();
    {
        let mut cloud = server.cloud.lock().unwrap();
        cloud.rows.clear();
        cloud.seq = 0;
    }
    let recovered = run(&f, "w", true).unwrap();
    assert!(recovered.last_full_sync_ms > 0);
    assert_eq!(recovered.pending, 0);
    let cloud = server.cloud.lock().unwrap();
    assert!(!cloud.rows[&("alice".into(), project.clone(), "alive".into())].deleted);
    assert!(cloud.rows[&("alice".into(), project, "gone".into())].deleted);
    assert_eq!(
        super::super::dev_memory::read(&f.root, "w")
            .unwrap()
            .library
            .cards
            .len(),
        1
    );
}

#[test]
fn restored_older_content_conflicts_even_when_global_sequence_has_advanced() {
    let f = Fixture::new();
    let server = Server::start(|_| {});
    let project = "c".repeat(64);
    f.configure("w", &server.url, Some("alice"), &project);
    f.cards("w", |cards| cards.push(card("a", "新版")));
    round(&f, "w").unwrap();
    round(&f, "w").unwrap();
    {
        let mut cloud = server.cloud.lock().unwrap();
        cloud.rows.insert(
            ("alice".into(), project, "a".into()),
            super::storage_tests::item("a", "备份旧版", 1, false),
        );
        cloud.seq = 500; // Other scopes may already have exceeded the old high-water mark.
    }
    let v = run(&f, "w", true).unwrap();
    assert_eq!(v.conflicts.len(), 1);
    assert_eq!(v.pending, 0);
    assert_eq!(
        super::super::dev_memory::read(&f.root, "w")
            .unwrap()
            .library
            .cards[0]
            .title,
        "新版"
    );
}

#[test]
fn token_refresh_stays_incremental_and_elapsed_day_requests_a_full_scan() {
    let f = Fixture::new();
    let server = Server::start(|_| {});
    let project = "c".repeat(64);
    f.configure("w", &server.url, Some("alice"), &project);
    f.cards("w", |cards| cards.push(card("a", "本机")));
    round(&f, "w").unwrap();
    let previous = round(&f, "w").unwrap();
    assert_eq!(previous.cursor, 1);
    server.cloud.lock().unwrap().pulls.clear();
    f.configure("w", &server.url, Some("alice-refreshed"), &project);
    let refreshed = round(&f, "w").unwrap();
    assert_eq!(server.cloud.lock().unwrap().pulls, vec![1]);
    assert_eq!(refreshed.last_full_sync_ms, previous.last_full_sync_ms);
    let path = f
        .dir("w")
        .join("sync-states")
        .join(format!("{}.json", refreshed.scope.unwrap()));
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["state"]["last_full_sync_ms"] = json!(1);
    std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
    server.cloud.lock().unwrap().pulls.clear();
    let full = round(&f, "w").unwrap();
    assert_eq!(server.cloud.lock().unwrap().pulls, vec![0]);
    assert!(full.last_full_sync_ms > 1);
}

#[test]
fn incomplete_full_scan_keeps_cursor_baseline_and_full_sync_timestamp() {
    let f = Fixture::new();
    let server = Server::start(|_| {});
    f.configure("w", &server.url, Some("alice"), &"c".repeat(64));
    f.cards("w", |cards| cards.push(card("a", "本机")));
    round(&f, "w").unwrap();
    let before = round(&f, "w").unwrap();
    {
        let mut cloud = server.cloud.lock().unwrap();
        cloud.rows.clear();
        cloud.pulls.clear();
        cloud.endless = true;
    }
    assert!(run(&f, "w", true).err().unwrap().contains("20 页"));
    let after = f.op("w", Operation::Page(Request::Status));
    assert_eq!(server.cloud.lock().unwrap().pulls.len(), 20);
    assert_eq!(after.cursor, before.cursor);
    assert_eq!(after.pending, 0);
    assert_eq!(after.last_full_sync_ms, before.last_full_sync_ms);
}

#[test]
fn resolved_local_and_saved_choices_survive_restart_then_full_scan_and_push() {
    for (choice, expected) in [("local", "本机选择"), ("saved:0", "先前收到")] {
        let f = Fixture::new();
        let server = Server::start(|_| {});
        let project = "d".repeat(64);
        let key = ("alice".into(), project.clone(), "a".into());
        f.configure("w", &server.url, Some("alice"), &project);
        f.cards("w", |cards| cards.push(card("a", "本机选择")));
        {
            let mut cloud = server.cloud.lock().unwrap();
            cloud.seq = 5;
            cloud.rows.insert(
                key.clone(),
                super::storage_tests::item("a", "先前收到", 5, false),
            );
        }
        assert_eq!(round(&f, "w").unwrap().conflicts.len(), 1);
        {
            let mut cloud = server.cloud.lock().unwrap();
            cloud.seq = 1;
            cloud.rows.insert(
                key.clone(),
                super::storage_tests::item("a", "恢复旧版", 1, false),
            );
        }
        let restored = run(&f, "w", true).unwrap();
        assert_eq!(restored.conflicts[0].alternatives.len(), 1);
        f.op(
            "w",
            Operation::Page(Request::Resolve {
                id: "a".into(),
                choice: choice.into(),
                scope: restored.scope.unwrap(),
            }),
        );
        let (_, restarted) = f.bind("w", "realm", "alice");
        assert_eq!(restarted.pending, 1);
        let result = run(&f, "w", true).unwrap();
        assert!(
            result.conflicts.is_empty(),
            "the full scan must honor the persisted {choice} choice"
        );
        assert_eq!(result.pending, 0);
        assert_eq!(
            server.cloud.lock().unwrap().rows[&key].payload,
            payload(&card("a", expected))
        );
    }
}

#[test]
fn push_conflict_resolution_survives_replayed_cloud_version_then_incremental_push() {
    let f = Fixture::new();
    let server = Server::start(|_| {});
    let project = "d".repeat(64);
    let key = ("alice".into(), project.clone(), "a".into());
    f.configure("w", &server.url, Some("alice"), &project);
    f.cards("w", |cards| cards.push(card("a", "初始")));
    round(&f, "w").unwrap();
    assert_eq!(round(&f, "w").unwrap().cursor, 1);
    f.cards("w", |cards| cards[0].title = "本机选择".into());
    server.cloud.lock().unwrap().before_push =
        Some(super::storage_tests::item("a", "并发云端", 0, false));
    let conflicted = round(&f, "w").unwrap();
    assert_eq!(conflicted.cursor, 1);
    assert_eq!(conflicted.conflicts[0].remote.seq, 2);
    f.op(
        "w",
        Operation::Page(Request::Resolve {
            id: "a".into(),
            choice: "local".into(),
            scope: conflicted.scope.unwrap(),
        }),
    );
    let (_, restarted) = f.bind("w", "realm", "alice");
    assert_eq!(restarted.pending, 1);
    let result = round(&f, "w").unwrap();
    assert!(
        result.conflicts.is_empty(),
        "receiving the already reviewed cloud version must preserve the choice"
    );
    assert_eq!(result.pending, 0);
    assert_eq!(
        server.cloud.lock().unwrap().rows[&key].payload,
        payload(&card("a", "本机选择"))
    );
}
