//! [`MentionHooks`] 실물 — 턴 임대 넘기기·놓기는 **그 에이전트 링크**(`AgentClients::link`)로 오퍼레이터에 알리고, 스케줄러 몫
//! (슬롯 놓기·턴 끝·결과·펜스·[중단] 시각·실행 파일 없음)은 부르는 쪽([`SchedulerHooks`])에 넘긴다.
//!
//! **턴 임대 토큰은 오퍼레이터 알림 한 길로만 간다** — 글·로그에 싣지 않는다(로그는 고정 문장, `TurnLease` 의 Debug 는 토큰을
//! 가린다). 놓을 때는 받은 멘션 id(cause)로 끝을 알린다(정본 `secretLeases.release(mention.id)` → `notifyEnded(cause)`).
//!
//! **임대를 쥐는 자리는 러너 수명의 [`LeaseBook`] 이다**(정본 `secretLeases` 의 `held` Map). 멘션 호출(deps)은 시도마다 새로 짓지만,
//! 재시도·계정 전환으로 같은 멘션이 다시 돌면 장부의 답을 그대로 쓴다 — 서버는 멘션당 한 번만 주고 끝난 멘션의 재청은 409
//! `lease_used` 다. 그래서 [`LinkHooks`] 의 `Drop` 은 **패닉 풀림 중일 때만** 놓는다 — 정상 길에서 놓을지는 결말(`settle`)이 정한다.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::link::LinkClient;
use crate::mention_deps::MentionHooks;
use crate::mention_settle::LeaseState;
use crate::rest::TurnLease;
use crate::secret_scrub::{scrub_needles, scrub_path};
use crate::turn_io::Timer;

/// 스케줄러가 쥔 일.
pub trait SchedulerHooks {
    /// 임대를 잃어 접힌 턴 — `thread_key` 는 그 멘션의 스레드 열쇠(`채널/앵커`). 받는 쪽이 그 스레드에 표지를 단다.
    fn notice_fenced(&mut self, thread_key: &str);
    fn turn_outcome(&mut self, ok: bool);
    fn stop_requested(&mut self, at: &str);
    fn executable_missing(&mut self);
    fn release_slot(&mut self, thread_key: &str);
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str);
}

/// 오퍼레이터에 턴 임대를 알리는 길(실물 `LinkClient`).
pub trait LeaseHandoff {
    fn lease(&self, cause: &str, lease_id: &str, token: &str, expires_at: &str);
    fn lease_ended(&self, cause: &str);
    /// 임대 늘리기 박동(정본 `notifyHeartbeat` → `relay.notifySecretLeaseHeartbeat`).
    fn heartbeat(&self, cause: &str);
}

impl LeaseHandoff for LinkClient {
    fn lease(&self, cause: &str, lease_id: &str, token: &str, expires_at: &str) {
        self.notify_secret_lease(cause, lease_id, token, expires_at);
    }
    fn lease_ended(&self, cause: &str) {
        self.notify_secret_lease_ended(cause);
    }
    fn heartbeat(&self, cause: &str) {
        self.notify_secret_lease_heartbeat(cause);
    }
}

/// 장부에 적힌 그 멘션의 답.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Booked {
    /// 받아서 오퍼레이터에 맡겼다(정본 `leaseId` 있음 → `'held'`).
    Held,
    /// 서버가 주지 않았다(정본 `leaseId: null` → `'none'`) — 재시도마다 다시 묻지 않는다.
    Declined,
}

/// 받은 임대의 수명 재료(정본 `secretLeases` 의 `beat`·`turnSecretsDir`).
pub struct LeaseLife {
    /// 박동 — 오퍼레이터에 임대 늘리기를 청한다(실물 `LinkClient::notify_secret_lease_heartbeat`). 실패는 다음 박동이 받는다.
    pub beat: Arc<dyn Fn(&str) + Send + Sync>,
    /// 박동 간격(정본 `LEASE_HEARTBEAT_MS` 4분 — 서버 갱신 폭 10분의 절반 아래).
    pub every: Duration,
    /// 오퍼레이터의 턴 비밀 폴더 뿌리 — `<뿌리>/<임대 id>/` 의 값으로 가림 바늘을 짓는다(정본 `needlesOf`).
    pub secrets_dir: Option<PathBuf>,
}

/// 정본 `LEASE_HEARTBEAT_MS`.
pub const LEASE_HEARTBEAT: Duration = Duration::from_secs(4 * 60);

/// 장부 한 칸 — 답, 박동 시계, 임대 id(바늘 짓기용, 토큰 아님), 이 멘션이 쓴 기록 파일.
struct Entry {
    booked: Booked,
    /// 받은 임대에만 선다. 칸이 빠지면(놓기·패닉 풀림) 떨어지며 멈춘다(`Timer` 의 Drop).
    beat: Option<Timer>,
    lease_id: Option<String>,
    transcripts: BTreeSet<PathBuf>,
}

