use super::{storage::*, *};
use std::{fs, path::PathBuf};

pub(super) struct Fixture {
    pub root: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir()
            .join(format!("lumo-sync-test-{}", uuid::Uuid::new_v4()))
            .join("development-memory");
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }
    pub fn op(&self, ws: &str, op: Operation) -> View {
        handle(&self.root, ws, op).unwrap()
    }
    pub fn configure(&self, ws: &str, server: &str, token: Option<&str>, id: &str) -> View {
        self.op(
            ws,
            Operation::Page(Request::Configure {
                enabled: true,
                server: server.into(),
                token: token.map(str::to_string),
                project_id: id.into(),
            }),
        )
    }
    pub fn bind(&self, ws: &str, realm: &str, user: &str) -> (Session, View) {
        let snapshot = self.op(ws, Operation::Capture).snapshot.unwrap();
        let v = self.op(
            ws,
            Operation::Bind {
                snapshot,
                identity: Identity {
                    realm: realm.into(),
                    user_id: user.into(),
                },
            },
        );
        (v.session.clone().unwrap(), v)
    }
    pub fn cards(&self, ws: &str, edit: impl FnOnce(&mut Vec<Card>)) {
        super::super::dev_memory::with_cards(&self.root, ws, |_, cards| {
            edit(cards);
            Ok(((), true, || Ok(())))
        })
        .unwrap();
    }
    pub fn dir(&self, ws: &str) -> PathBuf {
        self.root.join(digest(ws))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.parent().unwrap());
    }
}

pub(super) fn card(id: &str, title: &str) -> Card {
    Card {
        id: id.into(),
        category: "project".into(),
        title: title.into(),
        body: "内容".into(),
        revision: 1,
    }
}
pub(super) fn item(id: &str, title: &str, seq: i64, deleted: bool) -> Item {
    Item {
        id: id.into(),
        kind: "card".into(),
        payload: if deleted {
            String::new()
        } else {
            payload(&card(id, title))
        },
        hlc: "1".into(),
        device: "remote".into(),
        deleted,
        seq,
    }
}
const PROJECT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERVER: &str = "https://cloud.example.com";

#[test]
fn independent_workspaces_can_pair_explicitly_and_invalid_pairing_does_not_mutate_config() {
    let a = Fixture::new();
    let b = Fixture::new();
    let first = a.op("local-a", Operation::Page(Request::Status));
    let second = b.op("local-b", Operation::Page(Request::Status));
    assert_ne!(first.project_id, second.project_id);
    a.configure("local-a", SERVER, Some("token-a"), PROJECT);
    b.configure("local-b", SERVER, Some("token-b"), PROJECT);
    let (sa, _) = a.bind("local-a", "realm", "alice");
    let (sb, _) = b.bind("local-b", "realm", "alice");
    assert_eq!(sa.scope, sb.scope);
    assert_ne!(sa.snapshot.config.device, sb.snapshot.config.device);
    let err = handle(
        &a.root,
        "local-a",
        Operation::Page(Request::Configure {
            enabled: true,
            server: "https://changed.example".into(),
            token: Some("bad".into()),
            project_id: "../bad".into(),
        }),
    );
    assert!(err.is_err());
    assert_eq!(
        a.op("local-a", Operation::Page(Request::Status)).server,
        SERVER
    );
}

