use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};

fn t1() -> ThreadRef {
    ThreadRef {
        channel_id: "c1".into(),
        thread_root_id: "r1".into(),
    }
}
fn ms(s: &str) -> u64 {
    parse_iso_ms(s).unwrap()
}
fn now() -> u64 {
    ms("2026-10-06T00:00:00Z")
}
const S: CleanupSettings = CleanupSettings {
    enabled: true,
    grace_days: 7,
};
fn pr(state: PrState, head: Option<&str>) -> Option<CleanupPr> {
    Some(CleanupPr {
        number: 1,
        state,
        head_sha: head.map(str::to_string),
    })
}
fn wt() -> ObservedWorktree {
    ObservedWorktree {
        path: "/tmp/wt-a".into(),
        repo: "/repo".into(),
        branch: Some("b".into()),
        head_sha: Some("abc".into()),
        thread: Some(t1()),
        pr: pr(PrState::Merged, Some("abc")),
        size: Some(100.0),
        ..Default::default()
    }
}
fn facts(w: Vec<ObservedWorktree>, done: bool) -> SweepFacts {
    SweepFacts {
        worktrees: w,
        done_threads: if done {
            ["c1/r1".to_string()].into()
        } else {
            HashSet::new()
        },
        ..Default::default()
    }
}
fn empty() -> CleanupLedger {
    CleanupLedger::default()
}

#[test]
fn merged_and_done_is_listed_with_grace_and_deps_removal() {
    let p = plan_sweep(&empty(), &facts(vec![wt()], true), &S, now());
    assert_eq!(p.ledger.items[0].state, CleanupState::Listed);
    assert_eq!(
        p.ledger.items[0].delete_after.as_deref(),
        Some("2026-10-13T00:00:00.000Z")
    );
    assert_eq!(p.actions, vec![SweepAction::RemoveDeps("/tmp/wt-a".into())]);
}

#[test]
fn not_done_or_open_pr_stays_off_the_ledger() {
    assert!(
        plan_sweep(&empty(), &facts(vec![wt()], false), &S, now())
            .ledger
            .items
            .is_empty()
    );
    let open = ObservedWorktree {
        pr: pr(PrState::Open, None),
        ..wt()
    };
    assert!(
        plan_sweep(&empty(), &facts(vec![open], true), &S, now())
            .ledger
            .items
            .is_empty()
    );
}

#[test]
fn unowned_is_shown_only_with_no_actions() {
    let w = ObservedWorktree {
        thread: None,
        ..wt()
    };
    let p = plan_sweep(&empty(), &facts(vec![w.clone()], true), &S, now());
    assert_eq!(p.ledger.items[0].state, CleanupState::Unowned);
    assert!(p.actions.is_empty());
    let later = plan_sweep(
        &p.ledger,
        &facts(vec![w], true),
        &S,
        ms("2026-12-01T00:00:00Z"),
    );
    assert!(later.actions.is_empty());
}

#[test]
fn due_is_deleted_and_new_turn_revives() {
    let first = plan_sweep(&empty(), &facts(vec![wt()], true), &S, now()).ledger;
    let due = ms("2026-10-14T00:00:00Z");
    assert_eq!(
        plan_sweep(&first, &facts(vec![wt()], true), &S, due).actions,
        vec![SweepAction::Delete("/tmp/wt-a".into())]
    );
    let mut f = facts(vec![wt()], true);
    f.last_turn_at
        .insert("c1/r1".into(), "2026-10-08T00:00:00.000Z".into());
    let revived = plan_sweep(&first, &f, &S, due);
    assert!(revived.ledger.items.is_empty());
    assert_eq!(
        revived.ledger.events.last().unwrap().action,
        EventAction::Revived
    );
}

#[test]
fn kept_is_never_deleted_and_disabled_does_nothing() {
    let first = plan_sweep(&empty(), &facts(vec![wt()], true), &S, now()).ledger;
    let (kept, _) =
        apply_human_action(&first, "/tmp/wt-a", HumanAction::Keep, "acct-1", &S, now()).unwrap();
    assert_eq!(kept.items[0].state, CleanupState::Kept);
    assert_eq!(kept.items[0].acted_by.as_deref(), Some("acct-1"));
    assert!(
        plan_sweep(
            &kept,
            &facts(vec![wt()], true),
            &S,
            ms("2027-01-01T00:00:00Z")
        )
        .actions
        .is_empty()
    );
    let off = CleanupSettings {
        enabled: false,
        ..S
    };
    assert!(
        plan_sweep(&empty(), &facts(vec![wt()], true), &off, now())
            .ledger
            .items
            .is_empty()
    );
}

