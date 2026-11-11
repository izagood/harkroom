//! 동시 턴 상한 — TS `packages/operator/src/turnSlots.ts` 이식(s21b-3a).
//!
//! 오퍼레이터 **전체**에서 센다(`HARKROOM_MAX_TURNS`). 러너가 턴을 띄우기 직전 `http.forward POST /agent/turn-slots`
//! 로 자리를 묻고, 여기서 답한다 — 서버로 나가지 않는다.
//!
//! - 자리가 없으면 409. 러너는 그 멘션을 읽음 처리하지 않는다 — 인박스가 곧 대기열이다.
//! - 자리의 키는 `(runner_id, key)` 다. runner_id 는 링크 인증이 정한 값이다.
//! - relay 가 끊기거나 **다시 붙으면** 그 러너의 자리를 전부 돌려받는다(`release_runner`, security #1127 L1).
//! - 자리는 relay 소켓에서만 잡고 놓는다. 다른 소켓이면 403 이고 서버로도 넘기지 않는다(security #1127 L2).
//! - 값이 없거나 0 이면 상한이 없다.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};

pub const TURN_SLOTS_PATH: &str = "/agent/turn-slots";
pub const TURN_SLOTS_RELEASE_PATH: &str = "/agent/turn-slots/release";
pub const MAX_TURNS_ENV: &str = "HARKROOM_MAX_TURNS";
/// 러너가 보내는 키(스레드 키) 길이 상한. 비교에만 쓰고 어디에도 찍지 않는다.
const KEY_MAX: usize = 512;
const FULL_LOG_EVERY_MS: u64 = 60_000;

/// TS `parseMaxTurns` — 없음·빈 값·0 은 상한 없음. 숫자(1~4자리)가 아니면 상한 없음 + 경고.
pub fn parse_max_turns(raw: Option<&str>, log: &dyn Fn(&str)) -> Option<u32> {
    let v = raw?.trim();
    if v.is_empty() {
        return None;
    }
    if !(1..=4).contains(&v.len()) || !v.bytes().all(|b| b.is_ascii_digit()) {
        let shown: String = v.chars().take(20).collect();
        log(&format!(
            "{MAX_TURNS_ENV}={} 는 0 이상의 정수가 아니다 — 동시 턴 상한 없이 돈다",
            Value::String(shown)
        ));
        return None;
    }
    match v.parse::<u32>() {
        Ok(0) | Err(_) => None,
        Ok(n) => Some(n),
    }
}

pub struct TurnSlots {
    max: Option<u32>,
    held: HashMap<String, HashSet<String>>,
    count: usize,
    last_full_log_at: u64,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

fn answer(req: &RunnerLinkRequest, status: u16, body: String) -> RunnerLinkResponse {
    let id = match req {
        RunnerLinkRequest::HttpForward { id, .. } => id.clone(),
        _ => String::new(),
    };
    RunnerLinkResponse::HttpResponse { id, status, body }
}

impl TurnSlots {
    pub fn new(
        max: Option<u32>,
        now: impl Fn() -> u64 + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self {
            max,
            held: HashMap::new(),
            count: 0,
            last_full_log_at: 0,
            now: Box::new(now),
            log: Box::new(log),
        }
    }

    /// 프로세스 하나에 하나 — 여러 커뮤니티의 러너를 합쳐 센다(TS run.ts 는 오퍼레이터당 하나를 만든다).
    pub fn process() -> Arc<Mutex<TurnSlots>> {
        static SLOTS: OnceLock<Arc<Mutex<TurnSlots>>> = OnceLock::new();
        Arc::clone(SLOTS.get_or_init(|| {
            let log = |line: &str| eprintln!("{line}");
            let max = parse_max_turns(std::env::var(MAX_TURNS_ENV).ok().as_deref(), &log);
            if let Some(m) = max {
                eprintln!("동시 턴 상한: {m}");
            }
            Arc::new(Mutex::new(TurnSlots::new(
                max,
                || {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0)
                },
                log,
            )))
        }))
    }

    pub fn max(&self) -> Option<u32> {
        self.max
    }

    pub fn in_use(&self) -> usize {
        self.count
    }

    pub fn by_runner(&self) -> HashMap<String, usize> {
        self.held
            .iter()
            .map(|(r, k)| (r.clone(), k.len()))
            .collect()
    }

