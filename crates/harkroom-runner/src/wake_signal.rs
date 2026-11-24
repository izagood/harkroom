//! 깨움 신호(E2b) — 오퍼레이터가 넘긴 `wake` 프레임을 「지금 한 번 당겨 보라」로 바꾼다.
//!
//! 스위치 `HARKROOM_WAKE_TURN=on`(기본 꺼짐) 뒤에 있다. 꺼져 있으면 프레임은 그림자다 — 아무것도 깨우지 않는다.
//! 켜져 있어도 이 모듈은 **턴을 열지 않는다**: 폴 루프의 쉼을 끊을 뿐이고, 턴은 폴이 서버에서 다시 당겨 온 inbox
//! 항목으로 스케줄러(claim·장부·임대)가 연다. 프레임 내용은 믿지 않는다 — id 를 대조·중복 판정에만 쓴다.

use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

/// 스위치 이름.
pub const WAKE_TURN_ENV: &str = "HARKROOM_WAKE_TURN";
/// 기억하는 깨움 id 수. 넘치면 오래된 것부터 잊는다(잊힌 id 가 다시 와도 폴 한 번이 더 돌 뿐이다).
pub const SEEN_CAP: usize = 256;
/// id 로 받아들이는 최대 길이 — 그보다 길면 프레임을 버린다.
const ID_MAX: usize = 128;

/// `on` 일 때만 켠다(그 밖의 값·없음은 꺼짐).
pub fn wake_turn_enabled(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("on")
}

/// 프레임 하나를 본 결과.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeNote {
    /// 스위치가 꺼져 있다 — 그림자.
    Shadow,
    /// 꼴이 틀렸거나 내 에이전트가 아니거나 아직 폴 루프가 없다.
    Ignored,
    /// 이미 본 깨움 id.
    Duplicate,
    /// 폴 루프를 깨웠다.
    Kicked,
}

type Kick = Box<dyn Fn() + Send + Sync>;

pub struct WakeSignal {
    enabled: bool,
    agent_id: OnceLock<String>,
    kick: OnceLock<Kick>,
    seen: Mutex<VecDeque<String>>,
}

fn id_of<'a>(frame: &'a Value, key: &str) -> Option<&'a str> {
    let s = frame.get(key)?.as_str()?;
    let ok = !s.is_empty()
        && s.len() <= ID_MAX
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then_some(s)
}

impl WakeSignal {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            agent_id: OnceLock::new(),
            kick: OnceLock::new(),
            seen: Mutex::new(VecDeque::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// 내 에이전트 id 와 폴 루프를 깨우는 손잡이를 건다(한 번). 걸기 전의 프레임은 버린다 — 첫 폴이 어차피 당긴다.
    pub fn bind(&self, agent_id: &str, kick: Kick) {
        let _ = self.agent_id.set(agent_id.to_string());
        let _ = self.kick.set(kick);
    }

    /// `wake` 프레임 하나. 깨웠으면 [`WakeNote::Kicked`].
    pub fn on_frame(&self, frame: &Value) -> WakeNote {
        if !self.enabled {
            return WakeNote::Shadow;
        }
        let (Some(wake_id), Some(agent)) = (id_of(frame, "wakeId"), id_of(frame, "agentId")) else {
            return WakeNote::Ignored;
        };
        let (Some(me), Some(kick)) = (self.agent_id.get(), self.kick.get()) else {
            return WakeNote::Ignored;
        };
        if agent != me {
            return WakeNote::Ignored;
        }
        {
            let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
            if seen.iter().any(|s| s == wake_id) {
                return WakeNote::Duplicate;
            }
            if seen.len() >= SEEN_CAP {
                seen.pop_front();
            }
            seen.push_back(wake_id.to_string());
        }
        kick();
        WakeNote::Kicked
    }
}

#[cfg(test)]
#[path = "wake_signal_tests.rs"]
mod tests;
