//! 폴 루프(B4-1a). 정본은 `main.ts` 의 `while (running)` 루프와 그 둘레 — `stop.ts`(종료 요청 판정)·
//! `idleStop.ts`(빈 폴의 종료 요청)·`stoppableSleep.ts`·이관 보류(`HARKROOM_HANDOVER_HOLD`/`_DONE`)·
//! `applySelfRename`.
//!
//! 멘션을 턴으로 바꾸는 판단(유예·자리·재시도·계정 축)은 [`Scheduler`] 뒤에 있다 — 정본 `mentionScheduler.ts` 는
//! B4-1b 에서 옮긴다. 이 루프가 아는 것은 「폴 → 배치 맥락 → admit → 쉼」과 물러나는 순서뿐이다.
//!
//! 물러나는 순서(정본과 같다): 플래그를 끈다 → 루프가 지금 배치를 끝내고 빠져나온다 → **그 순간** 쥔 entry·
//! 끝냈지만 읽음 못 한 entry 를 오퍼레이터에 알린다(`runner.pollStopped`) → 도는 턴을 기다린다(`drain`).
//! 시그널 핸들러에서 알리면 거짓말이 된다 — 그때는 배치 하나가 아직 새 항목을 집을 수 있다.

use crate::rest::HarkroomError;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// 폴 자체의 transport 실패 백오프 시작값. 턴 실패는 스케줄러가 entry 별로 쉰다.
pub const POLL_BACKOFF_START_MS: u64 = 1_000;
/// 아무것도 새로 못 띄웠는데 유예·막힘이 있으면 쉬는 시간 — 턴 하나가 끝난 뒤 대기 멘션이 시작되기까지의 최대 지연.
pub const IDLE_ADMIT_SLEEP_MS: u64 = 5_000;
/// 이관 보류의 백스톱. 오퍼레이터의 `handover.released` 가 영영 안 올 때만 쓰인다(턴 예산과 같은 30분).
pub const HANDOVER_HOLD_MS: i64 = 30 * 60_000;

/// 정본 `stopRequestedForRunner`(#129) — 내 기동 시각보다 **나중에** 온 요청만 나를 향한 것이다.
/// 파싱할 수 없는 값은 요청으로 보지 않는다(종료는 되돌리는 데 사람 손이 필요하다).
/// `…Z` 꼴과 `±HH:MM` 꼴을 읽는다 — 서버는 `toISOString`(`…Z`)으로 쓰지만, 꼴이 바뀌어 못 읽으면 러너가 종료
/// 요청을 못 보고 계속 돈다(끄는 장치라 실패 방향이 반대다, #1965 security 낮음).
pub fn stop_requested_for_runner(stop_requested_at: Option<&str>, started_at_ms: i64) -> bool {
    match stop_requested_at.and_then(parse_iso_offset_ms) {
        Some(at) => at > started_at_ms,
        None => false,
    }
}

