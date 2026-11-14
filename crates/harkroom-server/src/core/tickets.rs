//! `/ws` 티켓(TS `ws/tickets.ts`) — 1회용, 30초. 브라우저 WebSocket 은 헤더를 못 붙여 자격증명이 URL 로 가므로, 장기 토큰 대신
//! 이것을 싣는다. 소모는 만료와 상관없이 지운다. 형식은 TS `newToken('hrkt')` 와 같다(`hrkt_` + 32바이트 base64url).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub account_id: String,
    pub credential_hash: String,
}

pub struct TicketStore {
    ttl: Duration,
    live: Mutex<HashMap<String, (Claim, Instant)>>,
}

impl TicketStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            live: Mutex::new(HashMap::new()),
        }
    }

    pub fn issue(&self, claim: Claim) -> String {
        let mut b = [0u8; 32];
        getrandom::fill(&mut b).expect("os random");
        let token = format!("hrkt_{}", crate::inbox_today::b64url(&b));
        let now = Instant::now();
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        live.retain(|_, (_, exp)| *exp > now);
        live.insert(token.clone(), (claim, now + self.ttl));
        token
    }

    pub fn consume(&self, ticket: &str) -> Option<Claim> {
        let (claim, exp) = self
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(ticket)?;
        (exp > Instant::now()).then_some(claim)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c() -> Claim {
        Claim {
            account_id: "a".into(),
            credential_hash: "h".into(),
        }
    }

    #[test]
    fn one_shot_and_expiry() {
        let s = TicketStore::new(Duration::from_secs(30));
        let t = s.issue(c());
        assert!(t.starts_with("hrkt_") && t.len() == 5 + 43);
        assert_eq!(s.consume(&t), Some(c()));
        assert_eq!(s.consume(&t), None, "1회용");
        let s = TicketStore::new(Duration::from_millis(0));
        let t = s.issue(c());
        assert_eq!(s.consume(&t), None, "만료");
    }
}
