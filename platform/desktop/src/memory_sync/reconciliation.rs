//! A complete scan can lower the cursor after an older server backup is restored. Sequence
//! numbers alone cannot establish freshness across restores, so differing known content is
//! retained as a conflict. No absence decisions are made until the caller has every page.
use super::*;

fn same(a: &Item, b: &Item) -> bool {
    a.kind == b.kind && a.deleted == b.deleted && (a.deleted || a.payload == b.payload)
}

fn absent(id: &str) -> Item {
    Item {
        id: id.into(),
        kind: "card".into(),
        payload: String::new(),
        hlc: String::new(),
        device: String::new(),
        deleted: true,
        seq: 0,
    }
}

fn preserve(conflict: &mut Conflict, item: Item) {
    if !conflict.alternatives.iter().any(|old| same(old, &item)) {
        conflict.alternatives.push(item);
    }
}

pub(super) fn update_conflict(
    conflict: &mut Conflict,
    local: Option<String>,
    remote: Option<Item>,
) {
    if !conflict.remote_missing
        && remote
            .as_ref()
            .is_none_or(|item| !same(item, &conflict.remote))
    {
        preserve(conflict, conflict.remote.clone());
    }
    conflict.local = local;
    conflict.remote_missing = remote.is_none();
    conflict.remote = remote.unwrap_or_else(|| absent(&conflict.id));
}

fn force_push(state: &mut State, id: &str, seq: i64) {
    state.synced.insert(
        id.into(),
        Synced {
            seq,
            hash: "\u{0}".into(),
            deleted: false,
        },
    );
}

/// A user's choice stays queued when the reviewed cloud content is unchanged, including
/// a replay at the same seq or a restore that only renumbers it. New content requires a new
/// decision. Both incremental pulls, full scans and push conflicts use this same comparison.
pub(super) fn observe_resolution(
    state: &mut State,
    id: &str,
    local: Option<String>,
    current: Option<Item>,
) -> bool {
    let Some(mut choice) = state.pending_resolutions.remove(id) else {
        return false;
    };
    let observed = current.as_ref().map(remote_snapshot);
    let unchanged = match (&choice.expected_remote, &observed) {
        (None, None) => true,
        (Some(expected), Some(actual)) => {
            expected.hash == actual.hash && expected.deleted == actual.deleted
        }
        _ => false,
    };
    if let Some(remote) = &observed {
        state.synced.insert(id.into(), remote.clone());
    } else {
        state.synced.remove(id);
    }
    if unchanged {
        choice.expected_remote = observed;
        state.pending_resolutions.insert(id.into(), choice);
    } else {
        let mut alternatives = vec![];
        if choice.selected != local {
            let mut selected = absent(id);
            selected.device = "saved-choice".into();
            if let Some(payload) = choice.selected {
                selected.payload = payload;
                selected.deleted = false;
            }
            alternatives.push(selected);
        }
        state.conflicts.push(Conflict {
            id: id.into(),
            local,
            remote_missing: current.is_none(),
            remote: current.unwrap_or_else(|| absent(id)),
            alternatives,
        });
    }
    true
}

pub(super) fn reconcile(
    cards: &mut Vec<Card>,
    state: &mut State,
    items: Vec<Item>,
    cursor: i64,
) -> bool {
    let mut remote: BTreeMap<String, Item> = BTreeMap::new();
    for item in items.into_iter().filter(|i| i.kind == "card") {
        if remote.get(&item.id).is_none_or(|old| old.seq < item.seq) {
            remote.insert(item.id.clone(), item);
        }
    }
    let ids: BTreeSet<String> = remote
        .keys()
        .chain(state.synced.keys())
        .chain(state.deferred.keys())
        .chain(state.pending_resolutions.keys())
        .chain(state.legacy_missing.iter())
        .cloned()
        .chain(cards.iter().map(|c| c.id.clone()))
        .chain(state.conflicts.iter().map(|c| c.id.clone()))
        .collect();
    let mut changed = false;
    for id in ids {
        let current = remote.remove(&id);
        let local = local_payload(cards, &id);
        if observe_resolution(state, &id, local.clone(), current.clone()) {
            continue;
        }
        let queued = state.deferred.remove(&id);
        if let Some(conflict) = state.conflicts.iter_mut().find(|c| c.id == id) {
            update_conflict(conflict, local, current.clone());
            if let Some(queued) = queued {
                preserve(conflict, queued);
            }
            // Drop only the obsolete sequence baseline; all unchosen content stays in conflict.
            if let Some(item) = &current {
                state.synced.insert(id, remote_snapshot(item));
            } else {
                state.synced.remove(&id);
            }
            continue;
        }
        if let Some(queued) = queued {
            if current.as_ref().is_none_or(|item| !same(item, &queued)) {
                let missing = current.is_none();
                let item = current.unwrap_or_else(|| absent(&id));
                state.synced.insert(id.clone(), remote_snapshot(&item));
                state.conflicts.push(Conflict {
                    id,
                    local,
                    remote: item,
                    remote_missing: missing,
                    alternatives: vec![queued],
                });
                continue;
            }
            // Same payload with a restored sequence is still pending, and can now replay.
        }
        let Some(item) = current else {
            if local.is_some() {
                state.synced.remove(&id);
            } else if state.synced.contains_key(&id) || state.legacy_missing.contains(&id) {
                // Recreate a tombstone rather than discarding the user's deletion intent.
                force_push(state, &id, 0);
            }
            continue;
        };
        let snapshot = remote_snapshot(&item);
        if state.synced.get(&id) == Some(&snapshot) {
            continue; // Unchanged cloud baseline: preserve an ordinary pending local edit/delete.
        }
        let matches = local.as_deref().map(digest).unwrap_or_default() == snapshot.hash
            && local.is_some() != item.deleted;
        if matches {
            state.synced.insert(id.clone(), snapshot);
            state.legacy_missing.remove(&id);
        } else if local.is_none()
            && !state.synced.contains_key(&id)
            && !state.legacy_missing.contains(&id)
        {
            if write_remote(cards, &item) {
                changed = true;
                state.synced.insert(id, snapshot);
            } else {
                state.deferred.insert(id, item);
            }
        } else {
            state.synced.insert(id.clone(), snapshot);
            state.conflicts.push(Conflict {
                id,
                local,
                remote: item,
                remote_missing: false,
                alternatives: vec![],
            });
        }
    }
    state.cursor = cursor;
    state.skipped = state.deferred.len().try_into().unwrap_or(u32::MAX);
    changed
}
