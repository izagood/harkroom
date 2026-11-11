//! 턴 열쇠 장부 — TS `packages/operator/src/turnKeys.ts` 이식(s21b-1).
//!
//! 러너는 하네스를 띄울 때마다 열쇠 둘(`bridge`·`shell`)을 만들어 **relay 요청**
//! (`http.forward POST /agent/turn-keys`)으로 여기 맡기고, 끝나면 `/agent/turn-keys/end` 로 지운다.
//! 서버로 나가지 않는다.
//!
//! - 맡기기·끝내기는 relay 소켓에서만 받는다 — 하네스가 여는 소켓(bridge·hook·wrapper)이면 403.
//! - 열쇠는 맡긴 러너에 묶인다. 장부에는 원값이 아니라 sha256 을 둔다.
//! - 러너가 잊히면 그 러너의 열쇠를 전부 지우고, 끝내기가 오지 않은 열쇠는 12시간 뒤 쓴다.

use std::collections::HashMap;

use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};

/// 끝내기가 오지 않은 열쇠의 수명 상한(TS `TURN_KEY_MAX_AGE_MS`).
pub const TURN_KEY_MAX_AGE_MS: u64 = 12 * 60 * 60_000;
/// 러너 하나가 쥘 수 있는 턴 수(TS `TURN_KEYS_PER_RUNNER`).
pub const TURN_KEYS_PER_RUNNER: usize = 64;
pub const TURN_KEYS_PATH: &str = "/agent/turn-keys";
pub const TURN_KEYS_END_PATH: &str = "/agent/turn-keys/end";
/// 래퍼 소켓이 받는 도구(TS `MERGE_TOOL`·`API_TOOL`).
pub const MERGE_TOOL: &str = "repo.merge";
pub const API_TOOL: &str = "api.call";
const ID_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnKeyScope {
    Bridge,
    Shell,
}

impl TurnKeyScope {
    /// TS `TURN_KEY_SCOPE_KINDS` — relay 는 어떤 열쇠로도 못 연다.
    pub fn opens(self, kind: RunnerLinkKind) -> bool {
        match self {
            TurnKeyScope::Bridge => kind == RunnerLinkKind::Bridge,
            TurnKeyScope::Shell => matches!(kind, RunnerLinkKind::Hook | RunnerLinkKind::Wrapper),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnKeyEntry {
    pub runner_id: String,
    pub scope: TurnKeyScope,
    pub turn_id: String,
    /// 그 턴을 띄운 메시지 id. 대화형·백그라운드 턴은 없다.
    pub cause: Option<String>,
}

struct Stored {
    entry: TurnKeyEntry,
    digest: [u8; 32],
    at: u64,
}

/// TS `TURN_KEY_PATTERN` = `^[0-9a-f]{64}$`.
pub fn is_turn_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn digest(key: &str) -> [u8; 32] {
    let d = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

fn hex(d: &[u8; 32]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// 상수 시간 비교(TS `timingSafeEqual`). 길이가 다르면 곧바로 false — 길이는 비밀이 아니다.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

fn valid_id(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= ID_MAX => Some(s),
        _ => None,
    }
}

pub struct TurnKeyLedger {
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    log: Box<dyn Fn(&str) + Send + Sync>,
    /// sha256(hex) → 항목.
    by_digest: HashMap<String, Stored>,
    /// runnerId → turnId → 그 턴 열쇠들의 digest(hex).
    by_runner: HashMap<String, HashMap<String, Vec<String>>>,
}

fn answer(req: &RunnerLinkRequest, status: u16, body: Value) -> RunnerLinkResponse {
    match req {
        RunnerLinkRequest::McpRequest { id, .. } => RunnerLinkResponse::McpError {
            id: id.clone(),
            status,
            message: body.to_string(),
        },
        RunnerLinkRequest::HttpForward { id, .. } => RunnerLinkResponse::HttpResponse {
            id: id.clone(),
            status,
            body: body.to_string(),
        },
    }
}

impl TurnKeyLedger {
    pub fn new(
        now: impl Fn() -> u64 + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self {
            now: Box::new(now),
            log: Box::new(log),
            by_digest: HashMap::new(),
            by_runner: HashMap::new(),
        }
    }

    /// 벽시계(ms)와 표준 오류 로그.
    pub fn system() -> Self {
        Self::new(
            || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            },
            |line| eprintln!("{line}"),
        )
    }

    /// 프로세스 하나에 하나 — 여러 커뮤니티의 러너 링크가 같이 쓴다(TS run.ts 는 오퍼레이터당 하나를 만든다).
    pub fn process() -> std::sync::Arc<std::sync::Mutex<TurnKeyLedger>> {
        static LEDGER: std::sync::OnceLock<std::sync::Arc<std::sync::Mutex<TurnKeyLedger>>> =
            std::sync::OnceLock::new();
        std::sync::Arc::clone(LEDGER.get_or_init(|| {
            let l = std::sync::Arc::new(std::sync::Mutex::new(Self::system()));
            // TS run.ts — 1분마다 끝내기가 오지 않은 열쇠를 쓴다.
            let w = std::sync::Arc::downgrade(&l);
            let _ = std::thread::Builder::new()
                .name("turn-keys-sweep".into())
                .spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                        let Some(l) = w.upgrade() else { return };
                        l.lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .sweep();
                    }
                });
            l
        }))
    }

