//! 서버 링크 상태(안 A) — 오퍼레이터가 서버에 붙어 있는지·왜 못 붙는지를 앱에 알린다.
//!
//! 링크 고리(`server_link`)의 열림·닫힘·다음 시도 예정을 받아 한 장의 상태로 접는다. 앱은 `serverLinkState`
//! 이벤트(바뀔 때마다)와 `serverLinkGet`(끊긴 도중에 앱이 켜졌을 때 첫 값)으로 받는다.
//! **원문 오류는 싣지 않는다** — 까닭은 [`classify_failure`](crate::ws_dialer::classify_failure) 의 낱말 하나뿐이다.
use serde_json::{Value, json};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkReason {
    Dns,
    Offline,
    Closed,
    Refused,
    Tls,
    Auth,
    Other,
}

impl LinkReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkReason::Dns => "dns",
            LinkReason::Offline => "offline",
            LinkReason::Closed => "closed",
            LinkReason::Refused => "refused",
            LinkReason::Tls => "tls",
            LinkReason::Auth => "auth",
            LinkReason::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkSnapshot {
    pub up: bool,
    pub reason: Option<LinkReason>,
    pub close_code: Option<u16>,
    pub host: String,
    pub down_since_ms: Option<u64>,
    pub last_up_ms: Option<u64>,
    pub attempts: u32,
    pub next_retry_at_ms: Option<u64>,
}

impl LinkSnapshot {
    pub fn to_json(&self) -> Value {
        json!({
            "state": if self.up { "up" } else { "down" },
            "reason": self.reason.map(LinkReason::as_str),
            "closeCode": self.close_code,
            "host": self.host,
            "downSinceMs": self.down_since_ms,
            "lastUpMs": self.last_up_ms,
            "attempts": self.attempts,
            "nextRetryAtMs": self.next_retry_at_ms,
        })
    }
}

/// `base_url`(`https://host[:port]/…`)에서 호스트만 떼어 낸다 — 경로·포트·사용자 정보는 싣지 않는다.
pub fn host_of(base_url: &str) -> String {
    let rest = base_url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(base_url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    if let Some(v6) = authority.strip_prefix('[') {
        return v6.split(']').next().unwrap_or("").to_string();
    }
    authority.split(':').next().unwrap_or("").to_string()
}

/// 링크 상태 한 장. 처음은 「아직 못 붙음」(down, 까닭 없음, 시작 시각부터)이다 — 앱은 60초 안의 끊김을 정상으로 둔다.
pub struct LinkState {
    inner: Mutex<LinkSnapshot>,
}

impl LinkState {
    pub fn new(base_url: &str, now_ms: u64) -> Self {
        Self {
            inner: Mutex::new(LinkSnapshot {
                up: false,
                reason: None,
                close_code: None,
                host: host_of(base_url),
                down_since_ms: Some(now_ms),
                last_up_ms: None,
                attempts: 0,
                next_retry_at_ms: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LinkSnapshot> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> LinkSnapshot {
        self.lock().clone()
    }

    /// 붙었다.
    pub fn opened(&self, now_ms: u64) -> LinkSnapshot {
        let mut s = self.lock();
        s.up = true;
        s.reason = None;
        s.close_code = None;
        s.down_since_ms = None;
        s.last_up_ms = Some(now_ms);
        s.attempts = 0;
        s.next_retry_at_ms = None;
        s.clone()
    }

    /// 끊겼거나 접속에 실패했다. 끊긴 시작 시각은 처음 끊긴 때를 지킨다.
    pub fn failed(&self, now_ms: u64, reason: LinkReason, close_code: Option<u16>) -> LinkSnapshot {
        let mut s = self.lock();
        if s.up {
            s.up = false;
            s.down_since_ms = Some(now_ms);
            s.attempts = 0;
            // 붙어 있던 연결이 끊긴 것 — 붙어 있던 마지막 순간을 남긴다.
            s.last_up_ms = Some(now_ms);
        }
        s.attempts = s.attempts.saturating_add(1);
        s.reason = Some(reason);
        s.close_code = close_code;
        s.next_retry_at_ms = None;
        s.clone()
    }

    /// 다음 접속 시도 예정.
    pub fn waiting(&self, at_ms: u64) -> LinkSnapshot {
        let mut s = self.lock();
        s.next_retry_at_ms = Some(at_ms);
        s.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_only_no_port_path_or_userinfo() {
        assert_eq!(host_of("https://one.example.com/"), "one.example.com");
        assert_eq!(
            host_of("https://one.example.com:8443/sub?x"),
            "one.example.com"
        );
        assert_eq!(host_of("http://127.0.0.1:3400"), "127.0.0.1");
        assert_eq!(host_of("https://u:p@one.example.com"), "one.example.com");
        assert_eq!(host_of("http://[::1]:9/"), "::1");
    }

    #[test]
    fn down_since_keeps_first_failure_and_open_resets() {
        let st = LinkState::new("https://one.example.com", 100);
        let s = st.failed(200, LinkReason::Dns, None);
        assert_eq!((s.up, s.down_since_ms, s.attempts), (false, Some(100), 1));
        assert_eq!(st.waiting(1_200).next_retry_at_ms, Some(1_200));
        let s = st.failed(1_300, LinkReason::Offline, None);
        assert_eq!(
            (s.down_since_ms, s.attempts, s.next_retry_at_ms),
            (Some(100), 2, None)
        );
        let s = st.opened(2_000);
        assert_eq!(
            (s.up, s.down_since_ms, s.attempts, s.last_up_ms),
            (true, None, 0, Some(2_000))
        );
        assert_eq!(s.reason, None);
        let s = st.failed(9_000, LinkReason::Closed, Some(1006));
        assert_eq!(
            (s.down_since_ms, s.last_up_ms, s.attempts, s.close_code),
            (Some(9_000), Some(9_000), 1, Some(1006))
        );
        let j = s.to_json();
        assert_eq!(j["state"], "down");
        assert_eq!(j["reason"], "closed");
        assert_eq!(j["host"], "one.example.com");
        assert_eq!(j["closeCode"], 1006);
    }
}