/// 러너 수명의 턴 임대 장부(정본 `secretLeases` 의 `held`) — 멘션 id → 받은 답. 토큰은 적지 않는다.
/// 409·무응답은 적지 않는다(다음 시도가 다시 묻는다). 수명 재료([`LeaseLife`])가 있으면 받은 임대마다 박동을 걸고, 놓을 때
/// 이 멘션의 기록을 **가린 뒤** 끝을 알린다(정본 `release`: `scrub(h)` → `notifyEnded`).
#[derive(Default)]
pub struct LeaseBook {
    map: Mutex<HashMap<String, Entry>>,
    life: Option<LeaseLife>,
}

impl LeaseBook {
    pub fn with_life(life: LeaseLife) -> Self {
        Self {
            map: Mutex::default(),
            life: Some(life),
        }
    }
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        // 맵 조작 도중 패닉하지 않는다 — 독이 들어도 값은 쓸 만하다(놓기를 멈추면 임대가 남는다).
        self.map.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn get(&self, cause: &str) -> Option<Booked> {
        self.map().get(cause).map(|e| e.booked)
    }
    fn put(&self, cause: &str, b: Booked, lease_id: Option<&str>) {
        let beat = match (b, &self.life) {
            (Booked::Held, Some(l)) => {
                let (f, c) = (Arc::clone(&l.beat), cause.to_string());
                Some(Timer::every(l.every, move || {
                    f(&c);
                    true
                }))
            }
            _ => None,
        };
        self.map().insert(
            cause.to_string(),
            Entry {
                booked: b,
                beat,
                lease_id: lease_id.map(str::to_string),
                transcripts: BTreeSet::new(),
            },
        );
    }
    /// 이 멘션의 턴이 쓴 기록 파일을 적는다(정본 `noteTranscript`) — 놓을 때 가린다. 장부에 없는 멘션이면 버린다.
    pub fn note_transcript(&self, cause: &str, path: PathBuf) {
        if let Some(e) = self.map().get_mut(cause) {
            e.transcripts.insert(path);
        }
    }
    /// 칸을 빼고(박동은 여기서 멈춘다) 받은 임대였으면 기록을 가린다. 끝 알림을 보낼지(`Held` 였나) 돌려준다.
    /// 아직 장부에 남은 멘션(물러날 때 drain 시한이 지나도 남은 임대 — `main.rs` 가 놓는다).
    pub fn causes(&self) -> Vec<String> {
        self.map().keys().cloned().collect()
    }

    /// 부르는 쪽(`LinkHooks` 결말, 패닉 뒤 정리)이 `true` 면 끝을 알린다.
    pub fn release(&self, cause: &str) -> bool {
        let Some(mut e) = self.map().remove(cause) else {
            return false;
        };
        drop(e.beat.take());
        if e.booked != Booked::Held {
            return false;
        }
        self.scrub(&e);
        true
    }
    /// 정본 `scrub` — 임대 폴더의 값으로 바늘을 짓고 적어 둔 기록을 가린다. 실패는 로컬 로그(경로·건수만)이고 끝 알림을 막지 않는다.
    fn scrub(&self, e: &Entry) {
        let (Some(root), Some(id)) = (
            self.life.as_ref().and_then(|l| l.secrets_dir.as_ref()),
            e.lease_id.as_deref(),
        ) else {
            return;
        };
        if e.transcripts.is_empty() || id.is_empty() || id.contains('/') || id.contains("..") {
            return;
        }
        let needles = lease_needles(&root.join(id));
        if needles.is_empty() {
            return;
        }
        // 파일이면 그 파일, 폴더(claude 곁 `<sessionId>/` — tool-results·subagents)면 그 아래 일반 파일 전부(정본 `scrubPath`).
        for path in &e.transcripts {
            let t = scrub_path(
                path,
                &needles,
                &mut |p| {
                    eprintln!(
                        "[secretLeases] {}: 크기 상한을 넘어 가리지 않았다",
                        p.display()
                    )
                },
                &mut |p, err| {
                    eprintln!(
                        "[secretLeases] 기록 가리기 실패({}) — {:?}",
                        p.display(),
                        err.kind()
                    )
                },
            );
            if t.replaced > 0 {
                eprintln!(
                    "[secretLeases] {}: 비밀 값 {}곳을 가렸다",
                    path.display(),
                    t.replaced
                );
            }
        }
    }
    /// 그 멘션에 적힌 기록 경로(시험·진단용 — 값이 아니라 경로).
    pub fn transcripts(&self, cause: &str) -> Vec<PathBuf> {
        self.map()
            .get(cause)
            .map(|e| e.transcripts.iter().cloned().collect())
            .unwrap_or_default()
    }
    pub fn len(&self) -> usize {
        self.map().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// 임대 폴더의 값들로 바늘(긴 것부터). 값은 이 함수 밖으로 나가지 않는다 — 바늘만.
fn lease_needles(dir: &std::path::Path) -> Vec<String> {
    let mut set = BTreeSet::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for ent in rd.flatten() {
            if ent.file_type().is_ok_and(|t| t.is_file())
                && let Ok(v) = std::fs::read(ent.path())
            {
                set.extend(scrub_needles(&v));
            }
        }
    }
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort_by_key(|s| std::cmp::Reverse(s.len()));
    v
}

/// [`MentionHooks`] 실물.
pub struct LinkHooks<'a, O: LeaseHandoff, S: SchedulerHooks> {
    /// 그 에이전트 링크 — `AgentClients::link` 에서 받는다.
    pub operator: &'a O,
    /// 러너 수명의 임대 장부.
    pub book: &'a LeaseBook,
    pub scheduler: S,
    pub key: String,
    pub now: fn() -> u64,
    /// 이 호출이 장부에서 다룬 cause(멘션 id) — 놓을 때 쓴다. 토큰은 쥐지 않는다.
    cause: Option<String>,
}

