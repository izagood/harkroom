//! C3b-3a 판정 코어(`core::decide_core`) — DB 없이 볼 수 있는 표·골든·잠금 순서. DB 대조·동시성 시험은 `HARKROOM_TEST_DATABASE_URL`
//! 이 있을 때 도는 쪽에 둔다.
use harkroom_server::core::decide_core::{
    AfterVerdict, Decision, FORBIDDEN_MESSAGE, LOCK_FN, LOCK_FN_MIGRATION, LOCK_FN_SIGNATURE,
    LOCK_ORDER, LOCK_REQUEST, LockedRequest, Recheck, Shape, UNKNOWN_OPTION_MESSAGE, Verdict,
    after_verdict, option_decision, recheck_locked, rust_takes,
};

const TS_DECISIONS: &str = include_str!("../../../packages/server/src/services/decisions.ts");
const RS_SRC: &str = include_str!("../src/core/decide_core.rs");
const CARGO: &str = include_str!("../Cargo.toml");

#[test]
fn messages_match_ts() {
    assert!(TS_DECISIONS.contains(&format!("message: '{FORBIDDEN_MESSAGE}'")));
    assert!(TS_DECISIONS.contains(&format!("message: '{UNKNOWN_OPTION_MESSAGE}'")));
}

#[test]
fn option_table_matches_ts() {
    for (o, d) in [
        ("approve", Decision::Approve),
        ("approve_mandate", Decision::ApproveMandate),
        ("approve_new_mandate", Decision::ApproveNewMandate),
        ("approve_once", Decision::ApproveOnce),
        ("approve_hour", Decision::ApproveHour),
        ("approve_turn", Decision::ApproveTurn),
        ("deny", Decision::Deny),
    ] {
        assert_eq!(option_decision(o), Some(d), "{o}");
    }
    // Object.hasOwn — 원형 사슬·대소문자·공백은 없는 선택지.
    for o in [
        "toString",
        "__proto__",
        "Deny",
        " deny",
        "",
        "approve_mandate ",
    ] {
        assert_eq!(option_decision(o), None, "{o:?}");
    }
    // TS 표에 있는 선택지 수와 같다.
    let ts = TS_DECISIONS
        .split("const OPTION_DECISION")
        .nth(1)
        .unwrap()
        .split("};")
        .next()
        .unwrap();
    assert_eq!(ts.matches("]: '").count(), 7);
}

fn shape<'a>(option: &'a str, kind: &'a str) -> Shape<'a> {
    Shape {
        option,
        kind,
        has_mandate: false,
        has_denial: false,
        has_once: false,
        via_chat: false,
        via_mirror: false,
    }
}

