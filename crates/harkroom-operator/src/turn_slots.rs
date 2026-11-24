//! 동시 턴 상한 — TS 옛 Node 오퍼레이터(P3 에서 지움)의 `src/turnSlots.ts` 이식(s21b-3a).
//!
//! 오퍼레이터 **전체**에서 센다(`HARKROOM_MAX_TURNS`). 러너가 턴을 띄우기 직전 `http.forward POST /agent/turn-slots`
//! 로 자리를 묻고, 여기서 답한다 — 서버로 나가지 않는다.
//!
//! - 자리가 없으면 409. 러너는 그 멘션을 읽음 처리하지 않는다 — 인박스가 곧 대기열이다.
//! - 자리의 키는 `(runner_id, key)` 다. runner_id 는 링크 인증이 정한 값이다.
//! - relay 가 끊기거나 **다시 붙으면** 그 러너의 자리를 전부 돌려받는다(`release_runner`, security #1127 L1).
//! - 자리는 relay 소켓에서만 잡고 놓는다. 다른 소켓이면 403 이고 서버로도 넘기지 않는다(security #1127 L2).
//! - `HARKROOM_MAX_TURNS` 가 없으면 상한을 기기 메모리·디스크 여유로 계산한다([`crate::device_capacity`]) — 고정값이 없다.
//!   값이 있으면 그 값이 덮는다. `0` 이면 상한이 없다(일부러 끈 것).
//! - 계산한 상한은 기동 때 한 번 잡고, **새 자리를 줄 때마다 다시 잰다**([`PROBE_EVERY_MS`] 안에서는 앞 값을 쓴다).
//!   가용 메모리·디스크가 줄면 새 턴이 인박스에서 기다리고, 도는 턴은 건드리지 않는다.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::device_capacity::{Capacity, decide, describe, measure};

use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};

pub const TURN_SLOTS_PATH: &str = "/agent/turn-slots";
pub const TURN_SLOTS_RELEASE_PATH: &str = "/agent/turn-slots/release";
pub const MAX_TURNS_ENV: &str = "HARKROOM_MAX_TURNS";
/// 계산한 상한을 다시 재는 간격. 이 안에서는 앞서 잰 상한을 그대로 쓴다 — 한꺼번에 몰린 요청이 같은 「가용 메모리」를
/// 저마다 보고 전부 들어오는 것을 막는다(방금 받은 턴은 아직 메모리를 쓰지 않았다).
pub const PROBE_EVERY_MS: u64 = 10_000;
const LIMIT_LOG_EVERY_MS: u64 = 60_000;
/// 러너가 보내는 키(스레드 키) 길이 상한. 비교에만 쓰고 어디에도 찍지 않는다.
const KEY_MAX: usize = 512;
const FULL_LOG_EVERY_MS: u64 = 60_000;

/// `HARKROOM_MAX_TURNS` 를 읽은 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaxTurns {
    /// 값이 없다 — 기기 자원으로 계산한다.
    Auto,
    /// `0` — 상한 없음(일부러 끈 것).
    Unlimited,
    Fixed(u32),
}

/// 없음·빈 값은 계산([`MaxTurns::Auto`]), `0` 은 상한 없음. 숫자(1~4자리)가 아니면 계산 + 경고 —
/// 잘못 적은 값이 상한을 조용히 끄지 않는다.
pub fn parse_max_turns(raw: Option<&str>, log: &dyn Fn(&str)) -> MaxTurns {
    let v = raw.map(str::trim).unwrap_or_default();
    if v.is_empty() {
        return MaxTurns::Auto;
    }
    if !(1..=4).contains(&v.len()) || !v.bytes().all(|b| b.is_ascii_digit()) {
        let shown: String = v.chars().take(20).collect();
        log(&format!(
            "{MAX_TURNS_ENV}={} 는 0 이상의 정수가 아니다 — 기기 자원으로 계산한 상한으로 돈다",
            Value::String(shown)
        ));
        return MaxTurns::Auto;
    }
    match v.parse::<u32>() {
        Ok(0) => MaxTurns::Unlimited,
        Ok(n) => MaxTurns::Fixed(n),
        Err(_) => MaxTurns::Auto,
    }
}

