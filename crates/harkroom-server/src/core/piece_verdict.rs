//! PX5 조각 판정 — 리더가 넘긴 조각(위임이 낳은 하위 작업 행)이 닫힌 뒤 리더가 내리는 수락·재시도·승격·버림을 적는다.
//!
//! - **서버는 품질을 보지 않는다.** 누가 판정할 수 있나·몇 번까지인가만 본다. 판정 행은 `work_verdict`(마이그레이션 188)다.
//! - 판정은 그 조각을 **넘긴 쪽**(`team_delegation.lead_account_id`)만, **닫힌 조각**(`work.closed_at`)에만 한다.
//! - 재시도는 조각당 1번이다([`RETRY_LIMIT`]). 재시도 판정 뒤에는 수락·버림으로만 바꿀 수 있고, 수락·버림은 끝이다(다시 판정할 수 없다).
//! - 승격은 실행 조합이 생긴 뒤의 일이라 칸만 있고 지금은 거절한다([`Refusal::ComboUnimplemented`]).
//! - 재시도로 새 조각을 띄우는 일은 리더가 스스로 다시 부른다 — 여기서는 판정과 횟수만 적는다.
//! - 스위치 `HARKROOM_PIECE_VERDICT`(`on`·`1`·`true` 만 켬, 기본 꺼짐). 자기 쪼개기 스위치(`HARKROOM_SELF_SPLIT`)가 꺼져 있으면
//!   이 길도 닫힌다([`switch_on`]). **이 단계에서는 어떤 도구·경로도 [`decide`] 를 부르지 않는다** — 도구 배선은 다음 단계다.
use sqlx::PgPool;

/// 판정 쓰기가 쓰는 권한. 하나라도 없으면 이 길을 켜지 않는다(fail-closed).
pub const PIECE_VERDICT_PRIVILEGES: &[(&str, &str)] = &[
    ("work_verdict", "SELECT"),
    ("work_verdict", "INSERT"),
    ("work_verdict", "UPDATE"),
    ("work", "SELECT"),
    ("team_delegation", "SELECT"),
];

/// 조각당 재시도 상한. `work_verdict.retry_count` 의 check 와 같은 값이다.
pub const RETRY_LIMIT: i32 = 1;

/// 리더의 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Accept,
    Retry,
    Promote,
    Discard,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Accept => "accept",
            Verdict::Retry => "retry",
            Verdict::Promote => "promote",
            Verdict::Discard => "discard",
        }
    }

    /// 도구 인자 글자 → 판정. 모르는 값은 없음.
    pub fn parse(raw: &str) -> Option<Verdict> {
        match raw {
            "accept" => Some(Verdict::Accept),
            "retry" => Some(Verdict::Retry),
            "promote" => Some(Verdict::Promote),
            "discard" => Some(Verdict::Discard),
            _ => None,
        }
    }
}

/// 판정을 적지 않은 까닭. [`Refusal::code`] 가 응답에 실을 글자다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// 스위치가 꺼져 있다.
    Disabled,
    /// 승격은 실행 조합이 생긴 뒤에 연다.
    ComboUnimplemented,
    /// 그런 조각이 없다(작업 행이 없거나 위임이 낳은 작업이 아니다).
    NotFound,
    /// 내가 넘긴 조각이 아니다.
    NotLeader,
    /// 아직 닫히지 않았다.
    NotClosed,
    /// 이미 재시도를 한 번 했다.
    RetryLimit,
    /// 이미 수락했거나 버렸다.
    AlreadyDecided,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Disabled => "piece_verdict_disabled",
            Refusal::ComboUnimplemented => "combo_unimplemented",
            Refusal::NotFound => "piece_not_found",
            Refusal::NotLeader => "not_piece_leader",
            Refusal::NotClosed => "piece_not_closed",
            Refusal::RetryLimit => "retry_limit",
            Refusal::AlreadyDecided => "already_decided",
        }
    }
}

