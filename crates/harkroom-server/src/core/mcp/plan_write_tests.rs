use super::*;
use serde_json::json;

const ROOT: &str = "9c3a7e51-2b4d-4f8a-a1c6-5d7e8f9a0b12";
const CHILD: &str = "11111111-2222-4333-8444-555555555555";
const ME: &str = "4527ba9a-ac07-4aba-b347-bddd972fb969";
const OTHER: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn locked(doc: Value) -> Locked {
    Locked {
        updated_at: "2026-11-18T03:00:00.123Z".into(),
        rev: 3,
        doc,
        auto_on: false,
    }
}

fn body(t: &str) -> Value {
    let v: Value = serde_json::from_str(t).unwrap();
    serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[test]
fn guard_follows_set_thread_plan() {
    let doc = Some(json!({ "goal": "x", "groups": [], "steps": [] }));
    let now = locked(json!({}));
    // 계획이 있는데 guard 없음 → guard_required(updatedAt·rev 를 싣는다).
    let e = build_set(Some(&now), doc.clone(), None).unwrap_err();
    assert_eq!(e.code, "guard_required");
    assert_eq!(
        body(&e.text())["error"],
        json!({ "code": "guard_required", "updatedAt": now.updated_at, "rev": 3, "message": MESSAGES[3].1 })
    );
    // 판이 다르면 conflict, 없던 계획에 날짜 guard 도 conflict(updatedAt·rev null).
    let e = build_set(
        Some(&now),
        doc.clone(),
        Some(Some("2026-11-18T03:00:00.124Z".into())),
    )
    .unwrap_err();
    assert_eq!(e.code, "conflict");
    let e = build_set(None, doc.clone(), Some(Some(now.updated_at.clone()))).unwrap_err();
    assert_eq!(e.fields, r#""code":"conflict","updatedAt":null,"rev":null"#);
    let e = build_set(Some(&now), doc.clone(), Some(None)).unwrap_err();
    assert_eq!(e.code, "conflict");
    // 맞는 판·없던 계획 + null·guard 없음은 통과.
    assert_eq!(
        build_set(Some(&now), doc.clone(), Some(Some(now.updated_at.clone()))),
        Ok(doc.clone())
    );
    assert_eq!(build_set(None, doc.clone(), Some(None)), Ok(doc.clone()));
    assert_eq!(build_set(None, None, None), Ok(None));
}

#[test]
fn manager_defaults_and_keeps() {
    // 처음 세우고 비었으면 쓰는 에이전트.
    let mut d = json!({ "goal": "x" });
    assert_eq!(settle_manager(&mut d, None, ME), (Some(ME.into()), None));
    assert_eq!(d["managerId"], ME);
    // null 로 처음 세워도 쓰는 에이전트(TS `!manager`).
    let mut d = json!({ "goal": "x", "managerId": null });
    assert_eq!(settle_manager(&mut d, None, ME).0, Some(ME.into()));
    // 칸이 없으면 앞 판 유지, null 이면 비움(칸을 지운다), 값이면 그 값.
    let before = json!({ "managerId": OTHER });
    let mut d = json!({ "goal": "x" });
    assert_eq!(
        settle_manager(&mut d, Some(&before), ME),
        (Some(OTHER.into()), Some(OTHER.into()))
    );
    let mut d = json!({ "goal": "x", "managerId": null });
    assert_eq!(
        settle_manager(&mut d, Some(&before), ME),
        (None, Some(OTHER.into()))
    );
    assert!(d.get("managerId").is_none());
    let mut d = json!({ "goal": "x", "managerId": ME });
    assert_eq!(
        settle_manager(&mut d, Some(&before), ME),
        (Some(ME.into()), Some(OTHER.into()))
    );
}

/// security 조건 — 연결 루트 꼴(`invalid_linked_root`)·자기 연결(`self_link`)은 그룹 순서로 첫 거절.
#[test]
fn link_shape_refuses_bad_and_self() {
    let g = |id: &str| json!({ "id": "g1", "title": "t", "linkedRootId": id });
    let doc = json!({ "groups": [g("not-a-uuid")] });
    assert_eq!(
        link_shape(&doc, ROOT),
        Some(Refusal::id("invalid_linked_root", "not-a-uuid"))
    );
    let doc = json!({ "groups": [g(&ROOT.to_uppercase())] });
    assert_eq!(
        link_shape(&doc, ROOT),
        Some(Refusal::id("self_link", &ROOT.to_uppercase()))
    );
    let doc = json!({ "groups": [g(CHILD), { "id": "g2", "title": "t", "linkedRootId": "x" }] });
    assert_eq!(
        link_shape(&doc, ROOT),
        Some(Refusal::id("invalid_linked_root", "x"))
    );
    assert_eq!(link_shape(&json!({ "groups": [g(CHILD)] }), ROOT), None);
    assert!(is_uuid_shape("ABCDEF01-2345-6789-abcd-ef0123456789"));
    assert!(!is_uuid_shape("ABCDEF01-2345-6789-abcd-ef012345678"));
    assert!(!is_uuid_shape("ABCDEF01x2345-6789-abcd-ef0123456789"));
}

/// 새로 더한 연결만 묻는다(R1) — 대소문자만 다른 것은 새 연결이 아니다.
#[test]
fn only_added_links_are_checked() {
    let doc = |ids: &[&str]| json!({ "groups": ids.iter().enumerate().map(|(i, id)| json!({ "id": format!("g{}", i + 1), "title": "t", "linkedRootId": id })).collect::<Vec<_>>() });
    let before = doc(&[CHILD]);
    assert_eq!(
        added_links(&doc(&[&CHILD.to_uppercase(), OTHER]), Some(&before)),
        vec![OTHER.to_string()]
    );
    assert_eq!(added_links(&doc(&[CHILD]), None), vec![CHILD.to_string()]);
    let child = |v: bool| Child {
        channel_id: "c".into(),
        public_channel: false,
        viewer_visible: v,
        progress: None,
    };
    let added = vec![CHILD.to_string(), OTHER.to_string()];
    // 못 보는 자식 → 거절. 없는 자식(행 없음) → 같은 거절(있다는 사실을 새지 않는다).
    assert_eq!(
        unavailable(
            &added,
            &vec![(CHILD.into(), child(true)), (OTHER.into(), child(false))]
        ),
        Some(Refusal::id("linked_thread_unavailable", OTHER))
    );
    assert_eq!(
        unavailable(&added, &vec![(CHILD.into(), child(true))]),
        Some(Refusal::id("linked_thread_unavailable", OTHER))
    );
    assert_eq!(
        unavailable(
            &added,
            &vec![(CHILD.into(), child(true)), (OTHER.into(), child(true))]
        ),
        None
    );
}

/// 보는 사람 맵과 청중 맵이 갈린다(R2) — 청중은 public 이거나 같은 채널인 자식만 연다.
#[test]
fn audience_and_viewer_maps_differ() {
    let doc =
        json!({ "groups": [{ "id": "g1", "title": "t", "linkedRootId": CHILD }], "steps": [] });
    let facts = vec![(
        CHILD.to_string(),
        Child {
            channel_id: "other".into(),
            public_channel: false,
            viewer_visible: true,
            progress: None,
        },
    )];
    assert!(matches!(
        linked_map(&doc, &facts, None)[CHILD],
        Linked::Shown(_)
    ));
    assert!(matches!(
        linked_map(&doc, &facts, Some("mine"))[CHILD],
        Linked::Hidden
    ));
    assert!(matches!(
        linked_map(&doc, &facts, Some("other"))[CHILD],
        Linked::Shown(_)
    ));
    assert!(matches!(
        linked_map(&doc, &Vec::new(), None)[CHILD],
        Linked::Hidden
    ));
}

#[test]
fn written_answer_follows_plan_written() {
    let before = json!({ "goal": "x", "groups": [], "steps": [
        { "id": "s1", "title": "a", "state": "active", "dependsOn": [] },
        { "id": "s2", "title": "b", "state": "pending", "dependsOn": ["s1"] }
    ] });
    let after = json!({ "goal": "x", "groups": [], "steps": [
        { "id": "s1", "title": "a", "state": "done", "dependsOn": [] },
        { "id": "s2", "title": "b", "state": "pending", "dependsOn": ["s1"] }
    ] });
    let t = written_text(
        4,
        "2026-11-18T03:00:00.124Z",
        &after,
        Some(&before),
        &Vec::new(),
        None,
        Some(("s1", false)),
    );
    let inner: Value = serde_json::from_str(&t).unwrap();
    let text = inner["content"][0]["text"].as_str().unwrap();
    assert!(
        text.starts_with(r#"{"ok":true,"rev":4,"updatedAt":"2026-11-18T03:00:00.124Z","progress":{"done":1,"total":2,"#),
        "{text}"
    );
    assert!(
        text.ends_with(r#","id":"s1","removed":false,"nowReady":["s2"],"nowWaiting":[]}"#),
        "{text}"
    );
    // 걸린 쓰기는 flagged·notice 를 끝에 붙인다.
    let hit = crate::core::content_scan::ScanHit {
        reason: "r".into(),
        rules: vec!["x"],
    };
    let t = written_text(1, "t", &after, None, &Vec::new(), Some(&hit), None);
    let text = body_text(&t);
    assert!(
        text.contains(
            r#""nowWaiting":[],"flagged":{"reason":"r","rules":["x"]},"notice":"저장했지만"#
        ),
        "{text}"
    );
}

fn body_text(t: &str) -> String {
    let v: Value = serde_json::from_str(t).unwrap();
    v["content"][0]["text"].as_str().unwrap().to_string()
}

/// 거절 문구·문장·답 모양을 TS 원본과 맞춘다(값은 rustFrontDb 대조 시험이 본다).
#[test]
fn texts_follow_ts_source() {
    let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
    for (code, msg) in MESSAGES {
        let line = if msg.contains('\'') {
            format!("    {code}: \"{msg}\",")
        } else {
            format!("    {code}: '{msg}',")
        };
        assert!(mcp.contains(&line), "{line}");
    }
    for want in [
        "if (account.kind !== 'agent') return jsonResult({ error: { code: 'agents_only', message: '계획판 쓰기 도구는 에이전트만 쓴다' } });",
        "ok: true, rev: view.rev, updatedAt: view.updatedAt, progress: view.progress, ...extra,\n      ...diffDerived(before, view.derived),",
        "notice: `저장했지만 쓰기 검사에 걸렸다(${res.flagged.reason}) — 사람에게는 보이지만 다음 턴 프롬프트에는 싣지 않는다. 남의 글을 옮겼거나 비밀 값을 넣었다면 빼고 다시 써라.`,",
        "if ('deleted' in res) return jsonResult({ ok: true, deleted: true });\n    return planWritten(res, { id, removed: patch.remove === true });",
    ] {
        assert!(mcp.contains(want), "{want}");
    }
    let svc = include_str!("../../../../../packages/server/src/services/threadPlan.ts");
    for want in [
        "const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;",
        "`select updated_at, rev, doc from thread_plan where root_id = $1 for update`",
        "`select 1 from account a join channel c on c.id = $2\n            where a.id = $1 and a.kind = 'agent' and a.deleted_at is null and ${channelVisibleSql('c', '$1')}`,",
        "set doc = excluded.doc, flag_reason = excluded.flag_reason, updated_by = excluded.updated_by,\n               rev = thread_plan.rev + 1,\n               updated_at = greatest(now(), thread_plan.updated_at + interval '1 millisecond')",
        "await client.query(`delete from thread_plan_link where parent_root = $1`, [rootId]);",
        "`insert into thread_plan_link (parent_root, child_root) select $1, unnest($2::uuid[]) on conflict do nothing`,",
        "await client.query(`delete from thread_plan where root_id = $1`, [rootId]);",
        "type: 'thread.plan.changed', channelId, rootId, rev: row?.rev ?? null, progress,",
        "if (now && manager !== before) managerChanged = true;",
        "if (!now && !manager && accountId !== null) {",
        "let manager = doc.managerId === undefined ? before : doc.managerId;",
    ] {
        assert!(svc.contains(want), "{want}");
    }
}

/// 권한 상수가 쓰는 문장을 덮는다.
#[test]
fn privileges_cover_sql() {
    let has = |t: &str, p: &str| PLAN_WRITE_PRIVILEGES.contains(&(t, p));
    assert!(UPSERT_SQL.starts_with("insert into thread_plan ") && has("thread_plan", "INSERT"));
    assert!(UPSERT_SQL.contains("do update") && has("thread_plan", "UPDATE"));
    assert!(LOCK_SQL.ends_with("for update"));
    assert!(has("thread_plan", "DELETE"));
    assert!(has("thread_plan_link", "INSERT") && has("thread_plan_link", "DELETE"));
    assert!(has("event_outbox", "INSERT"));
    assert_eq!(
        PLAN_WRITE_SEQUENCE_PRIVILEGES,
        &[("event_outbox_id_seq", "USAGE")]
    );
    assert!(children_sql().contains("$2::uuid") && manager_sql().contains("a.kind = 'agent'"));
}

#[test]
fn link_plan_card_hook_out_like_ts() {
    assert_eq!(plan_hook_out(Ok(4)), r#"{"ok":true,"rev":4}"#);
    assert_eq!(
        plan_hook_out(Err(Refusal::plain("unchanged"))),
        r#"{"ok":true,"unchanged":true}"#
    );
    let v: Value =
        serde_json::from_str(&plan_hook_out(Err(Refusal::id("unknown_item", "s9")))).unwrap();
    assert_eq!(
        v,
        json!({ "ok": false, "error": { "code": "unknown_item", "id": "s9", "message": "그런 단계·그룹이 없다" } })
    );
    let doc = json!({ "steps": [{ "id": "s1" }, { "id": "s2" }] });
    assert!(has_step(&doc, "s2"));
    assert!(!has_step(&doc, "s3"));
    assert!(!has_step(&json!({}), "s1"));
}