#[test]
fn who_takes_it() {
    // Rust 가 맡는 꼴(허용 목록).
    for (o, k, d) in [
        ("deny", "tool", Decision::Deny),
        ("deny", "command", Decision::Deny),
        ("deny", "merge", Decision::Deny),
        ("deny", "future_kind", Decision::Deny),
        ("approve", "tool", Decision::Approve),
        // S5.4 12e — 위임장·거절 기록 없는 merge 7일 승인.
        ("approve", "merge", Decision::Approve),
        ("approve_once", "command", Decision::ApproveOnce),
        ("approve_hour", "command", Decision::ApproveHour),
        // S5.4 — tool 카드의 approve_once 는 Rust 가 409 not_once(쓰기 없음).
        ("approve_once", "tool", Decision::ApproveOnce),
        // C1 — 위임장 없는 approve_mandate 는 TS 처럼 grant 만(approve 와 같음).
        ("approve_mandate", "tool", Decision::ApproveMandate),
        // C2 — 위임장 없는 approve_new_mandate(tool)는 Rust 가 카드 스레드에 위임장을 세운다.
        ("approve_new_mandate", "tool", Decision::ApproveNewMandate),
    ] {
        assert_eq!(rust_takes(shape(o, k)), Some(d), "{o}/{k}");
    }
    // 승인 kind 는 허용 목록 — merge(7일 승인 밖)·모르는 kind 는 TS.
    for (o, k) in [
        ("approve", "command"),
        ("approve", "future_kind"),
        ("approve_once", "merge"),
        ("approve_new_mandate", "merge"),
        ("approve_turn", "merge"),
        ("nope", "tool"),
    ] {
        assert_eq!(rust_takes(shape(o, k)), None, "{o}/{k}");
    }
    // S5.4 11d — TS 가 쓰기 없이 409 `bad_decision` 으로 답하는 꼴도 Rust(같은 답).
    for (o, k, d) in [
        ("approve_hour", "tool", Decision::ApproveHour),
        ("approve_turn", "tool", Decision::ApproveTurn),
        ("approve_turn", "command", Decision::ApproveTurn),
        ("approve_mandate", "command", Decision::ApproveMandate),
        (
            "approve_new_mandate",
            "command",
            Decision::ApproveNewMandate,
        ),
    ] {
        assert_eq!(rust_takes(shape(o, k)), Some(d), "{o}/{k}");
    }
    // C1·C2·C3 — 위임장이 있는 tool 승인 넷과 command once·hour 는 Rust, 나머지(merge·deny)는 TS.
    let m = |o, k| Shape {
        has_mandate: true,
        ..shape(o, k)
    };
    assert_eq!(rust_takes(m("approve", "tool")), Some(Decision::Approve));
    assert_eq!(
        rust_takes(m("approve_mandate", "tool")),
        Some(Decision::ApproveMandate)
    );
    assert_eq!(
        rust_takes(m("approve_turn", "tool")),
        Some(Decision::ApproveTurn)
    );
    assert_eq!(
        rust_takes(m("approve_new_mandate", "tool")),
        Some(Decision::ApproveNewMandate)
    );
    assert_eq!(
        rust_takes(m("approve_once", "command")),
        Some(Decision::ApproveOnce)
    );
    assert_eq!(
        rust_takes(m("approve_hour", "command")),
        Some(Decision::ApproveHour)
    );
    // 14d — 위임장 있는 merge 7일 승인(`approve` = grant + 줄, `approve_mandate` = 줄만)은 Rust.
    assert_eq!(rust_takes(m("approve", "merge")), Some(Decision::Approve));
    assert_eq!(
        rust_takes(m("approve_mandate", "merge")),
        Some(Decision::ApproveMandate)
    );
    for (o, k) in [
        ("approve_once", "merge"),
        ("approve_new_mandate", "merge"),
        ("deny", "command"),
    ] {
        assert_eq!(rust_takes(m(o, k)), None, "{o}/{k}");
    }
    // C3 — 위임장 있는 command 라도 거절 카드(denial)·카드 once 는 TS.
    assert_eq!(
        rust_takes(Shape {
            has_denial: true,
            ..m("approve_once", "command")
        }),
        None
    );
    assert_eq!(
        rust_takes(Shape {
            has_once: true,
            ..m("approve_hour", "command")
        }),
        None
    );
    // 위임장·once·글 승인·거울이면 deny 라도 처음부터 TS(반쯤 하다 넘기는 길 없음).
    let base = shape("deny", "tool");
    for s in [
        Shape {
            has_mandate: true,
            ..base
        },
        Shape {
            has_once: true,
            ..base
        },
        Shape {
            via_chat: true,
            ..base
        },
    ] {
        assert_eq!(rust_takes(s), None, "{s:?}");
    }
    // S5.5 d — 진짜 거울(입구가 확인)은 원본 버튼과 같은 허용 목록을 탄다.
    assert_eq!(
        rust_takes(Shape {
            via_mirror: true,
            ..base
        }),
        rust_takes(base)
    );
    // 머지 거절 카드(denial_id): deny 는 Rust, once 값 없는 approve_once 는 TS(security ②-6).
    // 13d — 같은 카드의 7일 approve 는 Rust(CI 거절이면 400 `ci_card_once_only`). 14d — 위임장이 있어도 Rust.
    let d = |o| Shape {
        has_denial: true,
        ..shape(o, "merge")
    };
    assert_eq!(rust_takes(d("deny")), Some(Decision::Deny));
    assert_eq!(rust_takes(d("approve_once")), None);
    assert_eq!(rust_takes(d("approve")), Some(Decision::Approve));
    // 13d — 위임장 없는 merge approve_mandate 는 쓰기 없는 409 `mandate_unavailable`(Rust).
    assert_eq!(
        rust_takes(shape("approve_mandate", "merge")),
        Some(Decision::ApproveMandate)
    );
    assert_eq!(
        rust_takes(Shape {
            has_mandate: true,
            ..d("approve")
        }),
        Some(Decision::Approve)
    );
}

