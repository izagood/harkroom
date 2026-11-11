//! 릴레이 다중화기(s21b-2) — TS `relayMux.ts`·`runnerLink.ts::wrapRunnerFrame/unwrapServerFrame` 의 이식.
//!
//! 러너 프레임에 `runnerId` 를 붙여 서버 채널에 싣고, 서버 프레임의 `runnerId` 로 러너를 골라 링크에 내려보낸다.
//! **해석하지 않는다** — 읽는 것은 세션 목록 하나다. 서버가 다시 붙으면 `resync` 가 러너별 `runner.announce` 를 다시 낸다
//! (서버는 소켓이 끊기면 러너의 세션을 버리고, 러너는 서버가 끊긴 것을 모른다).
//!
//! 러너 프레임은 꼴을 여기서 확인한다 — 필드가 빠졌거나 타입이 틀리면 서버로 보내지 않는다(TS 는 타입 검사에 맡겼다).
//! 러너는 오퍼레이터의 능력(`local-terminal`)을 주장하지 못한다(security n2) — announce 의 caps 에서 지운다.
//! 로컬 터미널 허브가 있으면 오퍼레이터가 `local-terminal` 을 덧붙인다(`with_extra_caps`, TS `extraCaps`).
use harkroom_proto::p2::{OperatorToServerFrame, ServerToOperatorFrame};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

/// 러너가 아니라 오퍼레이터만 가질 수 있는 능력.
const OPERATOR_CAPS: [&str; 1] = ["local-terminal"];

/// 다중화기가 쓰는 바깥. 시험은 가짜를 준다.
pub trait RelayMuxDeps: Send + Sync {
    /// 러너 링크로. 러너가 없으면 false.
    fn send_to_runner(&self, runner_id: &str, frame: &Value) -> bool;
    fn is_linked(&self, runner_id: &str) -> bool;
    /// 서버 채널로. 안 붙어 있으면 false — 그때의 손실은 `resync` 가 메운다(세션 목록에 한해).
    fn send_to_server(&self, frame: &OperatorToServerFrame) -> bool;
    fn log(&self, line: &str);
    /// 이 러너로 가는 터미널 열기를 거절할 까닭(TS `refuseInteractive`, C1 후속). 이 판의 Rust 오퍼레이터는 API 키 연결을 모르므로 늘 없다.
    fn refuse_interactive(&self, _runner_id: &str) -> Option<String> {
        None
    }
}

#[derive(Default)]
struct Known {
    /// 도착 순서를 지킨다(TS Map).
    sessions: Vec<(String, Value)>,
    caps: Option<Vec<Value>>,
}

