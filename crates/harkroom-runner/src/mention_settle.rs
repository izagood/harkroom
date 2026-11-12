//! 정본 `createMentionScheduler().runOne` 의 결말 갈래(B4-1b-2b-2a) — 턴 임대 판정, 턴이 끝난 뒤의 성공·실패 갈래,
//! 그리고 `finally` 의 장부 정리. 하네스 턴 자체(`withAccountFailover` + `runMentionTurn`)는 이 모듈 밖이다:
//! 호출자가 턴을 돌린 뒤 그 결과를 [`TurnEnd`] 로 접어 [`settle`] 에 넘긴다.
//!
//! 순서는 정본 그대로다.
//! - 임대 판정([`lease_gate`]): 409 `lease_used`·무응답은 8분 동안 조용히 미뤘다 다시 묻는다(시도로 세지 않는다).
//!   상한까지 409 면 실패 통지 → 읽음 → 회계 지움 → 임대 놓기. 무응답은 상한 뒤 비밀 없이 돈다.
//! - 성공: 회계 지움 → 읽음 → 임대 놓기 → 펜싱됐으면 표지 → 종료 요청 전달.
//! - 펜싱(스레드 임대 잃음): 읽음·통지·회계 없이 이번 시도를 세지 않고 표지만 남긴다 — 넘겨받은 러너가 잇는다.
//! - 계정 관문: 재기동(상한 5회·2시간). 상한이면 읽음 처리로 흘려보낸다.
//! - 재시도로 낫지 않는 실패(한도·세션 충돌·API 키 연결·모델 거절·정지): 실패 통지 → 읽음 → 회계 지움 → 임대 놓기.
//! - 그 밖: 시도가 남았으면 재시도 통지(entry 당 1회)와 백오프, 다 썼으면 포기 통지 → 읽음.
//!
//! 통지 실패는 관측의 실패라 판정을 바꾸지 않는다(로그 한 줄). 읽음 처리 실패는 장부의 「읽음 남음」으로 간다
//! ([`Ledger::mark_read_result`]) — 턴을 다시 띄우지 않고 다음 폴에 읽음 처리만 다시 한다.
//! 통지 본문은 [`FailNotice`] 값으로 넘기고 문구 조립은 받는 쪽(B4-2 멘션 턴 본체) 몫이다 — 화면 원문은 여기 없다.

use crate::mention_ledger::{GateRequeueOutcome, Ledger};
use crate::turn_notice::retry_reason;

/// 정본 `policy.ts::MAX_ATTEMPTS`.
pub const MAX_ATTEMPTS: u32 = 3;

/// 정본 `secretLeases.acquire` 의 결과.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseState {
    /// 받았거나, 이 러너가 턴 임대를 쓰지 않는다.
    Ready,
    /// 비밀이 없는 등 — 임대 없이 돈다(정본이 삼키는 거절).
    Declined,
    /// 409 — 앞 러너가 받아 갔다.
    LeaseUsed,
    /// 무응답.
    Unreachable,
}

/// 턴 임대 판정의 결말.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseGate {
    /// 턴을 돌린다.
    Run,
    /// 조용히 미뤘다 — 이 턴은 여기서 끝(시도로 세지 않음).
    Deferred,
    /// 상한까지 409 — 실패 통지·읽음 처리까지 했다.
    GaveUp,
}

/// 하네스 턴이 끝난 모양(정본 `try` 의 반환과 `catch` 의 오류 갈래를 접은 것).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnEnd {
    /// 답을 냈다. `stop_requested_at` 은 턴이 받은 종료 요청 시각.
    Done {
        stop_requested_at: Option<String>,
    },
    /// 계정 관문 때문에 접었다(`AccountGateRequeueError`). `queued` 면 그 계정 설정 폴더의 표식이 지워진 뒤.
    GateRequeue {
        why: String,
        queued_config_dir: Option<String>,
    },
    /// 사용량 한도. `api_line` 은 하네스가 자기 기록에 적은 오류 한 줄(화면이 아니다).
    Quota {
        resets_at: Option<String>,
        api_line: Option<String>,
    },
    SessionConflict {
        message: String,
    },
    /// API 키 연결 실패. `recallable` 은 정본 `providerLaneRecallable(code)`.
    ProviderLane {
        code: String,
        recallable: bool,
    },
    ThreadModelRejected {
        model: Option<String>,
        effort: Option<String>,
        api_error: String,
    },
    /// 하네스 정지. `screen` 은 정지 순간 화면 판정(`gate`·`idle`·`stuck`), `screen_line` 은 가린 한 줄.
    Stall {
        stall_ms: u64,
        screen: Option<String>,
        screen_line: Option<String>,
    },
    /// 그 밖의 실패. `err_text` 는 사람이 보는 자리에 실을 문장(준비 실패면 종류만).
    Other {
        err_text: String,
    },
}

