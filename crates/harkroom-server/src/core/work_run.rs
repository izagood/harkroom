//! I2d 턴 ↔ 작업 잇기 — 턴 임대가 서는 자리와 턴 끝 판정 자리에서 두 가지를 한다.
//!
//! 1. **잡은 줄에 턴 적기**(기록): 러너가 임대를 받으며 넘긴 `(작업, 횟수)` 의 `work_claim.turn_id` 에 그 임대 id 를 적는다
//!    ([`super::work_claim::note_lease_with`]). 잡기 스위치(`HARKROOM_WORK_CLAIM`)가 켜져 있을 때만.
//! 2. **뿌리 작업의 `running`·`waiting`**(스위치 `HARKROOM_WORK_RUN`, `on`·`1`·`true` 만 켬, 기본 꺼짐):
//!    - 임대가 서면 그 턴이 맡은 뿌리 작업을 `open`·`waiting` → `running` 으로([`START_SQL`]).
//!    - 턴 끝 판정이 그 뿌리를 **닫지 않았으면** `running` → `waiting` 으로([`WAIT_SQL`]) — 그 스레드에서 그 에이전트의 다른 턴이
//!      살아 있으면 그대로 둔다.
//!    - 닫는 것은 여전히 턴 끝 판정([`super::turn_end_judge`]) 하나다. 여기서는 닫지 않고, 닫힌 작업을 다시 열지도 않는다.
//!    - 위임이 낳은 하위 작업은 건드리지 않는다(위임 쪽 `work_shadow` 가 `running` 으로 세우고 닫는다).
//!    - 끝내기 없이 만료된 임대는 판정을 지나지 않아 `running` 으로 남는다 — 다음 턴이 서면 그대로 `running`, 아무것도 안 오면
//!      옛 뿌리 정리(`turn_end_judge::sweep`)가 접는다. 그래서 **`running` 은 「지금 턴이 돈다」의 증명이 아니다.**
//! - 「그 턴이 맡은 작업」은 러너가 넘긴 작업 id 가 그 에이전트·그 스레드의 안 닫힌 작업이면 그것, 아니면 턴 끝 판정과 같은 규칙
//!   ([`super::turn_end_judge::WORK_SQL`])으로 찾는다.
//! - **이 상태를 권한·순서·머지 판정의 근거로 읽는 코드를 두지 않는다.** 누가 무엇을 할 수 있는지는 허용 표와 각 길의 문지기가 정한다.
//! - 요청 밖(`tokio::spawn`)에서 돈다 — 임대 발급의 답을 늦추지 않고, 실패는 로그 한 줄(오류 갈래만)로 삼킨다.
use super::work_claim::{self, Held};
use sqlx::PgPool;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// 상태 옮기기에 드는 권한(쓰기 역할). 시퀀스는 `work::WORK_SEQUENCE_PRIVILEGES`. 없으면 `main.rs` 가 켜지 않는다.
pub const WORK_RUN_PRIVILEGES: &[(&str, &str)] = &[
    ("work", "SELECT"),
    ("work", "UPDATE"),
    ("work_event", "SELECT"),
    ("work_event", "INSERT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
];

/// 러너가 넘긴 작업이 맞는가 — `$1` 작업, `$2` 에이전트, `$3` 스레드. 그 에이전트가 그 스레드에서 맡은 안 닫힌 작업일 때만 한 줄.
pub const PASSED_SQL: &str = "select w.id::text from work w \
    where w.id = $1::uuid and w.assignee_account_id = $2::uuid and w.thread_root_id = $3::uuid and w.closed_at is null";

/// 턴이 섰다 — `$1` 작업, `$2` 에이전트, `$3` 임대. 그 에이전트가 맡은 **뿌리**이고 `open`·`waiting` 일 때만 `running` 으로 옮기고
/// `state` 사건(앞 상태·임대)을 같은 문장에 남긴다. 옮긴 수(0 또는 1)를 돌려준다.
pub const START_SQL: &str = "with cur as ( \
       select id, state from work \
        where id = $1::uuid and assignee_account_id = $2::uuid and parent_id is null and delegation_id is null \
          and closed_at is null and state in ('open', 'waiting') for update \
     ), upd as ( \
       update work w set state = 'running', updated_at = now() from cur where w.id = cur.id returning w.id \
     ), ev as ( \
       insert into work_event (work_id, kind, actor_account_id, payload) \
       select cur.id, 'state', $2::uuid, \
              jsonb_build_object('from', cur.state, 'to', 'running', 'by', 'turn', 'leaseId', $3::text) \
         from cur join upd on upd.id = cur.id returning 1 \
     ) select count(*)::int8 from ev";

/// 턴이 끝났는데 판정이 닫지 않았다 — `$1` 작업, `$2` 에이전트, `$3` 임대, `$4` 판정 이름. 그 에이전트가 맡은 **뿌리**이고 `running` 이고
/// 그 스레드에서 그 에이전트의 살아 있는 임대가 없을 때만 `waiting` 으로 옮긴다. 옮긴 수를 돌려준다.
pub const WAIT_SQL: &str = "with cur as ( \
       select w.id, w.state from work w \
        where w.id = $1::uuid and w.assignee_account_id = $2::uuid and w.parent_id is null and w.delegation_id is null \
          and w.closed_at is null and w.state = 'running' \
          and not exists (select 1 from secret_turn_lease tl \
                           where tl.agent_id = w.assignee_account_id and tl.thread_root_id = w.thread_root_id \
                             and tl.ended_at is null and tl.expires_at > now()) \
          for update of w \
     ), upd as ( \
       update work w set state = 'waiting', updated_at = now() from cur where w.id = cur.id returning w.id \
     ), ev as ( \
       insert into work_event (work_id, kind, actor_account_id, payload) \
       select cur.id, 'state', $2::uuid, \
              jsonb_build_object('from', cur.state, 'to', 'waiting', 'by', 'turn', 'leaseId', $3::text, 'verdict', $4::text) \
         from cur join upd on upd.id = cur.id returning 1 \
     ) select count(*)::int8 from ev";

static POOL: OnceLock<PgPool> = OnceLock::new();
/// 상태를 옮기는가(스위치와 권한을 함께 본 값). [`enable`] 이 정한다.
static RUN: AtomicBool = AtomicBool::new(false);
/// 잡은 줄에 턴을 적는가(잡기 스위치와 권한). [`enable`] 이 정한다.
static NOTE: AtomicBool = AtomicBool::new(false);

/// 켬 판정 — `on`·`1`·`true` 만.
pub fn switch_from_env() -> bool {
    work_claim::switch_on(crate::env_once::get(&crate::env_once::WORK_RUN))
}

/// 프로세스에 한 번 건다. `run` 은 상태 옮기기, `note` 는 잡은 줄에 턴 적기. 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool, run: bool, note: bool) {
    if POOL.set(pool).is_ok() {
        RUN.store(run, Ordering::Relaxed);
        NOTE.store(note, Ordering::Relaxed);
    }
}