#[test]
fn unowned_listed_only_by_hand() {
    let w = ObservedWorktree {
        thread: None,
        ..wt()
    };
    let p = plan_sweep(&empty(), &facts(vec![w], true), &S, now()).ledger;
    let (l, a) =
        apply_human_action(&p, "/tmp/wt-a", HumanAction::List, "acct-1", &S, now()).unwrap();
    assert_eq!(l.items[0].state, CleanupState::Listed);
    assert_eq!(a, vec![SweepAction::RemoveDeps("/tmp/wt-a".into())]);
    assert!(apply_human_action(&p, "/tmp/wt-a", HumanAction::Unkeep, "a", &S, now()).is_err());
    assert!(apply_human_action(&p, "/nope", HumanAction::Keep, "a", &S, now()).is_err());
    // 지금 정리는 삭제 예정(listed·blocked)만.
    assert!(apply_human_action(&p, "/tmp/wt-a", HumanAction::DeleteNow, "a", &S, now()).is_err());
    let (d, a) =
        apply_human_action(&l, "/tmp/wt-a", HumanAction::DeleteNow, "a", &S, now()).unwrap();
    assert_eq!(a, vec![SweepAction::Delete("/tmp/wt-a".into())]);
    assert_eq!(
        d.items[0].delete_after.as_deref(),
        Some("2026-10-06T00:00:00.000Z")
    );
}

const OLD: &str = "2026-09-20T00:00:00.000Z";
fn u() -> ObservedWorktree {
    ObservedWorktree {
        thread: None,
        clean: Some(true),
        only_rebuildable_ignored: Some(true),
        last_activity_at: Some(OLD.into()),
        ..wt()
    }
}
fn uplan(w: ObservedWorktree, s: &CleanupSettings, at: u64, prev: &CleanupLedger) -> SweepPlan {
    plan_sweep(prev, &facts(vec![w], false), s, at)
}

#[test]
fn unowned_auto_lists_when_all_conditions_hold() {
    let p = uplan(u(), &S, now(), &empty());
    assert_eq!(p.ledger.items[0].state, CleanupState::Listed);
    assert_eq!(p.ledger.items[0].acted_by, None);
    assert_eq!(p.actions, vec![SweepAction::RemoveDeps("/tmp/wt-a".into())]);
    assert_eq!(
        uplan(u(), &S, ms("2026-10-14T00:00:00Z"), &p.ledger).actions,
        vec![SweepAction::Delete("/tmp/wt-a".into())]
    );
    let closed = ObservedWorktree {
        pr: pr(PrState::Closed, Some("abc")),
        ..u()
    };
    assert_eq!(
        uplan(closed, &S, now(), &empty()).ledger.items[0].state,
        CleanupState::Listed
    );
}

#[test]
fn unowned_auto_each_missing_condition_keeps_it_unowned() {
    let cases: Vec<ObservedWorktree> = vec![
        ObservedWorktree {
            pr: pr(PrState::Open, Some("abc")),
            ..u()
        },
        ObservedWorktree { pr: None, ..u() },
        ObservedWorktree {
            pr: pr(PrState::Merged, Some("old")),
            ..u()
        },
        ObservedWorktree {
            pr: pr(PrState::Merged, None),
            ..u()
        },
        ObservedWorktree {
            head_sha: None,
            ..u()
        },
        ObservedWorktree {
            clean: Some(false),
            ..u()
        },
        ObservedWorktree { clean: None, ..u() },
        ObservedWorktree {
            only_rebuildable_ignored: Some(false),
            ..u()
        },
        ObservedWorktree {
            only_rebuildable_ignored: None,
            ..u()
        },
        ObservedWorktree {
            last_activity_at: Some("2026-10-01T00:00:00.000Z".into()),
            ..u()
        },
        ObservedWorktree {
            last_activity_at: None,
            ..u()
        },
    ];
    for (i, w) in cases.into_iter().enumerate() {
        let p = uplan(w, &S, now(), &empty());
        assert_eq!(p.ledger.items[0].state, CleanupState::Unowned, "case {i}");
        assert!(p.actions.is_empty(), "case {i}");
    }
    let off = CleanupSettings {
        enabled: false,
        ..S
    };
    assert_eq!(
        uplan(u(), &off, now(), &empty()).ledger.items[0].state,
        CleanupState::Unowned
    );
    let long = CleanupSettings {
        grace_days: 30,
        ..S
    };
    assert_eq!(
        uplan(u(), &long, now(), &empty()).ledger.items[0].state,
        CleanupState::Unowned
    );
}

