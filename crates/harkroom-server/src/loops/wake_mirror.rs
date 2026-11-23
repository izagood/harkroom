//! 깨움 거울 sweep(E1) — 에이전트 `inbox` 행을 `wake` 표(181)에 그대로 베낀다. 그림자 단계다: 정본은 여전히 `inbox` 이고,
//! `wake` 를 읽어 판단하는 경로는 없다. 이 루프가 꺼지거나 실패해도 다른 동작은 달라지지 않는다.
//!
//! - 문장 둘, 각각 한 번씩([`MIRROR_SQL`] → [`CLOSE_SQL`]). 이벤트를 내지 않고 `inbox` 를 고치지 않는다.
//! - 베끼기: 계정이 에이전트(`account.kind = 'agent'`)인 inbox 행만. `channel_id`·`thread_root_id` 는 글에서 읽는다(뿌리 글이면 자기 id).
//! - 커서: inbox id 는 커밋 **전에** 매겨지므로 「이미 베낀 가장 큰 id 보다 큰 것」만 보면 늦게 커밋된 작은 id 를 놓친다. 그래서
//!   가장 큰 id 에서 [`MIRROR_SLACK`] 만큼 물러난 창을 다시 훑고, 이미 베낀 행은 anti-join 으로 거른다. 겹쳐 돌아도
//!   `on conflict (inbox_id) do nothing` 이라 한 inbox 행은 한 번만 들어간다(멱등). 창보다 더 늦게(그 사이 에이전트 행이
//!   [`MIRROR_SLACK`] 개 넘게 쌓인 뒤) 커밋된 행은 놓칠 수 있다 — 그림자 단계라 받아들인다.
//! - 표가 비어 있으면 창이 처음부터라, 옛 inbox 행도 한 번에 [`MIRROR_BATCH`] 개씩 차례로 들어온다(이미 읽은 행은 곧바로 닫힌다).
//! - 닫기: 베낀 inbox 행에 `read_at` 이 찍혔으면 `wake` 를 `done` 으로 닫는다(`closed_at` = 그 `read_at`). inbox 행이 지워졌으면 그대로 둔다.
use super::{GateResult, Side, run_gated};
use sqlx::PgPool;
use std::time::Duration;

/// sweep 주기.
pub const WAKE_MIRROR_INTERVAL: Duration = Duration::from_secs(15);
/// 한 sweep 이 베끼는 최대 행 수. [`MIRROR_SQL`] 의 `limit` 과 같아야 한다(시험이 본다).
pub const MIRROR_BATCH: i64 = 500;
/// 가장 큰 베낀 inbox id 에서 물러나 다시 훑는 폭. [`MIRROR_SQL`] 의 수와 같아야 한다(시험이 본다).
pub const MIRROR_SLACK: i64 = 1000;

/// 베끼는 문장 — 아직 베끼지 않은 에이전트 inbox 행을 id 순으로.
pub const MIRROR_SQL: &str = "insert into wake (account_id, message_id, channel_id, thread_root_id, reason, inbox_id, created_at) \
     select i.account_id, i.message_id, m.channel_id, coalesce(m.thread_root_id, m.id), i.reason, i.id, i.created_at \
       from inbox i \
       join account a on a.id = i.account_id and a.kind = 'agent' \
       join message m on m.id = i.message_id \
      where i.id > (select coalesce(max(inbox_id), 0) - 1000 from wake) \
        and not exists (select 1 from wake w where w.inbox_id = i.id) \
      order by i.id limit 500 \
     on conflict (inbox_id) do nothing";

/// 닫는 문장 — 베낀 inbox 행이 읽혔으면(`read_at`) 열린 깨움을 `done` 으로.
pub const CLOSE_SQL: &str = "update wake w set state = 'done', closed_at = i.read_at \
       from inbox i \
      where i.id = w.inbox_id and i.read_at is not null and w.state in ('pending', 'delivered')";

/// 이 루프가 쓰는 권한(표, 권한) — 운영 GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(다른 것은 그대로 돈다).
pub const WAKE_MIRROR_PRIVILEGES: &[(&str, &str)] = &[
    ("wake", "SELECT"),
    ("wake", "INSERT"),
    ("wake", "UPDATE"),
    ("inbox", "SELECT"),
    ("account", "SELECT"),
    ("message", "SELECT"),
];

/// sweep 한 번 — (베낀 수, 닫은 수).
pub async fn sweep(pool: &PgPool) -> Result<(u64, u64), sqlx::Error> {
    let mirrored = sqlx::query(MIRROR_SQL).execute(pool).await?.rows_affected();
    let closed = sqlx::query(CLOSE_SQL).execute(pool).await?.rows_affected();
    Ok((mirrored, closed))
}

/// 루프를 띄운다 — 15초마다. 주인이 `rust` 일 때만 실제로 돈다. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다.
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(WAKE_MIRROR_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            let p = &pool;
            match run_gated(&gate, "wake.mirror", Side::Rust, || async move {
                sweep(p).await.map(|_| ())
            })
            .await
            {
                // 실패는 다음 시각에 다시 한다 — 거울은 늦어도 해가 없다. 오류 문구만(행 내용 없음).
                GateResult::Gate(e) => eprintln!("loop wake.mirror: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop wake.mirror: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_matches_constants() {
        assert_eq!(WAKE_MIRROR_INTERVAL.as_secs(), 15);
        assert!(MIRROR_SQL.contains(&format!("- {MIRROR_SLACK} from wake")));
        assert!(MIRROR_SQL.contains(&format!("limit {MIRROR_BATCH} ")));
    }

    #[test]
    fn mirror_is_agent_only_and_idempotent() {
        assert!(MIRROR_SQL.contains("a.kind = 'agent'"));
        assert!(MIRROR_SQL.contains("not exists (select 1 from wake w where w.inbox_id = i.id)"));
        assert!(MIRROR_SQL.ends_with("on conflict (inbox_id) do nothing"));
        assert!(MIRROR_SQL.contains("coalesce(m.thread_root_id, m.id)"));
    }

    #[test]
    fn close_only_touches_open_rows_with_read_inbox() {
        assert!(CLOSE_SQL.contains("i.read_at is not null"));
        assert!(CLOSE_SQL.contains("w.state in ('pending', 'delivered')"));
        // 지워진 inbox 행은 join 에 걸리지 않는다 — 그대로 둔다.
        assert!(CLOSE_SQL.contains("where i.id = w.inbox_id"));
    }

    #[test]
    fn privileges_cover_exactly_the_tables_touched() {
        let tables: Vec<&str> = WAKE_MIRROR_PRIVILEGES.iter().map(|(t, _)| *t).collect();
        assert_eq!(
            tables,
            ["wake", "wake", "wake", "inbox", "account", "message"]
        );
        assert!(
            WAKE_MIRROR_PRIVILEGES
                .iter()
                .all(|(t, p)| *t == "wake" || *p == "SELECT")
        );
    }

    #[test]
    fn loop_name_is_registered() {
        assert!(super::super::LOOP_NAMES.contains(&"wake.mirror"));
    }
}
