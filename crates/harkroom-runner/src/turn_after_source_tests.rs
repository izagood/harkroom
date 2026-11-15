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
        promise: None,
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
        screen_ended: false,
        screen_said: None,
        screen_record_said: None,
        ..AfterCtx::default()
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

fn tui_end(had_pty: bool, reclaimed: bool, finished: bool, screen_ended: bool) -> AfterCtx {
    AfterCtx {
        had_pty,
        reclaimed,
        finished,
        screen_ended,
        ..actx("t", 5, None)
    }
}

// 정본 mentionTurn.test.ts 「혼자 꺼진 TUI 턴」 묶음 — 거두지 않았고 끝내지도 않았는데 꺼진 침묵 턴만 실패다.
#[test]
fn quit_early_only_when_pty_up_not_reclaimed_not_finished() {
    let mut c = cfg();
    c.harness = AgentHarness::Codex;
    let mut src = after_source(&c);
    assert_eq!(
        src(&tui_end(true, false, false, false), &[]).plan.silent,
        SilentPath::QuitEarly
    );
    // 끝낸 턴(기록 end_turn·화면 끝)·러너가 거둔 턴·PTY 가 없던 턴은 그대로 침묵 통지다.
    for a in [
        tui_end(true, false, true, false),
        tui_end(true, false, false, true),
        tui_end(true, true, false, false),
        tui_end(false, false, false, false),
    ] {
        assert_eq!(src(&a, &[]).plan.silent, SilentPath::SilentTurn);
    }
    // 하위 에이전트를 거둔 턴·발화한 턴은 갈래가 바뀌지 않는다.
    let cut = AfterCtx {
        background_cut: Some(1),
        ..tui_end(true, false, false, false)
    };
    assert_eq!(
        src(&cut, &[]).plan.silent,
        SilentPath::BackgroundCut { count: 1 }
    );
    assert_eq!(
        src(&tui_end(true, false, false, false), &[post(6, "t")])
            .plan
            .silent,
        SilentPath::Nothing
    );
}
