//! C5e-2 푸시 페이로드 — TS `payload.ts` 결과(`golden/push_payload.json`, TS `rustPushPayloadGolden.test.ts` 가 씀)와 한 줄씩 대조한다.
use harkroom_server::push::payload::*;
use serde_json::Value;
use std::collections::HashMap;

fn golden() -> Value {
    serde_json::from_str(include_str!("../golden/push_payload.json"))
        .expect("golden/push_payload.json")
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

fn kind(s: &str) -> PushKind {
    [
        PushKind::Ask,
        PushKind::Fail,
        PushKind::Gate,
        PushKind::Check,
        PushKind::Done,
        PushKind::AgentReply,
        PushKind::Mention,
        PushKind::ThreadReply,
        PushKind::Dm,
    ]
    .into_iter()
    .find(|k| k.as_str() == s)
    .expect("kind")
}

#[test]
fn classify_matches_ts() {
    let g = golden();
    let rows = g["classify"].as_array().unwrap();
    assert_eq!(rows.len(), 320);
    for r in rows {
        let i = &r["input"];
        let got = classify_push(&ClassifyInput {
            reason: PushReason::parse(i["reason"].as_str().unwrap()).unwrap(),
            author_is_agent: i["authorKind"] == "agent",
            meta_kind: opt(&i["metaKind"]),
            failure_code: opt(&i["failureCode"]),
            mine_thread: i["mineThread"].as_bool().unwrap(),
        });
        assert_eq!(got.as_str(), r["kind"].as_str().unwrap(), "{i}");
    }
}

/// 주입 미확인 실패는 `check` — 긴급이 아니라 집중 모드를 뚫지 않고, 글마다 따로 남는다.
#[test]
fn inject_unconfirmed_is_non_urgent_check() {
    for reason in [PushReason::Mention, PushReason::ThreadReply, PushReason::Dm] {
        let got = classify_push(&ClassifyInput {
            reason,
            author_is_agent: true,
            meta_kind: Some("failure"),
            failure_code: Some("inject_unconfirmed"),
            mine_thread: true,
        });
        assert_eq!(got, PushKind::Check);
    }
    assert!(!is_urgent(PushKind::Check));
    assert!(is_urgent(PushKind::Gate));
    assert_eq!(push_collapse_id(PushKind::Check, "t", "m"), "m");
    let handles = HashMap::new();
    let out = build_push_payload(&PayloadInput {
        kind: PushKind::Check,
        account_id: "a",
        message_id: "m",
        channel_id: "c",
        thread_root_id: None,
        author_handle: Some("forge"),
        channel_name: Some("general"),
        badge: None,
        preview_body: None,
        id_to_handle: &handles,
        reply_count: 0,
        option_count: 0,
        sound: true,
    });
    assert_eq!(out["aps"]["interruption-level"], "active");
    assert_eq!(out["aps"]["alert"]["subtitle-loc-key"], "PUSH_SUB_CHECK");
    assert_eq!(out["aps"]["alert"]["loc-key"], "PUSH_REASON_CHECK");
}

#[test]
fn payloads_match_ts() {
    let g = golden();
    let handles: HashMap<String, String> = g["handles"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    let rows = g["payloads"].as_array().unwrap();
    assert_eq!(rows.len(), 162);
    for r in rows {
        let i = &r["input"];
        let got = build_push_payload(&PayloadInput {
            kind: kind(i["kind"].as_str().unwrap()),
            account_id: i["accountId"].as_str().unwrap(),
            message_id: i["messageId"].as_str().unwrap(),
            channel_id: i["channelId"].as_str().unwrap(),
            thread_root_id: opt(&i["threadRootId"]),
            author_handle: opt(&i["authorHandle"]),
            channel_name: opt(&i["channelName"]),
            badge: i["badge"].as_i64(),
            preview_body: opt(&i["previewBody"]),
            id_to_handle: &handles,
            reply_count: i["replyCount"].as_i64().unwrap(),
            option_count: i["optionCount"].as_i64().unwrap(),
            sound: i["sound"].as_bool().unwrap(),
        });
        assert_eq!(got, r["out"], "{i}");
    }
}

#[test]
fn collapse_and_thread_keys_match_ts() {
    let g = golden();
    for r in g["collapse"].as_array().unwrap() {
        let k = kind(r["kind"].as_str().unwrap());
        assert_eq!(
            push_collapse_id(
                k,
                r["threadKey"].as_str().unwrap(),
                r["messageId"].as_str().unwrap()
            ),
            r["out"]
        );
    }
    for r in g["threadKeys"].as_array().unwrap() {
        let got = push_thread_key(
            r["channelId"].as_str().unwrap(),
            opt(&r["channelName"]),
            opt(&r["threadRootId"]),
            r["messageId"].as_str().unwrap(),
        );
        assert_eq!(got, r["out"].as_str().unwrap(), "{r}");
    }
}