#[test]
fn authenticated_scopes_restore_progress_and_conflicts_and_token_refresh_does_not_reset() {
    let f = Fixture::new();
    f.configure("w", SERVER, Some("token1"), PROJECT);
    f.cards("w", |cards| cards.push(card("conflict", "本地")));
    let (original, _) = f.bind("w", "r", "alice");
    let first = f.op(
        "w",
        Operation::Apply {
            session: original.clone(),
            items: vec![
                item("conflict", "远端", 89, false),
                item("a", "已收到", 90, false),
            ],
            cursor: 90,
        },
    );
    assert_eq!(first.conflicts.len(), 1);
    f.configure("w", SERVER, Some("token2"), PROJECT);
    assert!(handle(&f.root, "w", Operation::Check(original)).is_err());
    let (_, refreshed) = f.bind("w", "r", "alice");
    assert_eq!(refreshed.cursor, 90);
    assert_eq!(refreshed.conflicts.len(), 1);
    let (_, bob) = f.bind("w", "r", "bob");
    assert_eq!(bob.cursor, 0);
    assert!(bob.conflicts.is_empty());
    let (_, realm) = f.bind("w", "r2", "alice");
    assert_eq!(realm.cursor, 0);
    f.configure("w", "https://other.example.com", None, PROJECT);
    assert!(
        !f.op("w", Operation::Capture).has_token,
        "changing servers cannot forward the old credential"
    );
    let (_, other) = f.bind("w", "r", "alice");
    assert_eq!(other.cursor, 0);
    f.configure("w", SERVER, Some("token3"), PROJECT);
    let (_, restored) = f.bind("w", "r", "alice");
    assert_eq!(restored.cursor, 90);
    assert_eq!(restored.conflicts.len(), 1);
    f.configure("w", SERVER, None, &"b".repeat(64));
    let (_, other_project) = f.bind("w", "r", "alice");
    assert_eq!(other_project.cursor, 0);
    f.configure("w", SERVER, None, PROJECT);
    let (_, restored) = f.bind("w", "r", "alice");
    assert_eq!(restored.cursor, 90);
}

#[test]
fn late_identity_ack_and_pull_are_rejected_after_configuration_changes() {
    let f = Fixture::new();
    f.configure("w", SERVER, Some("t1"), PROJECT);
    let snapshot = f.op("w", Operation::Capture).snapshot.unwrap();
    f.configure("w", SERVER, Some("t2"), PROJECT);
    assert!(handle(
        &f.root,
        "w",
        Operation::Bind {
            snapshot,
            identity: Identity {
                realm: "r".into(),
                user_id: "a".into()
            }
        }
    )
    .is_err());
    let (session, _) = f.bind("w", "r", "a");
    f.configure("w", SERVER, None, &"b".repeat(64));
    assert!(handle(
        &f.root,
        "w",
        Operation::Apply {
            session: session.clone(),
            items: vec![item("late", "旧内容", 100, false)],
            cursor: 100
        }
    )
    .is_err());
    assert!(handle(
        &f.root,
        "w",
        Operation::Ack {
            session: session.clone(),
            results: vec![Ack {
                id: "late".into(),
                outcome: "accepted".into(),
                seq: 100,
                current: None,
                payload: "p".into(),
                deleted: false
            }]
        }
    )
    .is_err());
    assert!(super::super::dev_memory::read(&f.root, "w")
        .unwrap()
        .library
        .cards
        .is_empty());
    assert!(handle(
        &f.root,
        "w",
        Operation::Reconcile {
            session,
            items: vec![item("late", "旧内容", 1, false)],
            cursor: 1,
        }
    )
    .is_err());
    let (_, state) = f.bind("w", "r", "a");
    assert_eq!(state.cursor, 0);
}

