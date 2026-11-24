//! 깨움 넘기기(E2b) — 서버가 민 `wake` 프레임을 그 에이전트의 **지금 세대 러너**로 넘긴다.
//!
//! 스위치 `HARKROOM_WAKE_TURN=on`(기본 꺼짐) 뒤에 있다. 꺼져 있으면 E2a 그대로다(적고 `wake.ack` 만 답한다).
//! 넘기는 것은 id 뿐이다 — 러너는 그것을 「지금 당겨 보라」로만 쓰고 실제 요청은 서버에서 다시 당긴다.
//! 이 오퍼레이터의 러너 표에 없는 에이전트의 깨움은 버린다.

use harkroom_proto::p2::ServerToOperatorFrame;
use serde_json::{Value, json};

/// 스위치 이름(러너도 같은 이름을 읽는다).
pub const WAKE_TURN_ENV: &str = "HARKROOM_WAKE_TURN";

/// `on` 일 때만 켠다.
pub fn enabled(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("on")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Forward {
    /// 깨움 프레임이 아니다.
    NotWake,
    /// 이 오퍼레이터가 돌리는 에이전트가 아니다.
    UnknownAgent,
    /// 러너는 있는데 링크가 붙어 있지 않다 — 폴링이 안전망이다.
    NotLinked,
    Sent,
}

/// `runner_of` 는 에이전트의 지금 세대 러너 id, `send` 는 그 러너의 링크로 프레임을 쓴다.
pub fn forward(
    frame: &ServerToOperatorFrame,
    runner_of: impl Fn(&str) -> Option<String>,
    send: impl Fn(&str, &Value) -> bool,
) -> Forward {
    let ServerToOperatorFrame::Wake {
        wake_id,
        agent_id,
        message_id,
        ..
    } = frame
    else {
        return Forward::NotWake;
    };
    let Some(runner) = runner_of(agent_id) else {
        return Forward::UnknownAgent;
    };
    let out =
        json!({ "type": "wake", "wakeId": wake_id, "agentId": agent_id, "messageId": message_id });
    if send(&runner, &out) {
        Forward::Sent
    } else {
        Forward::NotLinked
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn wake(agent: &str) -> ServerToOperatorFrame {
        ServerToOperatorFrame::Wake {
            wake_id: "w1".into(),
            agent_id: agent.into(),
            message_id: "m1".into(),
            channel_id: "c1".into(),
            thread_root_id: "r1".into(),
            work_id: None,
            reason: "mention".into(),
        }
    }

    fn runner_of(agent: &str) -> Option<String> {
        (agent == "a1").then(|| "run-1".to_string())
    }

    #[test]
    fn switch_reads_only_on() {
        assert!(enabled(Some("on")));
        for v in [None, Some(""), Some("1"), Some("off"), Some("true")] {
            assert!(!enabled(v), "{v:?}");
        }
    }

    #[test]
    fn assigned_agent_gets_ids_only() {
        let sent = RefCell::new(Vec::new());
        let out = forward(&wake("a1"), runner_of, |r, f| {
            sent.borrow_mut().push((r.to_string(), f.clone()));
            true
        });
        assert_eq!(out, Forward::Sent);
        assert_eq!(
            *sent.borrow(),
            vec![(
                "run-1".to_string(),
                json!({"type": "wake", "wakeId": "w1", "agentId": "a1", "messageId": "m1"})
            )]
        );
    }

    #[test]
    fn unknown_agent_is_dropped_without_send() {
        let out = forward(&wake("other"), runner_of, |_, _| panic!("보내면 안 된다"));
        assert_eq!(out, Forward::UnknownAgent);
    }

    #[test]
    fn unlinked_runner_and_other_frames() {
        assert_eq!(
            forward(&wake("a1"), runner_of, |_, _| false),
            Forward::NotLinked
        );
        let other = ServerToOperatorFrame::AgentRestart {
            agent_id: "a1".into(),
        };
        assert_eq!(
            forward(&other, runner_of, |_, _| panic!("보내면 안 된다")),
            Forward::NotWake
        );
    }
}
