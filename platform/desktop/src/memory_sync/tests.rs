use super::runner::{acks_for, PushReply};
use super::*;

fn card(id: &str, title: &str) -> Card {
    Card {
        id: id.into(),
        category: "project".into(),
        title: title.into(),
        body: "正文".into(),
        revision: 1,
    }
}
fn item(id: &str, title: &str, seq: i64, deleted: bool) -> Item {
    let payload = if deleted {
        String::new()
    } else {
        payload(&card(id, title))
    };
    Item {
        id: id.into(),
        kind: "card".into(),
        payload,
        hlc: "0000000000001-0000-x".into(),
        device: "other".into(),
        deleted,
        seq,
    }
}
fn accept_all(cards: &[Card], state: &mut State, changes: &[Change], seq0: i64) {
    let acks = changes
        .iter()
        .enumerate()
        .map(|(i, c)| Ack {
            id: c.id.clone(),
            outcome: "accepted".into(),
            seq: seq0 + i as i64,
            current: None,
            payload: c.payload.clone(),
            deleted: c.deleted,
        })
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
    let changed = apply(
        &mut cards,
        &mut s,
        vec![
            item("a", "云端改", 10, false),
            item("b", "云端也改", 11, false),
            item("c", "新条目", 12, false),
        ],
        12,
    );
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
    apply(
        &mut cards,
        &mut s,
        vec![item("a", "云A", 7, false), item("b", "云B", 8, true)],
        8,
    );
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
        Ack {
            id: "a".into(),
            outcome: "conflict".into(),
            seq: 4,
            current: Some(item("a", "云", 4, false)),
            payload: String::new(),
            deleted: false,
        },
        Ack {
            id: "b".into(),
            outcome: "conflict".into(),
            seq: 0,
            current: None,
            payload: String::new(),
            deleted: false,
        },
    ];
    s.synced.insert(
        "b".into(),
        Synced {
            seq: 3,
            hash: "x".into(),
            deleted: false,
        },
    );
    ack(&cards, &mut s, acks);
    assert_eq!(s.conflicts.len(), 1);
    assert!(!s.synced.contains_key("b"));
    assert_eq!(
        prepare(&cards, &mut s, "d", 1)
            .iter()
            .find(|c| c.id == "b")
            .unwrap()
            .base_seq,
        0
    );
}

#[test]
fn invalid_or_overflow_remote_items_are_skipped_without_loss() {
    let mut s = State::default();
    let mut cards: Vec<Card> = (0..MAX_CARDS)
        .map(|i| card(&format!("k{i}"), "t"))
        .collect();
    let mut bad = item("z", "t", 3, false);
    bad.payload = "不是 JSON（可能是另一台设备开了端到端加密）".into();
    apply(
        &mut cards,
        &mut s,
        vec![item("new", "满了", 2, false), bad],
        3,
    );
    assert_eq!(cards.len(), MAX_CARDS);
    assert_eq!(s.skipped, 2);
    assert_eq!(s.cursor, 3);
}

#[test]
fn overflow_survives_restart_and_recovers_after_capacity_is_freed() {
    let mut s = State::default();
    let mut cards: Vec<Card> = (0..MAX_CARDS)
        .map(|i| card(&format!("k{i}"), "t"))
        .collect();
    apply(
        &mut cards,
        &mut s,
        vec![item("queued", "远端内容", 9, false)],
        9,
    );
    let mut restarted: State = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
    cards.pop();
    apply(&mut cards, &mut restarted, vec![], 9);
    assert!(
        cards.iter().any(|c| c.id == "queued"),
        "未变化的远端内容必须在释放容量后恢复"
    );
}

#[test]
fn server_must_be_https_or_loopback() {
    assert!(super::http::parse_server("https://lumo.example.com").is_ok());
    assert!(super::http::parse_server("http://127.0.0.1:8086").is_ok());
    assert!(super::http::parse_server("http://lumo.example.com").is_err());
    assert!(super::http::parse_server("https://a b").is_err());
    assert!(super::http::parse_server("http://127.0.0.1.evil.com").is_err());
    assert!(super::http::parse_server("").is_err());
}

#[test]
fn page_cannot_drive_internal_ops_or_see_token() {
    for op in ["prepare", "apply", "ack", "bind", "capture"] {
        assert!(serde_json::from_value::<Request>(serde_json::json!({ "op": op })).is_err());
    }
    assert!(!serde_json::to_string(&View::default())
        .unwrap()
        .contains("token"));
}

#[test]
fn push_results_only_ack_sent_ids_with_sent_payload() {
    let batch = vec![Change {
        id: "c1".into(),
        kind: "card".into(),
        payload: "p".into(),
        hlc: "h".into(),
        deleted: false,
        base_seq: 0,
    }];
    let reply: PushReply = serde_json::from_str(r#"{"results":[{"id":"c1","outcome":"accepted","seq":7},{"id":"zz","outcome":"accepted"}]}"#).unwrap();
    assert!(acks_for(&batch, reply.results).is_err());
    let reply: PushReply =
        serde_json::from_str(r#"{"results":[{"id":"c1","outcome":"accepted","seq":7}]}"#).unwrap();
    let acks = acks_for(&batch, reply.results).unwrap();
    assert_eq!(acks.len(), 1);
    assert_eq!(
        (acks[0].seq, acks[0].payload.as_str(), acks[0].deleted),
        (7, "p", false)
    );
}