#[test]
fn persistent_overflow_recovers_after_restart_and_newer_tombstones_supersede_queued_items() {
    let f = Fixture::new();
    f.configure("w", SERVER, Some("t"), PROJECT);
    f.cards("w", |cards| {
        cards.extend((0..MAX_CARDS).map(|i| card(&format!("k{i}"), "满")))
    });
    let (s, _) = f.bind("w", "r", "a");
    let v = f.op(
        "w",
        Operation::Apply {
            session: s,
            items: vec![
                item("queued", "旧版", 9, false),
                item("gone", "稍后删除", 10, false),
            ],
            cursor: 10,
        },
    );
    assert_eq!(v.deferred, 2);
    f.cards("w", |cards| {
        cards.pop();
    });
    let (restarted, v) = f.bind("w", "r", "a");
    assert_eq!(v.deferred, 2);
    let v = f.op(
        "w",
        Operation::Apply {
            session: restarted.clone(),
            items: vec![
                item("queued", "新版", 11, false),
                item("gone", "", 12, true),
            ],
            cursor: 12,
        },
    );
    assert_eq!(v.deferred, 0);
    let memory = super::super::dev_memory::read(&f.root, "w").unwrap();
    assert_eq!(
        memory
            .library
            .cards
            .iter()
            .find(|c| c.id == "queued")
            .unwrap()
            .title,
        "新版"
    );
    assert!(!memory.library.cards.iter().any(|c| c.id == "gone"));
    // A stale item cannot resurrect the newer tombstone, even if delivered again.
    f.op(
        "w",
        Operation::Apply {
            session: restarted,
            items: vec![item("gone", "陈旧", 10, false)],
            cursor: 12,
        },
    );
    assert!(!super::super::dev_memory::read(&f.root, "w")
        .unwrap()
        .library
        .cards
        .iter()
        .any(|c| c.id == "gone"));
}

#[test]
fn persisted_deferred_replays_without_any_new_remote_changes() {
    let f = Fixture::new();
    f.configure("w", SERVER, Some("t"), PROJECT);
    f.cards("w", |cards| {
        cards.extend((0..MAX_CARDS).map(|i| card(&format!("k{i}"), "满")))
    });
    let (s, _) = f.bind("w", "r", "a");
    f.op(
        "w",
        Operation::Apply {
            session: s,
            items: vec![item("queued", "待接收", 9, false)],
            cursor: 9,
        },
    );
    f.cards("w", |cards| {
        cards.pop();
    });
    let (restarted, _) = f.bind("w", "r", "a");
    let v = f.op(
        "w",
        Operation::Apply {
            session: restarted,
            items: vec![],
            cursor: 9,
        },
    );
    assert_eq!(v.deferred, 0);
    assert!(super::super::dev_memory::read(&f.root, "w")
        .unwrap()
        .library
        .cards
        .iter()
        .any(|c| c.id == "queued"));
}

#[test]
fn deferred_replay_preserves_a_concurrent_local_edit_as_conflict() {
    let mut s = State::default();
    let mut cards: Vec<Card> = (0..MAX_CARDS)
        .map(|i| card(&format!("k{i}"), "满"))
        .collect();
    apply(&mut cards, &mut s, vec![item("q", "远端", 1, false)], 1);
    cards.pop();
    cards.push(card("q", "本地新内容"));
    apply(&mut cards, &mut s, vec![], 1);
    assert!(s.deferred.is_empty());
    assert_eq!(s.conflicts.len(), 1);
    assert_eq!(
        cards.iter().find(|c| c.id == "q").unwrap().title,
        "本地新内容"
    );
}

#[test]
fn legacy_cursor_is_not_trusted_and_local_deletion_is_not_resurrected() {
    let f = Fixture::new();
    f.cards("w", |_| {});
    let mut legacy = State {
        cursor: 900,
        ..State::default()
    };
    legacy.synced.insert(
        "removed".into(),
        Synced {
            seq: 800,
            hash: "old".into(),
            deleted: false,
        },
    );
    write_json(&f.dir("w").join("sync.json"), &legacy).unwrap();
    let before = fs::read(f.dir("w").join("sync.json")).unwrap();
    let v = f.op("w", Operation::Page(Request::Status));
    assert_eq!(v.project_id, digest("w"));
    f.configure("w", SERVER, Some("t"), &v.project_id);
    let (s, v) = f.bind("w", "r", "a");
    assert_eq!(v.cursor, 0);
    let v = f.op(
        "w",
        Operation::Apply {
            session: s,
            items: vec![item("removed", "云端仍有", 1, false)],
            cursor: 1,
        },
    );
    assert_eq!(v.conflicts.len(), 1);
    assert!(super::super::dev_memory::read(&f.root, "w")
        .unwrap()
        .library
        .cards
        .is_empty());
    assert_eq!(fs::read(f.dir("w").join("sync.json")).unwrap(), before);
}