/// 적힌 판정.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decided {
    pub verdict: Verdict,
    /// 이 조각에 지금까지 내린 재시도 판정 수.
    pub retry_count: i32,
}

/// 두 스위치가 다 켜졌을 때만 연다 — 자기 쪼개기가 꺼져 있으면 판정 스위치만 켜도 닫힌 채다.
pub fn switch_on(self_split: Option<&str>, piece_verdict: Option<&str>) -> bool {
    use super::mcp::delegate_gate::self_split_on;
    self_split_on(self_split) && self_split_on(piece_verdict)
}

fn switch_from_env() -> bool {
    switch_on(
        crate::env_once::get(&crate::env_once::SELF_SPLIT),
        crate::env_once::get(&crate::env_once::PIECE_VERDICT),
    )
}

/// 판정이 지금 상태에서 되는가(순수). `prior` 는 이 조각의 앞 판정(없으면 첫 판정)과 그때까지의 재시도 수다.
pub fn check(verdict: Verdict, prior: Option<(Verdict, i32)>) -> Result<(), Refusal> {
    if verdict == Verdict::Promote {
        return Err(Refusal::ComboUnimplemented);
    }
    match prior {
        None => Ok(()),
        Some((Verdict::Retry, n)) if verdict == Verdict::Retry && n >= RETRY_LIMIT => {
            Err(Refusal::RetryLimit)
        }
        Some((Verdict::Retry, _)) => Ok(()),
        Some(_) => Err(Refusal::AlreadyDecided),
    }
}

/// 한 문장으로 적는다 — 넘긴 쪽·닫힘·재판정 규칙을 문장이 스스로 지킨다(겹쳐 와도 한쪽만 적힌다).
/// `$1` 조각 작업 id, `$2` 판정하는 계정, `$3` 판정, `$4` 판정한 작업(없을 수 있다).
const DECIDE_SQL: &str = "insert into work_verdict (work_id, verdict, decided_by_account_id, decided_by_work_id, retry_count) \
     select w.id, $3::text, $2::uuid, $4::uuid, case when $3::text = 'retry' then 1 else 0 end \
       from work w join team_delegation d on d.id = w.delegation_id \
      where w.id = $1::uuid and d.lead_account_id = $2::uuid and w.closed_at is not null \
     on conflict (work_id) do update \
        set verdict = excluded.verdict, decided_by_account_id = excluded.decided_by_account_id, \
            decided_by_work_id = excluded.decided_by_work_id, decided_at = now() \
      where work_verdict.verdict = 'retry' and excluded.verdict <> 'retry' \
     returning retry_count";

/// 적지 못했을 때 까닭을 가리려고 읽는다: (넘긴 쪽이 나인가, 닫혔나, 앞 판정, 재시도 수).
const WHY_SQL: &str = "select d.lead_account_id = $2::uuid, w.closed_at is not null, v.verdict, v.retry_count \
       from work w join team_delegation d on d.id = w.delegation_id \
       left join work_verdict v on v.work_id = w.id \
      where w.id = $1::uuid";

/// 리더 `me` 가 조각 `work_id` 에 판정을 적는다. 스위치는 env 에서 읽는다.
pub async fn decide(
    pool: &PgPool,
    me: &str,
    work_id: &str,
    verdict: Verdict,
    decided_by_work_id: Option<&str>,
) -> sqlx::Result<Result<Decided, Refusal>> {
    decide_with(
        pool,
        switch_from_env(),
        me,
        work_id,
        verdict,
        decided_by_work_id,
    )
    .await
}