/// 상태 옮기기가 켜져 있는가.
pub fn running_on() -> bool {
    POOL.get().is_some() && RUN.load(Ordering::Relaxed)
}

fn kind_of(e: &sqlx::Error) -> &'static str {
    e.as_database_error().map_or("io", |_| "db")
}

/// 방금 선 임대 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub lease_id: String,
    pub agent_id: String,
    pub operator_id: String,
    pub thread_root_id: String,
    pub cause_message_id: String,
    /// 러너가 넘긴 (작업, 횟수) — 없을 수 있다(옛 러너·잡은 줄이 없는 턴).
    pub work: Option<Held>,
}

/// 임대 발급이 **성공한 뒤** 부른다 — 요청 밖에서 줄에 턴을 적고(켜져 있으면) 뿌리 작업을 `running` 으로 옮긴다(켜져 있으면).
pub fn turn_started(s: Started) {
    let Some(pool) = POOL.get() else { return };
    let (run, note) = (RUN.load(Ordering::Relaxed), NOTE.load(Ordering::Relaxed));
    if !run && !(note && s.work.is_some()) {
        return;
    }
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    rt.spawn(async move {
        if let Err(e) = turn_started_with(pool, run, note, &s).await {
            eprintln!("work run: turn start skipped ({})", kind_of(&e));
        }
    });
}