#[test]
fn after_verdict_table() {
    let v = |ok| Verdict {
        ok,
        owner: None,
        scope: None,
    };
    assert_eq!(
        after_verdict(&v(None), Decision::Deny),
        AfterVerdict::Forbidden
    );
    assert_eq!(
        after_verdict(&v(None), Decision::Approve),
        AfterVerdict::Forbidden
    );
    assert_eq!(
        after_verdict(&v(Some(true)), Decision::Approve),
        AfterVerdict::Go { as_owner: true }
    );
    assert_eq!(
        after_verdict(&v(Some(false)), Decision::Deny),
        AfterVerdict::Go { as_owner: false }
    );
    // 소유자 아닌 사람의 승인은 TS(소유자 알림 글).
    for d in [
        Decision::Approve,
        Decision::ApproveOnce,
        Decision::ApproveHour,
    ] {
        assert_eq!(after_verdict(&v(Some(false)), d), AfterVerdict::HandToTs);
    }
}

/// 잠금 순서는 하나다 — 표(`LOCK_ORDER`)와 잠금 함수 본문(마이그레이션)의 `perform … for …` 차례·세기가 같아야 한다
/// (security C3b-3 ①-3, A안 조건 3). `lock_basis` 는 그 함수를 한 번 부를 뿐이다.
#[test]
fn lock_order_is_fixed() {
    assert_eq!(
        LOCK_ORDER,
        [
            "channel",
            "account",
            "agent_config",
            "agent_invoker",
            "channel_member"
        ]
    );
    let sql = LOCK_FN_MIGRATION.to_lowercase();
    let body = sql
        .split("as $$")
        .nth(1)
        .and_then(|b| b.split("$$;").next())
        .expect("function body");
    let performs: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("perform "))
        .collect();
    assert_eq!(performs.len(), LOCK_ORDER.len(), "{performs:#?}");
    for (t, s) in LOCK_ORDER.iter().zip(&performs) {
        assert!(s.contains(&format!(" from public.{t} ")), "{t}: {s}");
    }
    // 세기: channel·account·agent_config = for share, DELETE 로만 빠지는 줄 = for key share.
    for s in &performs[..3] {
        assert!(s.ends_with(" for share;"), "{s}");
    }
    for s in &performs[3..] {
        assert!(s.ends_with(" for key share;"), "{s}");
    }
    assert!(performs[1].contains("order by id"));
    // 함수 성질: SECURITY DEFINER · search_path 고정 · void · 아무것도 고치지 않음 · PUBLIC EXECUTE 회수.
    for need in [
        "security definer",
        "set search_path = pg_catalog, public",
        "returns void",
        "revoke all on function permission_decide_lock(uuid, uuid, uuid) from public;",
    ] {
        assert!(sql.contains(need), "missing: {need}");
    }
    for bad in ["update ", "insert ", "delete ", "execute ", "grant "] {
        assert!(!body.contains(bad), "lock fn must only lock: {bad}");
    }
    assert!(LOCK_FN.starts_with("select permission_decide_lock("));
    assert_eq!(
        LOCK_FN_SIGNATURE,
        "permission_decide_lock(uuid, uuid, uuid)"
    );
    assert!(LOCK_REQUEST.ends_with(" for update"));
    // lock_basis 는 잠금 함수만 부른다(표마다 잠그는 문장이 돌아오면 빨강).
    let lb = RS_SRC
        .split("pub async fn lock_basis")
        .nth(1)
        .unwrap()
        .split("\n}\n")
        .next()
        .unwrap();
    assert!(lb.contains("LOCK_FN") && !lb.contains("for share"), "{lb}");
}