    fn drop_turn(&mut self, runner_id: &str, turn_id: &str) {
        let Some(turns) = self.by_runner.get_mut(runner_id) else {
            return;
        };
        let Some(digests) = turns.remove(turn_id) else {
            return;
        };
        for d in digests {
            self.by_digest.remove(&d);
        }
        if turns.is_empty() {
            self.by_runner.remove(runner_id);
        }
    }

    /// 맡기기·끝내기 요청이면 답한다. 아니면 `None`(다음 처리기로).
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
        if path != TURN_KEYS_PATH && path != TURN_KEYS_END_PATH {
            return None;
        }
        if from != RunnerLinkKind::Relay {
            return Some(answer(req, 403, json!({ "error": "relay_only" })));
        }
        if method != "POST" {
            return Some(answer(req, 405, json!({ "error": "method" })));
        }
        let parsed: Option<serde_json::Map<String, Value>> = body
            .as_deref()
            .and_then(|b| serde_json::from_str::<Value>(b).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            });
        let Some(obj) = parsed else {
            return Some(answer(req, 400, json!({ "error": "bad_request" })));
        };
        let Some(turn_id) = valid_id(obj.get("turnId")).map(str::to_string) else {
            return Some(answer(req, 400, json!({ "error": "bad_request" })));
        };
        if path == TURN_KEYS_END_PATH {
            self.drop_turn(runner_id, &turn_id);
            return Some(answer(req, 200, json!({ "ok": true })));
        }
        let cause = match obj.get("cause") {
            None | Some(Value::Null) => None,
            v => match valid_id(v) {
                Some(c) => Some(c.to_string()),
                None => return Some(answer(req, 400, json!({ "error": "bad_request" }))),
            },
        };
        let keys = obj.get("keys").and_then(Value::as_object);
        let bridge = keys.and_then(|k| k.get("bridge")).and_then(Value::as_str);
        let shell = keys.and_then(|k| k.get("shell")).and_then(Value::as_str);
        let (Some(bridge), Some(shell)) = (bridge, shell) else {
            return Some(answer(req, 400, json!({ "error": "bad_keys" })));
        };
        if !is_turn_key(bridge) || !is_turn_key(shell) || bridge == shell {
            return Some(answer(req, 400, json!({ "error": "bad_keys" })));
        }
        let open_turns = self.by_runner.get(runner_id).map_or(0, HashMap::len);
        let known = self
            .by_runner
            .get(runner_id)
            .is_some_and(|t| t.contains_key(&turn_id));
        if !known && open_turns >= TURN_KEYS_PER_RUNNER {
            (self.log)(&format!(
                "턴 열쇠 맡기기 거절: runnerId={runner_id} — 턴 {TURN_KEYS_PER_RUNNER}개가 이미 열려 있다"
            ));
            return Some(answer(req, 429, json!({ "error": "too_many_turns" })));
        }
        // 같은 턴을 다시 맡기면 앞 열쇠를 버린다(재spawn).
        self.drop_turn(runner_id, &turn_id);
        let at = (self.now)();
        let mut digests: Vec<String> = Vec::with_capacity(2);
        for (scope, key) in [(TurnKeyScope::Bridge, bridge), (TurnKeyScope::Shell, shell)] {
            let d = digest(key);
            let h = hex(&d);
            if self.by_digest.contains_key(&h) {
                for x in &digests {
                    self.by_digest.remove(x);
                }
                return Some(answer(req, 409, json!({ "error": "key_reused" })));
            }
            self.by_digest.insert(
                h.clone(),
                Stored {
                    entry: TurnKeyEntry {
                        runner_id: runner_id.to_string(),
                        scope,
                        turn_id: turn_id.clone(),
                        cause: cause.clone(),
                    },
                    digest: d,
                    at,
                },
            );
            digests.push(h);
        }
        self.by_runner
            .entry(runner_id.to_string())
            .or_default()
            .insert(turn_id, digests);
        Some(answer(req, 200, json!({ "ok": true })))
    }

    /// 열쇠 원값으로 찾는다. 모르거나 수명을 넘겼으면 `None`.
    pub fn lookup(&self, key: &str) -> Option<TurnKeyEntry> {
        if !is_turn_key(key) {
            return None;
        }
        let d = digest(key);
        let hit = self.by_digest.get(&hex(&d))?;
        // 맵 조회는 digest 로 하고, 찾은 뒤에도 상수 시간으로 한 번 더 맞춘다.
        if !ct_eq(&hit.digest, &d) {
            return None;
        }
        if (self.now)().saturating_sub(hit.at) > TURN_KEY_MAX_AGE_MS {
            return None;
        }
        Some(hit.entry.clone())
    }

    /// 러너가 잊혔다 — 그 러너의 열쇠를 전부 지운다.
    pub fn forget_runner(&mut self, runner_id: &str) {
        let turns: Vec<String> = match self.by_runner.get(runner_id) {
            Some(t) => t.keys().cloned().collect(),
            None => return,
        };
        for t in turns {
            self.drop_turn(runner_id, &t);
        }
    }

    /// 수명을 넘긴 열쇠를 지운다.
    pub fn sweep(&mut self) {
        let t = (self.now)();
        let mut stale: Vec<(String, String)> = Vec::new();
        for (runner_id, turns) in &self.by_runner {
            for (turn_id, digests) in turns {
                let fresh = digests
                    .first()
                    .and_then(|d| self.by_digest.get(d))
                    .is_some_and(|s| t.saturating_sub(s.at) <= TURN_KEY_MAX_AGE_MS);
                if !fresh {
                    stale.push((runner_id.clone(), turn_id.clone()));
                }
            }
        }
        for (r, turn) in stale {
            self.drop_turn(&r, &turn);
        }
    }

    pub fn size(&self) -> usize {
        self.by_digest.len()
    }
}

