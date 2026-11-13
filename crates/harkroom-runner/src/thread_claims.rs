//! 스레드 임대 실물(L2a) — 정본 `packages/agent/src/threadClaims.ts` 이식. 러너 사이의 스레드 잠금이다: 턴을 띄우기 전에 서버에서
//! (에이전트, 스레드) 임대를 잡고, 턴 동안 박동으로 밀고, 다른 러너가 넘겨받으면(박동 409) 잃음을 알린다.
//!
//! - **holder 는 이 러너 프로세스다**(기동 때 지은 무작위 id) — 같은 에이전트 러너 둘을 가른다.
//! - **한 프로세스 안에서도 스레드당 하나다.** 놓기가 끝나기 전에 같은 스레드를 다시 잡으면 앞 턴의 놓기가 뒤 턴의 임대를
//!   지운다(같은 holder) — 그래서 놓기가 끝날 때까지 `Busy`.
//! - **잃으면 접는다**(펜스): 박동이 `Taken` 을 받으면 표지(`fenced`)가 서고(다시 내려가지 않는다) 박동이 멈추며, 걸어 둔
//!   알림(`on_lost` — L2b 가 그 멘션 슬롯의 `fence_lost` 로 잇는다, #2042·#2071 길)을 한 번 부른다. 일시 오류(링크·5xx)로는
//!   울리지 않는다 — 잃었는지 모르는 것이지 잃은 것이 아니다.
//! - **확인하지 못하면 띄우지 않는다**(fail-closed): 잡기 오류는 `Busy`(다음 폴에 다시 묻는다). 옛 서버(404)는 임대가 없는
//!   것이라 잃을 일 없는 손잡이를 준다.
//! - **놓기는 날아가는 박동을 기다린다**(같은 잠금) — 놓은 뒤 도착한 박동이 임대를 되살리지 않게. 손잡이가 떨어지면(패닉
//!   풀림 포함) 놓는다(Drop 가드). 놓기 실패는 로그만 — 만료(`ttl`)가 놓는다.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::mention_admit::{ClaimHold, ThreadClaimHandle};
use crate::rest::{ClaimOutcome, HarkroomRestClient, RunnerLink};
use crate::turn_io::Timer;

/// 정본 `THREAD_CLAIM_TTL_SEC` — 러너가 죽은 뒤 넘겨받기까지의 상한.
pub const THREAD_CLAIM_TTL_SEC: u64 = 90;
/// 정본 `THREAD_CLAIM_HEARTBEAT_MS` — 만료의 1/3.
pub const THREAD_CLAIM_HEARTBEAT: Duration = Duration::from_secs(30);

/// 임대 서버 길(실물 [`HarkroomRestClient`]).
pub trait ClaimClient: Send + Sync {
    /// 잡기와 박동이 같은 호출이다. 링크·서버 오류는 `Err`.
    fn claim(
        &self,
        channel_id: &str,
        root: &str,
        holder: &str,
        ttl_sec: u64,
    ) -> Result<ClaimOutcome, String>;
    /// 멱등. 오류는 `Err`(만료가 대신 놓는다).
    fn release(&self, channel_id: &str, root: &str, holder: &str) -> Result<(), String>;
}

impl<L: RunnerLink> ClaimClient for HarkroomRestClient<L> {
    fn claim(
        &self,
        channel_id: &str,
        root: &str,
        holder: &str,
        ttl_sec: u64,
    ) -> Result<ClaimOutcome, String> {
        self.claim_thread(channel_id, root, holder, ttl_sec)
            .map_err(|e| e.to_string())
    }
    fn release(&self, channel_id: &str, root: &str, holder: &str) -> Result<(), String> {
        self.release_thread(channel_id, root, holder)
            .map_err(|e| e.to_string())
    }
}

/// 잃었을 때 부를 알림.
pub type OnLost = Arc<dyn Fn() + Send + Sync>;