/// [`turn_started`] 의 몸통 — (줄에 턴을 적었는가, 뿌리를 `running` 으로 옮겼는가).
pub async fn turn_started_with(
    pool: &PgPool,
    run: bool,
    note: bool,
    s: &Started,
) -> sqlx::Result<(bool, bool)> {
    let mut noted = false;
    if let (true, Some(held)) = (note, &s.work) {
        noted = work_claim::note_lease_with(
            pool,
            true,
            &s.operator_id,
            held,
            &s.lease_id,
            &s.agent_id,
            &s.thread_root_id,
        )
        .await?
        .unwrap_or(false);
    }
    if !run {
        return Ok((noted, false));
    }
    // 러너가 넘긴 작업이 그 에이전트·그 스레드의 안 닫힌 작업이면 그것, 아니면 판정과 같은 규칙으로 찾는다.
    let mut work_id: Option<String> = None;
    if let Some(h) = s
        .work
        .as_ref()
        .filter(|h| super::wake_deliver::is_uuid_shaped(&h.work_id))
    {
        work_id = sqlx::query_scalar(PASSED_SQL)
            .bind(&h.work_id)
            .bind(&s.agent_id)
            .bind(&s.thread_root_id)
            .fetch_optional(pool)
            .await?;
    }
    if work_id.is_none() {
        let found: Option<(String, bool, String)> = sqlx::query_as(super::turn_end_judge::WORK_SQL)
            .bind(&s.thread_root_id)
            .bind(&s.agent_id)
            .bind(&s.cause_message_id)
            .fetch_optional(pool)
            .await?;
        work_id = found.map(|(id, _, _)| id);
    }
    let Some(work_id) = work_id else {
        return Ok((noted, false));
    };
    let moved: i64 = sqlx::query_scalar(START_SQL)
        .bind(&work_id)
        .bind(&s.agent_id)
        .bind(&s.lease_id)
        .fetch_one(pool)
        .await?;
    Ok((noted, moved == 1))
}

/// 턴 끝 판정이 그 뿌리를 닫지 않았다 — `running` 이면 `waiting` 으로([`WAIT_SQL`]). 옮겼으면 `true`.
pub async fn turn_waits(
    pool: &PgPool,
    work_id: &str,
    agent_id: &str,
    lease_id: &str,
    verdict: &str,
) -> sqlx::Result<bool> {
    let moved: i64 = sqlx::query_scalar(WAIT_SQL)
        .bind(work_id)
        .bind(agent_id)
        .bind(lease_id)
        .bind(verdict)
        .fetch_one(pool)
        .await?;
    Ok(moved == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_touch_only_open_roots_of_that_agent_and_never_close() {
        for sql in [START_SQL, WAIT_SQL] {
            assert!(sql.contains("assignee_account_id = $2::uuid"), "{sql}");
            assert!(sql.contains("parent_id is null"), "{sql}");
            assert!(sql.contains("delegation_id is null"), "{sql}");
            assert!(sql.contains("closed_at is null"), "{sql}");
            // 닫지 않는다 — 닫는 것은 턴 끝 판정 하나다.
            assert!(!sql.contains("closed_at = "), "{sql}");
            for closed in ["'done'", "'failed'", "'canceled'"] {
                assert!(!sql.contains(closed), "{sql}");
            }
            // 사건에 임대를 싣는다(되짚을 근거).
            assert!(sql.contains("'leaseId', $3::text"), "{sql}");
        }
        assert!(START_SQL.contains("state in ('open', 'waiting')"));
        assert!(WAIT_SQL.contains("w.state = 'running'"));
        // 다른 턴이 살아 있으면 기다림으로 옮기지 않는다.
        assert!(WAIT_SQL.contains("tl.ended_at is null and tl.expires_at > now()"));
    }

    #[test]
    fn passed_work_must_be_this_agents_open_work_in_this_thread() {
        assert!(PASSED_SQL.contains("w.assignee_account_id = $2::uuid"));
        assert!(PASSED_SQL.contains("w.thread_root_id = $3::uuid"));
        assert!(PASSED_SQL.contains("w.closed_at is null"));
    }

    #[test]
    fn off_until_enabled() {
        // 이 시험 프로세스에서는 아무도 켜지 않는다.
        assert!(!running_on());
        turn_started(Started {
            lease_id: "l".into(),
            agent_id: "a".into(),
            operator_id: "o".into(),
            thread_root_id: "t".into(),
            cause_message_id: "m".into(),
            work: None,
        });
    }

    #[test]
    fn nobody_reads_this_state_as_a_gate() {
        // N2(자동 머지 게이트)·권한 길은 work_claim·work.state 를 근거로 쓰지 않는다 — 이 모듈을 부르는 곳은 임대 발급과 턴 끝 판정뿐이다.
        let src = include_str!("work_run.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert!(!body.contains("merge"));
        assert!(!body.contains("grant"));
    }
}