    fn body_field<'a>(body: &'a Option<Value>, name: &str) -> Option<&'a Value> {
        body.as_ref().and_then(|v| v.get(name))
    }

    /// 자리 요청이면 답한다. 아니면 `None`(다음 처리기로).
    pub fn maybe_handle(
        &mut self,
        runner_id: &str,
        req: &RunnerLinkRequest,
        from: RunnerLinkKind,
    ) -> Option<RunnerLinkResponse> {
        let RunnerLinkRequest::HttpForward {
            method, path, body, ..
        } = req
        else {
            return None;
        };
        if method != "POST" {
            return None;
        }
        let path = path.split('?').next().unwrap_or_default();
        if path != TURN_SLOTS_PATH && path != TURN_SLOTS_RELEASE_PATH {
            return None;
        }
        if from != RunnerLinkKind::Relay {
            return Some(answer(
                req,
                403,
                json!({"error": {"code": "forbidden", "message": "턴 자리는 러너 relay 에서만 잡는다"}})
                    .to_string(),
            ));
        }
        let parsed: Option<Value> = body.as_deref().and_then(|b| serde_json::from_str(b).ok());
        let key = Self::body_field(&parsed, "key")
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty() && k.chars().count() <= KEY_MAX)
            .map(str::to_string);
        let Some(key) = key else {
            return Some(answer(
                req,
                400,
                json!({"error": {"code": "bad_request", "message": "key 가 없다"}}).to_string(),
            ));
        };

        if path == TURN_SLOTS_RELEASE_PATH {
            if let Some(mine) = self.held.get_mut(runner_id)
                && mine.remove(&key)
            {
                self.count -= 1;
                if mine.is_empty() {
                    self.held.remove(runner_id);
                }
            }
            // 멱등 — 없는 자리를 놓아도 204 다.
            return Some(answer(req, 204, String::new()));
        }

        let ok_body =
            |count: usize, max: Option<u32>| json!({"max": max, "inUse": count}).to_string();
        // 같은 키를 다시 잡으면 이미 쥔 것이다(재시도) — 두 번 세지 않는다.
        if self.held.get(runner_id).is_some_and(|m| m.contains(&key)) {
            return Some(answer(req, 200, ok_body(self.count, self.max)));
        }
        // 백그라운드 회차는 `keepFree`(0~4 정수) 만큼 자리를 남겨 둔다. 옛 러너는 안 싣는다(0).
        let keep_free = Self::body_field(&parsed, "keepFree")
            .and_then(|v| {
                // TS Number.isInteger: 2.0 도 정수다.
                v.as_u64().or_else(|| {
                    v.as_f64()
                        .filter(|f| f.fract() == 0.0 && *f >= 0.0)
                        .map(|f| f as u64)
                })
            })
            .filter(|n| *n <= 4)
            .unwrap_or(0) as i64;
        if let Some(max) = self.max
            && self.count as i64 >= max as i64 - keep_free
        {
            let t = (self.now)();
            if t.saturating_sub(self.last_full_log_at) > FULL_LOG_EVERY_MS {
                self.last_full_log_at = t;
                (self.log)(&format!(
                    "동시 턴 상한({max})이 찼다 — 새 턴은 자리가 날 때까지 인박스에서 기다린다"
                ));
            }
            return Some(answer(
                    req,
                    409,
                    json!({
                        "error": {"code": "turn_slots_full", "message": format!("동시 턴 상한 {max} 이 찼다")},
                        "max": max,
                        "inUse": self.count,
                    })
                    .to_string(),
                ));
        }
        self.held
            .entry(runner_id.to_string())
            .or_default()
            .insert(key);
        self.count += 1;
        Some(answer(req, 200, ok_body(self.count, self.max)))
    }

    /// 러너가 죽었거나 relay 가 다시 붙었다 — 그 러너의 자리를 돌려받는다.
    pub fn release_runner(&mut self, runner_id: &str) {
        if let Some(mine) = self.held.remove(runner_id) {
            self.count -= mine.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn req(path: &str, body: Value) -> RunnerLinkRequest {
        RunnerLinkRequest::HttpForward {
            id: "q".into(),
            method: "POST".into(),
            path: path.into(),
            body: Some(body.to_string()),
            content_type: Some("application/json".into()),
            body_base64: None,
        }
    }

    fn status(r: Option<RunnerLinkResponse>) -> u16 {
        match r.expect("handled") {
            RunnerLinkResponse::HttpResponse { status, .. } => status,
            other => panic!("unexpected {other:?}"),
        }
    }

    fn slots(max: Option<u32>) -> TurnSlots {
        TurnSlots::new(max, || 1_000_000, |_| {})
    }

    #[test]
    fn parse_max_turns_matches_ts() {
        let warned = Arc::new(AtomicUsize::new(0));
        let w = Arc::clone(&warned);
        let log = move |_: &str| {
            w.fetch_add(1, Ordering::SeqCst);
        };
        assert_eq!(parse_max_turns(None, &log), None);
        assert_eq!(parse_max_turns(Some(""), &log), None);
        assert_eq!(parse_max_turns(Some("  "), &log), None);
        assert_eq!(parse_max_turns(Some("0"), &log), None);
        assert_eq!(parse_max_turns(Some(" 6 "), &log), Some(6));
        assert_eq!(parse_max_turns(Some("9999"), &log), Some(9999));
        assert_eq!(warned.load(Ordering::SeqCst), 0);
        assert_eq!(parse_max_turns(Some("10000"), &log), None);
        assert_eq!(parse_max_turns(Some("-1"), &log), None);
        assert_eq!(parse_max_turns(Some("3.5"), &log), None);
        assert_eq!(warned.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn caps_counts_retries_once_and_releases() {
        let mut s = slots(Some(2));
        assert_eq!(
            status(s.maybe_handle(
                "r1",
                &req(TURN_SLOTS_PATH, json!({"key":"a"})),
                RunnerLinkKind::Relay
            )),
            200
        );
        // 재시도는 두 번 세지 않는다.
        assert_eq!(
            status(s.maybe_handle(
                "r1",
                &req(TURN_SLOTS_PATH, json!({"key":"a"})),
                RunnerLinkKind::Relay
            )),
            200
        );
        assert_eq!(s.in_use(), 1);
        assert_eq!(
            status(s.maybe_handle(
                "r2",
                &req(TURN_SLOTS_PATH, json!({"key":"a"})),
                RunnerLinkKind::Relay
            )),
            200
        );
        assert_eq!(
            status(s.maybe_handle(
                "r2",
                &req(TURN_SLOTS_PATH, json!({"key":"b"})),
                RunnerLinkKind::Relay
            )),
            409
        );
        // 남의 자리는 못 놓는다 — r2 가 r1 의 키 a 를 놓으면 자기 a 가 놓인다.
        assert_eq!(
            status(s.maybe_handle(
                "r2",
                &req(TURN_SLOTS_RELEASE_PATH, json!({"key":"zz"})),
                RunnerLinkKind::Relay
            )),
            204
        );
        assert_eq!(s.in_use(), 2);
        assert_eq!(
            status(s.maybe_handle(
                "r2",
                &req(TURN_SLOTS_RELEASE_PATH, json!({"key":"a"})),
                RunnerLinkKind::Relay
            )),
            204
        );
        assert_eq!(s.in_use(), 1);
        assert_eq!(s.by_runner().get("r1"), Some(&1));
        assert!(!s.by_runner().contains_key("r2"));
        s.release_runner("r1");
        assert_eq!(s.in_use(), 0);
    }

    #[test]
    fn keep_free_reserves_slots_for_people() {
        let mut s = slots(Some(3));
        s.maybe_handle(
            "r",
            &req(TURN_SLOTS_PATH, json!({"key":"a"})),
            RunnerLinkKind::Relay,
        );
        s.maybe_handle(
            "r",
            &req(TURN_SLOTS_PATH, json!({"key":"b"})),
            RunnerLinkKind::Relay,
        );
        assert_eq!(
            status(s.maybe_handle(
                "r",
                &req(TURN_SLOTS_PATH, json!({"key":"c","keepFree":1})),
                RunnerLinkKind::Relay
            )),
            409
        );
        // 범위 밖 keepFree 는 0 으로 읽는다.
        assert_eq!(
            status(s.maybe_handle(
                "r",
                &req(TURN_SLOTS_PATH, json!({"key":"c","keepFree":9})),
                RunnerLinkKind::Relay
            )),
            200
        );
    }

    #[test]
    fn non_relay_is_forbidden_and_bad_key_is_400() {
        let mut s = slots(None);
        for kind in [
            RunnerLinkKind::Bridge,
            RunnerLinkKind::Hook,
            RunnerLinkKind::Wrapper,
        ] {
            assert_eq!(
                status(s.maybe_handle("r", &req(TURN_SLOTS_PATH, json!({"key":"a"})), kind)),
                403
            );
        }
        assert_eq!(
            status(s.maybe_handle("r", &req(TURN_SLOTS_PATH, json!({})), RunnerLinkKind::Relay)),
            400
        );
        let long = "x".repeat(KEY_MAX + 1);
        assert_eq!(
            status(s.maybe_handle(
                "r",
                &req(TURN_SLOTS_PATH, json!({"key": long})),
                RunnerLinkKind::Relay
            )),
            400
        );
        assert_eq!(s.in_use(), 0);
    }

    #[test]
    fn unlimited_and_other_paths_pass_through() {
        let mut s = slots(None);
        for i in 0..50 {
            assert_eq!(
                status(s.maybe_handle(
                    "r",
                    &req(TURN_SLOTS_PATH, json!({"key": format!("k{i}")})),
                    RunnerLinkKind::Relay
                )),
                200
            );
        }
        assert!(
            s.maybe_handle("r", &req("/agent/config", json!({})), RunnerLinkKind::Relay)
                .is_none()
        );
        let get = RunnerLinkRequest::HttpForward {
            id: "q".into(),
            method: "GET".into(),
            path: TURN_SLOTS_PATH.into(),
            body: None,
            content_type: None,
            body_base64: None,
        };
        assert!(s.maybe_handle("r", &get, RunnerLinkKind::Relay).is_none());
    }
}
