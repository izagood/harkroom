//! 고정 창(fixed window) 레이트 리미터 — TS `rateLimit.ts` `createRateLimiter` 와 같은 판정.
//!
//! **카운터는 프로세스 로컬이다**(TS 와 같다). Rust 와 TS 가 같은 경로를 나눠 받으면 상한이 둘로 갈라진다 —
//! 한 경로의 리밋을 옮길 때는 그 경로(그리고 같은 키를 쓰는 경로) 전부를 같이 옮긴다.
//!
//! 규칙·키(TS 와 같은 문자열):
//! - 주소 단위(`buildServer.ts` `LIMITED_ROUTES`): `"{rule}:{ip}"` — [`LOGIN`]·[`SIGNUP`]·[`TICKET`]·[`UPLOAD`]·[`PASSWORD_RESET`].
//! - `POST /auth/login`: `loginAccountIp:{loginKey}:{ip}` ([`LOGIN_ACCOUNT_IP`]) 먼저, 허용이면 `loginAccount:{loginKey}` ([`LOGIN_ACCOUNT`]).
//! - `POST /auth/password-reset/code`: `passwordReset:{loginKey}` ([`PASSWORD_RESET_ACCOUNT`]).
//! - `POST /auth/step-up`: `stepUp:{accountId}` ([`STEP_UP`]).
//! - `DELETE /account`: `accountDelete:{accountId}` ([`ACCOUNT_DELETE`]).
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub window_ms: u64,
    pub max: u32,
}

const MIN: u64 = 60_000;
/// TS `DEFAULT_RATE_LIMITS.login`.
pub const LOGIN: Rule = Rule {
    window_ms: 5 * MIN,
    max: 20,
};
/// TS `DEFAULT_RATE_LIMITS.loginAccountIp`.
pub const LOGIN_ACCOUNT_IP: Rule = Rule {
    window_ms: 15 * MIN,
    max: 10,
};
/// TS `DEFAULT_RATE_LIMITS.loginAccount`.
pub const LOGIN_ACCOUNT: Rule = Rule {
    window_ms: 15 * MIN,
    max: 50,
};
/// TS `DEFAULT_RATE_LIMITS.signup` (`/auth/register`·`/bootstrap`·`/claim`).
pub const SIGNUP: Rule = Rule {
    window_ms: 15 * MIN,
    max: 10,
};
/// TS `DEFAULT_RATE_LIMITS.ticket`.
pub const TICKET: Rule = Rule {
    window_ms: MIN,
    max: 120,
};
/// TS `DEFAULT_RATE_LIMITS.upload`.
pub const UPLOAD: Rule = Rule {
    window_ms: MIN,
    max: 20,
};
/// TS `DEFAULT_RATE_LIMITS.passwordReset` (`POST /auth/password-reset`, 주소 단위).
pub const PASSWORD_RESET: Rule = Rule {
    window_ms: 15 * MIN,
    max: 10,
};
/// TS `DEFAULT_RATE_LIMITS.passwordResetAccount` (로그인 ID 단위, 핸들러 안).
pub const PASSWORD_RESET_ACCOUNT: Rule = Rule {
    window_ms: 15 * MIN,
    max: 10,
};
/// TS `authRoutes.ts` `STEP_UP_RULE`.
pub const STEP_UP: Rule = Rule {
    window_ms: 15 * MIN,
    max: 10,
};
/// TS `accountDeletionRoutes.ts` `ACCOUNT_DELETE_RULE`.
pub const ACCOUNT_DELETE: Rule = Rule {
    window_ms: 15 * MIN,
    max: 10,
};

/// TS `LIMITED_ROUTES` — 주소 단위 리밋을 거는 (메서드, 경로, 규칙 이름, 규칙). 키는 `"{이름}:{ip}"`.
pub const LIMITED_ROUTES: &[(&str, &str, &str, Rule)] = &[
    ("POST", "/auth/login", "login", LOGIN),
    ("POST", "/auth/register", "signup", SIGNUP),
    ("POST", "/bootstrap", "signup", SIGNUP),
    ("POST", "/claim", "signup", SIGNUP),
    ("POST", "/ws-ticket", "ticket", TICKET),
    ("POST", "/uploads", "upload", UPLOAD),
    (
        "POST",
        "/auth/password-reset",
        "passwordReset",
        PASSWORD_RESET,
    ),
];

/// TS `RATE_LIMIT_MAX_KEYS`.
pub const MAX_KEYS: usize = 50_000;
/// TS `SWEEP_EVERY_MS`.
const SWEEP_EVERY_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    pub allowed: bool,
    /// 거절일 때 기다릴 시간. 허용이면 0.
    pub retry_after_ms: u64,
}

struct Window {
    count: u32,
    reset_at: u64,
    /// 넣은 순서(TS Map 의 삽입 순서) — 같은 키가 지워졌다 다시 들어오면 새 번호다.
    seq: u64,
}

struct Inner {
    windows: HashMap<String, Window>,
    /// 삽입 순서 (seq, key). 지워진 키·오래된 seq 는 꺼낼 때 건너뛴다.
    order: VecDeque<(u64, String)>,
    next_seq: u64,
    next_sweep_at: u64,
}

pub struct RateLimiter {
    inner: Mutex<Inner>,
    max_keys: usize,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(Box::new(epoch_ms), MAX_KEYS)
    }
}