/// 스레드에 남길 실패 통지(정본 `harkroom.fail` 의 본문 + 표지). 본문 문구는 받는 쪽이 조립한다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailBody {
    LeaseLost,
    Quota {
        resets_at: Option<String>,
    },
    SessionConflict,
    ProviderLane {
        code: String,
    },
    ThreadModelRejected {
        model: Option<String>,
        effort: Option<String>,
        api_error: String,
    },
    Stall {
        stall_ms: u64,
        screen: Option<String>,
        screen_line: Option<String>,
    },
    /// 정본 `retryNotice(tried, MAX_ATTEMPTS, reason)`.
    Retry {
        tried: u32,
        reason: Option<String>,
    },
    /// 정본 `FAILURE_NOTICE`.
    GaveUp,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailNotice {
    pub body: FailBody,
    pub retryable: bool,
    pub what: String,
    pub reason: Option<String>,
    /// 실패 표지(`provider_lane`·`thread_model_rejected`).
    pub code: Option<&'static str>,
    /// `provider_lane` 의 세부 코드.
    pub lane_code: Option<String>,
}

/// 결말이 밖에 하는 일(정본 `deps` 중 runOne 결말 몫).
pub trait SettleDeps {
    fn now(&self) -> u64;
    /// 실패 통지. 계정 축 흔적(`withAccountTrail`)은 받는 쪽이 붙인다.
    fn fail(&mut self, notice: &FailNotice) -> Result<(), String>;
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String>;
    /// 턴 임대 놓기(정본 `secretLeases.release`, 실패는 삼킨다).
    fn release_lease(&mut self);
    /// 임대 잃음 표지(정본 `noticeFenced`, 실패는 삼킨다).
    fn notice_fenced(&mut self);
    /// 정본 `turnOutcome` — 성공이면 `true`, 하네스 API 오류로 끝났으면 `false`.
    fn turn_outcome(&mut self, ok: bool);
    fn stop_requested(&mut self, at: &str);
    fn log(&mut self, line: &str);
}

/// 정본 `finish` — 묶음이면 구성원 전부 읽음 처리하고 장부에 결말을 적는다.
fn finish(ledger: &mut Ledger, deps: &mut dyn SettleDeps, lead: i64) {
    let ids = ledger.finish_ids(lead);
    if ids.is_empty() {
        return;
    }
    let ok = match deps.mark_read(&ids) {
        Ok(()) => true,
        Err(e) => {
            deps.log(&format!(
                "entry {} 읽음 처리 실패(턴은 끝났다 — 다시 띄우지 않고 다음 폴에 읽음 처리만 다시 한다): {e}",
                join_ids(&ids)
            ));
            false
        }
    };
    let now = deps.now();
    ledger.mark_read_result(&ids, ok, now);
}

