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
//! **좁히지 않은 잡기(I2d, 오퍼레이터 스위치 `HARKROOM_WORK_PULL`, 기본 꺼짐)** — 켜면 주기([`PULL_EVERY_MS`])마다 빈 칸 수만큼
//! `work.pull` 로 판에서 잡는다. 빈 칸 = 동시 턴 상한 − 도는 턴 − 잡았지만 아직 턴이 안 선 줄. 잡힌 줄의 에이전트는 러너를 빌려 띄운다
//! (러너가 인박스에서 그 글을 집는다 — 어느 글을 돌릴지는 여전히 러너가 정한다). 서버가 `work_pull_disabled` 로 답하거나 답이 없으면
//! pull 만 물러난다(깨움 때 잡기는 그대로). 켜져 있을 때만 두 가지가 더 돈다: 턴이 끝난(칸을 놓은) 줄은 놓고, 턴이 서지 않은 줄은
//! [`UNSTARTED_AFTER_MS`] 뒤에 놓는다.
//!
//! **러너에 작업 id 넘기기(I2d)** — 러너가 턴 직전 칸을 물을 때([`WorkClaims::start_turn`]) 그 (에이전트, 스레드)로 쥔 줄의
//! 작업 id·횟수를 답에 실어 준다. 러너는 그것을 턴 임대 발급에 실어 서버가 `work_claim.turn_id` 를 적는다(기록).
//!
//! 이 모듈은 장부와 판단만 한다. 보낼 프레임을 돌려주고, 보내기·시계·예약은 부르는 쪽(`serve`) 몫이다.

use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use harkroom_proto::p2::{OperatorToServerFrame, WorkClaimedItem, WorkHeld};
use std::collections::HashMap;

/// 장부 손잡이 — 서버 링크 쪽(serve)과 러너 링크 쪽(bridge)이 같은 것을 쓴다.
pub type WorkClaimsHandle = std::sync::Arc<std::sync::Mutex<WorkClaims>>;

/// 턴 칸 키(`<채널>/<스레드 뿌리>`)에서 스레드 뿌리. 뿌리가 없는 키(`_root`)·모양이 다른 키는 `None`.
fn thread_of_key(key: &str) -> Option<&str> {
    let (_, thread) = key.rsplit_once('/')?;
    (!thread.is_empty() && thread != "_root").then_some(thread)
}

/// 턴 칸 처리기([`crate::turn_slots::TurnSlots::maybe_handle`])가 답한 뒤에 부른다(I2d).
/// - 칸을 받았으면(200) 그 (에이전트, 스레드)로 쥔 줄의 작업 id·횟수를 답 본문의 `work` 에 싣는다 — 러너가 턴 임대 발급에 싣는다.
/// - 칸을 놓았으면(204) 그 줄의 턴이 끝났다고 적는다.
///
/// 에이전트는 링크 인증이 정한 값이다(러너가 보낸 값이 아니다). 쥔 줄이 없으면 답을 그대로 돌려준다.
pub fn on_slot_answer(
    claims: &WorkClaimsHandle,
    agent_id: &str,
    req: &RunnerLinkRequest,
    answer: RunnerLinkResponse,
) -> RunnerLinkResponse {
    let RunnerLinkRequest::HttpForward {
        path,
        body: req_body,
        ..
    } = req
    else {
        return answer;
    };
    let RunnerLinkResponse::HttpResponse { id, status, body } = answer else {
        return answer;
    };
    let back = |body: String| RunnerLinkResponse::HttpResponse {
        id: id.clone(),
        status,
        body,
    };
    let key = req_body
        .as_deref()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok())
        .and_then(|v| v.get("key").and_then(|k| k.as_str()).map(str::to_string));
    let Some(thread) = key.as_deref().and_then(thread_of_key) else {
        return back(body);
    };
    let path = path.split('?').next().unwrap_or_default();
    let mut c = claims.lock().unwrap_or_else(|p| p.into_inner());
    match (path, status) {
        (crate::turn_slots::TURN_SLOTS_RELEASE_PATH, 204) => {
            c.end_turn(agent_id, thread);
            back(body)
        }
        (crate::turn_slots::TURN_SLOTS_PATH, 200) => {
            let Some(w) = c.start_turn(agent_id, thread) else {
                return back(body);
            };
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(serde_json::Value::Object(mut m)) => {
                    m.insert(
                        "work".into(),
                        serde_json::json!({"workId": w.work_id, "attempts": w.attempts}),
                    );
                    back(serde_json::Value::Object(m).to_string())
                }
                _ => back(body),
            }
        }
        _ => back(body),
    }
}

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
/// 좁히지 않은 잡기(I2d)의 오퍼레이터 스위치 — `on`·`1`·`true` 만 켠다(기본 꺼짐). 서버 스위치와 이름이 같다(둘 다 켜야 돈다).
pub const WORK_PULL_ENV: &str = "HARKROOM_WORK_PULL";

