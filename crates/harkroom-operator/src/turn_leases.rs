//! 턴 임대 장부 — TS `packages/operator/src/turnSecrets.ts` 의 장부 절반(`noteLease`·`lookup`·`leaseEnded`·
//! `leaseHeartbeat`·`sweepExpired`) 이식(s21b-3b).
//!
//! 러너는 멘션을 집으며 서버에서 턴 임대를 받고(`POST /agent/turn-leases`), relay 소켓으로
//! `secret.lease{cause, leaseId, token, expiresAt}` 통지를 맡긴다. 오퍼레이터의 턴 도구(thread.peek·명령 허락·
//! api·머지·비밀)는 **이 장부에 임대가 있을 때만** 일한다 — 임대가 곧 「이 턴은 사람 글로 시작됐고 아직 살아 있다」는
//! 서버 증명이다.
//!
//! - 키는 `(runner_id, cause)` 다. runner_id 는 링크 인증이 정한 값이라 다른 러너의 하네스는 이 임대를 못 쓴다.
//! - 통지는 relay 소켓에서 온 것만 받는다(러너 링크가 통지를 relay 에서만 넘긴다).
//! - 이 장부는 I/O 를 하지 않는다. 끝내기·늘리기에 서버로 보낼 것을 [`LeaseCall`] 로 돌려주고, 부르는 쪽(bridge)이
//!   장부 잠금을 놓은 뒤 보낸다 — 서버가 느려도 다른 러너의 조회가 막히지 않게.
//! - 비밀 마운트 폴더 지우기는 부르는 쪽(bridge)이 [`crate::turn_secrets::SecretsRoot`] 로 한다 — `note` 가 뺀 임대 id·`ended` 의 임대 id.

use std::collections::HashMap;

/// 턴 도구가 쓰는 임대(TS `MergeLease`). 토큰은 Debug 에 찍지 않는다.
#[derive(Clone, PartialEq, Eq)]
pub struct TurnLease {
    pub lease_id: String,
    pub token: String,
    pub agent_id: String,
}

impl std::fmt::Debug for TurnLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnLease")
            .field("lease_id", &self.lease_id)
            .field("token", &"<redacted>")
            .field("agent_id", &self.agent_id)
            .finish()
    }
}

#[derive(Clone)]
struct Entry {
    lease: TurnLease,
    expires_at_ms: u64,
}

/// 장부가 서버에 보내 달라고 돌려주는 요청. 본문에 토큰이 있다 — 찍지 않는다.
#[derive(Clone, PartialEq, Eq)]
pub struct LeaseCall {
    pub agent_id: String,
    pub lease_id: String,
    pub path: String,
    pub body: String,
}

impl std::fmt::Debug for LeaseCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeaseCall")
            .field("agent_id", &self.agent_id)
            .field("path", &self.path)
            .field("body", &"<redacted>")
            .finish()
    }
}

fn call(lease: &TurnLease, verb: &str) -> LeaseCall {
    LeaseCall {
        agent_id: lease.agent_id.clone(),
        lease_id: lease.lease_id.clone(),
        path: format!(
            "/agent/turn-leases/{}/{verb}",
            encode_component(&lease.lease_id)
        ),
        body: serde_json::json!({ "token": lease.token }).to_string(),
    }
}

