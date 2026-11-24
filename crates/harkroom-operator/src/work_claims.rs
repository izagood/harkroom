//! 잡기 장부(I2b) — 깨움 프레임을 받았을 때 그 (에이전트, 스레드)로 좁혀 서버 작업 판에서 줄 하나를 잡아 **옆에 적어 둔다**.
//!
//! 이 단계의 잡기는 기록이지 실행 근거가 아니다:
//! - 잡기는 러너 빌림을 막지 않는다 — 깨움이 오면 러너는 지금처럼(I1b) 뜨고, 잡기가 없음·실패·무응답이어도 그대로다.
//! - **`work_claim`(쥔 줄)을 권한·순서 판정에 읽는 코드를 두지 않는다.** 이 장부도 러너를 띄울지·어느 글을 돌릴지에 쓰이지 않는다.
//!   작업 상태가 정본이 되기 전에는 「잡은 작업」과 러너가 실제로 돌리는 글이 같은 일이라는 보장이 없다.
//! - 잡는 때는 깨움 하나뿐이다. 「칸이 빔」·「주기 훑기」에서는 잡지 않는다(열린 채 남은 옛 작업을 되풀이해 잡는 고리를 만들지 않게).
//!
//! 켜지는 조건은 셋 다다: 서버 스위치(`HARKROOM_WORK_CLAIM` — 꺼져 있으면 `work_claim_disabled` 가 오고 이 연결에서는 묻지 않는다) ·
//! hello 의 `workClaim: true`(이 오퍼레이터가 잡기 프레임을 안다) · 그 에이전트의 로컬 설정 `runnerPool: true`.
//! 옛 서버는 프레임을 버려 답이 없다 — 기한을 연달아 넘기면 이 연결에서는 묻지 않는다.
//!
//! 이 모듈은 장부와 판단만 한다. 보낼 프레임을 돌려주고, 보내기·시계·예약은 부르는 쪽(`serve`) 몫이다.

use harkroom_proto::p2::{OperatorToServerFrame, WorkClaimedItem, WorkHeld};
use std::collections::HashMap;

/// 청하는 임대 길이(초). 서버가 15~600 으로 자른다.
pub const LEASE_SECS: i32 = 120;
/// 쥔 줄을 이만큼마다 묶어서 민다(임대의 1/3).
pub const RENEW_EVERY_MS: u64 = 40_000;
/// 잡을 것이 없다는 답이면 이만큼 뒤에 **한 번만** 다시 묻는다(깨움과 작업 라우팅은 다른 비동기 길이라 깨움이 먼저 올 수 있다).
pub const RETRY_AFTER_MS: u64 = 1_000;
/// 답을 이만큼 기다린다 — 넘기면 답 없음으로 센다.
pub const ANSWER_DEADLINE_MS: u64 = 10_000;
/// 답 없음이 이만큼 이어지면 이 연결에서는 묻지 않는다(잡기 프레임을 모르는 옛 서버).
pub const SILENT_LIMIT: u32 = 3;
/// 러너 없이 쥔 줄을 이만큼 지나면 놓는다(러너가 못 떴거나, 답이 러너 반납 뒤에 왔다).
pub const ORPHAN_AFTER_MS: u64 = 60_000;
/// 비율 로그 간격.
pub const SUMMARY_EVERY_MS: u64 = 60_000;
/// 한 번의 갱신에 싣는 줄 수(서버 상한 아래).
const RENEW_BATCH: usize = 32;

/// 이 연결에서 잡기를 그만둔 까닭.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Off {
    /// 서버 스위치가 꺼져 있다(`work_claim_disabled`).
    Disabled,
    /// 답이 없다(옛 서버).
    Silent,
}