pub fn pull_enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "1" | "true")
    )
}

/// 좁히지 않은 잡기(I2d)를 이만큼마다 한 번 묻는다.
pub const PULL_EVERY_MS: u64 = 15_000;
/// 한 번에 청하는 줄 수 상한(서버 상한과 같다).
pub const PULL_MAX: usize = 8;
/// pull 이 켜져 있을 때, 턴이 서지 않은 줄을 이만큼 지나면 놓는다(러너가 그 글을 집지 않았다).
pub const UNSTARTED_AFTER_MS: u64 = 300_000;
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
    /// 좁히지 않은 잡기로 잡힌 줄 수.
    pub pulled: u64,
    /// 러너에 넘긴(턴이 선) 줄 수.
    pub started: u64,
}

struct Pending {
    agent_id: String,
    thread_root_id: String,
    sent_at: u64,
    retry: bool,
}

struct HeldRow {
    agent_id: String,
    thread_root_id: String,
    work_id: String,
    attempts: i32,
    since: u64,
    /// 러너가 이 스레드의 턴 칸을 받아 갔다(작업 id 를 넘겼다).
    started: bool,
    /// 그 턴이 칸을 놓았다 — pull 이 켜져 있으면 다음 주기 일에서 놓는다.
    ended: bool,
}

/// 러너에 넘기는 쥔 줄(작업 id · 횟수).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnWork {
    pub work_id: String,
    pub attempts: i32,
}