/// 러너 수명의 스레드 임대 묶음.
pub struct ThreadClaims<C: ClaimClient + 'static> {
    client: Arc<C>,
    holder: String,
    ttl_sec: u64,
    heartbeat: Duration,
    held: Arc<Mutex<HashSet<String>>>,
    warned_unsupported: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl<C: ClaimClient + 'static> ThreadClaims<C> {
    pub fn new(client: Arc<C>, holder: String) -> Self {
        Self::with_timing(client, holder, THREAD_CLAIM_TTL_SEC, THREAD_CLAIM_HEARTBEAT)
    }

    pub fn with_timing(client: Arc<C>, holder: String, ttl_sec: u64, heartbeat: Duration) -> Self {
        Self {
            client,
            holder,
            ttl_sec,
            heartbeat,
            held: Arc::default(),
            warned_unsupported: AtomicBool::new(false),
        }
    }

    /// 정본 `hold` — 잡았으면 손잡이(`Held`), 남이 쥐었거나 확인하지 못했거나 이 프로세스가 아직 쥐고(놓고) 있으면 `Busy`.
    pub fn hold(&self, channel_id: &str, root: &str, on_lost: Option<OnLost>) -> ClaimHold {
        let key = format!("{channel_id}/{root}");
        if !lock(&self.held).insert(key.clone()) {
            return ClaimHold::Busy;
        }
        let outcome = match self
            .client
            .claim(channel_id, root, &self.holder, self.ttl_sec)
        {
            Ok(o) => o,
            Err(e) => {
                lock(&self.held).remove(&key);
                eprintln!(
                    "[threadClaims] {key}: 임대를 확인하지 못했다 — 이번 폴에는 띄우지 않는다({e})"
                );
                return ClaimHold::Busy;
            }
        };
        match outcome {
            ClaimOutcome::Taken => {
                lock(&self.held).remove(&key);
                ClaimHold::Busy
            }
            ClaimOutcome::Unsupported => {
                lock(&self.held).remove(&key);
                if !self.warned_unsupported.swap(true, Ordering::SeqCst) {
                    eprintln!(
                        "[threadClaims] 서버가 스레드 임대를 모른다(옛 서버) — 이 러너 안의 스레드 잠금만으로 띄운다"
                    );
                }
                ClaimHold::Held(Box::new(NoClaim))
            }
            ClaimOutcome::Held => {
                ClaimHold::Held(Box::new(self.start(key, channel_id, root, on_lost)))
            }
        }
    }

    fn start(
        &self,
        key: String,
        channel_id: &str,
        root: &str,
        on_lost: Option<OnLost>,
    ) -> HeldClaim<C> {
        let shared = Arc::new(Shared {
            client: Arc::clone(&self.client),
            channel_id: channel_id.to_string(),
            root: root.to_string(),
            holder: self.holder.clone(),
            key,
            released: AtomicBool::new(false),
            lost: AtomicBool::new(false),
            wire: Mutex::new(()),
            held: Arc::clone(&self.held),
        });
        let (s, ttl) = (Arc::clone(&shared), self.ttl_sec);
        let timer = Timer::every(self.heartbeat, move || {
            // 놓기와 같은 잠금 — 박동이 날아가는 동안에는 놓지 않고, 놓은 뒤에는 박동하지 않는다.
            let _wire = lock(&s.wire);
            if s.released.load(Ordering::SeqCst) {
                return false;
            }
            match s.client.claim(&s.channel_id, &s.root, &s.holder, ttl) {
                Ok(ClaimOutcome::Taken) => {
                    if !s.lost.swap(true, Ordering::SeqCst) {
                        eprintln!(
                            "[threadClaims] {}: 임대를 잃었다 — 박동이 끊긴 사이 다른 러너가 넘겨받았다. 이 턴을 접는다",
                            s.key
                        );
                        if let Some(f) = &on_lost {
                            f();
                        }
                    }
                    false
                }
                // 일시 오류는 다음 박동이 민다(만료 전에 두 번 더).
                _ => true,
            }
        });
        HeldClaim {
            shared,
            timer: Mutex::new(Some(timer)),
        }
    }

    /// 이 프로세스가 쥐고(또는 놓고) 있는 스레드 수(진단·시험용).
    pub fn held_count(&self) -> usize {
        lock(&self.held).len()
    }
}

struct Shared<C: ClaimClient> {
    client: Arc<C>,
    channel_id: String,
    root: String,
    holder: String,
    key: String,
    released: AtomicBool,
    lost: AtomicBool,
    /// 박동과 놓기를 한 줄로 세운다.
    wire: Mutex<()>,
    held: Arc<Mutex<HashSet<String>>>,
}

/// 잡은 임대의 손잡이.
pub struct HeldClaim<C: ClaimClient> {
    shared: Arc<Shared<C>>,
    timer: Mutex<Option<Timer>>,
}

impl<C: ClaimClient> ThreadClaimHandle for HeldClaim<C> {
    fn release(&self) {
        let s = &self.shared;
        if s.released.swap(true, Ordering::SeqCst) {
            return;
        }
        // 박동을 멈추고, 날아가는 박동이 끝나기를 기다린 뒤 놓는다.
        drop(lock(&self.timer).take());
        let _wire = lock(&s.wire);
        if let Err(e) = s.client.release(&s.channel_id, &s.root, &s.holder) {
            eprintln!("[threadClaims] {}: 놓기 실패 — 만료가 놓는다({e})", s.key);
        }
        lock(&s.held).remove(&s.key);
    }
    fn fenced(&self) -> bool {
        self.shared.lost.load(Ordering::SeqCst)
    }
}

impl<C: ClaimClient> Drop for HeldClaim<C> {
    /// 놓기를 잊거나 패닉으로 풀려도 놓는다 — 놓지 않으면 같은 스레드가 이 프로세스에서 영영 `Busy` 다.
    fn drop(&mut self) {
        self.release();
    }
}

/// 옛 서버 — 잃을 임대가 없다.
struct NoClaim;

impl ThreadClaimHandle for NoClaim {
    fn release(&self) {}
}

#[cfg(test)]
#[path = "thread_claims_tests.rs"]
mod tests;
