//! 위임 = 하위 작업 행 + 턴 끝 판정(D1) — **그림자만**. 기존 동작은 바꾸지 않는다.
//!
//! - 위임의 정본은 여전히 `team_delegation`·`team_delegation_item` 이다. 여기서는 그 옆에 `work` 행을 따라 적는다:
//!   위임 글이 커밋된 뒤 [`delegation_created`] 가 위임자의 부모 작업을 찾거나 만들고 담당마다 하위 작업(`running`)을 세운다.
//!   의무가 닫히는 자리마다(`measure::delegation_outcomes` 옆) [`delegation_closed`] 가 그 하위 작업을 닫고
//!   `delegation.closed` 사건을 남긴다.
//! - **기존 트랜잭션 안에서 문장을 돌리지 않는다.** 모두 요청 밖(`tokio::spawn`)에서 다른 연결로 돈다 — 실패는 로그 한 줄
//!   (오류 갈래만)로 삼킨다. 닫힘 훅은 부른 쪽 tx 가 커밋되기 전에 돌 수 있어, 그 tx 가 롤백되면 작업 행이 앞서 닫힌다(근삿값).
//! - 결말 → 작업 상태는 [`state_for`] 의 표다.
//! - 턴 끝 판정 [`judge`] 는 순수 함수다(사실 → 판정). 이 단계에서는 판정을 어디에도 적지 않는다 — 서버가 턴 끝을 보는 자리에
//!   잇는 일은 다음 단계다.
//! - 스위치 `HARKROOM_TURN_END_JUDGE`(`off` | `shadow`(기본) | `on`) — [`switch_from_env`]. `off` 면 그림자 기록을 켜지 않는다.
//!   **이 단계에서 `on` 은 `shadow` 와 똑같이 돈다** — 판정에 따라 담당을 다시 부르는 일은 다음 단계에서 붙는다.
use super::work::{self, NewWork};
use serde_json::json;
use sqlx::PgPool;
use std::sync::OnceLock;

/// 그림자 기록이 쓰는 권한 — `work::WORK_PRIVILEGES` + 위임 표 읽기 + 182 의 새 칸 + 위임 글의 원장 칸 읽기. 시퀀스는 `work::WORK_SEQUENCE_PRIVILEGES`.
/// 없으면 `main.rs` 가 켜지 않는다(나머지는 그대로 돈다). `work.delegation_id` 줄은 마이그레이션 182 가 안 깔린 DB 를 거른다.
pub const WORK_SHADOW_PRIVILEGES: &[(&str, &str)] = &[
    ("work", "SELECT"),
    ("work", "INSERT"),
    ("work", "UPDATE"),
    ("work.delegation_id", "INSERT"),
    ("work_event", "SELECT"),
    ("work_event", "INSERT"),
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    // 하위 작업의 원인 사람·위임장을 위임 글 행에서 읽는다(`work::INSERT_DELEGATED_SQL`).
    ("message.id", "SELECT"),
    ("message.principal_account_id", "SELECT"),
    ("message.mandate_id", "SELECT"),
];

/// 하위 작업이 닫힐 때 남기는 사건 종류.
pub const EVENT_DELEGATION_CLOSED: &str = "delegation.closed";
/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_TURN_END_JUDGE";

static POOL: OnceLock<PgPool> = OnceLock::new();

/// 그림자 기록을 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 스위치 값. `On` 은 이 단계에서 `Shadow` 와 같은 동작이다(모듈 머리 참고).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    Off,
    Shadow,
    On,
}

/// 스위치 글자를 읽는다 — 없거나 모르는 값이면 `Shadow`(기본). 앞뒤 공백·대소문자는 가리지 않는다.
pub fn parse_switch(raw: Option<&str>) -> Switch {
    match raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("off") => Switch::Off,
        Some("on") => Switch::On,
        _ => Switch::Shadow,
    }
}

/// 환경 변수 [`SWITCH_ENV`] 에서 읽는다.
pub fn switch_from_env() -> Switch {
    parse_switch(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// 위임 결말(`team_delegation_item.outcome`) → 하위 작업 상태.
///
/// | 결말 | 작업 상태 | 까닭 |
/// |---|---|---|
/// | `reported`·`done` | `done` | 담당이 보고했다 |
/// | `failed` | `failed` | 담당이 실패를 알렸다 |
/// | `timeout` | `failed` | 기한까지 답이 없었다 — 일은 되지 않았다 |
/// | `closed`(대체·위임자 닫음·idle·max_age)·`canceled` | `canceled` | 결과와 무관하게 접혔다 |
///
/// 모르는 결말은 `None`(아무것도 하지 않는다).
pub fn state_for(outcome: &str) -> Option<&'static str> {
    match outcome {
        "reported" | "done" => Some("done"),
        "failed" | "timeout" => Some("failed"),
        "closed" | "canceled" => Some("canceled"),
        _ => None,
    }
}

fn kind_of(e: &sqlx::Error) -> &'static str {
    e.as_database_error().map_or("io", |_| "db")
}