/// `encodeURIComponent` 과 같은 집합(영숫자와 `-_.!~*'()` 만 그대로).
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// ISO 8601(`2026-11-11T02:31:41.123Z`·`…+09:00`) → 유닉스 ms. JS `Date.parse` 가 서버의 `toISOString()` 을 읽는 범위만.
pub fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = s.get(r)?;
        if t.bytes().all(|c| c.is_ascii_digit()) {
            t.parse().ok()
        } else {
            None
        }
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[start..i];
        if frac.is_empty() {
            return None;
        }
        let three: String = frac.chars().chain("000".chars()).take(3).collect();
        ms = three.parse().ok()?;
    }
    let offset_min = match &s[i..] {
        "Z" | "z" => 0,
        tz if tz.len() == 6
            && matches!(tz.as_bytes()[0], b'+' | b'-')
            && tz.as_bytes()[3] == b':' =>
        {
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            let v = oh * 60 + om;
            if tz.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    // 그레고리력 날짜 → 일수(Howard Hinnant days_from_civil).
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    let total = secs.checked_mul(1000)?.checked_add(ms)?;
    u64::try_from(total).ok()
}

pub struct TurnLeases {
    /// `(runner_id, cause)` → 임대.
    leases: HashMap<(String, String), Entry>,
    now: Box<dyn Fn() -> u64 + Send>,
}

impl TurnLeases {
    pub fn new(now: impl Fn() -> u64 + Send + 'static) -> Self {
        Self {
            leases: HashMap::new(),
            now: Box::new(now),
        }
    }

    pub fn system() -> Self {
        Self::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
                .unwrap_or(0)
        })
    }

    /// `secret.lease` 통지(TS `noteLease`). 만료 시각을 못 읽으면 버린다. 같은 에이전트·같은 부름의 다른 임대(앞 러너가
    /// 받았고 서버가 다시 주며 끝낸 것)는 장부에서 뺀다 — 서버가 이미 끝냈으므로 끝내기는 보내지 않는다.
    pub fn note(
        &mut self,
        runner_id: &str,
        agent_id: &str,
        cause: &str,
        lease_id: &str,
        token: &str,
        expires_at: &str,
    ) -> Vec<String> {
        let Some(expires_at_ms) = parse_iso_ms(expires_at) else {
            return Vec::new();
        };
        let now = (self.now)();
        // 끝 통지를 못 받은 만료 임대가 쌓이지 않게 여기서 함께 턴다(TS 는 1분 sweep).
        // 뺀 임대 id 를 돌려준다 — 부르는 쪽이 그 비밀 마운트 폴더를 지운다(TS `drop`).
        let mut dropped = Vec::new();
        self.leases.retain(|(_, c), e| {
            let keep = e.expires_at_ms > now
                && !(e.lease.agent_id == agent_id && c == cause && e.lease.lease_id != lease_id);
            if !keep {
                dropped.push(e.lease.lease_id.clone());
            }
            keep
        });
        self.leases.insert(
            (runner_id.to_string(), cause.to_string()),
            Entry {
                lease: TurnLease {
                    lease_id: lease_id.to_string(),
                    token: token.to_string(),
                    agent_id: agent_id.to_string(),
                },
                expires_at_ms,
            },
        );
        dropped
    }

    /// TS `lookup` — 그 러너·그 부름의 살아 있는 임대. 만료됐으면 없다.
    pub fn lookup(&self, runner_id: &str, cause: &str) -> Option<TurnLease> {
        let e = self
            .leases
            .get(&(runner_id.to_string(), cause.to_string()))?;
        (e.expires_at_ms > (self.now)()).then(|| e.lease.clone())
    }

    /// 턴 도구가 쓰는 판정 — 임대가 있고 **그 에이전트의 것**일 때만(TS `lease.agentId !== agentId` 거절).
    pub fn lookup_for(
        &self,
        runner_id: &str,
        agent_id: &str,
        cause: Option<&str>,
    ) -> Option<TurnLease> {
        let l = self.lookup(runner_id, cause.filter(|c| !c.is_empty())?)?;
        (l.agent_id == agent_id).then_some(l)
    }

    /// `secret.leaseEnded`(TS `leaseEnded`) — 장부에서 빼고 서버에 끝내기를 보내라고 돌려준다.
    pub fn ended(&mut self, runner_id: &str, cause: &str) -> Option<LeaseCall> {
        let e = self
            .leases
            .remove(&(runner_id.to_string(), cause.to_string()))?;
        Some(call(&e.lease, "end"))
    }

    /// `secret.leaseHeartbeat`(TS `leaseHeartbeat`) — 살아 있는 임대면 늘리기 요청을 돌려준다.
    pub fn heartbeat(&self, runner_id: &str, cause: &str) -> Option<LeaseCall> {
        self.lookup(runner_id, cause).map(|l| call(&l, "renew"))
    }

    /// 늘리기 응답 반영 — 그 사이 끝 통지가 와서 빠졌거나 다른 임대로 바뀌었으면 고치지 않는다(TS 의 같은 객체 확인).
    pub fn renewed(&mut self, runner_id: &str, cause: &str, lease_id: &str, expires_at: &str) {
        let Some(ms) = parse_iso_ms(expires_at) else {
            return;
        };
        if let Some(e) = self
            .leases
            .get_mut(&(runner_id.to_string(), cause.to_string()))
            && e.lease.lease_id == lease_id
        {
            e.expires_at_ms = ms;
        }
    }

    /// TS `sweepExpired` — 만료돼 장부에서 뺀 임대들의 id(비밀 마운트 폴더를 지우는 데 쓴다).
    pub fn sweep_expired(&mut self) -> Vec<String> {
        let now = (self.now)();
        let mut gone = Vec::new();
        self.leases.retain(|_, e| {
            let keep = e.expires_at_ms > now;
            if !keep {
                gone.push(e.lease.lease_id.clone());
            }
            keep
        });
        gone
    }

    pub fn len(&self) -> usize {
        self.leases.len()
    }

    pub fn is_empty(&self) -> bool {
        self.leases.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    const T0: &str = "2026-11-11T02:00:00.000Z";
    const T0_MS: u64 = 1_794_362_400_000;

    fn at(clock: &Arc<AtomicU64>) -> TurnLeases {
        let c = Arc::clone(clock);
        TurnLeases::new(move || c.load(Ordering::SeqCst))
    }

    #[test]
    fn parses_iso_like_date_parse() {
        assert_eq!(parse_iso_ms(T0), Some(T0_MS));
        assert_eq!(parse_iso_ms("2026-11-11T02:00:00Z"), Some(T0_MS));
        assert_eq!(
            parse_iso_ms("2026-11-11T11:00:00.5+09:00"),
            Some(T0_MS + 500)
        );
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2024-02-29T00:00:00.000Z"),
            Some(1_709_164_800_000)
        );
        for bad in [
            "",
            "soon",
            "2026-11-11",
            "2026-13-01T00:00:00Z",
            "2026-11-11T02:00:00",
            "2026-11-11T02:00:00.Z",
        ] {
            assert_eq!(parse_iso_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn lease_is_scoped_to_runner_cause_agent_and_expiry() {
        let clock = Arc::new(AtomicU64::new(T0_MS - 60_000));
        let mut l = at(&clock);
        l.note("r1", "a1", "c1", "L1", "tok", T0);
        assert_eq!(l.lookup("r1", "c1").map(|x| x.lease_id), Some("L1".into()));
        assert!(l.lookup("r2", "c1").is_none(), "다른 러너는 못 쓴다");
        assert!(
            l.lookup_for("r1", "a2", Some("c1")).is_none(),
            "다른 에이전트는 못 쓴다"
        );
        assert!(l.lookup_for("r1", "a1", None).is_none());
        assert!(l.lookup_for("r1", "a1", Some("")).is_none());
        assert!(l.lookup_for("r1", "a1", Some("c1")).is_some());
        clock.store(T0_MS, Ordering::SeqCst);
        assert!(l.lookup("r1", "c1").is_none(), "만료 시각에 닫힌다");
        assert_eq!(l.sweep_expired().len(), 1);
        assert!(l.is_empty());
    }

    #[test]
    fn bad_expiry_is_dropped_and_old_lease_of_same_call_is_replaced() {
        let clock = Arc::new(AtomicU64::new(0));
        let mut l = at(&clock);
        assert!(l.note("r1", "a1", "c1", "L1", "tok", "later").is_empty());
        assert!(l.is_empty());
        l.note("r1", "a1", "c1", "L1", "tok", T0);
        assert_eq!(
            l.note("r2", "a1", "c1", "L2", "tok2", T0),
            vec!["L1".to_string()],
            "뺀 임대 id 를 돌려준다"
        );
        assert!(l.lookup("r1", "c1").is_none(), "앞 러너의 옛 임대는 빠진다");
        assert_eq!(l.lookup("r2", "c1").map(|x| x.lease_id), Some("L2".into()));
        // 다른 에이전트의 같은 cause 는 건드리지 않는다.
        l.note("r3", "a9", "c1", "L9", "tok9", T0);
        assert_eq!(l.len(), 2);
    }

    #[test]
    fn end_and_renew_calls_carry_token_in_body_only() {
        let clock = Arc::new(AtomicU64::new(0));
        let mut l = at(&clock);
        l.note("r1", "a1", "c1", "L/1", "secret-tok", T0);
        let hb = l.heartbeat("r1", "c1").expect("살아 있으면 늘린다");
        assert_eq!(hb.path, "/agent/turn-leases/L%2F1/renew");
        assert_eq!(hb.body, r#"{"token":"secret-tok"}"#);
        assert!(!format!("{hb:?}").contains("secret-tok"));
        assert!(!format!("{:?}", l.lookup("r1", "c1").unwrap()).contains("secret-tok"));
        l.renewed("r1", "c1", "L/1", "2026-11-11T03:00:00Z");
        clock.store(T0_MS + 1, Ordering::SeqCst);
        assert!(l.lookup("r1", "c1").is_some(), "늘린 만큼 산다");
        l.renewed("r1", "c1", "OTHER", "2099-01-01T00:00:00Z");
        let end = l.ended("r1", "c1").expect("끝내기");
        assert_eq!(end.path, "/agent/turn-leases/L%2F1/end");
        assert!(l.lookup("r1", "c1").is_none());
        assert!(l.ended("r1", "c1").is_none(), "두 번 끝내지 않는다");
        l.renewed("r1", "c1", "L/1", "2099-01-01T00:00:00Z");
        assert!(l.is_empty(), "끝난 뒤 늘리기 응답이 와도 되살리지 않는다");
        assert!(l.heartbeat("r1", "c1").is_none());
    }
}