/// 래퍼 소켓(`wrapper`)이 받는 요청인가 — `tools/call` 의 머지·api 도구 하나(TS `isWrapperCall`).
pub fn is_wrapper_call(req: &RunnerLinkRequest) -> bool {
    let RunnerLinkRequest::McpRequest { payload, .. } = req else {
        return false;
    };
    payload.get("method").and_then(Value::as_str) == Some("tools/call")
        && matches!(
            payload.pointer("/params/name").and_then(Value::as_str),
            Some(MERGE_TOOL) | Some(API_TOOL)
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    const K1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const K2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const K3: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    fn ledger() -> (TurnKeyLedger, Arc<AtomicU64>) {
        let clock = Arc::new(AtomicU64::new(1_000));
        let c = Arc::clone(&clock);
        (
            TurnKeyLedger::new(move || c.load(Ordering::SeqCst), |_| {}),
            clock,
        )
    }

    fn fwd(path: &str, body: Value) -> RunnerLinkRequest {
        RunnerLinkRequest::HttpForward {
            id: "r1".into(),
            method: "POST".into(),
            path: path.into(),
            body: Some(body.to_string()),
            body_base64: None,
            content_type: None,
        }
    }

    fn status(res: Option<RunnerLinkResponse>) -> u16 {
        match res.expect("handled") {
            RunnerLinkResponse::HttpResponse { status, .. }
            | RunnerLinkResponse::McpError { status, .. } => status,
            RunnerLinkResponse::McpResponse { .. } => 0,
        }
    }

    fn deposit(l: &mut TurnKeyLedger, runner: &str, turn: &str, b: &str, s: &str) -> u16 {
        status(l.maybe_handle(
            runner,
            &fwd(
                TURN_KEYS_PATH,
                json!({"turnId": turn, "cause": "m1", "keys": {"bridge": b, "shell": s}}),
            ),
            RunnerLinkKind::Relay,
        ))
    }

    #[test]
    fn deposit_lookup_and_end() {
        let (mut l, _) = ledger();
        assert_eq!(deposit(&mut l, "r", "t1", K1, K2), 200);
        let e = l.lookup(K1).unwrap();
        assert_eq!(
            (e.scope, e.turn_id.as_str(), e.cause.as_deref()),
            (TurnKeyScope::Bridge, "t1", Some("m1"))
        );
        assert_eq!(l.lookup(K2).unwrap().scope, TurnKeyScope::Shell);
        assert_eq!(l.size(), 2);
        let end = fwd(TURN_KEYS_END_PATH, json!({"turnId": "t1"}));
        assert_eq!(
            status(l.maybe_handle("r", &end, RunnerLinkKind::Relay)),
            200
        );
        assert!(l.lookup(K1).is_none());
        assert_eq!(l.size(), 0);
    }

    #[test]
    fn only_relay_may_deposit() {
        let (mut l, _) = ledger();
        for kind in [
            RunnerLinkKind::Bridge,
            RunnerLinkKind::Hook,
            RunnerLinkKind::Wrapper,
        ] {
            let req = fwd(
                TURN_KEYS_PATH,
                json!({"turnId": "t", "keys": {"bridge": K1, "shell": K2}}),
            );
            assert_eq!(status(l.maybe_handle("r", &req, kind)), 403);
        }
        assert_eq!(l.size(), 0);
    }

    #[test]
    fn bad_keys_and_other_paths() {
        let (mut l, _) = ledger();
        assert_eq!(deposit(&mut l, "r", "t", K1, K1), 400);
        assert_eq!(deposit(&mut l, "r", "t", "ABC", K2), 400);
        let other = fwd("/agent/other", json!({}));
        assert!(l.maybe_handle("r", &other, RunnerLinkKind::Relay).is_none());
        let get = RunnerLinkRequest::HttpForward {
            id: "x".into(),
            method: "GET".into(),
            path: TURN_KEYS_PATH.into(),
            body: None,
            body_base64: None,
            content_type: None,
        };
        assert_eq!(
            status(l.maybe_handle("r", &get, RunnerLinkKind::Relay)),
            405
        );
    }

    #[test]
    fn reused_key_is_refused_and_redeposit_replaces() {
        let (mut l, _) = ledger();
        assert_eq!(deposit(&mut l, "r", "t1", K1, K2), 200);
        assert_eq!(deposit(&mut l, "r", "t2", K3, K1), 409);
        assert!(l.lookup(K3).is_none(), "half-written deposit rolled back");
        // 같은 턴을 다시 맡기면 앞 열쇠를 버린다.
        assert_eq!(deposit(&mut l, "r", "t1", K3, K2), 200);
        assert!(l.lookup(K1).is_none());
        assert_eq!(l.lookup(K3).unwrap().turn_id, "t1");
    }

    #[test]
    fn expiry_forget_and_cap() {
        let (mut l, clock) = ledger();
        assert_eq!(deposit(&mut l, "r", "t1", K1, K2), 200);
        clock.fetch_add(TURN_KEY_MAX_AGE_MS + 1, Ordering::SeqCst);
        assert!(l.lookup(K1).is_none());
        l.sweep();
        assert_eq!(l.size(), 0);
        assert_eq!(deposit(&mut l, "r", "t1", K1, K2), 200);
        l.forget_runner("r");
        assert_eq!(l.size(), 0);
        for i in 0..TURN_KEYS_PER_RUNNER {
            let b = format!("{:064x}", 2 * i + 10);
            let s = format!("{:064x}", 2 * i + 11);
            assert_eq!(deposit(&mut l, "r", &format!("t{i}"), &b, &s), 200);
        }
        assert_eq!(deposit(&mut l, "r", "over", K1, K2), 429);
    }

    #[test]
    fn scopes_and_wrapper_calls() {
        assert!(TurnKeyScope::Bridge.opens(RunnerLinkKind::Bridge));
        assert!(!TurnKeyScope::Bridge.opens(RunnerLinkKind::Relay));
        assert!(TurnKeyScope::Shell.opens(RunnerLinkKind::Hook));
        assert!(TurnKeyScope::Shell.opens(RunnerLinkKind::Wrapper));
        assert!(!TurnKeyScope::Shell.opens(RunnerLinkKind::Relay));
        let call = |name: &str| RunnerLinkRequest::McpRequest {
            id: "1".into(),
            payload: json!({"method": "tools/call", "params": {"name": name}}),
            cause: None,
            cwd: None,
            turn_id: None,
            command_files: None,
        };
        assert!(is_wrapper_call(&call(MERGE_TOOL)));
        assert!(is_wrapper_call(&call(API_TOOL)));
        assert!(!is_wrapper_call(&call("message.post")));
        assert!(ct_eq(b"abc", b"abc") && !ct_eq(b"abc", b"abd") && !ct_eq(b"ab", b"abc"));
    }
}
