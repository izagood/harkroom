use super::*;
use serde_json::json;

const R: &str = "9c3a7e51-2b4d-4f8a-a1c6-5d7e8f9a0b12";
const U: &str = "192adb53-d03e-4e1c-a3ef-d898444d1922";

#[test]
fn doc_fills_defaults_trims_and_strips() {
    let got = parse_doc(&json!({
        "goal": "  목표  ", "seq": { "s": 9 }, "junk": 1,
        "groups": [{ "id": "g1", "title": " 묶음 ", "x": true }],
        "steps": [{ "id": "s1", "title": "할 일", "state": "active", "groupId": "g1",
                    "links": [{ "kind": "pr", "repo": "izagood/harkroom", "number": 7, "extra": 1 }] }],
        "next": null, "managerId": U,
    }))
    .unwrap();
    assert_eq!(
        got,
        json!({
            "goal": "목표",
            "groups": [{ "id": "g1", "title": "묶음", "dependsOn": [] }],
            "steps": [{ "id": "s1", "groupId": "g1", "title": "할 일", "state": "active",
                        "links": [{ "kind": "pr", "repo": "izagood/harkroom", "number": 7 }], "dependsOn": [] }],
            "next": null, "managerId": U,
        })
    );
    assert_eq!(
        parse_doc(&json!({ "goal": "g" })).unwrap(),
        json!({ "goal": "g", "groups": [], "steps": [] })
    );
}

#[test]
fn doc_rejects_or_defers_what_zod_would_not_take_the_same_way() {
    for bad in [
        json!({}),
        json!({ "goal": "   " }),
        json!({ "goal": "a\u{feff}" }),
        json!({ "goal": "a\u{85}" }),
        json!({ "goal": "x".repeat(401) }),
        json!({ "goal": "g", "groups": [{ "id": "s1", "title": "t" }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t" }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "doing" }] }),
        json!({ "goal": "g", "steps": [{ "id": "s0", "title": "t", "state": "done" }] }),
        json!({ "goal": "g", "steps": [{ "id": "s10000", "title": "t", "state": "done" }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "done", "groupId": "s1" }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "done", "dependsOn": ["x1"] }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "done",
                "links": [{ "kind": "pr", "repo": "a/b", "number": 1.5 }] }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "done",
                "links": [{ "kind": "pr", "repo": "a/b", "number": 9_007_199_254_740_992u64 }] }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "done",
                "links": [{ "kind": "pr", "repo": "a/b/c", "number": 1 }] }] }),
        json!({ "goal": "g", "steps": [{ "id": "s1", "title": "t", "state": "done",
                "links": [{ "kind": "url", "id": U }] }] }),
        json!({ "goal": "g", "managerId": "x" }),
        json!({ "goal": "g", "next": 1 }),
        json!({ "goal": "g", "groups": (0..17).map(|i| json!({ "id": format!("g{}", i + 1), "title": "t" })).collect::<Vec<_>>() }),
    ] {
        assert_eq!(parse_doc(&bad), None, "{bad}");
    }
    // 바깥 울타리(×2)는 넉넉하다 — 상한 판정은 validate_plan 몫.
    let nine: Vec<Value> = (1..=9)
        .map(|i| json!({ "id": format!("g{i}"), "title": "t" }))
        .collect();
    assert!(parse_doc(&json!({ "goal": "g", "groups": nine })).is_some());
}

#[test]
fn plan_set_args() {
    let set = parse_plan_set(&json!({ "threadRootId": R, "plan": null })).unwrap();
    assert_eq!(set.doc, None);
    assert_eq!(set.guard, None);
    let set =
        parse_plan_set(&json!({ "threadRootId": R, "plan": { "goal": "g" }, "ifUpdatedAt": null }))
            .unwrap();
    assert_eq!(set.guard, Some(None));
    let set = parse_plan_set(
        &json!({ "threadRootId": R, "plan": null, "ifUpdatedAt": "2026-11-18T12:00:00.123456+09:00" }),
    )
    .unwrap();
    assert_eq!(set.guard, Some(Some("2026-11-18T03:00:00.123Z".into())));
    for bad in [
        json!({ "threadRootId": R }),
        json!({ "threadRootId": "x", "plan": null }),
        json!({ "threadRootId": R, "plan": 1 }),
        json!({ "threadRootId": R, "plan": null, "ifUpdatedAt": "yesterday" }),
        json!({ "threadRootId": R, "plan": null, "ifUpdatedAt": 1 }),
    ] {
        assert_eq!(parse_plan_set(&bad), None, "{bad}");
    }
}