/// `work.claimed` 를 받은 결과.
#[derive(Debug, PartialEq)]
pub enum Claimed {
    /// 모르는 요청이거나 이미 물러났다.
    Ignored,
    /// 잡아서 적었다.
    Held,
    /// 잡을 것이 없다 — [`RETRY_AFTER_MS`] 뒤에 [`WorkClaims::retry`] 를 한 번 부른다.
    Retry {
        agent_id: String,
        thread_root_id: String,
    },
    /// 다시 물어도 없었다.
    Nothing,
    /// 이 연결에서 물러났다.
    Off(Off),
    /// 서버가 하지 못했다(`unavailable`·`invalid_request` 등). 러너는 그대로 돈다.
    Failed,
    /// 청한 것과 다른 줄이 왔다 — 적지 않고 이 프레임으로 바로 놓는다.
    Mismatch(Box<OperatorToServerFrame>),
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// 잡으러 간 깨움 수.
    pub wakes: u64,
    /// 잡힌 깨움 수(다시 물어 잡힌 것 포함).
    pub claimed: u64,
    /// 그 가운데 다시 물어서 잡힌 수.
    pub claimed_on_retry: u64,
    /// 다시 물어도 없던 수.
    pub nothing: u64,
    /// 답이 없던 수.
    pub silent: u64,
    /// 서버가 하지 못한 수.
    pub failed: u64,
    /// 청한 것과 다른 줄이 온 수.
    pub mismatch: u64,
    /// 갱신에서 빠진(잃은) 줄 수.
    pub lost: u64,
}

struct Pending {
    agent_id: String,
    thread_root_id: String,
    sent_at: u64,
    retry: bool,
}

struct HeldRow {
    agent_id: String,
    work_id: String,
    attempts: i32,
    since: u64,
}

#[derive(Default)]
pub struct WorkClaims {
    off: Option<Off>,
    generation: i64,
    seq: u64,
    silent_run: u32,
    pending: HashMap<String, Pending>,
    held: Vec<HeldRow>,
    /// 보낸 갱신 하나(요청 id · 그때 실은 작업 id · 보낸 시각). 답이 오면 그때 실은 것 가운데 빠진 줄만 잃은 것으로 본다.
    renewing: Option<(String, Vec<String>, u64)>,
    last_renew_at: u64,
    stats: Stats,
    logged: Stats,
    last_summary_at: u64,
}

/// [`WorkClaims::tick`] 이 돌려주는 것.
#[derive(Debug, Default, PartialEq)]
pub struct Tick {
    pub frames: Vec<OperatorToServerFrame>,
    pub log: Option<String>,
    /// 이번에 물러났다면 그 까닭.
    pub off: Option<Off>,
}

fn release(row: &HeldRow, reason: &str) -> OperatorToServerFrame {
    OperatorToServerFrame::WorkRelease {
        work_id: row.work_id.clone(),
        attempts: row.attempts,
        reason: reason.to_string(),
    }
}

impl WorkClaims {
    /// 서버에 (다시) 붙었다 — 물러남을 풀고 세대를 올린다. 기다리던 답은 버린다. 쥔 줄은 둔다(다음 갱신이 남은 것을 가린다).
    pub fn on_open(&mut self) {
        self.off = None;
        self.generation += 1;
        self.silent_run = 0;
        self.pending.clear();
        self.renewing = None;
    }

    pub fn off(&self) -> Option<Off> {
        self.off
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn held_count(&self) -> usize {
        self.held.len()
    }

    /// 줄을 쥔 에이전트들(겹침 없이).
    pub fn held_agents(&self) -> Vec<String> {
        let mut v: Vec<String> = self.held.iter().map(|h| h.agent_id.clone()).collect();
        v.sort();
        v.dedup();
        v
    }

    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("wc-{}-{}", self.generation, self.seq)
    }

    fn claim(
        &mut self,
        agent_id: &str,
        thread_root_id: &str,
        retry: bool,
        now: u64,
    ) -> OperatorToServerFrame {
        let request_id = self.next_id();
        self.pending.insert(
            request_id.clone(),
            Pending {
                agent_id: agent_id.to_string(),
                thread_root_id: thread_root_id.to_string(),
                sent_at: now,
                retry,
            },
        );
        OperatorToServerFrame::WorkClaim {
            request_id,
            slot_generation: self.generation,
            lease_secs: Some(LEASE_SECS),
            agents: Some(vec![agent_id.to_string()]),
            thread_root_id: Some(thread_root_id.to_string()),
        }
    }