type Probe = Box<dyn Fn() -> Capacity + Send + Sync>;

/// 계산하는 상한의 상태 — `HARKROOM_MAX_TURNS` 가 없을 때만 있다.
struct Dynamic {
    probe: Probe,
    probed_at: Option<u64>,
    logged_at: u64,
}

pub struct TurnSlots {
    max: Option<u32>,
    dynamic: Option<Dynamic>,
    held: HashMap<String, HashSet<String>>,
    count: usize,
    last_full_log_at: u64,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    log: Box<dyn Fn(&str) + Send + Sync>,
    /// 러너 하나가 쥔 자리 수가 바뀔 때마다 `(runner_id, 쥔 수)` 를 받는다(러너 풀 그림자, I1a). 판정에는 쓰지 않는다.
    observer: Option<SlotObserver>,
}

/// 자리 수 통지를 받는 쪽. **이 표의 잠금을 쥔 채 불린다** — 안에서 `TurnSlots` 를 다시 잠그지 않고, 다른 잠금·입출력·
/// 패닉할 수 있는 일을 하지 않는다(채널에 넣고 바로 돌아온다 — 패닉하면 칸 표의 잠금이 오염된다).
pub type SlotObserver = Box<dyn Fn(&str, usize) + Send + Sync>;

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
            dynamic: None,
            held: HashMap::new(),
            count: 0,
            last_full_log_at: 0,
            now: Box::new(now),
            log: Box::new(log),
            observer: None,
        }
    }

    /// 자리 수 통지를 건다(한 번 — 두 번째는 앞 것을 덮지 않고 버린다).
    pub fn set_observer(&mut self, observer: SlotObserver) {
        if self.observer.is_none() {
            self.observer = Some(observer);
        }
    }

    fn notify(&self, runner_id: &str) {
        if let Some(o) = &self.observer {
            o(runner_id, self.held.get(runner_id).map_or(0, HashSet::len));
        }
    }

    /// 상한을 기기 자원으로 계산한다. 만들 때 한 번 재서 그 근거를 로그에 남긴다.
    pub fn dynamic(
        probe: impl Fn() -> Capacity + Send + Sync + 'static,
        now: impl Fn() -> u64 + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        let mut slots = Self::new(None, now, log);
        let cap = probe();
        let d = decide(&cap, 0);
        let t = (slots.now)();
        (slots.log)(&describe(&d, &cap, 0));
        slots.max = Some(d.limit);
        slots.dynamic = Some(Dynamic {
            probe: Box::new(probe),
            probed_at: Some(t),
            logged_at: t,
        });
        slots
    }

    /// 계산하는 상한이면 다시 잰다. 간격([`PROBE_EVERY_MS`]) 안이면 앞 값을 둔다.
    fn refresh_limit(&mut self) {
        let Some(dy) = self.dynamic.as_mut() else {
            return;
        };
        let t = (self.now)();
        if dy
            .probed_at
            .is_some_and(|at| t.saturating_sub(at) < PROBE_EVERY_MS)
        {
            return;
        }
        dy.probed_at = Some(t);
        let cap = (dy.probe)();
        let d = decide(&cap, self.count);
        if self.max != Some(d.limit) {
            self.max = Some(d.limit);
            // 도는 턴 수에 따라 오르내리므로 줄마다 찍지 않는다.
            if t.saturating_sub(dy.logged_at) >= LIMIT_LOG_EVERY_MS {
                dy.logged_at = t;
                (self.log)(&describe(&d, &cap, self.count));
            }
        }
    }

    /// 프로세스 하나에 하나 — 여러 커뮤니티의 러너를 합쳐 센다(TS run.ts 는 오퍼레이터당 하나를 만든다).
    pub fn process() -> Arc<Mutex<TurnSlots>> {
        static SLOTS: OnceLock<Arc<Mutex<TurnSlots>>> = OnceLock::new();
        Arc::clone(SLOTS.get_or_init(|| {
            let log = |line: &str| eprintln!("{line}");
            let now = || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            };
            let slots = match parse_max_turns(std::env::var(MAX_TURNS_ENV).ok().as_deref(), &log) {
                MaxTurns::Fixed(m) => {
                    eprintln!("동시 턴 상한: {m} ({MAX_TURNS_ENV} 로 정함)");
                    TurnSlots::new(Some(m), now, log)
                }
                MaxTurns::Unlimited => {
                    eprintln!("동시 턴 상한: 없음({MAX_TURNS_ENV}=0)");
                    TurnSlots::new(None, now, log)
                }
                MaxTurns::Auto => {
                    // 턴이 쓰는 자리(~/.harkroom-agent)의 디스크를 본다. 아직 없으면 홈.
                    let home = std::env::var_os("HOME").map(PathBuf::from);
                    TurnSlots::dynamic(
                        move || {
                            let agent = home.as_ref().map(|h| h.join(".harkroom-agent"));
                            let paths: Vec<&Path> = [agent.as_deref(), home.as_deref()]
                                .into_iter()
                                .flatten()
                                .collect();
                            measure(&paths)
                        },
                        now,
                        log,
                    )
                }
            };
            Arc::new(Mutex::new(slots))
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
                self.notify(runner_id);
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
        self.refresh_limit();
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
        self.notify(runner_id);
        Some(answer(req, 200, ok_body(self.count, self.max)))
    }

    /// 러너가 죽었거나 relay 가 다시 붙었다 — 그 러너의 자리를 돌려받는다.
    pub fn release_runner(&mut self, runner_id: &str) {
        if let Some(mine) = self.held.remove(runner_id) {
            self.count -= mine.len();
            self.notify(runner_id);
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
    fn parse_max_turns_computes_when_unset_and_zero_turns_it_off() {
        let warned = Arc::new(AtomicUsize::new(0));
        let w = Arc::clone(&warned);
        let log = move |_: &str| {
            w.fetch_add(1, Ordering::SeqCst);
        };
        assert_eq!(parse_max_turns(None, &log), MaxTurns::Auto);
        assert_eq!(parse_max_turns(Some(""), &log), MaxTurns::Auto);
        assert_eq!(parse_max_turns(Some("  "), &log), MaxTurns::Auto);
        // 0 은 일부러 끈 것이다 — 경고 없이 상한 없음.
        assert_eq!(parse_max_turns(Some("0"), &log), MaxTurns::Unlimited);
        assert_eq!(parse_max_turns(Some(" 6 "), &log), MaxTurns::Fixed(6));
        assert_eq!(parse_max_turns(Some("9999"), &log), MaxTurns::Fixed(9999));
        assert_eq!(warned.load(Ordering::SeqCst), 0);
        // 잘못 적은 값은 상한을 끄지 않는다 — 계산 + 경고.
        assert_eq!(parse_max_turns(Some("10000"), &log), MaxTurns::Auto);
        assert_eq!(parse_max_turns(Some("-1"), &log), MaxTurns::Auto);
        assert_eq!(parse_max_turns(Some("3.5"), &log), MaxTurns::Auto);
        assert_eq!(warned.load(Ordering::SeqCst), 3);
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    fn acquire(s: &mut TurnSlots, key: &str) -> u16 {
        status(s.maybe_handle(
            "r",
            &req(TURN_SLOTS_PATH, json!({"key": key})),
            RunnerLinkKind::Relay,
        ))
    }

    #[test]
    fn dynamic_limit_follows_the_device_and_logs_why() {
        // 가용 메모리를 시험이 바꾼다(GiB). 전체 8GB → 천장 8, 남겨 둘 몫 1GB.
        let avail = Arc::new(Mutex::new(8u64));
        let clock = Arc::new(Mutex::new(1_000_000u64));
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let (a, c, l) = (Arc::clone(&avail), Arc::clone(&clock), Arc::clone(&lines));
        let mut s = TurnSlots::dynamic(
            move || Capacity {
                mem_total: Some(8 * GIB),
                mem_available: Some(*a.lock().unwrap() * GIB),
                disk_free: Some(100 * GIB),
            },
            move || *c.lock().unwrap(),
            move |line| l.lock().unwrap().push(line.to_string()),
        );
        assert_eq!(s.max(), Some(8));
        assert_eq!(
            lines.lock().unwrap().as_slice(),
            [
                "동시 턴 상한: 8 (메모리 전체 8.0GB·가용 8.0GB, 디스크 여유 100.0GB, 도는 턴 0, 기준 전체 메모리)"
            ]
        );
        assert_eq!(acquire(&mut s, "a"), 200);
        assert_eq!(acquire(&mut s, "b"), 200);
        // 가용이 2GB 로 줄었다 — 간격 안에서는 앞 상한을 쓴다.
        *avail.lock().unwrap() = 2;
        assert_eq!(acquire(&mut s, "c"), 200);
        assert_eq!(s.max(), Some(8));
        // 간격이 지나면 다시 잰다: 도는 3 + (2GB − 1GB) ÷ 512MB = 5.
        *clock.lock().unwrap() += PROBE_EVERY_MS;
        assert_eq!(acquire(&mut s, "d"), 200);
        assert_eq!(s.max(), Some(5));
        assert_eq!(acquire(&mut s, "e"), 200);
        // 같은 간격 안의 요청은 잰 여유를 나눠 쓴다 — 여섯째는 기다린다. 이미 쥔 키의 재시도는 통과한다.
        assert_eq!(acquire(&mut s, "f"), 409);
        assert_eq!(acquire(&mut s, "a"), 200);
        assert_eq!(s.in_use(), 5);
        // 가용이 바닥이어도 도는 턴은 그대로고, 새 턴만 기다린다.
        *avail.lock().unwrap() = 0;
        *clock.lock().unwrap() += PROBE_EVERY_MS;
        assert_eq!(acquire(&mut s, "f"), 409);
        assert_eq!(s.max(), Some(5));
        assert_eq!(s.in_use(), 5);
        // 메모리가 돌아오면 다시 받는다. 바뀐 상한은 1분에 한 번만 찍는다.
        *avail.lock().unwrap() = 8;
        *clock.lock().unwrap() += LIMIT_LOG_EVERY_MS;
        assert_eq!(acquire(&mut s, "f"), 200);
        assert_eq!(s.max(), Some(8));
        let lines = lines.lock().unwrap();
        assert_eq!(
            lines.last().unwrap(),
            "동시 턴 상한: 8 (메모리 전체 8.0GB·가용 8.0GB, 디스크 여유 100.0GB, 도는 턴 5, 기준 전체 메모리)"
        );
        // 기동 줄 + 「찼다」 줄 + 바뀐 상한 줄.
        assert_eq!(lines.len(), 3, "{lines:?}");
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
    fn observer_hears_each_change_of_a_runners_held_count() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut s = slots(Some(4));
        let sink = Arc::clone(&seen);
        s.set_observer(Box::new(move |r, n| {
            sink.lock().unwrap().push((r.to_string(), n))
        }));
        // 두 번째 배선은 버린다.
        s.set_observer(Box::new(|_, _| panic!("앞 통지를 덮으면 안 된다")));
        let take = |s: &mut TurnSlots, r: &str, path: &str, key: &str| {
            status(s.maybe_handle(r, &req(path, json!({"key": key})), RunnerLinkKind::Relay))
        };
        assert_eq!(take(&mut s, "r1", TURN_SLOTS_PATH, "k1"), 200);
        // 같은 키 재시도·없는 자리 놓기는 수가 안 바뀌므로 통지도 없다.
        assert_eq!(take(&mut s, "r1", TURN_SLOTS_PATH, "k1"), 200);
        assert_eq!(take(&mut s, "r1", TURN_SLOTS_RELEASE_PATH, "nope"), 204);
        assert_eq!(take(&mut s, "r1", TURN_SLOTS_PATH, "k2"), 200);
        assert_eq!(take(&mut s, "r1", TURN_SLOTS_RELEASE_PATH, "k1"), 204);
        assert_eq!(take(&mut s, "r2", TURN_SLOTS_PATH, "k1"), 200);
        s.release_runner("r1");
        s.release_runner("r1");
        let want: Vec<(String, usize)> = [("r1", 1), ("r1", 2), ("r1", 1), ("r2", 1), ("r1", 0)]
            .iter()
            .map(|(r, n)| (r.to_string(), *n))
            .collect();
        assert_eq!(*seen.lock().unwrap(), want);
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
