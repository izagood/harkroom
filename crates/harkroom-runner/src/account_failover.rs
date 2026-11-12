//! 정본 `claudeAccounts.ts::withAccountFailover` 와 `mentionScheduler.ts::runOne` 의 계정 표식 갈래(B4-1b-2b-2b).
//!
//! - [`with_account_failover`]: 계정 축을 돌며 같은 일을 시도한다. 계정을 바꿔서 나을 실패(한도·준비 실패·
//!   로그인 풀림)면 다음 계정으로 넘어가고, 아니면 그 오류를 곧바로 돌려준다. 한 계정에서는 **한 번만**
//!   시도한다 — 재시도 회계(`MAX_ATTEMPTS`)와 곱하지 않는다.
//! - [`marks_after`]: 한 시도가 끝난 뒤 그 계정의 「사람 손 필요」(attention)·「로그인 풀림」(auth) 표식을
//!   어떻게 할지. 표식은 프롬프트가 입력창까지 간 것이 확실할 때만 지운다(#1047 security F1).
//!
//! 흔적([`AccountFailure`])에는 **종류만** 담는다 — 화면 원문·오류 문장은 조직 설정 값을 담을 수 있다.
//! 계정 이름은 풀 안의 디렉터리 이름이고 이메일이 아니다.

use crate::account_assign::ClaudeAccount;

/// 정본 `AccountFailureKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountFailureKind {
    /// 관문 화면이 사람의 선택을 기다린다(첫 실행 승인 등).
    Gate,
    /// 사용량 한도.
    Quota,
    /// 하네스 로그인이 풀렸다·없다.
    Credential,
    /// 상한까지 입력창을 못 봤다.
    Timeout,
}

impl AccountFailureKind {
    /// 로그에 적는 이름(정본 문자열과 같다).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gate => "gate",
            Self::Quota => "quota",
            Self::Credential => "credential",
            Self::Timeout => "timeout",
        }
    }
}

/// 정본 `accountFailureOf` 의 결과(계정 이름 없는 몫).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailureOf {
    pub kind: AccountFailureKind,
    pub resets_at: Option<String>,
}

/// 정본 `AccountFailure` — 축이 넘긴 한 칸의 이유.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountFailure {
    /// 계정 이름. 풀이 없는 러너(`[None]`)면 `None`.
    pub account: Option<String>,
    pub kind: AccountFailureKind,
    pub resets_at: Option<String>,
}

/// 시도 오류가 계정 전환 방아쇠인지 말해 준다. `Some` 이면 전환(정본 `switchesAccount` 와 `accountFailureOf` 를
/// 한 판정으로 묶었다 — 정본에서도 둘은 같은 조건이다).
pub trait AccountFailureClass {
    fn account_failure(&self) -> Option<FailureOf>;
}

/// 축이 끝난 오류와 그때까지의 흔적(정본 `accountTrailOf`). 흔적은 축을 한 칸이라도 넘겼을 때만 있다.
#[derive(Debug, PartialEq, Eq)]
pub struct FailoverError<E> {
    pub error: E,
    pub trail: Vec<AccountFailure>,
}

/// 계정 축이 비었다 — 호출자 결함(정본은 던진다). 조용히 성공값을 지어내지 않는다.
#[derive(Debug, PartialEq, Eq)]
pub struct EmptyLane;