/// ISO 시각을 epoch ms 로 — `…Z` 는 [`crate::omp_home::parse_iso_utc_ms`], `…±HH:MM` 은 그 차이만큼 되돌린다.
pub fn parse_iso_offset_ms(s: &str) -> Option<i64> {
    if s.ends_with('Z') {
        return crate::omp_home::parse_iso_utc_ms(s);
    }
    let split = s.len().checked_sub(6)?;
    let (head, off) = (s.get(..split)?, s.get(split..)?);
    let b = off.as_bytes();
    let sign = match b[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    if b[3] != b':' || !b[1..3].iter().chain(&b[4..6]).all(u8::is_ascii_digit) {
        return None;
    }
    let (h, m): (i64, i64) = (off[1..3].parse().ok()?, off[4..6].parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let utc = crate::omp_home::parse_iso_utc_ms(&format!("{head}Z"))?;
    Some(utc - sign * (h * 60 + m) * 60_000)
}

/// 정본 `idleStopRequestedAt` — 빈 폴 응답에 `stopRequestedAt` **키가 있으면**(값이 `null` 이어도) 그것을 쓰고
/// 정의를 읽지 않는다. 키가 없으면(옛 서버) 정의를 읽는다. `null` 과 「키 없음」을 섞으면 옛 서버의 러너가 종료
/// 요청을 영영 못 본다.
pub fn idle_stop_requested_at(
    batch: &Value,
    read_definition: impl FnOnce() -> Result<Value, HarkroomError>,
) -> Result<Option<String>, HarkroomError> {
    if let Some(v) = batch.get("stopRequestedAt") {
        return Ok(v.as_str().map(str::to_string));
    }
    let def = read_definition()?;
    Ok(def
        .get("stopRequestedAt")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// `HARKROOM_HANDOVER_HOLD`·`_DONE` 의 쉼표 목록 → 양의 정수 entry id. 그 밖의 조각은 버린다.
pub fn parse_entry_ids(s: Option<&str>) -> HashSet<i64> {
    s.unwrap_or("")
        .split(',')
        .filter_map(|t| t.trim().parse::<i64>().ok())
        .filter(|n| *n > 0)
        .collect()
}

/// 이관 보류 — 앞 세대 러너가 아직 들고 있는 entry. **푸는 것은 오퍼레이터다**(`handover.released`).
/// 시한은 백스톱이다: 지나면 남은 항목을 평범한 멘션으로 다시 본다(늦어질지언정 잃지 않는다).
pub struct HandoverHold {
    held: Mutex<HashSet<i64>>,
    until_ms: i64,
}

impl HandoverHold {
    pub fn new(held: HashSet<i64>, now_ms: i64) -> Self {
        Self {
            held: Mutex::new(held),
            until_ms: now_ms + HANDOVER_HOLD_MS,
        }
    }

    /// 지금 건너뛸 entry. 백스톱 시한이 지났으면 비우고 빈 집합을 돌려준다.
    pub fn held_entry_ids(&self, now_ms: i64) -> HashSet<i64> {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        if !held.is_empty() && now_ms > self.until_ms {
            eprintln!(
                "[main] 이관 보류 백스톱 시한이 지났다 — 오퍼레이터의 해제가 안 왔다. 남은 항목을 평범한 멘션으로 다시 본다"
            );
            held.clear();
        }
        held.clone()
    }

    /// 오퍼레이터가 「앞 러너가 물러났다」고 알렸다 — 정상 경로.
    pub fn release(&self) {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        if !held.is_empty() {
            eprintln!("[main] 오퍼레이터가 이관 보류를 풀었다 — 앞 러너가 물러났다");
            held.clear();
        }
    }
}

/// 종료 신호에 깨는 sleep(정본 `createStoppableSleep`). `wake` 는 **지금 자는 것**만 깨운다 —
/// 깨운 뒤의 sleep 은 다시 끝까지 잔다(루프는 `running` 플래그로 빠져나간다).
#[derive(Default)]
pub struct StoppableSleep {
    generation: Mutex<u64>,
    cv: Condvar,
}

impl StoppableSleep {
    pub fn new() -> Self {
        Self::default()
    }

    /// `ms` 동안 잔다. 다 잤으면 `true`, `wake` 로 깼으면 `false`.
    pub fn sleep(&self, ms: u64) -> bool {
        let g = self.generation.lock().unwrap_or_else(|p| p.into_inner());
        let start = *g;
        let (_g, res) = self
            .cv
            .wait_timeout_while(g, Duration::from_millis(ms), |cur| *cur == start)
            .unwrap_or_else(|p| p.into_inner());
        res.timed_out()
    }

    pub fn wake(&self) {
        let mut g = self.generation.lock().unwrap_or_else(|p| p.into_inner());
        *g = g.wrapping_add(1);
        self.cv.notify_all();
    }
}

/// 내 계정(`me`). handle 은 배치마다 따라간다(#847) — 판정은 전부 id 라 틀리는 것은 말뿐이었다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Me {
    pub id: String,
    pub handle: String,
}

/// 정본 `applySelfRename` — 계정 목록에서 내 handle 이 바뀌었으면 고치고 옛 이름을 돌려준다.
/// 객체를 갈아끼우지 않고 필드를 고친다(`me` 를 쥔 자리가 여럿이다).
pub fn apply_self_rename(me: &mut Me, accounts: &[Value]) -> Option<String> {
    let mine = accounts
        .iter()
        .find(|a| a.get("id").and_then(Value::as_str) == Some(me.id.as_str()))?;
    let handle = mine.get("handle").and_then(Value::as_str)?;
    if handle == me.handle {
        return None;
    }
    Some(std::mem::replace(&mut me.handle, handle.to_string()))
}

/// 배치 단위로 한 번 받는 맥락(정본 `BatchContext`). 채널 이름·계정 handle 은 턴마다 바뀌지 않는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BatchContext {
    pub channel_names: HashMap<String, String>,
    pub handles: HashMap<String, String>,
    pub agent_ids: HashSet<String>,
    pub human_ids: HashSet<String>,
}

impl BatchContext {
    pub fn new(channels: &[(String, String)], accounts: &[Value]) -> Self {
        let mut ctx = Self {
            channel_names: channels.iter().cloned().collect(),
            ..Self::default()
        };
        for a in accounts {
            let Some(id) = a.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(h) = a.get("handle").and_then(Value::as_str) {
                ctx.handles.insert(id.to_string(), h.to_string());
            }
            match a.get("kind").and_then(Value::as_str) {
                Some("agent") => {
                    ctx.agent_ids.insert(id.to_string());
                }
                Some("human") => {
                    ctx.human_ids.insert(id.to_string());
                }
                _ => {}
            }
        }
        ctx
    }

    /// 채널 이름. 모르는 채널(DM)은 `dm`.
    pub fn channel_name(&self, channel_id: &str) -> &str {
        self.channel_names
            .get(channel_id)
            .map(String::as_str)
            .unwrap_or("dm")
    }
}

/// 배치 하나를 받아들인 결과(정본 `admit` 의 돌려준 값).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AdmitOutcome {
    pub started: usize,
    pub deferred: usize,
    pub blocked: usize,
}

/// 서버로 가는 길(정본 `HarkroomAgentClient` 중 루프가 쓰는 몫).
pub trait PollSource {
    /// `inbox.poll` 롱폴. `holding` 은 도는 턴이 쥔 entry(inbox 임대) — 서버가 다시 내주지 않는다.
    fn poll(&self, holding: &[i64]) -> Result<Value, HarkroomError>;
    fn definition(&self) -> Result<Value, HarkroomError>;
    fn channels(&self) -> Result<Vec<(String, String)>, HarkroomError>;
    fn accounts(&self) -> Result<Vec<Value>, HarkroomError>;
    /// transport 오류 뒤 세션을 버린다(다음 호출이 새로 붙는다).
    fn reset(&self);
}

/// 멘션을 턴으로 바꾸는 쪽(정본 `createMentionScheduler`, B4-1b).
pub trait Scheduler {
    /// 고아·관문 상한 읽음 처리가 실패하면 `Err` — 폴 실패와 같이 물러났다 다시 붙는다(정본 `admit` 이 던지는 것).
    fn admit(&self, batch: &Value, ctx: &BatchContext) -> Result<AdmitOutcome, HarkroomError>;
    /// 도는 턴이 쥔 entry.
    fn holding_entries(&self) -> Vec<i64>;
    /// 끝냈지만 읽음 처리를 못 한 entry(교체 러너가 턴 없이 읽음 처리만 한다).
    fn done_entries(&self) -> Vec<i64>;
    /// 도는 턴이 모두 끝날 때까지 기다린다.
    fn drain(&self);
}

/// 루프 밖의 손잡이들.
pub struct LoopHooks<'a> {
    /// 이 배치의 메모리 판본(`memoryCache.noteRev`).
    pub note_memory_rev: &'a dyn Fn(Option<&str>),
    /// 재시도로 낫지 않는 실패(자격증명·실행 파일 부재)면 프로세스를 끝낸다(정본 `exitIfUnrecoverable`). 아니면 그냥 돌아온다.
    pub exit_if_unrecoverable: &'a dyn Fn(&HarkroomError),
    /// `runner.pollStopped` — 쥔 entry·끝냈지만 읽음 못 한 entry.
    pub notify_poll_stopped: &'a dyn Fn(&[i64], &[i64]),
}

