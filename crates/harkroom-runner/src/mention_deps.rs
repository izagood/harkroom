//! `run_one` 이 받는 [`RunDeps`]·[`SettleDeps`] 의 실물(정본 `mentionScheduler.ts` 의 deps 중 runOne 몫).
//!
//! 서버 쪽 일(실패 통지·읽음·턴 임대)은 [`MentionIo`] 하나로 모으고(실물 [`LinkIo`]), 러너 안 일(자리 놓기·감시 끝·
//! 결과 알림·물러나기·로그)은 [`MentionHooks`] 로 받는다. 표식은 계정 config 폴더의 표식 파일(`account_marks`)이다.
//!
//! - 턴 임대: `rest::issue_turn_lease` 가 이미 상태·접힌 코드만 로그에 남긴다 — 여기서도 응답 본문을 어디에도 싣지 않고
//!   [`LeaseState`] 로만 접는다(받은 임대는 `lease_issued` 로만 넘긴다).
//! - 실패 통지: 본문은 `fail_body_text` + 계정 축 흔적(`with_account_trail` — 계정 이름 없이 순번), `reason` 이 없으면
//!   흔적 한 줄. 통지 실패 사유는 로그로만(글로 가지 않는다).

use crate::account_assign::ClaudeAccount;
use crate::account_failover::{AccountFailure, Mark};
use crate::account_marks;
use crate::fail_text::{account_trail_reason, fail_body_text, with_account_trail};
use crate::mcp::{FailOpts, HarkroomMcpClient};
use crate::mention_run::RunDeps;
use crate::mention_settle::{FailNotice, LeaseState, SettleDeps};
use crate::rest::{HarkroomRestClient, LeaseOutcome, RunnerLink, TurnLease};
use crate::turn_policy::AttemptError;

/// 이 스레드의 계정 축을 고르는 닫개(스레드 열쇠, 앵커).
pub type LaneFn<'a> = Box<dyn FnMut(&str, &str) -> Vec<Option<ClaudeAccount>> + 'a>;

/// 서버 쪽 일.
pub trait MentionIo {
    fn fail(
        &mut self,
        channel_id: &str,
        body: &str,
        anchor: Option<&str>,
        opts: &FailOpts,
    ) -> Result<(), String>;
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String>;
    fn issue_lease(&mut self, cause: &str) -> LeaseOutcome;
}

/// 실물 — MCP(실패 통지·읽음)와 REST(턴 임대).
pub struct LinkIo<'a, L: RunnerLink> {
    pub mcp: &'a HarkroomMcpClient<L>,
    pub rest: &'a HarkroomRestClient<L>,
    pub claim_holder: Option<&'a str>,
    pub log: &'a dyn Fn(&str),
}

impl<L: RunnerLink> MentionIo for LinkIo<'_, L> {
    fn fail(
        &mut self,
        channel_id: &str,
        body: &str,
        anchor: Option<&str>,
        opts: &FailOpts,
    ) -> Result<(), String> {
        self.mcp
            .fail(channel_id, body, anchor, opts)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        self.mcp
            .mark_read(ids)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn issue_lease(&mut self, cause: &str) -> LeaseOutcome {
        self.rest
            .issue_turn_lease(cause, self.log, self.claim_holder)
    }
}

/// 러너 안 일.
pub trait MentionHooks {
    fn now(&self) -> u64;
    /// 받은 턴 임대를 넘긴다(정본 `secretLeases` — 오퍼레이터에 맡기기). 토큰은 글·로그에 싣지 않는다.
    fn lease_issued(&mut self, cause: &str, lease: TurnLease);
    /// 이 멘션에 이미 받은 답(재시도·계정 전환 — 정본 `held.get(cause)`). 있으면 다시 발급을 청하지 않는다.
    fn prior_lease(&mut self, _cause: &str) -> Option<LeaseState> {
        None
    }
    /// 서버가 임대를 주지 않았다 — 적어 두고 재시도마다 다시 묻지 않는다.
    fn lease_declined(&mut self, _cause: &str) {}
    /// 턴 임대 놓기(실패는 삼킨다).
    fn release_lease(&mut self);
    fn notice_fenced(&mut self);
    fn turn_outcome(&mut self, ok: bool);
    fn stop_requested(&mut self, at: &str);
    /// 실행 파일이 없다 — 러너가 잘못 세워졌다(정본 `exitIfUnrecoverable`, 물러날 수 있다).
    fn executable_missing(&mut self);
    fn release_slot(&mut self, thread_key: &str);
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str);
    fn log(&mut self, line: &str);
}