pub struct RelayMux {
    deps: Box<dyn RelayMuxDeps>,
    known: Mutex<HashMap<String, Known>>,
    extra_caps: Vec<String>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn session_id_of(session: &Value) -> Option<String> {
    s(session, "sessionId")
}

/// 러너 프레임 → 서버 채널 프레임. 모르는 타입·틀린 꼴은 `None`(TS `wrapRunnerFrame`, `session.updated` 도 TS 처럼 넘기지 않는다).
pub fn wrap_runner_frame(runner_id: &str, f: &Value) -> Option<OperatorToServerFrame> {
    let runner_id = runner_id.to_string();
    let ty = f.get("type").and_then(Value::as_str)?;
    Some(match ty {
        "announce" => OperatorToServerFrame::RunnerAnnounce {
            runner_id,
            sessions: f.get("sessions")?.as_array()?.clone(),
            caps: match f.get("caps") {
                None => None,
                Some(c) => Some(c.as_array()?.clone()),
            },
        },
        "session.started" => {
            let session = f.get("session")?;
            session_id_of(session)?;
            OperatorToServerFrame::SessionStarted {
                runner_id,
                session: session.clone(),
            }
        }
        "session.ended" => OperatorToServerFrame::SessionEnded {
            runner_id,
            session_id: s(f, "sessionId")?,
        },
        "output" => OperatorToServerFrame::PtyOutput {
            runner_id,
            session_id: s(f, "sessionId")?,
            bytes: s(f, "data")?,
        },
        "replay" => OperatorToServerFrame::PtyReplay {
            runner_id,
            session_id: s(f, "sessionId")?,
            bytes: s(f, "data")?,
        },
        "interactive.opened" => OperatorToServerFrame::InteractiveOpened {
            runner_id,
            request_id: s(f, "requestId")?,
            session_id: s(f, "sessionId")?,
            created: f.get("created")?.as_bool()?,
        },
        "interactive.error" => OperatorToServerFrame::InteractiveError {
            runner_id,
            request_id: s(f, "requestId")?,
            message: s(f, "message")?,
        },
        "attention.required" => OperatorToServerFrame::AttentionRequired {
            runner_id,
            session_id: s(f, "sessionId")?,
            account_label: s(f, "accountLabel")?,
            screen: s(f, "screen")?,
        },
        "local.input" => OperatorToServerFrame::LocalInput {
            runner_id,
            session_id: s(f, "sessionId")?,
            r#gen: f.get("gen")?.as_i64()?,
            bytes: f.get("bytes")?.as_i64()?,
        },
        _ => return None,
    })
}

/// 서버 채널 프레임 → (runnerId, 러너 프레임). 오퍼레이터 자신의 말이면 `None`(TS `unwrapServerFrame`).
pub fn unwrap_server_frame(f: &ServerToOperatorFrame) -> Option<(String, Value)> {
    use ServerToOperatorFrame as S;
    Some(match f {
        S::PtyReplayRequest {
            runner_id,
            session_id,
        } => (
            runner_id.clone(),
            json!({"type": "replay.request", "sessionId": session_id}),
        ),
        S::PtyInput {
            runner_id,
            session_id,
            bytes,
        } => (
            runner_id.clone(),
            json!({"type": "input", "sessionId": session_id, "data": bytes}),
        ),
        S::PtyResize {
            runner_id,
            session_id,
            cols,
            rows,
        } => (
            runner_id.clone(),
            json!({"type": "resize", "sessionId": session_id, "cols": cols, "rows": rows}),
        ),
        S::ViewerCount {
            runner_id,
            session_id,
            count,
        } => (
            runner_id.clone(),
            json!({"type": "viewer.count", "sessionId": session_id, "count": count}),
        ),
        S::SessionCancel {
            runner_id,
            session_id,
            by_handle,
        } => (
            runner_id.clone(),
            json!({"type": "session.cancel", "sessionId": session_id, "byHandle": by_handle}),
        ),
        S::InteractiveOpen {
            runner_id,
            request_id,
            channel_id,
            thread_root_id,
            opened_by_handle,
            cols,
            rows,
        } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("interactive.open"));
            m.insert("requestId".into(), json!(request_id));
            m.insert("channelId".into(), json!(channel_id));
            m.insert("threadRootId".into(), json!(thread_root_id));
            m.insert("openedByHandle".into(), json!(opened_by_handle));
            if let Some(c) = cols {
                m.insert("cols".into(), json!(c));
            }
            if let Some(r) = rows {
                m.insert("rows".into(), json!(r));
            }
            (runner_id.clone(), Value::Object(m))
        }
        _ => return None,
    })
}

impl RelayMux {
    pub fn new(deps: Box<dyn RelayMuxDeps>) -> Self {
        Self {
            deps,
            known: Mutex::new(HashMap::new()),
            extra_caps: Vec::new(),
        }
    }

    /// 오퍼레이터가 announce 에 덧붙일 능력(TS `extraCaps`). 로컬 터미널 허브가 있을 때 `local-terminal`.
    pub fn with_extra_caps(mut self, caps: &[&str]) -> Self {
        self.extra_caps = caps.iter().map(|c| c.to_string()).collect();
        self
    }