#[test]
fn shown_unowned_lists_later_but_kept_stays() {
    let shown = uplan(
        ObservedWorktree {
            clean: Some(false),
            ..u()
        },
        &S,
        now(),
        &empty(),
    )
    .ledger;
    assert_eq!(
        uplan(u(), &S, now(), &shown).ledger.items[0].state,
        CleanupState::Listed
    );
    let (kept, _) =
        apply_human_action(&shown, "/tmp/wt-a", HumanAction::Keep, "acct-1", &S, now()).unwrap();
    assert_eq!(
        uplan(u(), &S, now(), &kept).ledger.items[0].state,
        CleanupState::Kept
    );
}

#[test]
fn f1_unowned_revived_on_new_commit_or_reopened_pr() {
    let listed = uplan(u(), &S, now(), &empty()).ledger;
    let due = ms("2026-10-20T00:00:00Z");
    let moved = ObservedWorktree {
        head_sha: Some("def".into()),
        last_activity_at: None,
        clean: None,
        only_rebuildable_ignored: None,
        ..u()
    };
    let r = uplan(moved, &S, due, &listed);
    assert!(r.actions.is_empty());
    assert!(r.ledger.items.iter().all(|i| i.path != "/tmp/wt-a"));
    assert_eq!(r.ledger.events.last().unwrap().action, EventAction::Revived);
    for p in [pr(PrState::Open, Some("abc")), None] {
        let r = uplan(ObservedWorktree { pr: p, ..u() }, &S, due, &listed);
        assert!(r.actions.is_empty());
        assert_eq!(r.ledger.events.last().unwrap().action, EventAction::Revived);
    }
    // 사람이 넣은 것은 되살리지 않는다.
    let shown = uplan(
        ObservedWorktree {
            clean: Some(false),
            ..u()
        },
        &S,
        now(),
        &empty(),
    )
    .ledger;
    let (by_hand, _) =
        apply_human_action(&shown, "/tmp/wt-a", HumanAction::List, "acct-1", &S, now()).unwrap();
    let r = uplan(
        ObservedWorktree {
            head_sha: Some("def".into()),
            ..u()
        },
        &S,
        due,
        &by_hand,
    );
    assert_eq!(r.ledger.items[0].state, CleanupState::Listed);
    // 손댄 흔적이 새로 생기면 되살린다.
    let r = uplan(
        ObservedWorktree {
            last_activity_at: Some("2026-10-07T00:00:00.000Z".into()),
            ..u()
        },
        &S,
        ms("2026-10-08T00:00:00Z"),
        &listed,
    );
    assert!(r.ledger.items.is_empty());
    assert_eq!(r.ledger.events.last().unwrap().action, EventAction::Revived);
}

struct Ports {
    reason: Option<BlockReason>,
    removed: Cell<usize>,
    deps: RefCell<Vec<String>>,
}
impl CleanupPorts for Ports {
    fn check(&self, _i: &CleanupItem, _r: &HashSet<String>) -> Option<BlockReason> {
        self.reason
    }
    fn remove(&self, _i: &CleanupItem) -> Result<(), String> {
        self.removed.set(self.removed.get() + 1);
        Ok(())
    }
    fn size(&self, _p: &str) -> Option<f64> {
        Some(1.0)
    }
    fn remove_deps(&self, root: &str) -> Result<(), String> {
        self.deps.borrow_mut().push(root.into());
        Ok(())
    }
}
fn ports(reason: Option<BlockReason>) -> Ports {
    Ports {
        reason,
        removed: Cell::new(0),
        deps: RefCell::default(),
    }
}