fn spawn<F>(f: impl FnOnce(&'static PgPool) -> F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let Some(pool) = POOL.get() else { return };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    rt.spawn(f(pool));
}

/// 위임 글이 **커밋된 뒤** 부른다 — 요청 밖에서 부모·하위 작업 행을 세운다. 꺼져 있으면 아무것도 하지 않는다.
pub fn delegation_created(delegation_id: &str) {
    let id = delegation_id.to_owned();
    spawn(move |pool| async move {
        if let Err(e) = delegation_created_with(pool, &id).await {
            eprintln!("work shadow: delegation.created skipped ({})", kind_of(&e));
        }
    });
}

/// [`delegation_created`] 의 몸통. 되풀이해도 같은 결과다 — 부모는 열린 행을 다시 찾고, 하위는 (위임, 담당) 유일 인덱스가 막는다.
/// 새로 만든 하위 작업 수를 돌려준다. 위임 행이 없으면 0.
pub async fn delegation_created_with(pool: &PgPool, delegation_id: &str) -> sqlx::Result<usize> {
    let head: Option<(String, String, String, String, String)> = sqlx::query_as(
        "select channel_id::text, thread_root_id::text, lead_account_id::text, message_id::text, \
                to_char(deadline_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') \
           from team_delegation where id = $1::uuid",
    )
    .bind(delegation_id)
    .fetch_optional(pool)
    .await?;
    let Some((channel, thread, lead, message, deadline)) = head else {
        return Ok(0);
    };
    let delegates: Vec<String> = sqlx::query_scalar(
        "select delegate_account_id::text from team_delegation_item \
          where delegation_id = $1::uuid order by delegate_account_id",
    )
    .bind(delegation_id)
    .fetch_all(pool)
    .await?;
    if delegates.is_empty() {
        return Ok(0);
    }
    // 위임자의 부모 작업 — 그 스레드에서 위임자가 맡은 열린 작업 가운데 가장 새것(위임자 자신이 받은 위임의 하위 작업일 수 있다).
    let found: Option<String> = sqlx::query_scalar(
        "select id::text from work \
          where thread_root_id = $1::uuid and assignee_account_id = $2::uuid and closed_at is null \
          order by created_at desc, id desc limit 1",
    )
    .bind(&thread)
    .bind(&lead)
    .fetch_optional(pool)
    .await?;
    let parent = match found {
        Some(p) => p,
        None => {
            let root = NewWork {
                channel_id: &channel,
                thread_root_id: &thread,
                source_message_id: Some(&thread),
                assignee_account_id: Some(&lead),
                ..Default::default()
            };
            match work::create(pool, &root, None).await? {
                Some(p) => p,
                None => return Ok(0),
            }
        }
    };
    let mut made = 0;
    for d in &delegates {
        let child = NewWork {
            channel_id: &channel,
            thread_root_id: &thread,
            parent_id: Some(&parent),
            source_message_id: Some(&message),
            assignee_account_id: Some(d),
            requester_account_id: Some(&lead),
            due_at_iso: Some(&deadline),
            delegation_id: Some(delegation_id),
            ..Default::default()
        };
        // 이미 있으면(되풀이) `None` — 상태도 건드리지 않는다.
        if let Some(id) = work::create(pool, &child, Some(&lead)).await? {
            work::set_state(pool, &id, "running", None).await?;
            made += 1;
        }
    }
    Ok(made)
}

/// 닫힌 위임 의무들 — `ids` 는 **위임 id**(`team_delegation.id`)다(`measure::delegation_outcomes` 와 같은 값).
/// `delegate` 가 있으면 그 담당의 하위 작업만, 없으면 그 위임의 아직 안 끝난 하위 작업 전부를 닫는다
/// (이미 끝난 작업은 그대로 둔다 — 보고된 뒤 idle 로 닫히는 의무는 작업이 이미 `done` 이다).
pub fn delegation_closed(
    ids: &[String],
    delegate: Option<&str>,
    outcome: &str,
    reason: Option<&str>,
) {
    if ids.is_empty() || POOL.get().is_none() {
        return;
    }
    let (ids, delegate) = (ids.to_vec(), delegate.map(str::to_owned));
    let (outcome, reason) = (outcome.to_owned(), reason.map(str::to_owned));
    spawn(move |pool| async move {
        for id in &ids {
            let r =
                delegation_closed_with(pool, id, delegate.as_deref(), &outcome, reason.as_deref());
            if let Err(e) = r.await {
                eprintln!("work shadow: delegation.closed skipped ({})", kind_of(&e));
            }
        }
    });
}

/// [`delegation_closed`] 의 몸통(위임 하나). 닫은 하위 작업 수를 돌려준다. 모르는 결말이면 0.
pub async fn delegation_closed_with(
    pool: &PgPool,
    delegation_id: &str,
    delegate: Option<&str>,
    outcome: &str,
    reason: Option<&str>,
) -> sqlx::Result<usize> {
    let Some(state) = state_for(outcome) else {
        return Ok(0);
    };
    let open: Vec<String> = sqlx::query_scalar(
        "select id::text from work \
          where delegation_id = $1::uuid and closed_at is null \
            and ($2::uuid is null or assignee_account_id = $2::uuid) \
          order by created_at, id",
    )
    .bind(delegation_id)
    .bind(delegate)
    .fetch_all(pool)
    .await?;
    let mut n = 0;
    for w in &open {
        if work::set_state(pool, w, state, None).await? {
            let payload = json!({ "outcome": outcome, "reason": reason });
            work::append_event(pool, w, EVENT_DELEGATION_CLOSED, None, &payload).await?;
            n += 1;
        }
    }
    Ok(n)
}

/// 턴이 끝났을 때 서버가 아는 사실. 모두 「그 에이전트 × 그 스레드 × 그 턴」 기준이다.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    /// 이 턴에 보고(`message.report`)를 냈다.
    pub posted_report: bool,
    /// 이 턴에 실패(`message.fail`)를 알렸다.
    pub posted_fail: bool,
    /// 사람에게 건 물음이 열려 있다.
    pub open_ask: bool,
    /// 스스로 예약한 깨움이 남아 있다.
    pub scheduled_wake: bool,
    /// 자기가 넘긴 하위 위임이 열려 있다.
    pub sub_delegation_open: bool,
    /// 이 턴에 글을 하나라도 냈다(보고·실패가 아니어도). 판정을 바꾸지 않는다 — 기록에 같이 싣는 재료다.
    pub posted_any: bool,
    /// 턴이 취소됐다(사람이 멈췄거나 새 부름이 밀어냈다).
    pub turn_canceled: bool,
}