fn locked(agent: &str, channel: Option<&str>, kind: &str) -> LockedRequest {
    LockedRequest {
        agent_id: agent.into(),
        channel_id: channel.map(Into::into),
        kind: kind.into(),
        status: "pending".into(),
        expired: false,
        mandate_id: None,
        denial_id: None,
        card_message_id: None,
    }
}

/// security C3b-3 조건 ① — 요청 줄을 마지막에 잠근 뒤 잠근 값으로 다시 대조한다.
#[test]
fn recheck_after_request_lock() {
    let sh = shape("approve", "tool");
    let base = locked("a", Some("c"), "tool");
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&base), sh),
        Recheck::Go(Decision::Approve)
    );
    assert_eq!(recheck_locked("a", Some("c"), None, sh), Recheck::Gone);
    // agent·channel 이 바뀌면 처음부터.
    assert_eq!(
        recheck_locked("x", Some("c"), Some(&base), sh),
        Recheck::Restart
    );
    assert_eq!(
        recheck_locked("a", Some("d"), Some(&base), sh),
        Recheck::Restart
    );
    assert_eq!(recheck_locked("a", None, Some(&base), sh), Recheck::Restart);
    // 잠근 값의 kind·mandate·denial 로 rust_takes 를 다시 — 바뀌면 TS.
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&locked("a", Some("c"), "command")), sh),
        Recheck::HandToTs
    );
    // C1 — 위임장이 생겨도 tool approve 는 Rust(있는 위임장에 줄), deny 는 TS. C3 — command 승인도 Rust.
    let mut m = base.clone();
    m.mandate_id = Some("m".into());
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&m), sh),
        Recheck::Go(Decision::Approve)
    );
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&m), shape("deny", "tool")),
        Recheck::HandToTs
    );
    let mut mc = locked("a", Some("c"), "command");
    mc.mandate_id = Some("m".into());
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&mc), shape("approve_once", "command")),
        Recheck::Go(Decision::ApproveOnce)
    );
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&mc), shape("deny", "command")),
        Recheck::HandToTs
    );
    let mut d = base.clone();
    d.denial_id = Some("d".into());
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&d), sh),
        Recheck::HandToTs
    );
    // deny 는 denial 이 생겨도 Rust.
    assert_eq!(
        recheck_locked("a", Some("c"), Some(&d), shape("deny", "tool")),
        Recheck::Go(Decision::Deny)
    );
}

/// 망가뜨리기 스위치는 기본 꺼진 feature 뒤에만 있다 — release 빌드에 들어가지 않는다.
#[test]
fn breakage_switch_not_in_default_features() {
    let feats = CARGO
        .split("[features]")
        .nth(1)
        .expect("[features]")
        .split("\n[")
        .next()
        .unwrap();
    let default = feats
        .lines()
        .find(|l| l.trim_start().starts_with("default"))
        .unwrap_or("");
    assert!(!default.contains("breakage-tests"), "{default}");
    assert!(
        RS_SRC.contains("#[cfg(feature = \"breakage-tests\")]\npub async fn may_decide_for_with")
    );
}

const TS_PERMISSION_REQUESTS: &str =
    include_str!("../../../packages/server/src/services/permissionRequests.ts");

