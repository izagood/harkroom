//! 입력 중(TS `ws/typing.ts`) — 채널마다 (계정 → 만료 시각). 기본 수명 6초(클라이언트가 3초마다 갱신).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Typing {
    ttl: Duration,
    by_channel: Mutex<HashMap<String, HashMap<String, Instant>>>,
}

impl Typing {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            by_channel: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, Instant>>> {
        self.by_channel.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn mark(&self, channel: &str, account: &str) {
        self.lock()
            .entry(channel.into())
            .or_default()
            .insert(account.into(), Instant::now() + self.ttl);
    }

    pub fn clear(&self, channel: &str, account: &str) {
        let mut m = self.lock();
        if let Some(seen) = m.get_mut(channel) {
            seen.remove(account);
            if seen.is_empty() {
                m.remove(channel);
            }
        }
    }

    /// 계정이 들어 있던 채널(지우기 전) — 소켓이 닫힐 때 그 채널에만 다시 알린다.
    pub fn forget(&self, account: &str) -> Vec<String> {
        let mut m = self.lock();
        let mut out = vec![];
        m.retain(|ch, seen| {
            if seen.remove(account).is_some() {
                out.push(ch.clone());
            }
            !seen.is_empty()
        });
        out
    }

    /// 지금 입력 중인 계정(만료된 것은 치운다).
    pub fn who(&self, channel: &str) -> Vec<String> {
        let now = Instant::now();
        let mut m = self.lock();
        let Some(seen) = m.get_mut(channel) else {
            return vec![];
        };
        seen.retain(|_, exp| *exp > now);
        let mut v: Vec<String> = seen.keys().cloned().collect();
        if seen.is_empty() {
            m.remove(channel);
        }
        v.sort();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_clear_forget_expire() {
        let t = Typing::new(Duration::from_secs(6));
        t.mark("c", "a");
        t.mark("c", "b");
        t.mark("d", "a");
        assert_eq!(t.who("c"), ["a", "b"]);
        t.clear("c", "b");
        assert_eq!(t.who("c"), ["a"]);
        let mut gone = t.forget("a");
        gone.sort();
        assert_eq!(gone, ["c", "d"]);
        assert!(t.who("c").is_empty());
        let t = Typing::new(Duration::from_millis(0));
        t.mark("c", "a");
        assert!(t.who("c").is_empty(), "만료");
    }
}