/// 턴 끝 판정. `Silent` 만이 「맡은 일이 아무 매듭 없이 남았다」다 — 다음 단계가 담당을 다시 부를 근거.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 매듭지었다 — 보고·실패를 냈거나, 턴이 취소돼 따로 정리된다.
    Settled,
    /// 사람의 답을 기다린다.
    WaitingOnHuman,
    /// 예약한 깨움을 기다린다.
    WaitingOnWake,
    /// 하위 위임의 결말을 기다린다.
    WaitingOnChild,
    /// 아무 매듭 없이 끝났다(글을 냈더라도 보고·실패·기다림이 없다).
    Silent,
}

impl Verdict {
    /// 사건 payload 에 싣는 이름.
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Settled => "settled",
            Verdict::WaitingOnHuman => "waiting_on_human",
            Verdict::WaitingOnWake => "waiting_on_wake",
            Verdict::WaitingOnChild => "waiting_on_child",
            Verdict::Silent => "silent",
        }
    }
}

/// 사실 → 판정(순수). 앞선 줄이 이긴다:
/// 1. 보고·실패를 냈다 → `Settled`(의무가 이미 닫혔다).
/// 2. 턴이 취소됐다 → `Settled`(취소 정리 길이 따로 닫는다 — 다시 부르면 취소를 거스른다).
/// 3. 열린 물음 → `WaitingOnHuman`(사람이 막고 있으면 다른 기다림보다 먼저 보인다).
/// 4. 열린 하위 위임 → `WaitingOnChild`.
/// 5. 예약한 깨움 → `WaitingOnWake`.
/// 6. 그 밖 → `Silent`.
pub fn judge(f: Facts) -> Verdict {
    if f.posted_report || f.posted_fail || f.turn_canceled {
        Verdict::Settled
    } else if f.open_ask {
        Verdict::WaitingOnHuman
    } else if f.sub_delegation_open {
        Verdict::WaitingOnChild
    } else if f.scheduled_wake {
        Verdict::WaitingOnWake
    } else {
        Verdict::Silent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_parses_with_shadow_default() {
        for (raw, want) in [
            (None, Switch::Shadow),
            (Some(""), Switch::Shadow),
            (Some("shadow"), Switch::Shadow),
            (Some("off"), Switch::Off),
            (Some(" OFF "), Switch::Off),
            (Some("on"), Switch::On),
            (Some("On"), Switch::On),
            (Some("1"), Switch::Shadow),
            (Some("true"), Switch::Shadow),
        ] {
            assert_eq!(parse_switch(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn outcome_maps_to_a_known_closed_work_state() {
        for (outcome, want) in [
            ("reported", Some("done")),
            ("done", Some("done")),
            ("failed", Some("failed")),
            ("timeout", Some("failed")),
            ("closed", Some("canceled")),
            ("canceled", Some("canceled")),
            ("", None),
            ("open", None),
        ] {
            assert_eq!(state_for(outcome), want, "{outcome}");
            if let Some(s) = want {
                assert!(work::STATES.contains(&s) && work::is_closed(s));
            }
        }
    }

    #[test]
    fn judge_table() {
        let f = Facts::default();
        let cases = [
            (f, Verdict::Silent),
            (
                Facts {
                    posted_any: true,
                    ..f
                },
                Verdict::Silent,
            ),
            (
                Facts {
                    posted_report: true,
                    ..f
                },
                Verdict::Settled,
            ),
            (
                Facts {
                    posted_fail: true,
                    ..f
                },
                Verdict::Settled,
            ),
            (
                Facts {
                    turn_canceled: true,
                    ..f
                },
                Verdict::Settled,
            ),
            (
                Facts {
                    open_ask: true,
                    ..f
                },
                Verdict::WaitingOnHuman,
            ),
            (
                Facts {
                    scheduled_wake: true,
                    ..f
                },
                Verdict::WaitingOnWake,
            ),
            (
                Facts {
                    sub_delegation_open: true,
                    ..f
                },
                Verdict::WaitingOnChild,
            ),
            // 겹칠 때의 앞뒤.
            (
                Facts {
                    posted_report: true,
                    open_ask: true,
                    scheduled_wake: true,
                    ..f
                },
                Verdict::Settled,
            ),
            (
                Facts {
                    posted_fail: true,
                    sub_delegation_open: true,
                    ..f
                },
                Verdict::Settled,
            ),
            (
                Facts {
                    turn_canceled: true,
                    open_ask: true,
                    ..f
                },
                Verdict::Settled,
            ),
            (
                Facts {
                    open_ask: true,
                    sub_delegation_open: true,
                    scheduled_wake: true,
                    ..f
                },
                Verdict::WaitingOnHuman,
            ),
            (
                Facts {
                    sub_delegation_open: true,
                    scheduled_wake: true,
                    ..f
                },
                Verdict::WaitingOnChild,
            ),
            (
                Facts {
                    scheduled_wake: true,
                    posted_any: true,
                    ..f
                },
                Verdict::WaitingOnWake,
            ),
        ];
        for (facts, want) in cases {
            assert_eq!(judge(facts), want, "{facts:?}");
        }
    }

    /// 일곱 사실의 모든 조합(128)에서 — `posted_any` 는 판정을 바꾸지 않고, `Silent` 는 매듭·기다림이 하나도 없을 때뿐이다.
    #[test]
    fn judge_exhaustive_invariants() {
        for bits in 0u8..128 {
            let b = |i: u8| bits & (1 << i) != 0;
            let facts = Facts {
                posted_report: b(0),
                posted_fail: b(1),
                open_ask: b(2),
                scheduled_wake: b(3),
                sub_delegation_open: b(4),
                posted_any: b(5),
                turn_canceled: b(6),
            };
            let v = judge(facts);
            assert_eq!(
                v,
                judge(Facts {
                    posted_any: !facts.posted_any,
                    ..facts
                })
            );
            let nothing = !(b(0) || b(1) || b(2) || b(3) || b(4) || b(6));
            assert_eq!(v == Verdict::Silent, nothing, "{facts:?}");
            assert_eq!(v == Verdict::Settled, b(0) || b(1) || b(6), "{facts:?}");
        }
    }

    #[test]
    fn verdict_names_are_distinct() {
        let all = [
            Verdict::Settled,
            Verdict::WaitingOnHuman,
            Verdict::WaitingOnWake,
            Verdict::WaitingOnChild,
            Verdict::Silent,
        ];
        let names: std::collections::HashSet<_> = all.iter().map(|v| v.as_str()).collect();
        assert_eq!(names.len(), all.len());
    }

    #[test]
    fn hooks_are_noops_when_not_enabled() {
        // 풀이 없으면(켜지 않았으면) 런타임 밖에서도 그냥 돌아온다.
        delegation_created("00000000-0000-4000-8000-000000000001");
        delegation_closed(
            &["00000000-0000-4000-8000-000000000001".into()],
            None,
            "closed",
            None,
        );
    }
}