/// 정본 `withAccountFailover`. `attempt(account, is_last)` — `is_last` 는 물러설 계정이 남지 않았는가다.
/// `on_switch(from, to, why)` 는 다음 계정으로 넘어갈 때 한 번.
pub fn with_account_failover<T, E, F, S>(
    accounts: &[Option<ClaudeAccount>],
    mut attempt: F,
    mut on_switch: S,
) -> Result<Result<T, FailoverError<E>>, EmptyLane>
where
    E: AccountFailureClass,
    F: FnMut(Option<&ClaudeAccount>, bool) -> Result<T, E>,
    S: FnMut(Option<&ClaudeAccount>, Option<&ClaudeAccount>, Option<AccountFailureKind>),
{
    if accounts.is_empty() {
        return Err(EmptyLane);
    }
    let mut trail: Vec<AccountFailure> = Vec::new();
    let last_idx = accounts.len() - 1;
    for (idx, account) in accounts.iter().enumerate() {
        if idx > 0 {
            on_switch(
                accounts[idx - 1].as_ref(),
                account.as_ref(),
                trail.last().map(|f| f.kind),
            );
        }
        match attempt(account.as_ref(), idx == last_idx) {
            Ok(v) => return Ok(Ok(v)),
            Err(err) => {
                let Some(failure) = err.account_failure() else {
                    // 계정을 바꿔서 나을 실패가 아니다 — 앞 계정들의 이유와 함께 호출자의 실패 경로로.
                    return Ok(Err(FailoverError { error: err, trail }));
                };
                if idx == last_idx {
                    // 모든 계정이 방아쇠에 걸렸다. 계정이 하나뿐이면 흔적 없이(그 오류 자신이 이유다).
                    if accounts.len() >= 2 {
                        trail.push(AccountFailure {
                            account: account.as_ref().map(|a| a.name.clone()),
                            kind: failure.kind,
                            resets_at: failure.resets_at,
                        });
                    }
                    return Ok(Err(FailoverError { error: err, trail }));
                }
                trail.push(AccountFailure {
                    account: account.as_ref().map(|a| a.name.clone()),
                    kind: failure.kind,
                    resets_at: failure.resets_at,
                });
            }
        }
    }
    unreachable!("마지막 계정에서 반드시 돌아간다")
}

/// 한 시도의 끝 모양(표식 판정에 필요한 만큼만).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptEnd {
    /// 끝까지 돌았다.
    Ok,
    /// 화면이 사람의 선택을 기다리며 멈췄다(`PromptNotDelivered` + `Waiting`).
    Waiting,
    /// 로그인이 풀렸다(`accountFailureOf(err).kind == credential`).
    Credential,
    /// 그 밖의 실패.
    OtherErr,
}

/// 표식 하나에 할 일.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Keep,
    Set,
    Clear,
}

/// 한 시도 뒤 그 계정의 표식 처리.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marks {
    /// 「사람 손 필요」(정본 `accountAttention`).
    pub attention: Mark,
    /// 「로그인 풀림」(정본 `accountAuth`).
    pub auth: Mark,
}

/// 정본 runOne 의 `attempt` 콜백 표식 갈래. `delivered` 는 이 시도에서 프롬프트가 입력창까지 갔다는 신호.
/// 계정이 없는 러너(`None`)는 표식이 없으므로 호출자가 부르지 않는다.
pub fn marks_after(end: AttemptEnd, delivered: bool) -> Marks {
    match end {
        AttemptEnd::Ok => Marks {
            attention: if delivered { Mark::Clear } else { Mark::Keep },
            // 이 계정으로 끝까지 돌았다 — 로그인은 살아 있다.
            auth: Mark::Clear,
        },
        AttemptEnd::Waiting => Marks {
            attention: Mark::Set,
            auth: Mark::Keep,
        },
        AttemptEnd::Credential => Marks {
            attention: if delivered { Mark::Clear } else { Mark::Keep },
            auth: Mark::Set,
        },
        AttemptEnd::OtherErr => Marks {
            attention: if delivered { Mark::Clear } else { Mark::Keep },
            auth: Mark::Keep,
        },
    }
}

/// 정본 `onSwitch` 로그 한 줄 — 이유는 종류만.
pub fn switch_log_line(
    mention_id: &str,
    from: Option<&ClaudeAccount>,
    to: Option<&ClaudeAccount>,
    why: Option<AccountFailureKind>,
) -> String {
    let name = |a: Option<&ClaudeAccount>| a.map_or("(기본)".to_string(), |a| a.name.clone());
    format!(
        "  {mention_id} 계정 전환: {} → {} (이유: {})",
        name(from),
        name(to),
        why.map_or("알 수 없음", AccountFailureKind::as_str)
    )
}

#[cfg(test)]
#[path = "account_failover_tests.rs"]
mod tests;