/// 폴 루프의 상태. 시그널·원격 종료 요청·링크 포기가 모두 [`PollLoop::stop`] 하나로 루프를 끝낸다.
pub struct PollLoop {
    running: AtomicBool,
    sleep: StoppableSleep,
    started_at_ms: i64,
    me: Mutex<Me>,
}

impl PollLoop {
    pub fn new(me: Me, started_at_ms: i64) -> Self {
        Self {
            running: AtomicBool::new(true),
            sleep: StoppableSleep::new(),
            started_at_ms,
            me: Mutex::new(me),
        }
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 플래그를 끄고 기다림을 깨운다. 도는 턴은 건드리지 않는다 — 진행 중인 배치를 끝낸 뒤에만 빠져나간다.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.sleep.wake();
    }

    pub fn me(&self) -> Me {
        self.me.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 종료 요청 시각을 보고 나를 향한 것이면 받아들인다. 받아들였으면 `true`.
    pub fn consider_stop_request(&self, at: Option<&str>) -> bool {
        if !stop_requested_for_runner(at, self.started_at_ms) {
            return false;
        }
        self.stop();
        eprintln!(
            "[main] 종료 요청을 받았다 (요청 시각: {}) — 진행 중인 턴을 마쳤으므로 물러난다.",
            at.unwrap_or("")
        );
        eprintln!(
            "  harkroom 서버는 러너를 띄우지 않는다 — 다시 띄우는 것은 데스크탑 앱(소유한 에이전트) 또는 사람/launchd/systemd 감독의 몫이다."
        );
        true
    }

    /// 폴 한 바퀴. 돌려준 값은 다음 바퀴 전에 쉴 시간(ms, 0 이면 바로).
    fn turn_once(
        &self,
        src: &dyn PollSource,
        sched: &dyn Scheduler,
        hooks: &LoopHooks<'_>,
    ) -> Result<u64, HarkroomError> {
        let batch = src.poll(&sched.holding_entries())?;
        (hooks.note_memory_rev)(batch.get("memoryRev").and_then(Value::as_str));
        let empty = batch
            .get("entries")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        if empty {
            // 멘션이 없어도 종료 요청은 봐야 한다 — 조용한 러너가 영원히 물러나지 않으면 안 된다.
            let at = idle_stop_requested_at(&batch, || src.definition())?;
            self.consider_stop_request(at.as_deref());
            return Ok(0);
        }
        let channels = src.channels()?;
        let accounts = src.accounts()?;
        {
            let mut me = self.me.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(was) = apply_self_rename(&mut me, &accounts) {
                eprintln!("이름이 바뀌었다: @{was} → @{}", me.handle);
            }
        }
        let ctx = BatchContext::new(&channels, &accounts);
        let outcome = sched.admit(&batch, &ctx)?;
        // 띄운 것이 없는데 유예·막힘이 있으면 잠깐 쉰다 — 인플라이트 entry 는 미읽음이라 다음 폴이 바로 같은 배치를 준다.
        if outcome.started == 0 && outcome.deferred + outcome.blocked > 0 {
            return Ok(IDLE_ADMIT_SLEEP_MS);
        }
        Ok(0)
    }

    /// 루프를 돌고, 멈추면 물러나는 순서를 밟는다(알림 → drain).
    pub fn run(&self, src: &dyn PollSource, sched: &dyn Scheduler, hooks: &LoopHooks<'_>) {
        let mut backoff = POLL_BACKOFF_START_MS;
        while self.running() {
            match self.turn_once(src, sched, hooks) {
                Ok(wait) => {
                    backoff = POLL_BACKOFF_START_MS;
                    if wait > 0 {
                        self.sleep.sleep(wait);
                    }
                }
                Err(e) => {
                    // 자격증명 실패는 여기서 먼저 거른다 — PAT 회전 때 옛 러너의 401 은 거의 늘 이 롱폴로 온다.
                    (hooks.exit_if_unrecoverable)(&e);
                    eprintln!("poll 루프 오류, 재접속: {}", e.message);
                    src.reset();
                    self.sleep.sleep(backoff);
                    backoff = crate::link::next_backoff_ms(backoff);
                }
            }
        }
        (hooks.notify_poll_stopped)(&sched.holding_entries(), &sched.done_entries());
        sched.drain();
    }
}

#[cfg(test)]
#[path = "poll_loop_tests.rs"]
mod tests;
