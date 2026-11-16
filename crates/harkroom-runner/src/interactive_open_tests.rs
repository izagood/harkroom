use super::*;
use crate::relay_session::{OpenSessionInput, RelaySessions};
use serde_json::{Value, json};
use std::sync::Mutex;

fn req(channel: &str, thread: &str) -> InteractiveOpenRequest {
    InteractiveOpenRequest {
        channel_id: channel.into(),
        thread_root_id: thread.into(),
        opened_by_handle: "someone".into(),
        cols: None,
        rows: None,
    }
}

fn mention(
    l: &Arc<RelaySessions>,
    channel: &str,
    thread: &str,
) -> crate::relay_session::SessionHandle {
    l.open_session(OpenSessionInput {
        agent_account_id: "agent".into(),
        channel_id: channel.into(),
        thread_root_id: Some(thread.into()),
        harness: "claude-code".into(),
        accepts_input: true,
        ..OpenSessionInput::default()
    })
}

/// 정본 분기 ①: 그 스레드에 멘션 턴이 돌면 그 세션에 붙는다(`created: false`). 다른 스레드·다른 채널엔 안 붙는다.
#[test]
fn attaches_to_running_mention_session_of_that_thread() {
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let h = mention(&l, "c1", "t1");
    let _other = mention(&l, "c1", "t2");
    assert_eq!(
        decide(false, Some(&l), &req("c1", "t1")),
        Ok((h.session_id().to_string(), false))
    );
    assert_eq!(
        decide(false, Some(&l), &req("c2", "t1")),
        Err(NEW_INTERACTIVE_UNSUPPORTED.to_string())
    );
}

/// 멘션이 끝나 세션이 닫히면 더는 붙지 않는다(닫힌 세션 id 를 주면 사람이 빈 화면에 붙는다).
#[test]
fn closed_mention_session_is_not_offered() {
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let h = mention(&l, "c1", "t1");
    h.close();
    assert_eq!(
        decide(false, Some(&l), &req("c1", "t1")),
        Err(NEW_INTERACTIVE_UNSUPPORTED.to_string())
    );
}

/// lane 러너는 도는 멘션이 있어도 붙기를 막는다(정본 `deps.providerLane`).
#[test]
fn provider_lane_rejects_even_attach() {
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let _h = mention(&l, "c1", "t1");
    assert_eq!(
        decide(true, Some(&l), &req("c1", "t1")),
        Err(PROVIDER_LANE_INTERACTIVE_REJECTION.to_string())
    );
}

/// 인터랙티브 세션(mode≠mention)은 붙기 대상이 아니다 — 이 처리자가 찾는 것은 멘션 턴뿐이다.
#[test]
fn non_mention_session_is_not_attached() {
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let _h = l.open_session(OpenSessionInput {
        channel_id: "c1".into(),
        thread_root_id: Some("t1".into()),
        mode: Some("interactive".into()),
        ..OpenSessionInput::default()
    });
    assert!(decide(false, Some(&l), &req("c1", "t1")).is_err());
}

/// 장부 프레임 길 끝까지: `interactive.open` 에 **반드시** 답한다(504 로 두지 않는다) — 붙으면 `interactive.opened`,
/// 아니면 `interactive.error`. 처리자는 기동 순서대로(장부 → 칸 채우기) 꽂는다.
#[test]
fn interactive_open_frame_always_answered() {
    let cell = ledger_cell();
    let l = RelaySessions::new(Some(handler(cell.clone(), false)), Box::new(|_| {}));
    fill(&cell, &l);
    let sent: Arc<Mutex<Vec<Value>>> = Arc::default();
    let s2 = Arc::clone(&sent);
    l.set_sink(Arc::new(move |f: &Value| {
        s2.lock().unwrap().push(f.clone())
    }));
    let h = mention(&l, "c1", "t1");

    l.on_frame(json!({"type": "interactive.open", "requestId": "r1", "channelId": "c1", "threadRootId": "t1", "openedByHandle": "x"}));
    l.on_frame(json!({"type": "interactive.open", "requestId": "r2", "channelId": "c1", "threadRootId": "nope", "openedByHandle": "x"}));

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let answers = loop {
        let got: Vec<Value> = sent
            .lock()
            .unwrap()
            .iter()
            .filter(|f| {
                f["type"]
                    .as_str()
                    .is_some_and(|t| t.starts_with("interactive."))
            })
            .cloned()
            .collect();
        if got.len() == 2 || std::time::Instant::now() > deadline {
            break got;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let by = |id: &str| answers.iter().find(|f| f["requestId"] == id).cloned();
    let r1 = by("r1").expect("r1 답");
    assert_eq!(r1["type"], "interactive.opened");
    assert_eq!(r1["sessionId"], h.session_id());
    assert_eq!(r1["created"], false);
    let r2 = by("r2").expect("r2 답");
    assert_eq!(r2["type"], "interactive.error");
    assert!(
        r2["message"]
            .as_str()
            .unwrap()
            .starts_with("interactive_unsupported:")
    );
}

/// 칸이 아직 비었으면(기동 중) 기동 중 문구로 답한다.
#[test]
fn empty_cell_answers_starting() {
    let cell = ledger_cell();
    let h = handler(cell, false);
    assert_eq!(h(req("c", "t")), Err(RUNNER_STARTING.to_string()));
}
