//! [`after_source`] — 그 시도의 문맥으로 계획·입력을 짓는지(앞 시도 값이 안 남는지).
use serde_json::json;

use super::*;
use crate::mention_parts::LoopCtx;
use crate::turn_success::SilentPath;

fn cfg() -> AfterConfig {
    AfterConfig {
        key: "k".into(),
        me_id: "me".into(),
        channel_id: "c".into(),
        anchor: Some("root".into()),
        mention_id: "m".into(),
        caller: NudgeCaller::Human,
        proxy_head: String::new(),
        record_proxy: false,
        wake_reason: String::new(),
        background_wait_ms: 1,
        target: SuccessTarget::default(),
        harness: AgentHarness::ClaudeCode,
        home: None,
    }
}

fn actx(turn: &str, seq: i64, cut: Option<usize>) -> AfterCtx {
    AfterCtx {
        ctx: LoopCtx {
            turn_id: turn.into(),
            turn_start_seq: seq,
            ..LoopCtx::default()
        },
        background_cut: cut,
    }
}

fn post(seq: i64, turn: &str) -> Value {
    json!({"id": format!("p{seq}"), "seq": seq, "authorId": "me", "kind": "user",
           "channelId": "c", "threadRootId": "root", "meta": {"turnId": turn}})
}

#[test]
fn inputs_come_from_this_attempts_context() {
    let c = cfg();
    let mut src = after_source(&c);
    let d1 = src(&actx("turn-a1", 10, None), &[]);
    let d2 = src(&actx("turn-a2", 20, None), &[]);
    assert_eq!(
        (d1.inputs.turn_id.as_str(), d1.inputs.turn_start_seq),
        ("turn-a1", 10)
    );
    assert_eq!(
        (d2.inputs.turn_id.as_str(), d2.inputs.turn_start_seq),
        ("turn-a2", 20),
        "a1 문맥이 a2 재료에 남지 않는다"
    );
    assert!(d2.inputs.view().promise.is_none());
}

#[test]
fn silent_turn_and_background_cut_paths() {
    let c = cfg();
    let mut src = after_source(&c);
    assert_eq!(
        src(&actx("t", 5, None), &[]).plan.silent,
        SilentPath::SilentTurn
    );
    assert_eq!(
        src(&actx("t", 5, Some(2)), &[]).plan.silent,
        SilentPath::BackgroundCut { count: 2 }
    );
}

#[test]
fn own_post_in_this_turn_is_not_silent() {
    let c = cfg();
    let mut src = after_source(&c);
    let d = src(&actx("t-now", 5, None), &[post(6, "t-now")]);
    assert_eq!(d.plan.post_count, 1);
    assert_eq!(d.plan.silent, SilentPath::Nothing);
    // 다른 시도(턴 id)의 글은 세지 않는다.
    let d = src(&actx("t-next", 5, None), &[post(6, "t-now")]);
    assert_eq!(d.plan.post_count, 0);
}