/// [`decide`] 의 몸통 — 스위치를 인자로 받는다(시험).
pub async fn decide_with(
    pool: &PgPool,
    on: bool,
    me: &str,
    work_id: &str,
    verdict: Verdict,
    decided_by_work_id: Option<&str>,
) -> sqlx::Result<Result<Decided, Refusal>> {
    if !on {
        return Ok(Err(Refusal::Disabled));
    }
    if verdict == Verdict::Promote {
        return Ok(Err(Refusal::ComboUnimplemented));
    }
    let wrote: Option<i32> = sqlx::query_scalar(DECIDE_SQL)
        .bind(work_id)
        .bind(me)
        .bind(verdict.as_str())
        .bind(decided_by_work_id)
        .fetch_optional(pool)
        .await?;
    if let Some(retry_count) = wrote {
        return Ok(Ok(Decided {
            verdict,
            retry_count,
        }));
    }
    let why: Option<(bool, bool, Option<String>, Option<i32>)> = sqlx::query_as(WHY_SQL)
        .bind(work_id)
        .bind(me)
        .fetch_optional(pool)
        .await?;
    Ok(Err(match why {
        None => Refusal::NotFound,
        Some((false, ..)) => Refusal::NotLeader,
        Some((_, false, ..)) => Refusal::NotClosed,
        Some((_, _, prior, n)) => {
            let prior = prior
                .as_deref()
                .and_then(Verdict::parse)
                .map(|p| (p, n.unwrap_or(0)));
            // 적지 못했는데 규칙으로는 되는 꼴(겹쳐 온 판정이 먼저 적힘)은 이미 판정된 것으로 답한다.
            check(verdict, prior)
                .err()
                .unwrap_or(Refusal::AlreadyDecided)
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_needs_both() {
        assert!(switch_on(Some("on"), Some("on")));
        assert!(switch_on(Some("1"), Some(" TRUE ")));
        assert!(!switch_on(None, Some("on")), "자기 쪼개기가 꺼지면 닫힌다");
        assert!(!switch_on(Some("on"), None), "기본 꺼짐");
        assert!(!switch_on(Some("on"), Some("shadow")));
        assert!(!switch_on(None, None));
    }

    #[test]
    fn verdict_round_trips() {
        for v in [
            Verdict::Accept,
            Verdict::Retry,
            Verdict::Promote,
            Verdict::Discard,
        ] {
            assert_eq!(Verdict::parse(v.as_str()), Some(v));
        }
        assert_eq!(Verdict::parse("Accept"), None);
        assert_eq!(Verdict::parse(""), None);
    }

    #[test]
    fn first_verdict_rules() {
        assert_eq!(check(Verdict::Accept, None), Ok(()));
        assert_eq!(check(Verdict::Retry, None), Ok(()));
        assert_eq!(check(Verdict::Discard, None), Ok(()));
        assert_eq!(
            check(Verdict::Promote, None),
            Err(Refusal::ComboUnimplemented)
        );
    }

    #[test]
    fn retry_once_then_only_accept_or_discard() {
        let after_retry = Some((Verdict::Retry, 1));
        assert_eq!(check(Verdict::Retry, after_retry), Err(Refusal::RetryLimit));
        assert_eq!(check(Verdict::Accept, after_retry), Ok(()));
        assert_eq!(check(Verdict::Discard, after_retry), Ok(()));
        assert_eq!(
            check(Verdict::Promote, after_retry),
            Err(Refusal::ComboUnimplemented)
        );
    }

    #[test]
    fn accept_and_discard_are_final() {
        for done in [Verdict::Accept, Verdict::Discard] {
            for next in [Verdict::Accept, Verdict::Retry, Verdict::Discard] {
                assert_eq!(
                    check(next, Some((done, 0))),
                    Err(Refusal::AlreadyDecided),
                    "{done:?} -> {next:?}"
                );
            }
        }
    }

    #[test]
    fn sql_keeps_the_rules() {
        assert!(DECIDE_SQL.contains("d.lead_account_id = $2::uuid"));
        assert!(DECIDE_SQL.contains("w.closed_at is not null"));
        assert!(
            DECIDE_SQL.contains("work_verdict.verdict = 'retry' and excluded.verdict <> 'retry'")
        );
        assert!(PIECE_VERDICT_PRIVILEGES.iter().all(|(_, p)| *p != "DELETE"));
        assert_eq!(Refusal::ComboUnimplemented.code(), "combo_unimplemented");
    }
}