#[test]
fn item_args() {
    let (root, p) = parse_item(&json!({
        "threadRootId": R, "type": "step", "id": "s3", "title": "  고침 ", "after": null, "groupId": null,
        "state": "done", "assigneeId": null, "addLinks": [{ "kind": "card", "messageId": U, "z": 0 }],
        "blockedReason": null, "ifRev": 4, "unknown": "x",
    }))
    .unwrap();
    assert_eq!(root, R);
    assert_eq!(p.type_.as_deref(), Some("step"));
    assert_eq!(p.title.as_deref(), Some("고침"));
    assert_eq!(p.after, Some(None));
    assert_eq!(p.group_id, Some(None));
    assert_eq!(p.assignee_id, Some(None));
    assert_eq!(p.blocked_reason, Some(None));
    assert_eq!(
        p.add_links,
        Some(vec![json!({ "kind": "card", "messageId": U })])
    );
    assert_eq!(p.if_rev, Some(4));
    assert_eq!(p.remove, None);
    assert_eq!(p.linked_root_id, None);

    let (_, p) = parse_item(&json!({ "threadRootId": R, "type": "plan", "managerId": U })).unwrap();
    assert_eq!(p.manager_id, Some(Some(U.into())));

    for bad in [
        json!({ "threadRootId": R, "type": "plan", "auto": null }),
        json!({ "threadRootId": R, "type": "x" }),
        json!({ "threadRootId": R, "id": "a1" }),
        json!({ "threadRootId": R, "remove": "yes" }),
        json!({ "threadRootId": R, "title": " " }),
        json!({ "threadRootId": R, "groupId": "s1" }),
        json!({ "threadRootId": R, "ifRev": 0 }),
        json!({ "threadRootId": R, "ifRev": 1.5 }),
        json!({ "threadRootId": R, "linkedRootId": "x" }),
        json!({ "threadRootId": R, "addDependsOn": ["s1", 2] }),
        json!({ "threadRootId": "x" }),
    ] {
        assert!(parse_item(&bad).is_none(), "{bad}");
    }
}

/// zod 원본이 바뀌면 여기가 깨진다 — 바뀐 꼴을 이 파서에 옮긴 뒤 고친다.
#[test]
fn schema_follows_ts_source() {
    let shared = include_str!("../../../../../packages/shared/src/planGraph.ts");
    assert!(shared.contains("export const PLAN_GROUP_ID_RE = /^g[1-9][0-9]{0,3}$/;"));
    assert!(shared.contains("export const PLAN_STEP_ID_RE = /^s[1-9][0-9]{0,3}$/;"));
}

#[test]
fn auto_arg_like_zod() {
    const R: &str = "00000000-0000-4000-8000-000000000001";
    const M: &str = "00000000-0000-4000-8000-000000000002";
    let off = parse_auto(&json!({ "threadRootId": R, "type": "plan", "auto": null })).unwrap();
    assert_eq!(
        (off.auto, off.alone, off.root.as_str()),
        (AutoArg::Off, true, R)
    );
    let on = parse_auto(&json!({ "threadRootId": R, "type": "plan", "auto": { "until": "g2", "sourceMessageId": M, "x": 1 } }))
        .unwrap();
    assert_eq!(
        on.auto,
        AutoArg::On {
            until: "g2".into(),
            source: M.into()
        }
    );
    assert!(on.alone);
    // 다른 칸이 있거나 type 이 plan 이 아니면 `auto_alone` 거절감이다(zod 는 지난다).
    for v in [
        json!({ "threadRootId": R, "auto": null }),
        json!({ "threadRootId": R, "type": "step", "auto": null }),
        json!({ "threadRootId": R, "type": "plan", "managerId": null, "auto": null }),
    ] {
        assert!(!parse_auto(&v).unwrap().alone, "{v}");
    }
    // 모르는 키는 zod 가 벗긴다.
    assert!(
        parse_auto(&json!({ "threadRootId": R, "type": "plan", "auto": null, "zzz": 1 }))
            .unwrap()
            .alone
    );
    // zod 가 거절할 꼴 — TS 가 답한다.
    for v in [
        json!({ "threadRootId": R, "type": "plan" }),
        json!({ "threadRootId": "x", "type": "plan", "auto": null }),
        json!({ "threadRootId": R, "type": "plan", "auto": 1 }),
        json!({ "threadRootId": R, "type": "plan", "auto": { "until": "s0", "sourceMessageId": M } }),
        json!({ "threadRootId": R, "type": "plan", "auto": { "until": "s1", "sourceMessageId": "m" } }),
        json!({ "threadRootId": R, "type": "plan", "auto": { "until": "s1" } }),
        json!({ "threadRootId": R, "type": "x", "auto": null }),
    ] {
        assert!(parse_auto(&v).is_none(), "{v}");
    }
    // `auto` 가 있으면 보통 칸 갈래는 받지 않는다.
    assert!(parse_item(&json!({ "threadRootId": R, "type": "plan", "auto": null })).is_none());
}