fn join_ids(ids: &[i64]) -> String {
    ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

fn send_fail(deps: &mut dyn SettleDeps, notice: &FailNotice, label: &str) {
    if let Err(e) = deps.fail(notice) {
        deps.log(&format!("{label} 통지 발화 실패(읽음 처리 계속): {e}"));
    }
}

/// 실패 통지 → 읽음 → 회계 지움 → 임대 놓기(재시도로 낫지 않는 갈래의 공통 끝).
fn fail_and_finish(
    ledger: &mut Ledger,
    deps: &mut dyn SettleDeps,
    lead: i64,
    notice: &FailNotice,
    label: &str,
) {
    send_fail(deps, notice, label);
    finish(ledger, deps, lead);
    ledger.settle(lead);
    deps.release_lease();
}

/// 턴 임대 판정(정본 runOne 머리). `tried` 는 이번 시도 번호.
pub fn lease_gate(
    ledger: &mut Ledger,
    deps: &mut dyn SettleDeps,
    lead: i64,
    tried: u32,
    state: LeaseState,
) -> LeaseGate {
    if matches!(state, LeaseState::LeaseUsed | LeaseState::Unreachable) {
        let now = deps.now();
        if ledger.lease_wait(lead, tried, now) {
            return LeaseGate::Deferred;
        }
    }
    ledger.lease_settled(lead);
    if state == LeaseState::LeaseUsed {
        deps.log(&format!(
            "턴 임대를 {}분 동안 다시 받지 못했다(409 lease_used) — 돌리지 않고 실패로 알린다",
            crate::mention_scheduler::LEASE_WAIT_MAX_MS / 60_000
        ));
        let notice = FailNotice {
            body: FailBody::LeaseLost,
            retryable: true,
            what: "이 부름의 턴 임대를 다시 받지 못했다".into(),
            reason: Some(
                "비밀·API 연결·머지를 쓸 수 없는 턴이라 시작하지 않았다 — 다시 부르면 새 임대로 돈다"
                    .into(),
            ),
            code: None,
            lane_code: None,
        };
        fail_and_finish(ledger, deps, lead, &notice, "임대 잃음");
        return LeaseGate::GaveUp;
    }
    LeaseGate::Run
}

/// 턴 결말(정본 runOne 의 `try` 끝 + `catch`). `fenced` 는 이 턴이 쥔 스레드 임대를 잃었다는 신호,
/// `harness_api_error` 는 오류에 하네스 API 오류 줄이 실렸는가(정본 `turnOutcome(false)`).
/// 계정 축 소진 판정(`noticeHarnessLogin`·`exitIfUnrecoverable`)은 호출자가 이 함수 **앞에서** 한다 — 물러남이 통지보다 먼저다.
pub fn settle(
    ledger: &mut Ledger,
    deps: &mut dyn SettleDeps,
    lead: i64,
    tried: u32,
    end: TurnEnd,
    fenced: bool,
    harness_api_error: bool,
) {
    if let TurnEnd::Done { stop_requested_at } = end {
        deps.turn_outcome(true);
        finish(ledger, deps, lead);
        ledger.settle(lead);
        deps.release_lease();
        // 답을 낸 뒤 잃었으면 답은 이미 나갔다 — 읽음은 그대로 두고 접혔다는 사실만 남긴다.
        if fenced {
            deps.notice_fenced();
        }
        if let Some(at) = stop_requested_at {
            deps.stop_requested(&at);
        }
        return;
    }
    if harness_api_error {
        deps.turn_outcome(false);
    }
    // 임대를 잃어 접혔다 — 실패가 아니다. 오류 종류가 아니라 신호로 가른다.
    if fenced {
        ledger.uncount(lead, tried);
        deps.release_lease();
        deps.log("스레드 임대를 잃어 턴을 접었다 — 넘겨받은 러너가 잇는다");
        deps.notice_fenced();
        return;
    }
    match end {
        TurnEnd::Done { .. } => unreachable!("handled above"),
        TurnEnd::GateRequeue {
            why,
            queued_config_dir,
        } => {
            deps.release_lease();
            let dir = if why == "queued" {
                queued_config_dir.as_deref()
            } else {
                None
            };
            let now = deps.now();
            match ledger.gate_requeue(lead, tried, dir, now) {
                GateRequeueOutcome::GiveUp { count } => {
                    deps.log(&format!(
                        "계정 관문 — 다시 띄우기 상한({count}회) — 읽음 처리한다"
                    ));
                    finish(ledger, deps, lead);
                }
                GateRequeueOutcome::Requeue { count } => deps.log(&format!(
                    "계정 관문 — 턴을 접고 다시 띄운다({why}, {count}/{})",
                    crate::mention_scheduler::GATE_REQUEUE_MAX
                )),
            }
        }
        TurnEnd::Quota {
            resets_at,
            api_line,
        } => {
            let api = if resets_at.is_none() {
                api_line
                    .map(|l| format!(" 하네스 오류: {}", l.chars().take(200).collect::<String>()))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            deps.log(&format!(
                "사용량 한도 — 재시도하지 않는다 (풀림: {}){api}",
                resets_at.as_deref().unwrap_or("알 수 없음")
            ));
            let reason = match &resets_at {
                None => "한도가 풀리는 시각을 읽지 못했다".to_string(),
                Some(at) => format!("{at} 에 풀린다"),
            };
            let notice = FailNotice {
                body: FailBody::Quota { resets_at },
                retryable: true,
                what: "사용량 한도로 답하지 못했다".into(),
                reason: Some(reason),
                code: None,
                lane_code: None,
            };
            fail_and_finish(ledger, deps, lead, &notice, "한도");
        }
        TurnEnd::SessionConflict { message } => {
            deps.log(&format!(
                "하네스 세션 충돌 — 재시도하지 않는다 (러너의 세션 상태와 하네스 디스크가 어긋났다): {message}"
            ));
            let notice = FailNotice {
                body: FailBody::SessionConflict,
                retryable: false,
                what: "하네스 세션 상태가 어긋나 답하지 못했다".into(),
                reason: Some(
                    "운영자가 러너 로그를 확인해야 한다 — 다시 불러도 같은 자리에서 실패한다"
                        .into(),
                ),
                code: None,
                lane_code: None,
            };
            fail_and_finish(ledger, deps, lead, &notice, "세션 충돌");
        }
        TurnEnd::ProviderLane { code, recallable } => {
            deps.log(&format!("API 키 연결 실패 — 재시도하지 않는다: {code}"));
            let (retryable, what, reason) = if recallable {
                (
                    true,
                    "턴 임대가 없어 턴을 띄우지 않았다",
                    "러너가 다시 뜨면서 이 멘션의 임대를 잃었다 — 다시 부르면 새 임대로 뜬다",
                )
            } else {
                (
                    false,
                    "API 키 연결을 준비하지 못해 턴을 띄우지 않았다",
                    "데스크톱의 에이전트 설정에서 API 주소·키를 확인해야 한다 — 같은 설정으로는 다시 실패한다",
                )
            };
            // 옛 서버 호환(표지 거절 시 `unknown` → 표지 없이 다시)은 받는 쪽 `fail` 이 한다 — 정본과 같이
            // 입력 검증 거절(-32602)일 때만 다시 올린다(네트워크 실패는 두 번 갈 수 있어 다시 올리지 않는다).
            let notice = FailNotice {
                body: FailBody::ProviderLane { code: code.clone() },
                retryable,
                what: what.into(),
                reason: Some(reason.into()),
                code: Some("provider_lane"),
                lane_code: Some(code),
            };
            fail_and_finish(ledger, deps, lead, &notice, "API 키 연결 실패");
        }
        TurnEnd::ThreadModelRejected {
            model,
            effort,
            api_error,
        } => {
            deps.log(&format!(
                "스레드 지정 모델 거절 — 재시도하지 않는다 ({}·{}): {api_error}",
                model.as_deref().unwrap_or("-"),
                effort.as_deref().unwrap_or("-")
            ));
            let notice = FailNotice {
                body: FailBody::ThreadModelRejected {
                    model,
                    effort,
                    api_error,
                },
                retryable: false,
                what: "이 스레드에 지정한 모델을 하네스가 받지 않았다".into(),
                reason: Some(
                    "스레드 머리의 모델 칩에서 기본으로 되돌리거나 다른 모델을 골라야 한다 — 같은 지정으로는 다시 실패한다"
                        .into(),
                ),
                code: Some("thread_model_rejected"),
                lane_code: None,
            };
            fail_and_finish(ledger, deps, lead, &notice, "모델 거절");
        }
        TurnEnd::Stall {
            stall_ms,
            screen,
            screen_line,
        } => {
            deps.log("하네스 정지 — 재시도하지 않는다 (사람이 그 터미널을 봐야 한다)");
            let s = screen.as_deref();
            let what = if s == Some("idle") {
                "하네스가 답을 올리지 않고 차례를 끝냈다"
            } else {
                "하네스가 서 있어 답하지 못했다"
            };
            let reason = match s {
                Some("gate") => "그 터미널을 열어 화면의 확인 물음에 답해야 한다",
                Some("idle") => "다시 부르면 이어서 한다",
                Some("stuck") => "그 터미널을 열어 화면을 확인해야 한다",
                _ => {
                    "그 터미널을 열어 화면을 확인해야 한다 — 확인을 기다리는 물음이 서 있을 수 있다"
                }
            };
            let notice = FailNotice {
                retryable: s == Some("idle"),
                body: FailBody::Stall {
                    stall_ms,
                    screen,
                    screen_line,
                },
                what: what.into(),
                reason: Some(reason.into()),
                code: None,
                lane_code: None,
            };
            fail_and_finish(ledger, deps, lead, &notice, "정지");
        }
        TurnEnd::Other { err_text } => {
            deps.log(&format!("답변 실패 ({tried}/{MAX_ATTEMPTS}): {err_text}"));
            let reason = retry_reason(&err_text);
            if tried >= MAX_ATTEMPTS {
                deps.log("포기하고 읽음 처리한다");
                let notice = FailNotice {
                    body: FailBody::GaveUp,
                    retryable: false,
                    what: format!("{MAX_ATTEMPTS}회 시도 끝에 답하지 못했다"),
                    reason,
                    code: None,
                    lane_code: None,
                };
                fail_and_finish(ledger, deps, lead, &notice, "실패");
                return;
            }
            // 시도가 남았다 — 재시도 통지는 entry 당 1회. 통지가 실패해도 재시도 회계는 그대로 간다.
            let now = deps.now();
            if ledger.retry_later(lead, tried, now) {
                let notice = FailNotice {
                    body: FailBody::Retry {
                        tried,
                        reason: reason.clone(),
                    },
                    retryable: true,
                    what: "멘션에 답하지 못하고 턴이 끝났다".into(),
                    reason,
                    code: None,
                    lane_code: None,
                };
                if let Err(e) = deps.fail(&notice) {
                    deps.log(&format!("재시도 통지 발화 실패(재시도는 계속된다): {e}"));
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "mention_settle_tests.rs"]
mod tests;