    /// 러너가 주장한 caps 에서 오퍼레이터 능력을 지우고, 오퍼레이터 능력을 덧붙인다(TS `ownCaps`).
    fn own_caps(&self, announce: &Value) -> Value {
        let claimed: Option<Vec<Value>> = announce.get("caps").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter(|c| !c.as_str().is_some_and(|c| OPERATOR_CAPS.contains(&c)))
                .cloned()
                .collect()
        });
        if claimed.is_none() && self.extra_caps.is_empty() {
            return announce.clone();
        }
        let mut caps: Vec<Value> = Vec::new();
        for c in claimed
            .iter()
            .flatten()
            .cloned()
            .chain(self.extra_caps.iter().map(|c| json!(c)))
        {
            if !caps.contains(&c) {
                caps.push(c);
            }
        }
        let mut out = announce.clone();
        out["caps"] = Value::Array(caps);
        out
    }

    fn track(&self, runner_id: &str, frame: &Value) {
        let mut known = lock(&self.known);
        match frame.get("type").and_then(Value::as_str) {
            Some("announce") => {
                let sessions = frame
                    .get("sessions")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| session_id_of(s).map(|id| (id, s.clone())))
                            .collect()
                    })
                    .unwrap_or_default();
                let caps = frame.get("caps").and_then(Value::as_array).cloned();
                known.insert(runner_id.to_string(), Known { sessions, caps });
            }
            Some("session.started") => {
                let (Some(entry), Some(session)) = (known.get_mut(runner_id), frame.get("session"))
                else {
                    return;
                };
                let Some(id) = session_id_of(session) else {
                    return;
                };
                match entry.sessions.iter_mut().find(|(k, _)| *k == id) {
                    Some(slot) => slot.1 = session.clone(),
                    None => entry.sessions.push((id, session.clone())),
                }
            }
            Some("session.ended") => {
                let (Some(entry), Some(id)) = (known.get_mut(runner_id), s(frame, "sessionId"))
                else {
                    return;
                };
                entry.sessions.retain(|(k, _)| *k != id);
            }
            _ => {}
        }
    }

    pub fn on_runner_frame(&self, runner_id: &str, incoming: Value) {
        let frame = if incoming.get("type").and_then(Value::as_str) == Some("announce") {
            self.own_caps(&incoming)
        } else {
            incoming
        };
        // 꼴이 틀린 프레임은 목록에도 넣지 않는다 — 서버가 못 받은 세션을 resync 로 내면 안 된다.
        let Some(wrapped) = wrap_runner_frame(runner_id, &frame) else {
            return;
        };
        self.track(runner_id, &frame);
        self.deps.send_to_server(&wrapped);
    }

    /// 러너에게 갔으면 true. 오퍼레이터의 말이거나 러너가 없으면 false.
    pub fn on_server_frame(&self, frame: &ServerToOperatorFrame) -> bool {
        let Some((runner_id, inner)) = unwrap_server_frame(frame) else {
            return false;
        };
        if inner["type"] == "interactive.open"
            && let Some(why) = self.deps.refuse_interactive(&runner_id)
        {
            self.deps
                .send_to_server(&OperatorToServerFrame::InteractiveError {
                    runner_id,
                    request_id: s(&inner, "requestId").unwrap_or_default(),
                    message: why,
                });
            return true;
        }
        if !self.deps.is_linked(&runner_id) {
            // 큐에 담지 않는다 — 입력은 안 보이는 화면에 친 것이고, 재생 요청은 뷰어가 다시 붙으며 다시 온다.
            self.deps.log(&format!(
                "러너가 없어 버린 서버 프레임: {} runnerId={runner_id}",
                inner["type"].as_str().unwrap_or_default()
            ));
            return false;
        }
        self.deps.send_to_runner(&runner_id, &inner)
    }

    /// 서버 (재)접속 뒤 — 붙어 있는 러너들의 세션 목록을 다시 낸다.
    pub fn resync(&self) {
        let frames: Vec<OperatorToServerFrame> = lock(&self.known)
            .iter()
            .filter(|(r, _)| self.deps.is_linked(r))
            .map(|(r, e)| OperatorToServerFrame::RunnerAnnounce {
                runner_id: r.clone(),
                sessions: e.sessions.iter().map(|(_, s)| s.clone()).collect(),
                caps: e.caps.clone(),
            })
            .collect();
        for f in frames {
            self.deps.send_to_server(&f);
        }
    }

    /// 러너가 죽었다 — 그 목록을 잊는다.
    pub fn forget(&self, runner_id: &str) {
        lock(&self.known).remove(runner_id);
    }

    /// hello 에 실을 세션 전부(붙어 있는 러너 것만).
    pub fn sessions(&self) -> Vec<Value> {
        lock(&self.known)
            .iter()
            .filter(|(r, _)| self.deps.is_linked(r))
            .flat_map(|(_, e)| e.sessions.iter().map(|(_, s)| s.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        linked: Mutex<HashSet<String>>,
        to_runner: Mutex<Vec<(String, Value)>>,
        to_server: Mutex<Vec<Value>>,
        logs: Mutex<Vec<String>>,
        refuse: Mutex<Option<String>>,
    }
    struct D(Arc<Fake>);
    impl RelayMuxDeps for D {
        fn send_to_runner(&self, r: &str, f: &Value) -> bool {
            lock(&self.0.to_runner).push((r.into(), f.clone()));
            true
        }
        fn is_linked(&self, r: &str) -> bool {
            lock(&self.0.linked).contains(r)
        }
        fn send_to_server(&self, f: &OperatorToServerFrame) -> bool {
            lock(&self.0.to_server).push(serde_json::to_value(f).unwrap());
            true
        }
        fn log(&self, l: &str) {
            lock(&self.0.logs).push(l.into());
        }
        fn refuse_interactive(&self, _r: &str) -> Option<String> {
            lock(&self.0.refuse).clone()
        }
    }

    fn mux() -> (Arc<Fake>, RelayMux) {
        let f = Arc::new(Fake::default());
        lock(&f.linked).insert("r1".into());
        (f.clone(), RelayMux::new(Box::new(D(f))))
    }

    fn sess(id: &str) -> Value {
        json!({"sessionId": id, "agentId": "a1"})
    }

    #[test]
    fn runner_frames_are_wrapped_with_runner_id_and_tracked_for_resync() {
        let (f, m) = mux();
        m.on_runner_frame(
            "r1",
            json!({"type":"announce","sessions":[sess("s1")],"caps":["input","local-terminal"]}),
        );
        m.on_runner_frame("r1", json!({"type":"session.started","session":sess("s2")}));
        m.on_runner_frame(
            "r1",
            json!({"type":"output","sessionId":"s2","data":"aGk="}),
        );
        m.on_runner_frame("r1", json!({"type":"session.ended","sessionId":"s1"}));
        let out = lock(&f.to_server).clone();
        // 러너가 주장한 오퍼레이터 능력은 지워진다(security n2).
        assert_eq!(
            out[0],
            json!({"type":"runner.announce","runnerId":"r1","sessions":[sess("s1")],"caps":["input"]})
        );
        assert_eq!(
            out[2],
            json!({"type":"pty.output","runnerId":"r1","sessionId":"s2","bytes":"aGk="})
        );
        assert_eq!(out[3]["type"], "session.ended");
        assert_eq!(m.sessions(), vec![sess("s2")]);

        lock(&f.to_server).clear();
        m.resync();
        assert_eq!(
            lock(&f.to_server)[0],
            json!({"type":"runner.announce","runnerId":"r1","sessions":[sess("s2")],"caps":["input"]})
        );
        // 링크가 끊긴 러너는 다시 내지 않는다.
        lock(&f.linked).clear();
        lock(&f.to_server).clear();
        m.resync();
        assert!(lock(&f.to_server).is_empty());
        assert!(m.sessions().is_empty());
    }

    #[test]
    fn malformed_or_unknown_runner_frames_are_dropped() {
        let (f, m) = mux();
        m.on_runner_frame("r1", json!({"type":"output","sessionId":"s1"})); // data 없음
        m.on_runner_frame("r1", json!({"type":"output","sessionId":1,"data":"x"}));
        m.on_runner_frame("r1", json!({"type":"announce","sessions":"no"}));
        m.on_runner_frame("r1", json!({"type":"session.updated","session":sess("s1")}));
        m.on_runner_frame("r1", json!({"type":"hello"}));
        m.on_runner_frame("r1", json!({"nope":1}));
        assert!(lock(&f.to_server).is_empty());
        assert!(m.sessions().is_empty());
    }

    #[test]
    fn server_frames_route_by_runner_id() {
        let (f, m) = mux();
        let input = ServerToOperatorFrame::PtyInput {
            runner_id: "r1".into(),
            session_id: "s1".into(),
            bytes: "eA==".into(),
        };
        assert!(m.on_server_frame(&input));
        assert_eq!(
            lock(&f.to_runner)[0],
            (
                "r1".to_string(),
                json!({"type":"input","sessionId":"s1","data":"eA=="})
            )
        );
        // 러너가 없으면 버리고 기록한다.
        let other = ServerToOperatorFrame::PtyInput {
            runner_id: "r9".into(),
            session_id: "s1".into(),
            bytes: "eA==".into(),
        };
        assert!(!m.on_server_frame(&other));
        assert!(lock(&f.logs)[0].contains("r9"));
        // 오퍼레이터의 말은 러너로 가지 않는다.
        assert!(!m.on_server_frame(&ServerToOperatorFrame::RunnerKill {
            runner_id: "r1".into()
        }));
        assert_eq!(lock(&f.to_runner).len(), 1);
    }

    #[test]
    fn interactive_open_drops_absent_size_and_can_be_refused() {
        let (f, m) = mux();
        let open = ServerToOperatorFrame::InteractiveOpen {
            runner_id: "r1".into(),
            request_id: "q1".into(),
            channel_id: "c".into(),
            thread_root_id: "t".into(),
            opened_by_handle: "h".into(),
            cols: None,
            rows: Some(40),
        };
        assert!(m.on_server_frame(&open));
        let (_, sent) = lock(&f.to_runner)[0].clone();
        assert!(sent.get("cols").is_none());
        assert_eq!(sent["rows"], 40);

        *lock(&f.refuse) = Some("막힘".into());
        assert!(m.on_server_frame(&open));
        assert_eq!(lock(&f.to_runner).len(), 1);
        assert_eq!(
            lock(&f.to_server)[0],
            json!({"type":"interactive.error","runnerId":"r1","requestId":"q1","message":"막힘"})
        );
    }

    #[test]
    fn forget_drops_tracked_sessions() {
        let (_f, m) = mux();
        m.on_runner_frame("r1", json!({"type":"announce","sessions":[sess("s1")]}));
        assert_eq!(m.sessions().len(), 1);
        m.forget("r1");
        assert!(m.sessions().is_empty());
    }
}
