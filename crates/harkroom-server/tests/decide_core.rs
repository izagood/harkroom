//! C3b-3a 판정 코어(`core::decide_core`) — DB 없이 볼 수 있는 표·골든·잠금 순서. DB 대조·동시성 시험은 `HARKROOM_TEST_DATABASE_URL`
//! 이 있을 때 도는 쪽에 둔다.
use harkroom_server::core::decide_core::{
    AfterVerdict, Decision, FORBIDDEN_MESSAGE, LOCK_ACCOUNTS, LOCK_AGENT_CONFIG, LOCK_CHANNEL,
    LOCK_INVOKER, LOCK_MEMBER, LOCK_ORDER, LOCK_REQUEST, Shape, UNKNOWN_OPTION_MESSAGE, Verdict,
    after_verdict, option_decision, rust_takes,
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
        ("approve_once", "command", Decision::ApproveOnce),
        ("approve_hour", "command", Decision::ApproveHour),
    ] {
        assert_eq!(rust_takes(shape(o, k)), Some(d), "{o}/{k}");
    }
    // 승인 kind 는 허용 목록 — merge·모르는 kind 는 TS.
    for (o, k) in [
        ("approve", "merge"),
        ("approve", "command"),
        ("approve", "future_kind"),
        ("approve_once", "merge"),
        ("approve_once", "tool"),
        ("approve_hour", "tool"),
        ("approve_mandate", "tool"),
        ("approve_new_mandate", "tool"),
        ("approve_turn", "tool"),
        ("nope", "tool"),
    ] {
        assert_eq!(rust_takes(shape(o, k)), None, "{o}/{k}");
    }
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
        Shape {
            via_mirror: true,
            ..base
        },
    ] {
        assert_eq!(rust_takes(s), None, "{s:?}");
    }
    // 머지 거절 카드(denial_id): deny 는 Rust, 같은 카드의 approve_once·approve 는 TS(security ②-6).
    let d = |o| Shape {
        has_denial: true,
        ..shape(o, "merge")
    };
    assert_eq!(rust_takes(d("deny")), Some(Decision::Deny));
    assert_eq!(rust_takes(d("approve_once")), None);
    assert_eq!(rust_takes(d("approve")), None);
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

/// 잠금 순서는 하나다 — 표(`LOCK_ORDER`)·문장·`lock_basis` 의 부르는 차례가 같아야 한다(security C3b-3 ①-3).
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
    let stmts = [
        LOCK_CHANNEL,
        LOCK_ACCOUNTS,
        LOCK_AGENT_CONFIG,
        LOCK_INVOKER,
        LOCK_MEMBER,
    ];
    for (t, s) in LOCK_ORDER.iter().zip(stmts) {
        assert!(s.contains(&format!(" from {t} ")), "{t}: {s}");
    }
    // 세기: account·channel·agent_config = for share, DELETE 로만 빠지는 줄 = for key share.
    for s in [LOCK_CHANNEL, LOCK_ACCOUNTS, LOCK_AGENT_CONFIG] {
        assert!(s.ends_with(" for share"), "{s}");
    }
    for s in [LOCK_INVOKER, LOCK_MEMBER] {
        assert!(s.ends_with(" for key share"), "{s}");
    }
    assert!(LOCK_ACCOUNTS.contains("order by id"));
    assert!(LOCK_REQUEST.ends_with(" for update"));
    // lock_basis 본문에서 문장을 부르는 차례.
    let body = RS_SRC
        .split("pub async fn lock_basis")
        .nth(1)
        .unwrap()
        .split("\n}\n")
        .next()
        .unwrap();
    let pos: Vec<usize> = [
        "LOCK_CHANNEL",
        "LOCK_ACCOUNTS",
        "LOCK_AGENT_CONFIG",
        "LOCK_INVOKER",
        "LOCK_MEMBER",
    ]
    .iter()
    .map(|n| body.find(n).unwrap_or_else(|| panic!("{n} not called")))
    .collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{pos:?}");
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