#[test]
fn card_write_failure_never_runs_the_state_commit() {
    let f = Fixture::new();
    let committed = std::cell::Cell::new(false);
    let result = super::super::dev_memory::with_cards(&f.root, "w", |dir, cards| {
        cards.push(card("a", "内容"));
        fs::create_dir(dir.join("library.json"))?; // Deterministically fail the subsequent atomic rename.
        Ok(((), true, || {
            committed.set(true);
            Ok(())
        }))
    });
    assert!(result.is_err());
    assert!(!committed.get());
}

#[test]
fn state_write_failure_keeps_old_cursor_and_replaying_saved_cards_is_safe() {
    let f = Fixture::new();
    f.configure("w", SERVER, Some("t"), PROJECT);
    let (s, _) = f.bind("w", "r", "a");
    let temporary = f
        .dir("w")
        .join("sync-states")
        .join(format!("{}.syncing", s.scope.key()));
    fs::create_dir(&temporary).unwrap();
    assert!(handle(
        &f.root,
        "w",
        Operation::Apply {
            session: s.clone(),
            items: vec![item("a", "收到", 1, false)],
            cursor: 1
        }
    )
    .is_err());
    assert_eq!(
        super::super::dev_memory::read(&f.root, "w")
            .unwrap()
            .library
            .cards
            .len(),
        1
    );
    assert_eq!(f.op("w", Operation::Check(s.clone())).cursor, 0);
    fs::remove_dir(&temporary).unwrap();
    let v = f.op(
        "w",
        Operation::Apply {
            session: s,
            items: vec![item("a", "收到", 1, false)],
            cursor: 1,
        },
    );
    assert_eq!(v.cursor, 1);
    assert!(v.conflicts.is_empty());
}

#[test]
fn workspace_single_flight_is_released_on_failure_or_drop() {
    let id = uuid::Uuid::new_v4().to_string();
    let a = super::runner::InFlight::acquire(&id).unwrap();
    assert!(super::runner::InFlight::acquire(&id).is_err());
    let other = super::runner::InFlight::acquire(&(id.clone() + "other")).unwrap();
    drop(a);
    drop(other);
    assert!(super::runner::InFlight::acquire(&id).is_ok());
}

#[test]
fn full_reconciliation_retains_conflicts_and_deferred_versions_across_restart() {
    let f = Fixture::new();
    f.configure("w", SERVER, Some("token"), PROJECT);
    f.cards("w", |cards| {
        cards.push(card("conflict", "本机当前"));
        cards.extend((1..MAX_CARDS).map(|i| card(&format!("k{i}"), "占用")));
    });
    let (session, _) = f.bind("w", "r", "a");
    let original = f.op(
        "w",
        Operation::Apply {
            session: session.clone(),
            items: vec![
                item("conflict", "先前云端", 80, false),
                item("queued", "尚未接收", 81, false),
            ],
            cursor: 81,
        },
    );
    assert_eq!(original.conflicts.len(), 1);
    assert_eq!(original.deferred, 1);
    let aligned = f.op(
        "w",
        Operation::Reconcile {
            session,
            items: vec![item("conflict", "恢复旧版", 1, false)],
            cursor: 1,
        },
    );
    assert_eq!(aligned.cursor, 1);
    assert_eq!(aligned.conflicts.len(), 2);
    assert_eq!(
        aligned.deferred, 0,
        "a missing queued payload becomes a recoverable conflict"
    );
    let (restarted, saved) = f.bind("w", "r", "a");
    let conflict = saved.conflicts.iter().find(|c| c.id == "conflict").unwrap();
    assert_eq!(
        conflict.alternatives,
        vec![item("conflict", "先前云端", 80, false)]
    );
    assert_eq!(conflict.remote, item("conflict", "恢复旧版", 1, false));
    let queued = saved.conflicts.iter().find(|c| c.id == "queued").unwrap();
    assert!(queued.remote_missing);
    assert_eq!(
        queued.alternatives,
        vec![item("queued", "尚未接收", 81, false)]
    );
    assert!(super::super::dev_memory::read(&f.root, "w")
        .unwrap()
        .library
        .cards
        .iter()
        .all(|c| c.id != "queued"));
    // A later pull cannot auto-dismiss a recovered alternative even if current local == remote.
    f.op(
        "w",
        Operation::Apply {
            session: restarted.clone(),
            items: vec![item("conflict", "本机当前", 2, false)],
            cursor: 2,
        },
    );
    let preserved = f.op("w", Operation::Check(restarted.clone()));
    assert_eq!(preserved.conflicts.len(), 2);
    assert_eq!(
        preserved
            .conflicts
            .iter()
            .find(|c| c.id == "conflict")
            .unwrap()
            .alternatives
            .len(),
        2
    );
    f.cards("w", |cards| {
        cards.pop();
    });
    f.op(
        "w",
        Operation::Page(Request::Resolve {
            id: "queued".into(),
            choice: "saved:0".into(),
            scope: restarted.scope.key(),
        }),
    );
    let changes = f.op("w", Operation::Prepare(restarted)).changes.unwrap();
    let upload = changes.iter().find(|c| c.id == "queued").unwrap();
    assert_eq!(upload.base_seq, 0);
    assert_eq!(
        upload.payload,
        item("queued", "尚未接收", 81, false).payload
    );
}