#[test]
fn run_sweep_blocks_with_reason_then_deletes() {
    let first = plan_sweep(&empty(), &facts(vec![wt()], true), &S, now()).ledger;
    let plan = plan_sweep(
        &first,
        &facts(vec![wt()], true),
        &S,
        ms("2026-10-14T00:00:00Z"),
    );
    let p = ports(Some(BlockReason::Uncommitted));
    let out = run_sweep(plan.clone(), &p, &HashSet::new(), now());
    assert_eq!(p.removed.get(), 0);
    assert_eq!(out.items[0].state, CleanupState::Blocked);
    assert_eq!(out.items[0].block_reason, Some(BlockReason::Uncommitted));
    let p = ports(None);
    let ok = run_sweep(plan, &p, &HashSet::new(), now());
    assert_eq!(p.removed.get(), 1);
    assert!(ok.items.is_empty());
    assert_eq!(ok.events.last().unwrap().action, EventAction::Deleted);
}

/// TS 보다 좁게: 원장의 경로가 `safe_target` 이 아니면 지우지도 의존성을 건드리지도 않는다.
#[test]
fn run_sweep_skips_unsafe_paths_from_a_tampered_ledger() {
    for bad in [
        "/",
        "/tmp",
        "/tmp/../etc",
        "relative/x",
        "/tmp//x",
        "/tmp/x/",
        "/private/tmp/x",
        "/tmp/./x",
    ] {
        assert!(!safe_target(bad), "{bad}");
        let mut item = CleanupItem::blank(bad, CleanupKind::Worktree);
        item.state = CleanupState::Listed;
        item.delete_after = Some("2026-01-01T00:00:00.000Z".into());
        let plan = SweepPlan {
            ledger: CleanupLedger {
                items: vec![item],
                ..empty()
            },
            actions: vec![
                SweepAction::RemoveDeps(bad.into()),
                SweepAction::Delete(bad.into()),
            ],
        };
        let p = ports(None);
        let out = run_sweep(plan, &p, &HashSet::new(), now());
        assert_eq!(p.removed.get(), 0, "{bad}");
        assert!(p.deps.borrow().is_empty(), "{bad}");
        assert_eq!(out.items[0].state, CleanupState::Listed, "{bad}");
    }
    assert!(safe_target("/tmp/wt-a"));
    assert!(safe_target("/Users/x/dev/wt"));
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-cleanup-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn remove_rebuildable_unlinks_symlink_only_and_respects_safe() {
    let d = tmp("rr");
    let shared = d.join("shared-nm");
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(shared.join("keep"), "x").unwrap();
    let root = d.join("wt");
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::os::unix::fs::symlink(&shared, root.join("node_modules")).unwrap();
    std::fs::write(root.join("src.ts"), "x").unwrap();
    remove_rebuildable(&root, &|_, _| true).unwrap();
    assert!(std::fs::symlink_metadata(root.join("node_modules")).is_err());
    assert!(std::fs::symlink_metadata(root.join("dist")).is_err());
    assert!(shared.join("keep").is_file());
    assert!(root.join("src.ts").is_file());
    std::fs::create_dir_all(root.join("build")).unwrap();
    remove_rebuildable(&root, &|_, _| false).unwrap();
    assert!(root.join("build").is_dir());
    let _ = std::fs::remove_dir_all(&d);
}

/// TS 보다 좁게: 뿌리 자체가 심링크면 그 대상 안을 지우지 않는다.
#[test]
fn remove_rebuildable_refuses_symlinked_root() {
    let d = tmp("rrlink");
    let real = d.join("real");
    std::fs::create_dir_all(real.join("node_modules")).unwrap();
    std::os::unix::fs::symlink(&real, d.join("wt")).unwrap();
    assert!(remove_rebuildable(&d.join("wt"), &|_, _| true).is_err());
    assert!(real.join("node_modules").is_dir());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn ledger_roundtrip_0600_and_broken_is_moved_aside() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp("ledger");
    let path = cleanup_ledger_path(&d);
    assert_eq!(read_ledger(&path), CleanupLedger::default());
    let l = plan_sweep(&empty(), &facts(vec![wt()], true), &S, now()).ledger;
    write_ledger(&path, &l).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(read_ledger(&path), l);
    // TS 가 쓴 모양(키 이름)으로도 읽는다.
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        v["items"][0]["deleteAfter"],
        json!("2026-10-13T00:00:00.000Z")
    );
    assert_eq!(v["items"][0]["kind"], json!("worktree"));
    assert_eq!(v["events"][0]["action"], json!("listed"));
    assert_eq!(v["lastSweepAt"], json!("2026-10-06T00:00:00.000Z"));
    // 깨진 파일 → 빈 원장, 옆으로 치움.
    std::fs::write(&path, "{nope").unwrap();
    assert_eq!(read_ledger(&path), CleanupLedger::default());
    assert!(!path.exists());
    let aside = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("ledger.json.broken-")
        });
    assert!(aside);
    // 심링크 원장은 읽지 않는다(치우지도 않는다).
    let other = d.join("other.json");
    write_ledger(&other, &l).unwrap();
    std::os::unix::fs::symlink(&other, &path).unwrap();
    assert_eq!(read_ledger(&path), CleanupLedger::default());
    assert!(
        std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn write_ledger_refuses_symlinked_dir() {
    let d = tmp("ledgerdir");
    let real = d.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, d.join("cleanup")).unwrap();
    assert!(write_ledger(&d.join("cleanup").join("ledger.json"), &empty()).is_err());
    assert!(std::fs::read_dir(&real).unwrap().next().is_none());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn report_filters_bad_rows_and_clamps_future() {
    let c = "11111111-1111-1111-1111-111111111111";
    let r = "22222222-2222-2222-2222-222222222222";
    let body = json!({
        "threads": [
            {"channelId": c, "threadRootId": r, "worktrees": ["/a", "rel", 3], "lastTurnAt": "2099-01-01T00:00:00Z", "running": true, "workspaceDir": "/w"},
            {"channelId": "bad", "threadRootId": r},
            {"channelId": c, "threadRootId": r, "lastTurnAt": "nope", "workspaceDir": "rel"},
        ],
        "deleted": [{"channelId": c, "threadRootId": r}, {"channelId": "x"}],
    });
    let rep = read_cleanup_report(&body, now()).unwrap();
    assert_eq!(rep.threads.len(), 2);
    assert_eq!(rep.threads[0].worktrees, vec!["/a".to_string()]);
    assert_eq!(
        rep.threads[0].last_turn_at.as_deref(),
        Some("2026-10-06T00:00:00.000Z")
    );
    assert!(rep.threads[0].running);
    assert_eq!(rep.threads[0].workspace_dir.as_deref(), Some("/w"));
    assert_eq!(rep.threads[1].last_turn_at, None);
    assert_eq!(rep.threads[1].workspace_dir, None);
    assert_eq!(rep.deleted.len(), 1);
    assert!(read_cleanup_report(&json!({}), now()).is_none());
}

#[test]
fn path_helpers_match_ts() {
    assert_eq!(normalize_cleanup_path("/private/tmp/x/"), "/tmp/x");
    assert_eq!(normalize_cleanup_path("/private/var/x"), "/private/var/x");
    assert_eq!(claude_project_dir_name("/Users/a b/x.y"), "-Users-a-b-x-y");
    assert_eq!(
        worktree_add_paths("git worktree add -b feat /tmp/wt-x origin/main && cd", "/h"),
        vec!["/tmp/wt-x".to_string()]
    );
    assert_eq!(
        worktree_add_paths("git worktree add --detach ~/wt/y; ls", "/h"),
        vec!["/h/wt/y".to_string()]
    );
    assert!(worktree_add_paths("git worktree add \"$W\" main", "/h").is_empty());
    assert!(worktree_add_paths("git worktree addx /tmp/z", "/h").is_empty());
}

#[test]
fn clamp_grace_like_ts() {
    assert_eq!(clamp_grace_days(&json!("7")), 7);
    assert_eq!(clamp_grace_days(&json!(0)), 1);
    assert_eq!(clamp_grace_days(&json!(99)), 30);
    assert_eq!(clamp_grace_days(&json!(2.5)), 3);
}