    /// 깨움이 왔다. `pool` 은 그 에이전트가 이 오퍼레이터의 풀 에이전트(`runnerPool: true`)인가다.
    /// 잡으러 갈 프레임을 돌려준다 — 풀 에이전트가 아니거나 이 연결에서 물러났으면 `None`(옛 길 그대로).
    pub fn on_wake(
        &mut self,
        agent_id: &str,
        thread_root_id: &str,
        pool: bool,
        now: u64,
    ) -> Option<OperatorToServerFrame> {
        if !pool || self.off.is_some() || agent_id.is_empty() || thread_root_id.is_empty() {
            return None;
        }
        self.stats.wakes += 1;
        Some(self.claim(agent_id, thread_root_id, false, now))
    }

    /// 「없음」 뒤의 한 번뿐인 다시 묻기. 그 사이 물러났으면 `None`(없음으로 센다).
    pub fn retry(
        &mut self,
        agent_id: &str,
        thread_root_id: &str,
        now: u64,
    ) -> Option<OperatorToServerFrame> {
        if self.off.is_some() {
            self.stats.nothing += 1;
            return None;
        }
        Some(self.claim(agent_id, thread_root_id, true, now))
    }

    fn step_back(&mut self, why: Off) {
        self.off = Some(why);
        self.pending.clear();
        self.renewing = None;
        // 쥔 줄은 잊는다 — 서버 쪽 임대는 기한이 차면 스스로 풀린다.
        self.held.clear();
    }

    /// `work.claimed` 를 받았다.
    pub fn on_claimed(
        &mut self,
        request_id: &str,
        work: Option<&WorkClaimedItem>,
        error: Option<&str>,
        now: u64,
    ) -> Claimed {
        let Some(p) = self.pending.remove(request_id) else {
            // 기한을 넘겨 잊은 요청의 답이 줄을 들고 왔다 — 쥐고 있지 않게 바로 놓는다.
            return match work {
                Some(w) => Claimed::Mismatch(Box::new(OperatorToServerFrame::WorkRelease {
                    work_id: w.work_id.clone(),
                    attempts: w.attempts,
                    reason: "released".into(),
                })),
                None => Claimed::Ignored,
            };
        };
        self.silent_run = 0;
        if let Some(code) = error {
            if code == "work_claim_disabled" {
                self.step_back(Off::Disabled);
                return Claimed::Off(Off::Disabled);
            }
            self.stats.failed += 1;
            return Claimed::Failed;
        }
        match work {
            Some(w) if w.agent_id == p.agent_id && w.thread_root_id == p.thread_root_id => {
                self.held.retain(|h| h.work_id != w.work_id);
                self.held.push(HeldRow {
                    agent_id: p.agent_id,
                    work_id: w.work_id.clone(),
                    attempts: w.attempts,
                    since: now,
                });
                self.stats.claimed += 1;
                if p.retry {
                    self.stats.claimed_on_retry += 1;
                }
                Claimed::Held
            }
            Some(w) => {
                self.stats.mismatch += 1;
                Claimed::Mismatch(Box::new(OperatorToServerFrame::WorkRelease {
                    work_id: w.work_id.clone(),
                    attempts: w.attempts,
                    reason: "released".into(),
                }))
            }
            None if !p.retry => Claimed::Retry {
                agent_id: p.agent_id,
                thread_root_id: p.thread_root_id,
            },
            None => {
                self.stats.nothing += 1;
                Claimed::Nothing
            }
        }
    }

    /// `work.renewed` 를 받았다 — 그 갱신에 실었던 것 가운데 답에 없는 줄은 잃은 것이다. 물러났으면 그 까닭.
    pub fn on_renewed(
        &mut self,
        request_id: &str,
        work_ids: &[String],
        error: Option<&str>,
    ) -> Option<Off> {
        let (_, sent, _) = self.renewing.take_if(|(id, _, _)| id == request_id)?;
        self.silent_run = 0;
        if let Some(code) = error {
            if code == "work_claim_disabled" {
                self.step_back(Off::Disabled);
                return Some(Off::Disabled);
            }
            // 서버가 하지 못했다 — 줄은 둔다(다음 갱신이 다시 본다).
            return None;
        }
        let before = self.held.len();
        self.held
            .retain(|h| !sent.contains(&h.work_id) || work_ids.contains(&h.work_id));
        self.stats.lost += (before - self.held.len()) as u64;
        None
    }