/// `work.pulled` 를 받은 결과.
#[derive(Debug, Default, PartialEq)]
pub struct Pulled {
    /// 줄이 잡힌 에이전트들(겹침 없이) — 러너를 빌려 띄운다.
    pub wake: Vec<String>,
    /// 적지 않고 바로 놓을 줄(모르는 요청의 답 · 청하지 않은 에이전트의 줄).
    pub release: Vec<OperatorToServerFrame>,
    /// 이번에 pull 에서 물러났다면 그 까닭.
    pub off: Option<Off>,
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
    /// 좁히지 않은 잡기(I2d)가 켜져 있나(오퍼레이터 스위치).
    pull_on: bool,
    /// 이 연결에서 pull 만 물러난 까닭.
    pull_off: Option<Off>,
    /// 보낸 pull 하나(요청 id · 청한 에이전트 · 보낸 시각).
    pulling: Option<(String, Vec<String>, u64)>,
    pull_silent_run: u32,
    last_pull_at: Option<u64>,
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
    /// 이번에 pull 만 물러났다면 그 까닭.
    pub pull_off: Option<Off>,
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
        self.pull_off = None;
        self.pulling = None;
        self.pull_silent_run = 0;
        self.last_pull_at = None;
    }

    /// 좁히지 않은 잡기(I2d)를 켠다 — 기동 때 한 번.
    pub fn set_pull(&mut self, on: bool) {
        self.pull_on = on;
    }

    pub fn pull_on(&self) -> bool {
        self.pull_on
    }

    pub fn pull_off(&self) -> Option<Off> {
        self.pull_off
    }

    /// 잡았지만 아직 턴이 서지 않은 줄 수 — 빈 칸에서 뺀다.
    pub fn unstarted_count(&self) -> usize {
        self.held.iter().filter(|h| !h.started).count()
    }

    /// 러너가 그 (에이전트, 스레드)의 턴 칸을 받았다 — 쥔 줄이 있으면 넘길 작업 id·횟수를 돌려주고 「턴이 섰다」고 적는다.
    /// 같은 스레드를 다시 물어도 같은 답이다. 쥔 줄이 없으면 `None`(러너는 지금처럼 돈다).
    pub fn start_turn(&mut self, agent_id: &str, thread_root_id: &str) -> Option<TurnWork> {
        let row = self
            .held
            .iter_mut()
            .find(|h| h.agent_id == agent_id && h.thread_root_id == thread_root_id)?;
        if !row.started {
            row.started = true;
            self.stats.started += 1;
        }
        row.ended = false;
        Some(TurnWork {
            work_id: row.work_id.clone(),
            attempts: row.attempts,
        })
    }

    /// 그 (에이전트, 스레드)의 턴이 칸을 놓았다. pull 이 켜져 있으면 다음 주기 일에서 그 줄을 놓는다(꺼져 있으면 지금처럼 러너가
    /// 끝날 때까지 쥔다).
    pub fn end_turn(&mut self, agent_id: &str, thread_root_id: &str) {
        if let Some(row) = self
            .held
            .iter_mut()
            .find(|h| h.agent_id == agent_id && h.thread_root_id == thread_root_id && h.started)
        {
            row.ended = true;
        }
    }

    /// 빈 칸만큼 판에서 잡으러 간다(I2d). `max`·`in_use` 는 동시 턴 상한과 도는 턴 수, `agents` 는 이 오퍼레이터의 풀 에이전트다.
    /// 꺼져 있거나 · 물러났거나 · 앞 답을 기다리거나 · 주기 안이거나 · 빈 칸이 없으면 `None`.
    pub fn pull(
        &mut self,
        max: Option<u32>,
        in_use: usize,
        agents: Vec<String>,
        now: u64,
    ) -> Option<OperatorToServerFrame> {
        if !self.pull_on
            || self.off.is_some()
            || self.pull_off.is_some()
            || self.pulling.is_some()
            || agents.is_empty()
            || self
                .last_pull_at
                .is_some_and(|at| now.saturating_sub(at) < PULL_EVERY_MS)
        {
            return None;
        }
        let waiting = self.unstarted_count();
        let free = match max {
            Some(m) => (m as usize).saturating_sub(in_use).saturating_sub(waiting),
            None => PULL_MAX.saturating_sub(waiting),
        }
        .min(PULL_MAX);
        if free == 0 {
            return None;
        }
        self.last_pull_at = Some(now);
        let request_id = self.next_id();
        self.pulling = Some((request_id.clone(), agents.clone(), now));
        Some(OperatorToServerFrame::WorkPull {
            request_id,
            slot_generation: self.generation,
            max: free as u32,
            lease_secs: Some(LEASE_SECS),
            agents: Some(agents),
        })
    }

    /// `work.pulled` 를 받았다.
    pub fn on_pulled(
        &mut self,
        request_id: &str,
        works: &[WorkClaimedItem],
        error: Option<&str>,
        now: u64,
    ) -> Pulled {
        let mut out = Pulled::default();
        let let_go = |w: &WorkClaimedItem| OperatorToServerFrame::WorkRelease {
            work_id: w.work_id.clone(),
            attempts: w.attempts,
            reason: "released".into(),
        };
        let Some((_, asked, _)) = self.pulling.take_if(|(id, _, _)| id == request_id) else {
            // 기한을 넘겨 잊은 요청의 답 — 쥐고 있지 않게 바로 놓는다.
            out.release = works.iter().map(let_go).collect();
            return out;
        };
        self.pull_silent_run = 0;
        if let Some(code) = error {
            if code == "work_pull_disabled" || code == "work_claim_disabled" {
                self.pull_off = Some(Off::Disabled);
                out.off = Some(Off::Disabled);
            } else {
                self.stats.failed += 1;
            }
            out.release = works.iter().map(let_go).collect();
            return out;
        }
        for w in works {
            if !asked.contains(&w.agent_id) || w.thread_root_id.is_empty() {
                self.stats.mismatch += 1;
                out.release.push(let_go(w));
                continue;
            }
            self.held.retain(|h| h.work_id != w.work_id);
            self.held.push(HeldRow {
                agent_id: w.agent_id.clone(),
                thread_root_id: w.thread_root_id.clone(),
                work_id: w.work_id.clone(),
                attempts: w.attempts,
                since: now,
                started: false,
                ended: false,
            });
            self.stats.pulled += 1;
            if !out.wake.contains(&w.agent_id) {
                out.wake.push(w.agent_id.clone());
            }
        }
        out
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
        self.pulling = None;
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
                    thread_root_id: p.thread_root_id,
                    work_id: w.work_id.clone(),
                    attempts: w.attempts,
                    since: now,
                    started: false,
                    ended: false,
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
        // pull 의 답 기한 — 연달아 넘기면 pull 만 물러난다.
        if self
            .pulling
            .as_ref()
            .is_some_and(|(_, _, at)| now.saturating_sub(*at) >= ANSWER_DEADLINE_MS)
        {
            self.pulling = None;
            self.pull_silent_run += 1;
            if self.pull_off.is_none() && self.pull_silent_run >= SILENT_LIMIT {
                self.pull_off = Some(Off::Silent);
                out.pull_off = Some(Off::Silent);
            }
        }
        // pull 이 켜져 있을 때만: 턴이 끝난 줄과 턴이 서지 않은 채 오래된 줄을 놓는다.
        if self.pull_on {
            let (gone, kept): (Vec<_>, Vec<_>) =
                std::mem::take(&mut self.held).into_iter().partition(|h| {
                    h.ended || (!h.started && now.saturating_sub(h.since) >= UNSTARTED_AFTER_MS)
                });
            self.held = kept;
            out.frames
                .extend(gone.iter().map(|h| release(h, "released")));
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
            "깨움 {} → 잡힘 {}({rate}, 다시 물어 {}) · 없음 {} · 답 없음 {} · 실패 {} · 다른 줄 {} · 잃음 {} · pull 잡힘 {} · 턴에 넘김 {} · 쥔 줄 {}",
            s.wakes,
            s.claimed,
            s.claimed_on_retry,
            s.nothing,
            s.silent,
            s.failed,
            s.mismatch,
            s.lost,
            s.pulled,
            s.started,
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

    // ── I2d ────────────────────────────────────────────────────────────────────────────────

    fn pull_id(f: &OperatorToServerFrame) -> (String, u32, Vec<String>) {
        match f {
            OperatorToServerFrame::WorkPull {
                request_id,
                max,
                agents,
                ..
            } => (request_id.clone(), *max, agents.clone().unwrap_or_default()),
            other => panic!("pull 프레임이 아니다: {other:?}"),
        }
    }

    fn pulling() -> WorkClaims {
        let mut w = opened();
        w.set_pull(true);
        w
    }

    #[test]
    fn pull_is_off_by_default_and_asks_only_for_free_slots() {
        let mut w = opened();
        assert_eq!(
            w.pull(Some(4), 0, vec!["a1".into()], 0),
            None,
            "스위치가 꺼져 있다"
        );
        let mut w = pulling();
        assert_eq!(w.pull(Some(4), 0, vec![], 0), None, "풀 에이전트가 없다");
        assert_eq!(
            w.pull(Some(4), 4, vec!["a1".into()], 0),
            None,
            "빈 칸이 없다"
        );
        let f = w.pull(Some(4), 1, vec!["a1".into()], 0).unwrap();
        let (id, max, agents) = pull_id(&f);
        assert_eq!((max, agents), (3, vec!["a1".to_string()]));
        // 답을 기다리는 동안은 다시 묻지 않는다.
        assert_eq!(w.pull(Some(4), 1, vec!["a1".into()], PULL_EVERY_MS), None);
        let out = w.on_pulled(
            &id,
            &[item("w1", "a1", "t1", 1), item("w2", "a1", "t2", 1)],
            None,
            10,
        );
        assert_eq!(out.wake, vec!["a1".to_string()]);
        assert!(out.release.is_empty() && out.off.is_none());
        assert_eq!((w.held_count(), w.unstarted_count()), (2, 2));
        // 주기 안에서는 묻지 않는다. 주기가 지나면 「아직 턴이 안 선 줄」을 빈 칸에서 뺀다.
        assert_eq!(
            w.pull(Some(4), 1, vec!["a1".into()], PULL_EVERY_MS - 1),
            None
        );
        let f = w
            .pull(Some(4), 1, vec!["a1".into()], PULL_EVERY_MS)
            .unwrap();
        assert_eq!(pull_id(&f).1, 1);
        // 상한이 없으면 한 번의 상한까지만.
        let mut w = pulling();
        assert_eq!(
            pull_id(&w.pull(None, 50, vec!["a1".into()], 0).unwrap()).1,
            PULL_MAX as u32
        );
    }

    #[test]
    fn pulled_rows_of_unasked_agents_and_late_answers_are_released_not_held() {
        let mut w = pulling();
        let (id, ..) = pull_id(&w.pull(Some(4), 0, vec!["a1".into()], 0).unwrap());
        let out = w.on_pulled(
            &id,
            &[item("w1", "a1", "t1", 1), item("w9", "other", "t9", 2)],
            None,
            0,
        );
        assert_eq!(out.wake, vec!["a1".to_string()]);
        assert_eq!(
            out.release,
            vec![OperatorToServerFrame::WorkRelease {
                work_id: "w9".into(),
                attempts: 2,
                reason: "released".into()
            }]
        );
        assert_eq!(w.held_count(), 1);
        // 모르는 요청의 답은 전부 놓는다.
        let out = w.on_pulled("nope", &[item("w3", "a1", "t3", 1)], None, 0);
        assert_eq!(
            (out.wake.len(), out.release.len(), w.held_count()),
            (0, 1, 1)
        );
    }

    #[test]
    fn pull_steps_back_alone_when_the_server_switch_is_off_or_silent() {
        let mut w = pulling();
        hold(&mut w, "w1", "a1", "t1", 1, 0);
        let (id, ..) = pull_id(&w.pull(Some(4), 0, vec!["a1".into()], 0).unwrap());
        let out = w.on_pulled(&id, &[], Some("work_pull_disabled"), 0);
        assert_eq!(out.off, Some(Off::Disabled));
        // pull 만 물러난다 — 깨움 때 잡기와 쥔 줄은 그대로다.
        assert_eq!(
            (w.off(), w.pull_off(), w.held_count()),
            (None, Some(Off::Disabled), 1)
        );
        assert_eq!(
            w.pull(Some(4), 0, vec!["a1".into()], PULL_EVERY_MS * 2),
            None
        );
        assert!(w.on_wake("a1", "t2", true, 0).is_some());
        // 다시 붙으면 다시 묻는다.
        w.on_open();
        assert!(w.pull(Some(4), 0, vec!["a1".into()], 0).is_some());
        // 답이 없으면(모르는 서버) 몇 번 뒤 pull 만 물러난다.
        let mut w = pulling();
        let mut now = 0;
        let mut off = None;
        for _ in 0..SILENT_LIMIT {
            assert!(w.pull(Some(4), 0, vec!["a1".into()], now).is_some());
            now += PULL_EVERY_MS.max(ANSWER_DEADLINE_MS);
            off = w.tick(now, &|_| true).pull_off;
        }
        assert_eq!(
            (off, w.pull_off(), w.off()),
            (Some(Off::Silent), Some(Off::Silent), None)
        );
    }

    #[test]
    fn start_turn_hands_the_held_row_and_end_turn_releases_it_only_when_pull_is_on() {
        // 꺼져 있을 때: 넘기기는 하지만(기록), 턴이 끝나도 줄은 러너가 끝날 때까지 쥔다(지금 동작).
        let mut w = opened();
        hold(&mut w, "w1", "a1", "t1", 3, 0);
        assert_eq!(w.start_turn("a1", "nope"), None);
        assert_eq!(
            w.start_turn("other", "t1"),
            None,
            "다른 에이전트의 줄은 넘기지 않는다"
        );
        let want = Some(TurnWork {
            work_id: "w1".into(),
            attempts: 3,
        });
        assert_eq!(w.start_turn("a1", "t1"), want);
        assert_eq!(w.start_turn("a1", "t1"), want, "다시 물어도 같은 답");
        assert_eq!((w.stats().started, w.unstarted_count()), (1, 0));
        w.end_turn("a1", "t1");
        assert!(w.tick(1_000, &|_| true).frames.is_empty());
        assert_eq!(w.held_count(), 1);
        // 켜져 있을 때: 턴이 끝난 줄은 다음 주기 일에서 놓는다.
        let mut w = pulling();
        hold(&mut w, "w1", "a1", "t1", 3, 0);
        w.end_turn("a1", "t1");
        assert!(
            w.tick(1_000, &|_| true).frames.is_empty(),
            "턴이 서지 않은 줄은 끝낼 수 없다"
        );
        w.start_turn("a1", "t1");
        w.end_turn("a1", "t1");
        assert_eq!(
            w.tick(2_000, &|_| true).frames,
            vec![OperatorToServerFrame::WorkRelease {
                work_id: "w1".into(),
                attempts: 3,
                reason: "released".into()
            }]
        );
        assert_eq!(w.held_count(), 0);
        // 켜져 있을 때: 턴이 서지 않은 줄은 기한 뒤에 놓는다(러너가 떠 있어도).
        hold(&mut w, "w2", "a1", "t2", 1, 10_000);
        assert!(
            w.tick(10_000 + UNSTARTED_AFTER_MS - 1, &|_| true)
                .frames
                .iter()
                .all(|f| !matches!(f, OperatorToServerFrame::WorkRelease { .. }))
        );
        assert!(w.tick(10_000 + UNSTARTED_AFTER_MS, &|_| true).frames.iter().any(
            |f| matches!(f, OperatorToServerFrame::WorkRelease { work_id, .. } if work_id == "w2")
        ));
    }

    #[test]
    fn slot_answer_carries_the_held_work_for_that_agent_and_thread_only() {
        let claims: WorkClaimsHandle = std::sync::Arc::new(std::sync::Mutex::new(pulling()));
        hold(&mut claims.lock().unwrap(), "w1", "a1", "t1", 2, 0);
        let req = |path: &str, key: &str| RunnerLinkRequest::HttpForward {
            id: "q".into(),
            method: "POST".into(),
            path: path.into(),
            body: Some(serde_json::json!({ "key": key }).to_string()),
            content_type: None,
            body_base64: None,
        };
        let ans = |status: u16, body: &str| RunnerLinkResponse::HttpResponse {
            id: "q".into(),
            status,
            body: body.into(),
        };
        let body_of = |r: RunnerLinkResponse| match r {
            RunnerLinkResponse::HttpResponse { body, .. } => body,
            other => panic!("unexpected {other:?}"),
        };
        let granted = r#"{"max":4,"inUse":1}"#;
        let slots = crate::turn_slots::TURN_SLOTS_PATH;
        // 다른 에이전트·다른 스레드·뿌리 없는 키·꽉 찬 답(409)에는 싣지 않는다.
        for (agent, key, status) in [
            ("a2", "c1/t1", 200),
            ("a1", "c1/t2", 200),
            ("a1", "c1/_root", 200),
            ("a1", "c1/t1", 409),
        ] {
            let out = body_of(on_slot_answer(
                &claims,
                agent,
                &req(slots, key),
                ans(status, granted),
            ));
            assert_eq!(out, granted, "{agent} {key} {status}");
        }
        assert_eq!(claims.lock().unwrap().unstarted_count(), 1);
        let out = body_of(on_slot_answer(
            &claims,
            "a1",
            &req(slots, "c1/t1"),
            ans(200, granted),
        ));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["work"],
            serde_json::json!({"workId": "w1", "attempts": 2})
        );
        assert_eq!((v["max"].as_u64(), v["inUse"].as_u64()), (Some(4), Some(1)));
        assert_eq!(claims.lock().unwrap().unstarted_count(), 0);
        // 칸을 놓으면 턴이 끝난 것으로 적힌다 — 다음 주기 일에서 놓는다.
        let rel = crate::turn_slots::TURN_SLOTS_RELEASE_PATH;
        on_slot_answer(&claims, "a1", &req(rel, "c1/t1"), ans(204, ""));
        assert_eq!(claims.lock().unwrap().tick(1, &|_| true).frames.len(), 1);
    }
}