#[test]
fn complete_scan_preserves_local_deletion_and_does_not_replace_local_with_old_tombstone() {
    let mut state = State::default();
    let mut cards = vec![];
    apply(
        &mut cards,
        &mut state,
        vec![
            item("deleted", "曾存在", 80, false),
            item("alive", "当前", 81, false),
        ],
        81,
    );
    cards.retain(|c| c.id != "deleted");
    reconciliation::reconcile(
        &mut cards,
        &mut state,
        vec![
            item("deleted", "备份旧版", 1, false),
            item("alive", "", 2, true),
        ],
        2,
    );
    assert_eq!(state.conflicts.len(), 2);
    assert!(state
        .conflicts
        .iter()
        .find(|c| c.id == "deleted")
        .unwrap()
        .local
        .is_none());
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].title, "当前");
}

#[test]
fn complete_scan_rebases_and_replays_an_unchanged_deferred_payload() {
    let mut state = State::default();
    let mut cards: Vec<_> = (0..MAX_CARDS)
        .map(|i| card(&format!("k{i}"), "满"))
        .collect();
    apply(
        &mut cards,
        &mut state,
        vec![item("queued", "待接收", 80, false)],
        80,
    );
    reconciliation::reconcile(
        &mut cards,
        &mut state,
        vec![item("queued", "待接收", 1, false)],
        1,
    );
    assert_eq!(state.deferred["queued"].seq, 1);
    cards.pop();
    apply(&mut cards, &mut state, vec![], 1);
    assert!(state.deferred.is_empty());
    assert!(cards.iter().any(|c| c.id == "queued"));
}

#[test]
fn missing_push_baseline_keeps_a_pending_delete_for_retry() {
    let mut state = State::default();
    ack(
        &[],
        &mut state,
        vec![Ack {
            id: "deleted".into(),
            outcome: "conflict".into(),
            seq: 0,
            current: None,
            payload: String::new(),
            deleted: true,
        }],
    );
    let changes = prepare(&[], &mut state, "device", 1);
    assert_eq!(changes.len(), 1);
    assert!(changes[0].deleted);
    assert_eq!(changes[0].base_seq, 0);
}