    /// 러너가 끝났다(반납 포함) — 그 에이전트로 쥔 줄을 **전부** 놓는다. 까닭은 코드 0 이면 `released`, 그 밖은 `failed`.
    /// `done` 은 쓰지 않는다: 러너가 끝난 것은 일이 끝난 것이 아니다.
    pub fn on_runner_exit(
        &mut self,
        agent_id: &str,
        code: Option<i32>,
    ) -> Vec<OperatorToServerFrame> {
        let reason = if code == Some(0) {
            "released"
        } else {
            "failed"
        };
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.held)
            .into_iter()
            .partition(|h| h.agent_id == agent_id);
        self.held = kept;
        gone.iter().map(|h| release(h, reason)).collect()
    }

    /// 주기 일(1초쯤마다): 답 기한 · 러너 없는 줄 놓기 · 갱신 · 비율 로그. `runner_alive` 는 그 에이전트의 러너가 떠 있는가다.
    pub fn tick(&mut self, now: u64, runner_alive: &dyn Fn(&str) -> bool) -> Tick {
        let mut out = Tick::default();
        // 답 기한.
        let late: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| now.saturating_sub(p.sent_at) >= ANSWER_DEADLINE_MS)
            .map(|(id, _)| id.clone())
            .collect();
        for id in late {
            self.pending.remove(&id);
            self.stats.silent += 1;
            self.silent_run += 1;
        }
        if self
            .renewing
            .as_ref()
            .is_some_and(|(_, _, at)| now.saturating_sub(*at) >= ANSWER_DEADLINE_MS)
        {
            self.renewing = None;
            self.silent_run += 1;
        }
        if self.off.is_none() && self.silent_run >= SILENT_LIMIT {
            self.step_back(Off::Silent);
            out.off = Some(Off::Silent);
        }
        // 러너 없이 쥔 줄 — 러너가 못 떴거나 답이 반납 뒤에 왔다.
        let (orphans, kept): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.held).into_iter().partition(|h| {
                now.saturating_sub(h.since) >= ORPHAN_AFTER_MS && !runner_alive(&h.agent_id)
            });
        self.held = kept;
        out.frames
            .extend(orphans.iter().map(|h| release(h, "released")));
        // 갱신.
        if self.off.is_none()
            && self.renewing.is_none()
            && !self.held.is_empty()
            && now.saturating_sub(self.last_renew_at) >= RENEW_EVERY_MS
        {
            self.last_renew_at = now;
            let held: Vec<WorkHeld> = self
                .held
                .iter()
                .take(RENEW_BATCH)
                .map(|h| WorkHeld {
                    work_id: h.work_id.clone(),
                    attempts: h.attempts,
                })
                .collect();
            let request_id = self.next_id();
            self.renewing = Some((
                request_id.clone(),
                held.iter().map(|h| h.work_id.clone()).collect(),
                now,
            ));
            out.frames.push(OperatorToServerFrame::WorkRenew {
                request_id,
                lease_secs: Some(LEASE_SECS),
                held,
            });
        }
        // 비율 로그 — 수치가 바뀌었을 때만, 간격을 두고.
        if self.stats != self.logged && now.saturating_sub(self.last_summary_at) >= SUMMARY_EVERY_MS
        {
            self.last_summary_at = now;
            self.logged = self.stats;
            out.log = Some(self.summary());
        }
        out
    }

    /// 「깨움 → 잡힘」 비율 한 줄. 식별자는 싣지 않는다.
    pub fn summary(&self) -> String {
        let s = &self.stats;
        let rate = (s.claimed * 100)
            .checked_div(s.wakes)
            .map_or_else(|| "-".to_string(), |p| format!("{p}%"));
        format!(
            "깨움 {} → 잡힘 {}({rate}, 다시 물어 {}) · 없음 {} · 답 없음 {} · 실패 {} · 다른 줄 {} · 잃음 {} · 쥔 줄 {}",
            s.wakes,
            s.claimed,
            s.claimed_on_retry,
            s.nothing,
            s.silent,
            s.failed,
            s.mismatch,
            s.lost,
            self.held.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened() -> WorkClaims {
        let mut w = WorkClaims::default();
        w.on_open();
        w
    }

    fn rid(f: &OperatorToServerFrame) -> String {
        match f {
            OperatorToServerFrame::WorkClaim { request_id, .. }
            | OperatorToServerFrame::WorkRenew { request_id, .. } => request_id.clone(),
            other => panic!("요청 프레임이 아니다: {other:?}"),
        }
    }

    fn item(work: &str, agent: &str, thread: &str, attempts: i32) -> WorkClaimedItem {
        WorkClaimedItem {
            work_id: work.into(),
            agent_id: agent.into(),
            channel_id: "c1".into(),
            thread_root_id: thread.into(),
            root_id: "r1".into(),
            attempts,
            lease_expires_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn hold(w: &mut WorkClaims, work: &str, agent: &str, thread: &str, attempts: i32, now: u64) {
        let f = w.on_wake(agent, thread, true, now).unwrap();
        assert_eq!(
            w.on_claimed(
                &rid(&f),
                Some(&item(work, agent, thread, attempts)),
                None,
                now
            ),
            Claimed::Held
        );
    }

    #[test]
    fn wake_claims_narrowed_to_that_agent_and_thread_only_for_pool_agents() {
        let mut w = opened();
        // 풀 에이전트가 아니면 묻지 않는다.
        assert_eq!(w.on_wake("a1", "t1", false, 0), None);
        assert_eq!(w.stats().wakes, 0);
        let f = w.on_wake("a1", "t1", true, 0).unwrap();
        match &f {
            OperatorToServerFrame::WorkClaim {
                slot_generation,
                lease_secs,
                agents,
                thread_root_id,
                ..
            } => {
                assert_eq!(*slot_generation, 1);
                assert_eq!(*lease_secs, Some(LEASE_SECS));
                assert_eq!(agents.as_deref(), Some(&["a1".to_string()][..]));
                assert_eq!(thread_root_id.as_deref(), Some("t1"));
            }
            other => panic!("{other:?}"),
        }
        // 좁힐 스레드가 없는 깨움으로는 잡지 않는다(좁히지 않은 잡기는 이 단계에 없다).
        assert_eq!(w.on_wake("a1", "", true, 0), None);
    }

    #[test]
    fn nothing_is_retried_exactly_once() {
        let mut w = opened();
        let f = w.on_wake("a1", "t1", true, 0).unwrap();
        let r = w.on_claimed(&rid(&f), None, None, 10);
        assert_eq!(
            r,
            Claimed::Retry {
                agent_id: "a1".into(),
                thread_root_id: "t1".into()
            }
        );
        let f2 = w.retry("a1", "t1", 1_010).unwrap();
        assert_eq!(w.on_claimed(&rid(&f2), None, None, 1_020), Claimed::Nothing);
        let s = w.stats();
        assert_eq!((s.wakes, s.claimed, s.nothing), (1, 0, 1));
        // 다시 물어 잡히면 잡힘으로 센다.
        let f = w.on_wake("a1", "t1", true, 2_000).unwrap();
        w.on_claimed(&rid(&f), None, None, 2_010);
        let f2 = w.retry("a1", "t1", 3_010).unwrap();
        assert_eq!(
            w.on_claimed(&rid(&f2), Some(&item("w1", "a1", "t1", 1)), None, 3_020),
            Claimed::Held
        );
        let s = w.stats();
        assert_eq!((s.wakes, s.claimed, s.claimed_on_retry), (2, 1, 1));
        assert!(w.summary().contains("깨움 2 → 잡힘 1(50%"));
    }

    #[test]
    fn disabled_steps_back_until_the_next_connection() {
        let mut w = opened();
        hold(&mut w, "w1", "a1", "t1", 1, 0);
        let f = w.on_wake("a1", "t2", true, 0).unwrap();
        assert_eq!(
            w.on_claimed(&rid(&f), None, Some("work_claim_disabled"), 1),
            Claimed::Off(Off::Disabled)
        );
        assert_eq!(w.off(), Some(Off::Disabled));
        assert_eq!(w.held_count(), 0);
        // 물러난 동안에는 묻지 않는다 — 깨움은 옛 길 그대로다.
        assert_eq!(w.on_wake("a1", "t1", true, 2), None);
        let t = w.tick(100_000, &|_| true);
        assert!(t.frames.is_empty() && t.off.is_none());
        // 다시 붙으면 다시 묻는다(세대가 오른다).
        w.on_open();
        match w.on_wake("a1", "t1", true, 3).unwrap() {
            OperatorToServerFrame::WorkClaim {
                slot_generation, ..
            } => assert_eq!(slot_generation, 2),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn other_errors_do_not_step_back() {
        let mut w = opened();
        let f = w.on_wake("a1", "t1", true, 0).unwrap();
        assert_eq!(
            w.on_claimed(&rid(&f), None, Some("unavailable"), 1),
            Claimed::Failed
        );
        assert_eq!(w.off(), None);
        assert!(w.on_wake("a1", "t1", true, 2).is_some());
    }

    #[test]
    fn silence_counts_and_steps_back_after_the_limit() {
        let mut w = opened();
        for i in 0..SILENT_LIMIT {
            w.on_wake("a1", "t1", true, 0).unwrap();
            let t = w.tick(ANSWER_DEADLINE_MS, &|_| true);
            assert_eq!(t.off.is_some(), i + 1 == SILENT_LIMIT, "{i}");
        }
        assert_eq!(w.off(), Some(Off::Silent));
        assert_eq!(w.stats().silent, u64::from(SILENT_LIMIT));
        assert_eq!(w.on_wake("a1", "t1", true, 0), None);
    }

    #[test]
    fn an_answer_resets_the_silent_run() {
        let mut w = opened();
        for _ in 0..SILENT_LIMIT - 1 {
            w.on_wake("a1", "t1", true, 0).unwrap();
            w.tick(ANSWER_DEADLINE_MS, &|_| true);
        }
        let f = w.on_wake("a1", "t1", true, ANSWER_DEADLINE_MS).unwrap();
        w.on_claimed(&rid(&f), None, Some("unavailable"), ANSWER_DEADLINE_MS);
        w.on_wake("a1", "t1", true, ANSWER_DEADLINE_MS).unwrap();
        w.tick(ANSWER_DEADLINE_MS * 2, &|_| true);
        assert_eq!(w.off(), None);
    }

    #[test]
    fn a_late_or_mismatched_row_is_released_not_held() {
        let mut w = opened();
        // 기한을 넘겨 잊은 요청의 답.
        let f = w.on_wake("a1", "t1", true, 0).unwrap();
        w.tick(ANSWER_DEADLINE_MS, &|_| true);
        let r = w.on_claimed(
            &rid(&f),
            Some(&item("w1", "a1", "t1", 3)),
            None,
            ANSWER_DEADLINE_MS + 1,
        );
        assert_eq!(
            r,
            Claimed::Mismatch(Box::new(OperatorToServerFrame::WorkRelease {
                work_id: "w1".into(),
                attempts: 3,
                reason: "released".into()
            }))
        );
        // 청한 스레드와 다른 줄.
        let f = w.on_wake("a1", "t1", true, 0).unwrap();
        let r = w.on_claimed(&rid(&f), Some(&item("w2", "a1", "other", 1)), None, 1);
        assert!(matches!(r, Claimed::Mismatch(_)));
        assert_eq!(w.held_count(), 0);
        assert_eq!(w.stats().mismatch, 1);
        // 모르는 요청 id 는 버린다.
        assert_eq!(w.on_claimed("nope", None, None, 2), Claimed::Ignored);
    }

    #[test]
    fn runner_exit_releases_every_row_of_that_agent_with_the_received_attempts() {
        let mut w = opened();
        hold(&mut w, "w1", "a1", "t1", 2, 0);
        hold(&mut w, "w2", "a1", "t2", 5, 0);
        hold(&mut w, "w3", "a2", "t3", 1, 0);
        let out = w.on_runner_exit("a1", Some(0));
        assert_eq!(
            out,
            vec![
                OperatorToServerFrame::WorkRelease {
                    work_id: "w1".into(),
                    attempts: 2,
                    reason: "released".into()
                },
                OperatorToServerFrame::WorkRelease {
                    work_id: "w2".into(),
                    attempts: 5,
                    reason: "released".into()
                },
            ]
        );
        assert_eq!(w.held_count(), 1);
        // 코드 0 이 아니면(신호 포함) failed. done 은 어디에서도 쓰지 않는다.
        for code in [Some(1), None] {
            hold(&mut w, "w9", "a2", "t3", 1, 0);
            for f in w.on_runner_exit("a2", code) {
                match f {
                    OperatorToServerFrame::WorkRelease { reason, .. } => {
                        assert_eq!(reason, "failed")
                    }
                    other => panic!("{other:?}"),
                }
            }
        }
        assert_eq!(w.held_count(), 0);
        assert!(w.on_runner_exit("a1", Some(0)).is_empty());
    }

    #[test]
    fn held_rows_are_renewed_and_missing_ones_are_dropped() {
        let mut w = opened();
        hold(&mut w, "w1", "a1", "t1", 1, 0);
        hold(&mut w, "w2", "a1", "t2", 4, 0);
        assert!(w.tick(RENEW_EVERY_MS - 1, &|_| true).frames.is_empty());
        let t = w.tick(RENEW_EVERY_MS, &|_| true);
        let renew = &t.frames[0];
        match renew {
            OperatorToServerFrame::WorkRenew {
                held, lease_secs, ..
            } => {
                assert_eq!(*lease_secs, Some(LEASE_SECS));
                assert_eq!(
                    held.iter()
                        .map(|h| (h.work_id.as_str(), h.attempts))
                        .collect::<Vec<_>>(),
                    vec![("w1", 1), ("w2", 4)]
                );
            }
            other => panic!("{other:?}"),
        }
        // 갱신을 보낸 뒤에 잡힌 줄은 그 답으로 잃지 않는다.
        hold(&mut w, "w3", "a1", "t3", 1, RENEW_EVERY_MS);
        assert_eq!(w.on_renewed(&rid(renew), &["w1".to_string()], None), None);
        assert_eq!(w.held_count(), 2);
        assert_eq!(w.stats().lost, 1);
        // 모르는 답은 버린다.
        assert_eq!(w.on_renewed("nope", &[], None), None);
        assert_eq!(w.held_count(), 2);
    }

    #[test]
    fn rows_without_a_runner_are_released_after_the_grace() {
        let mut w = opened();
        hold(&mut w, "w1", "a1", "t1", 1, 0);
        hold(&mut w, "w2", "a2", "t2", 1, 0);
        assert!(
            w.tick(ORPHAN_AFTER_MS - 1, &|_| false)
                .frames
                .iter()
                .all(|f| matches!(f, OperatorToServerFrame::WorkRenew { .. }))
        );
        let t = w.tick(ORPHAN_AFTER_MS, &|a| a == "a2");
        assert!(t.frames.contains(&OperatorToServerFrame::WorkRelease {
            work_id: "w1".into(),
            attempts: 1,
            reason: "released".into()
        }));
        assert_eq!(w.held_count(), 1);
    }

    #[test]
    fn summary_is_logged_only_when_numbers_change_and_carries_no_ids() {
        let mut w = opened();
        assert_eq!(w.tick(SUMMARY_EVERY_MS, &|_| true).log, None);
        hold(
            &mut w,
            "work-secret",
            "agent-secret",
            "thread-secret",
            1,
            SUMMARY_EVERY_MS,
        );
        let line = w.tick(SUMMARY_EVERY_MS * 2, &|_| true).log.unwrap();
        assert!(line.contains("깨움 1 → 잡힘 1(100%"), "{line}");
        assert!(!line.contains("secret"), "{line}");
        assert_eq!(w.tick(SUMMARY_EVERY_MS * 4, &|_| true).log, None);
    }
}