impl<'a, O: LeaseHandoff, S: SchedulerHooks> LinkHooks<'a, O, S> {
    pub fn new(
        operator: &'a O,
        book: &'a LeaseBook,
        scheduler: S,
        key: String,
        now: fn() -> u64,
    ) -> Self {
        Self {
            operator,
            book,
            scheduler,
            key,
            now,
            cause: None,
        }
    }

    /// 장부에서 지우고, 받은 임대였으면 끝을 알린다(정본 `release` — 거절이었으면 알릴 것이 없다).
    fn end(&mut self) {
        // 박동 멈춤 → 기록 가리기 → 끝 알림(정본 차례).
        if let Some(cause) = self.cause.take()
            && self.book.release(&cause)
        {
            self.operator.lease_ended(&cause);
        }
    }
}

impl<O: LeaseHandoff, S: SchedulerHooks> MentionHooks for LinkHooks<'_, O, S> {
    fn now(&self) -> u64 {
        (self.now)()
    }
    fn prior_lease(&mut self, cause: &str) -> Option<LeaseState> {
        let b = self.book.get(cause)?;
        self.cause = Some(cause.to_string());
        Some(match b {
            Booked::Held => LeaseState::Ready,
            Booked::Declined => LeaseState::Declined,
        })
    }
    fn lease_issued(&mut self, cause: &str, lease: TurnLease) {
        self.operator
            .lease(cause, &lease.id, &lease.token, &lease.expires_at);
        self.book.put(cause, Booked::Held, Some(&lease.id));
        self.cause = Some(cause.to_string());
        self.log("턴 임대를 받아 오퍼레이터에 맡겼다");
    }
    fn lease_declined(&mut self, cause: &str) {
        self.book.put(cause, Booked::Declined, None);
        self.cause = Some(cause.to_string());
    }
    fn release_lease(&mut self) {
        self.end();
    }
    fn notice_fenced(&mut self) {
        // 열쇠는 `OnceRelease` 가 자기 `Launch` 열쇠로 갈아 싣는다.
        let key = self.key.clone();
        self.scheduler.notice_fenced(&key);
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.scheduler.turn_outcome(ok);
    }
    fn stop_requested(&mut self, at: &str) {
        self.scheduler.stop_requested(at);
    }
    fn executable_missing(&mut self) {
        self.scheduler.executable_missing();
    }
    fn release_slot(&mut self, thread_key: &str) {
        self.scheduler.release_slot(thread_key);
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        self.scheduler.turn_ended(thread_key, mention_id);
    }
    fn log(&mut self, line: &str) {
        eprintln!("[mentionScheduler] {}: {line}", self.key);
    }
}

impl<O: LeaseHandoff, S: SchedulerHooks> Drop for LinkHooks<'_, O, S> {
    /// **패닉 풀림 중일 때만** 놓는다 — `release_lease` 를 못 지난 멘션의 임대를 남기지 않는다(그 멘션은 다시 돌지 않는다).
    /// 정상 길에서는 놓지 않는다: 재시도 갈래는 장부가 임대를 쥐고 있어야 다음 시도가 다시 발급을 청하지 않는다(서버 409).
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.end();
        }
    }
}

#[cfg(test)]
#[path = "mention_hooks_tests.rs"]
mod tests;