/// 멘션 하나의 deps.
pub struct MentionDeps<'a, I: MentionIo, H: MentionHooks> {
    pub io: I,
    pub hooks: H,
    pub channel_id: String,
    pub anchor: Option<String>,
    pub mention_id: String,
    /// 이 스레드의 계정 축(정본 `laneFor`).
    pub lane: LaneFn<'a>,
    trail: Vec<AccountFailure>,
}

impl<'a, I: MentionIo, H: MentionHooks> MentionDeps<'a, I, H> {
    pub fn new(
        io: I,
        hooks: H,
        channel_id: String,
        anchor: Option<String>,
        mention_id: String,
        lane: LaneFn<'a>,
    ) -> Self {
        Self {
            io,
            hooks,
            channel_id,
            anchor,
            mention_id,
            lane,
            trail: Vec::new(),
        }
    }
}

impl<I: MentionIo, H: MentionHooks> SettleDeps for MentionDeps<'_, I, H> {
    fn now(&self) -> u64 {
        self.hooks.now()
    }
    fn fail(&mut self, notice: &FailNotice) -> Result<(), String> {
        let body = with_account_trail(&fail_body_text(&notice.body), &self.trail);
        let opts = FailOpts {
            retryable: notice.retryable,
            what: Some(notice.what.clone()),
            reason: notice
                .reason
                .clone()
                .or_else(|| account_trail_reason(&self.trail)),
            code: notice.code.map(str::to_string),
            lane_code: notice.lane_code.clone(),
            mention_id: Some(self.mention_id.clone()),
            ..FailOpts::default()
        };
        self.io
            .fail(&self.channel_id, &body, self.anchor.as_deref(), &opts)
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        self.io.mark_read(ids)
    }
    fn release_lease(&mut self) {
        self.hooks.release_lease();
    }
    fn notice_fenced(&mut self) {
        self.hooks.notice_fenced();
    }
    fn turn_outcome(&mut self, ok: bool) {
        self.hooks.turn_outcome(ok);
    }
    fn stop_requested(&mut self, at: &str) {
        self.hooks.stop_requested(at);
    }
    fn log(&mut self, line: &str) {
        self.hooks.log(line);
    }
}

impl<I: MentionIo, H: MentionHooks> RunDeps<AttemptError> for MentionDeps<'_, I, H> {
    fn lane(&mut self, thread_key: &str, anchor: &str) -> Vec<Option<ClaudeAccount>> {
        (self.lane)(thread_key, anchor)
    }
    fn acquire_lease(&mut self, mention_id: &str) -> LeaseState {
        if let Some(prior) = self.hooks.prior_lease(mention_id) {
            return prior;
        }
        match self.io.issue_lease(mention_id) {
            LeaseOutcome::Lease(l) => {
                self.hooks.lease_issued(mention_id, l);
                LeaseState::Ready
            }
            LeaseOutcome::LeaseUsed => LeaseState::LeaseUsed,
            LeaseOutcome::Unreachable => LeaseState::Unreachable,
            LeaseOutcome::None => {
                self.hooks.lease_declined(mention_id);
                LeaseState::Declined
            }
        }
    }
    fn attention(&mut self, account: &ClaudeAccount, mark: Mark) {
        match mark {
            Mark::Set => account_marks::mark_attention(&account.config_dir, self.hooks.now()),
            Mark::Clear => {
                account_marks::clear_attention(&account.config_dir);
            }
            Mark::Keep => {}
        }
    }
    fn auth(&mut self, account: &ClaudeAccount, mark: Mark) {
        match mark {
            Mark::Set => {
                account_marks::mark_credential_failed(&account.config_dir, self.hooks.now())
            }
            Mark::Clear => {
                account_marks::clear_credential_failure(&account.config_dir);
            }
            Mark::Keep => {}
        }
    }
    fn account_trail(&mut self, trail: &[AccountFailure]) {
        self.trail = trail.to_vec();
    }
    fn before_fail(&mut self, err: &AttemptError, _mention_id: &str) {
        if err.executable_missing {
            self.hooks.executable_missing();
        }
    }
    fn release_slot(&mut self, thread_key: &str) {
        self.hooks.release_slot(thread_key);
    }
    fn turn_ended(&mut self, thread_key: &str, mention_id: &str) {
        self.hooks.turn_ended(thread_key, mention_id);
    }
}

#[cfg(test)]
#[path = "mention_deps_tests.rs"]
mod tests;