#[test]
fn persisted_choices_require_a_new_decision_only_when_cloud_content_changes() {
    for mode in ["incremental", "full", "missing"] {
        let f = Fixture::new();
        f.configure("w", SERVER, Some("token"), PROJECT);
        f.cards("w", |cards| cards.push(card("a", "本机选择")));
        let (session, _) = f.bind("w", "r", "a");
        let reviewed = item("a", "已经确认", 5, false);
        f.op(
            "w",
            Operation::Apply {
                session: session.clone(),
                items: vec![reviewed.clone()],
                cursor: 5,
            },
        );
        f.op(
            "w",
            Operation::Page(Request::Resolve {
                id: "a".into(),
                choice: "local".into(),
                scope: session.scope.key(),
            }),
        );
        let path = f
            .dir("w")
            .join("sync-states")
            .join(format!("{}.json", session.scope.key()));
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            saved["state"]["pending_resolutions"]["a"]["selected"],
            payload(&card("a", "本机选择"))
        );
        assert_eq!(
            saved["state"]["pending_resolutions"]["a"]["expected_remote"]["hash"],
            digest(&reviewed.payload)
        );
        let (restarted, _) = f.bind("w", "r", "a");
        let items = vec![item("a", "再次更改", 6, false)];
        let operation = match mode {
            "incremental" => Operation::Apply {
                session: restarted.clone(),
                items,
                cursor: 6,
            },
            "full" => Operation::Reconcile {
                session: restarted.clone(),
                items,
                cursor: 6,
            },
            _ => Operation::Reconcile {
                session: restarted.clone(),
                items: vec![],
                cursor: 0,
            },
        };
        let changed = f.op("w", operation);
        assert_eq!(changed.conflicts.len(), 1, "{mode}");
        assert_eq!(changed.conflicts[0].remote_missing, mode == "missing");
        assert!(f
            .op("w", Operation::Prepare(restarted))
            .changes
            .unwrap()
            .is_empty());
        assert_eq!(
            super::super::dev_memory::read(&f.root, "w")
                .unwrap()
                .library
                .cards[0]
                .title,
            "本机选择"
        );
    }
}

#[test]
fn pending_delete_survives_a_complete_scan_and_same_content_sequence_rollback() {
    let mut state = State::default();
    let mut cards = vec![];
    apply(&mut cards, &mut state, vec![item("a", "初始", 4, false)], 4);
    cards.clear();
    apply(
        &mut cards,
        &mut state,
        vec![item("a", "已确认云端", 5, false)],
        5,
    );
    resolve(&mut cards, &mut state, "a", "local").unwrap();
    let mut restarted: State =
        serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
    reconciliation::reconcile(
        &mut cards,
        &mut restarted,
        vec![item("a", "已确认云端", 1, false)],
        1,
    );
    assert!(cards.is_empty());
    assert!(restarted.conflicts.is_empty());
    let changes = prepare(&cards, &mut restarted, "device", 10);
    assert_eq!(changes.len(), 1);
    assert!(changes[0].deleted);
    assert_eq!(changes[0].base_seq, 1);
    ack(
        &cards,
        &mut restarted,
        vec![Ack {
            id: "a".into(),
            outcome: "accepted".into(),
            seq: 2,
            current: None,
            payload: String::new(),
            deleted: true,
        }],
    );
    assert!(restarted.pending_resolutions.is_empty());
    assert!(prepare(&cards, &mut restarted, "device", 11).is_empty());
}

#[test]
fn a_new_push_conflict_preserves_current_local_and_the_earlier_chosen_version() {
    let mut state = State::default();
    let mut cards = vec![card("a", "用户选择")];
    apply(
        &mut cards,
        &mut state,
        vec![item("a", "已确认云端", 5, false)],
        5,
    );
    resolve(&mut cards, &mut state, "a", "local").unwrap();
    cards[0].title = "随后本机编辑".into();
    ack(
        &cards,
        &mut state,
        vec![Ack {
            id: "a".into(),
            outcome: "conflict".into(),
            seq: 6,
            current: Some(item("a", "云端新编辑", 6, false)),
            payload: payload(&cards[0]),
            deleted: false,
        }],
    );
    assert!(state.pending_resolutions.is_empty());
    assert_eq!(state.conflicts.len(), 1);
    assert_eq!(state.conflicts[0].local, Some(payload(&cards[0])));
    assert_eq!(
        state.conflicts[0].alternatives[0].payload,
        payload(&card("a", "用户选择"))
    );
}