/// 감사 detail 골든(security C3b-3 ③) — TS 와 같은 칸 이름만, 요청 사유·경고·digest·비밀 같은 칸은 없다.
#[test]
fn audit_detail_keys_match_ts_and_carry_no_secrets() {
    use harkroom_server::core::decide_core::{AUDIT_DETAIL_KEYS, AuditDetail, audit_detail};
    for k in AUDIT_DETAIL_KEYS {
        assert!(
            TS_PERMISSION_REQUESTS.contains(k),
            "TS audit detail has {k}"
        );
    }
    let full = audit_detail(&AuditDetail {
        request_id: "r",
        kind: "command",
        target: "git status",
        channel_id: Some("c"),
        as_owner: false,
        thread_root_id: Some("t"),
        grant_expires_at: Some("2026-11-16T00:00:00.000Z"),
        grant_mode: Some(("hour", "g")),
        bundle_message_id: Some("b"),
        mirror_message_id: None,
    });
    let keys: Vec<&str> = full
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    for k in &keys {
        assert!(AUDIT_DETAIL_KEYS.contains(k), "unexpected audit key {k}");
    }
    // bundle 과 mirror 는 함께 오지 않는다 — mirrorMessageId 하나만 빠진다.
    assert_eq!(keys.len() + 1, AUDIT_DETAIL_KEYS.len());
    for bad in [
        "reason",
        "warnings",
        "fileDigests",
        "token",
        "secret",
        "body",
    ] {
        assert!(full.get(bad).is_none(), "{bad}");
    }
    // 소유자 deny(tool, 버튼): asOwner·threadRootId·grant 칸이 없고 `via: button` 은 있다 — TS 와 같다.
    let deny = audit_detail(&AuditDetail {
        request_id: "r",
        kind: "tool",
        target: "Bash(ls:*)",
        channel_id: None,
        as_owner: true,
        thread_root_id: None,
        grant_expires_at: None,
        grant_mode: None,
        bundle_message_id: None,
        mirror_message_id: None,
    });
    // 14d — 거울에서 온 결정: TS `{ via: 'mirror', mirrorMessageId }`.
    let mirror = audit_detail(&AuditDetail {
        request_id: "r",
        kind: "tool",
        target: "Bash(ls:*)",
        channel_id: None,
        as_owner: true,
        thread_root_id: None,
        grant_expires_at: None,
        grant_mode: None,
        bundle_message_id: None,
        mirror_message_id: Some("m"),
    });
    assert_eq!(
        mirror,
        serde_json::json!({"requestId": "r", "kind": "tool", "target": "Bash(ls:*)", "channelId": null, "via": "mirror", "mirrorMessageId": "m"})
    );
    assert!(
        TS_PERMISSION_REQUESTS
            .contains("{ via: 'mirror', mirrorMessageId: args.via.mirrorMessageId }")
    );
    use harkroom_server::core::decide_core::decided_via;
    assert_eq!(decided_via(None, None), None);
    assert_eq!(
        decided_via(None, Some("m")),
        Some(serde_json::json!({"kind": "mirror", "mirrorMessageId": "m"}))
    );
    assert_eq!(
        decided_via(Some("b"), None),
        Some(serde_json::json!({"kind": "bundle", "bundleMessageId": "b"}))
    );
    assert_eq!(
        deny,
        serde_json::json!({"requestId": "r", "kind": "tool", "target": "Bash(ls:*)", "channelId": null, "via": "button"})
    );
}

/// S5.4 12e — 결정 길의 만료 409 문구·코드는 TS `decidePermissionRequest` 원문과 같다.
#[test]
fn request_expired_matches_ts() {
    use harkroom_server::core::decide_approve::REQUEST_EXPIRED_MESSAGE;
    assert!(TS_PERMISSION_REQUESTS.contains(&format!(
        "code: 'request_expired', message: '{REQUEST_EXPIRED_MESSAGE}'"
    )));
}