impl RateLimiter {
    /// 시계를 주입받는다 — 창 만료를 sleep 없이 시험한다.
    pub fn new(now: Box<dyn Fn() -> u64 + Send + Sync>, max_keys: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                windows: HashMap::new(),
                order: VecDeque::new(),
                next_seq: 0,
                next_sweep_at: 0,
            }),
            max_keys,
            now,
        }
    }

    /// TS `hit(key, rule)`.
    pub fn hit(&self, key: &str, rule: Rule) -> Verdict {
        let t = (self.now)();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let inner = &mut *g;
        if t >= inner.next_sweep_at {
            inner.windows.retain(|_, w| w.reset_at > t);
            let windows = &inner.windows;
            inner
                .order
                .retain(|(s, k)| windows.get(k).is_some_and(|w| w.seq == *s));
            inner.next_sweep_at = t + SWEEP_EVERY_MS;
        }
        if inner.windows.get(key).is_some_and(|w| w.reset_at <= t) {
            inner.windows.remove(key);
        }
        if let Some(w) = inner.windows.get_mut(key) {
            if w.count < rule.max {
                w.count += 1;
                return Verdict {
                    allowed: true,
                    retry_after_ms: 0,
                };
            }
            return Verdict {
                allowed: false,
                retry_after_ms: (w.reset_at - t).max(1),
            };
        }
        while inner.windows.len() >= self.max_keys {
            let Some((s, k)) = inner.order.pop_front() else {
                break;
            };
            if inner.windows.get(&k).is_some_and(|w| w.seq == s) {
                inner.windows.remove(&k);
            }
        }
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.windows.insert(
            key.to_owned(),
            Window {
                count: 1,
                reset_at: t + rule.window_ms,
                seq,
            },
        );
        inner.order.push_back((seq, key.to_owned()));
        inner.next_sweep_at = inner.next_sweep_at.min(t + rule.window_ms);
        Verdict {
            allowed: true,
            retry_after_ms: 0,
        }
    }

    /// TS `reset(key)` — 성공한 로그인이 그 계정의 실패 수를 비운다.
    pub fn reset(&self, key: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.windows.remove(key);
    }

    /// TS `size()`.
    pub fn size(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .windows
            .len()
    }
}

/// 429 응답. `with_body_secs` 는 본문에도 `retryAfterSec` 를 싣는 경로(step-up·재설정 코드)다.
/// - 주소 단위·로그인 계정 단위: `retry-after = ceil(ms/1000)`, 본문 `{error:{code,message}}`.
/// - step-up·재설정 코드: `retryAfterSec = max(1, ceil(ms/1000))` 를 헤더와 본문 둘 다에.
pub fn too_many(verdict: Verdict, with_body_secs: bool) -> Response {
    let ceil = verdict.retry_after_ms.div_ceil(1000);
    let (secs, body) = if with_body_secs {
        let s = ceil.max(1);
        (
            s,
            serde_json::json!({ "error": { "code": "rate_limited", "message": "too many attempts, try again later", "retryAfterSec": s } }),
        )
    } else {
        (
            ceil,
            serde_json::json!({ "error": { "code": "rate_limited", "message": "too many attempts, try again later" } }),
        )
    };
    let mut res = (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body.to_string(),
    )
        .into_response();
    res.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(secs));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn limiter(max_keys: usize) -> (RateLimiter, Arc<AtomicU64>) {
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let c = clock.clone();
        (
            RateLimiter::new(Box::new(move || c.load(Ordering::SeqCst)), max_keys),
            clock,
        )
    }

    const R: Rule = Rule {
        window_ms: 1000,
        max: 3,
    };

    #[test]
    fn allows_max_then_blocks_until_window_end() {
        let (l, clock) = limiter(MAX_KEYS);
        for _ in 0..3 {
            assert!(l.hit("k", R).allowed);
        }
        clock.fetch_add(400, Ordering::SeqCst);
        assert_eq!(
            l.hit("k", R),
            Verdict {
                allowed: false,
                retry_after_ms: 600
            }
        );
        clock.fetch_add(600, Ordering::SeqCst);
        assert!(l.hit("k", R).allowed, "new window");
    }

    #[test]
    fn keys_are_independent_and_reset_clears() {
        let (l, _) = limiter(MAX_KEYS);
        for _ in 0..3 {
            l.hit("a", R);
        }
        assert!(!l.hit("a", R).allowed);
        assert!(l.hit("b", R).allowed);
        l.reset("a");
        assert!(l.hit("a", R).allowed);
    }

    #[test]
    fn evicts_oldest_over_max_keys() {
        let (l, _) = limiter(2);
        for _ in 0..3 {
            l.hit("a", R);
        }
        l.hit("b", R);
        l.hit("c", R); // evicts "a"
        assert_eq!(l.size(), 2);
        assert!(l.hit("a", R).allowed, "evicted key counts from 1 again");
    }

    #[test]
    fn sweeps_expired_keys() {
        let (l, clock) = limiter(MAX_KEYS);
        l.hit("a", R);
        l.hit("b", R);
        clock.fetch_add(1000, Ordering::SeqCst);
        l.hit("c", R);
        assert_eq!(l.size(), 1);
    }

    #[test]
    fn too_many_shapes() {
        let v = Verdict {
            allowed: false,
            retry_after_ms: 1,
        };
        let r = too_many(v, false);
        assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(r.headers()[header::RETRY_AFTER], "1");
        let r = too_many(
            Verdict {
                allowed: false,
                retry_after_ms: 0,
            },
            true,
        );
        assert_eq!(r.headers()[header::RETRY_AFTER], "1");
    }
}
