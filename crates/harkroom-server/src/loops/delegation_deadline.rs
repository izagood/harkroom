//! 위임 기한 스윕(S5.4 L1) — TS `services/delegations.ts` 의 `createDelegationDeadlineSweeper`(`expireOne`·`sweepV2`)와
//! 그것이 부르는 `autoCloseDelegations`·`flushDelegationUpdates`·`markSettledQuietly` 를 옮긴다. 문지기 이름 `delegation.deadline`.
//!
//! - 15초마다, 기한이 지난 위임을 한 건씩 자기 트랜잭션에서(`for update skip locked`, 최대 [`DELEGATION_SWEEP_BATCH`]건):
//!   1. 열린 팀원의 턴이 **그 스레드에서** 돌고 있으면(`agent_session_live` — 살아 있는 허브의 행만) 기한을 침묵 시계만큼 민다.
//!      TS 는 메모리 허브 + 사본을 보고, 사본 읽기가 실패하면 메모리만 본다(닫히는 쪽). Rust 는 사본 읽기도 같은 트랜잭션이라
//!      실패하면 롤백하고 다음 스윕이 다시 집는다(닫지 않는 쪽 — 행이 남으니 영영 안 닫히지는 않는다).
//!   2. v1(`HARKROOM_DELEGATION_V2` 켜짐)이고 열린 PR 감시가 붙었으면 민다(「외부 대기」).
//!   3. 만든 지 [`DELEGATION_WAIT_MAX_SEC`] 안이고 팀원이 이 스레드에 예약·열린 카드를 두었으면 민다.
//!   4. v1: 멈춤 알림 — 열린 항목에 `stalled_notified_at` 을 찍고 위임자에게 `delegation_update` 를 한 번 넣는다 → 기한을 최대 수명까지.
//!   5. v0: 남은 미결을 `timeout` 으로 닫고 [`notify_if_settled`] 로 위임자를 깨운다.
//! - v1 이면 이어서 `sweepV2`: 자동 닫힘(idle·max_age) + 턴 끝 update 를 한 트랜잭션으로.
//! - 신호(`inbox.updated`·`thread.reportWakes.changed`·대기 줄 `message.updated`)는 같은 트랜잭션의 outbox 로 — 커밋 뒤에만 나간다
//!   ([`announce`]). TS 는 커밋 뒤에 직접 친다. 순서는 같다.
//! - **스위치를 모르면 띄우지 않는다.** `HARKROOM_DELEGATION_V2` 가 없으면(`None`) v0/v1 을 고를 수 없으므로 `main.rs` 가 이 루프를
//!   띄우지 않는다(TS 에 남는다 — `msg_post.rs` 의 위임 갈래와 같은 선택). 권한 표가 모자라도 띄우지 않는다.
use super::{GateResult, Side, run_gated};
use crate::core::turn_settle::{fold_wakes_for_delegation, notify_if_settled};
use crate::core::wake_preempt::{Preempted, announce};
use sqlx::PgPool;
use std::time::Duration;

/// TS `DELEGATION_SWEEP_INTERVAL_MS`.
pub const DELEGATION_SWEEP_INTERVAL: Duration = Duration::from_secs(15);
/// TS `DELEGATION_SWEEP_BATCH`.
pub const DELEGATION_SWEEP_BATCH: i64 = 20;
/// TS `DELEGATION_SILENCE_SEC`.
pub const DELEGATION_SILENCE_SEC: i32 = 10 * 60;
/// TS `DELEGATION_WAIT_MAX_SEC`.
pub const DELEGATION_WAIT_MAX_SEC: i64 = 24 * 60 * 60;
/// TS `DELEGATION_IDLE_SEC`.
pub const DELEGATION_IDLE_SEC: i32 = 6 * 60 * 60;
/// TS `DELEGATION_MAX_AGE_SEC`.
pub const DELEGATION_MAX_AGE_SEC: i32 = 24 * 60 * 60;
/// TS `DELEGATION_UPDATE_QUIET_SEC`.
pub const DELEGATION_UPDATE_QUIET_SEC: i32 = 60;
/// TS `DELEGATION_UPDATE_LIMIT`.
pub const DELEGATION_UPDATE_LIMIT: i32 = 40;
/// TS `RELAY_HUB_TTL_SEC` — 사본 행을 살아 있는 것으로 칠 허브 박동 한도.
const RELAY_HUB_TTL_SEC: i32 = crate::core::relay_live::RELAY_HUB_TTL_SEC as i32;

/// 이 루프가 쓰는 권한 — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
pub const DELEGATION_DEADLINE_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation", "SELECT"),
    ("team_delegation.deadline_at", "UPDATE"),
    ("team_delegation.notified_at", "UPDATE"),
    ("team_delegation_item", "SELECT"),
    ("team_delegation_item.outcome", "UPDATE"),
    ("team_delegation_item.closed_at", "UPDATE"),
    ("team_delegation_item.closed_reason", "UPDATE"),
    ("team_delegation_item.stalled_notified_at", "UPDATE"),
    ("team_delegation_item.update_pending_message_id", "UPDATE"),
    ("team_delegation_item.update_pending_at", "UPDATE"),
    ("team_delegation_item.update_count", "UPDATE"),
    ("agent_session_live", "SELECT"),
    ("relay_hub", "SELECT"),
    ("pr_watch", "SELECT"),
    ("pr_watch_subscriber", "SELECT"),
    ("agent_wake", "SELECT"),
    ("agent_wake.canceled_at", "UPDATE"),
    ("agent_wake.canceled_by_message_id", "UPDATE"),
    ("secret_turn_lease", "SELECT"),
    ("message", "SELECT"),
    ("message.meta", "UPDATE"),
    ("inbox", "SELECT"),
    ("inbox", "INSERT"),
    ("inbox", "DELETE"),
    ("inbox.reason", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const DELEGATION_DEADLINE_SEQUENCE_PRIVILEGES: &[(&str, &str)] =
    &[("event_outbox_id_seq", "USAGE")];

/// 기한을 `now() + 침묵` 뒤로 민다(앞으로만).
const PUSH_SQL: &str = "update team_delegation \
    set deadline_at = greatest(deadline_at, now() + ($2::int * interval '1 second')) where id = $1::uuid";

/// TS `MARK_SETTLED_QUIETLY_SQL`.
const MARK_SETTLED_QUIETLY_SQL: &str = "update team_delegation d set notified_at = now() \
     where d.id = any($1::uuid[]) and d.notified_at is null \
       and not exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.outcome is null)";

enum One {
    Done,
    None,
}

/// TS `expireOne` — 기한이 지난 위임 한 건. `skip` 은 이번 스윕에서 이미 본 위임.
async fn expire_one(pool: &PgPool, v2: bool, skip: &mut Vec<String>) -> Result<One, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let due: Option<(String, String, bool)> = sqlx::query_as(
        "select id::text, thread_root_id::text, created_at > now() - make_interval(secs => $2) from team_delegation \
          where notified_at is null and deadline_at < now() and not (id = any($1::uuid[])) \
          order by deadline_at limit 1 for update skip locked",
    )
    .bind(&*skip)
    .bind(DELEGATION_WAIT_MAX_SEC as i32)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((id, root, young)) = due else {
        tx.commit().await?;
        return Ok(One::None);
    };
    skip.push(id.clone());

    // ① 도는 턴 — 열린 팀원이 이 스레드에서 턴을 돌리고 있으면 민다.
    let working: bool = sqlx::query_scalar(
        "select exists (select 1 from team_delegation_item i \
            join agent_session_live l on l.agent_account_id = i.delegate_account_id \
            join relay_hub h on h.hub_epoch = l.hub_epoch \
           where i.delegation_id = $1::uuid and i.outcome is null \
             and h.seen_at > now() - make_interval(secs => $2) and l.thread_root_id = $3::uuid)",
    )
    .bind(&id)
    .bind(RELAY_HUB_TTL_SEC)
    .bind(&root)
    .fetch_one(&mut *tx)
    .await?;
    if working {
        sqlx::query(PUSH_SQL)
            .bind(&id)
            .bind(DELEGATION_SILENCE_SEC)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(One::Done);
    }

    // ② v1: 열린 PR 감시(TS `OPEN_WATCH_FOR_DELEGATION_SQL`).
    if v2 {
        let watched: bool = sqlx::query_scalar(
            "select exists (select 1 from pr_watch_subscriber s join pr_watch w on w.id = s.watch_id \
              where s.delegation_id = $1::uuid and w.state = 'open' and w.expires_at > now())",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
        if watched {
            sqlx::query(PUSH_SQL)
                .bind(&id)
                .bind(DELEGATION_SILENCE_SEC)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(One::Done);
        }
    }

    // ③ 턴 사이에서 기다림(예약·열린 카드) — 만든 지 상한 안일 때만.
    if young {
        let (wake_at, open_ask): (Option<String>, bool) = sqlx::query_as(
            "with delegate as ( \
               select delegate_account_id as id from team_delegation_item where delegation_id = $1::uuid and outcome is null \
             ) \
             select (select max(w.wake_at) from agent_wake w join message m on m.id = w.message_id \
                      where w.account_id in (select id from delegate) \
                        and w.fired_at is null and w.canceled_at is null \
                        and (coalesce(m.thread_root_id, m.id) = $2::uuid \
                          or lower(m.meta->'wake'->'reportTo'->>'threadRootId') = $2::uuid::text))::text as wake_at, \
                    exists (select 1 from message m \
                             where m.author_id in (select id from delegate) \
                               and m.thread_root_id = $2::uuid \
                               and m.created_at >= (select created_at from team_delegation where id = $1::uuid) \
                               and m.deleted_at is null and m.meta->>'kind' = 'ask' \
                               and m.meta->'ask'->>'answeredWith' is null and m.meta->'ask'->>'closedAt' is null) as open_ask",
        )
        .bind(&id)
        .bind(&root)
        .fetch_one(&mut *tx)
        .await?;
        if wake_at.is_some() || open_ask {
            sqlx::query(
                "update team_delegation \
                    set deadline_at = greatest(deadline_at, now() + ($2::int * interval '1 second'), \
                                               coalesce($3::timestamptz, now()) + ($2::int * interval '1 second')) \
                  where id = $1::uuid",
            )
            .bind(&id)
            .bind(DELEGATION_SILENCE_SEC)
            .bind(wake_at)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(One::Done);
        }
    }

    let mut out = Preempted::default();
    if v2 {
        // ④ v1: 침묵은 닫지 않는다 — 위임자에게 한 번 알리고 열어 둔다.
        let marked = sqlx::query(
            "update team_delegation_item set stalled_notified_at = now() \
              where delegation_id = $1::uuid and outcome is null and stalled_notified_at is null",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        if marked.rows_affected() > 0 {
            let (lead, message): (String, String) = sqlx::query_as(
                "select lead_account_id::text, message_id::text from team_delegation where id = $1::uuid",
            )
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
            let exists: bool =
                sqlx::query_scalar(crate::core::delegation_recall::notice_exists_sql())
                    .bind(&lead)
                    .bind(&message)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                sqlx::query(
                    "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'delegation_update')",
                )
                .bind(&lead)
                .bind(&message)
                .execute(&mut *tx)
                .await?;
                crate::core::wake_write::along_one(&mut tx, &message, &lead).await;
                out.woke.push(lead);
            }
        }
        sqlx::query(
            "update team_delegation set deadline_at = greatest(deadline_at, created_at + ($2::int * interval '1 second')) \
              where id = $1::uuid",
        )
        .bind(&id)
        .bind(DELEGATION_MAX_AGE_SEC)
        .execute(&mut *tx)
        .await?;
    } else {
        // ⑤ v0: 남은 미결을 무응답으로 닫는다(이미 닫힌 것은 그대로).
        let timed_out = sqlx::query(
            "update team_delegation_item set outcome = 'timeout', closed_at = now() \
              where delegation_id = $1::uuid and outcome is null",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        // A1 측정 — 위임 결말(무응답). 닫힌 의무 수를 `value` 로.
        if timed_out > 0 {
            crate::core::measure::record(crate::core::measure::Event {
                kind: crate::core::measure::KIND_DELEGATION_OUTCOME,
                ref_id: Some(id.clone()),
                value: Some(timed_out as i64),
                detail: Some(serde_json::json!({ "outcome": "timeout", "reason": null })),
                ..Default::default()
            });
            // D1 그림자 — 무응답으로 닫힌 의무의 하위 작업. 이 tx 밖(다른 연결)에서 돈다. 기록만.
            crate::core::work_shadow::delegation_closed(
                std::slice::from_ref(&id),
                None,
                "timeout",
                None,
            );
        }
        if let Some(lead) = notify_if_settled(&mut tx, &id, &mut out).await? {
            out.woke.push(lead);
        }
    }
    announce(&mut tx, &out).await?;
    tx.commit().await?;
    Ok(One::Done)
}

/// TS `autoCloseDelegations` — 보고 뒤 idle, 만든 지 max_age 면 `closed`. 깨우지 않는다. 닫은 의무 수.
pub async fn auto_close(conn: &mut sqlx::PgConnection) -> Result<u64, sqlx::Error> {
    Ok(auto_close_ids(conn).await?.0)
}

/// [`auto_close`] 의 몸통 — 닫은 의무 수와 그 위임 id 들(F1b 가 마지막 자기 조각인지 본다).
async fn auto_close_ids(conn: &mut sqlx::PgConnection) -> Result<(u64, Vec<String>), sqlx::Error> {
    let idle: Vec<String> = sqlx::query_scalar(
        "update team_delegation_item \
            set outcome = 'closed', closed_reason = 'idle', update_pending_message_id = null, update_pending_at = null \
          where outcome = 'reported' and coalesce(last_activity_at, closed_at) < now() - make_interval(secs => $1) \
          returning delegation_id::text",
    )
    .bind(DELEGATION_IDLE_SEC)
    .fetch_all(&mut *conn)
    .await?;
    let aged: Vec<String> = sqlx::query_scalar(
        "update team_delegation_item i \
            set outcome = 'closed', closed_reason = 'max_age', closed_at = coalesce(i.closed_at, now()), \
                update_pending_message_id = null, update_pending_at = null \
           from team_delegation d \
          where d.id = i.delegation_id and (i.outcome is null or i.outcome = 'reported') \
            and d.created_at < now() - make_interval(secs => $1) \
          returning i.delegation_id::text",
    )
    .bind(DELEGATION_MAX_AGE_SEC)
    .fetch_all(&mut *conn)
    .await?;
    // A1 측정 — 위임 결말(자동 닫힘). 기록만. 롤백되면 한 번 더 적힐 수 있다(근삿값).
    crate::core::measure::delegation_outcomes(&idle, "closed", Some("idle"));
    crate::core::measure::delegation_outcomes(&aged, "closed", Some("max_age"));
    // D1 그림자 — 자동으로 닫힌 의무의 하위 작업(이미 끝난 작업은 그대로). 이 tx 밖(다른 연결)에서 돈다. 기록만.
    crate::core::work_shadow::delegation_closed(&idle, None, "closed", Some("idle"));
    crate::core::work_shadow::delegation_closed(&aged, None, "closed", Some("max_age"));
    let n = (idle.len() + aged.len()) as u64;
    let ids: Vec<String> = idle.into_iter().chain(aged).collect();
    if !ids.is_empty() {
        sqlx::query(MARK_SETTLED_QUIETLY_SQL)
            .bind(&ids)
            .execute(&mut *conn)
            .await?;
        // 나이로 닫힌 미결 담당을 위임 글의 열린 목록에서 뺀다(idle 은 이미 보고한 담당이라 목록이 그대로다).
        crate::core::turn_settle::sync_open_announce(conn, &ids).await?;
    }
    Ok((n, ids))
}

/// TS `flushDelegationUpdates` — 턴이 끝난 담당의 대기 중 update 를 위임자 inbox 로. 깨운 위임자는 `out.woke` 에.
pub async fn flush_updates(
    conn: &mut sqlx::PgConnection,
    out: &mut Preempted,
) -> Result<(), sqlx::Error> {
    let due: Vec<(String, String, String, String, String, i32)> = sqlx::query_as(
        "select i.delegation_id::text, i.delegate_account_id::text, i.update_pending_message_id::text, \
                d.lead_account_id::text, d.thread_root_id::text, i.update_count \
           from team_delegation_item i \
           join team_delegation d on d.id = i.delegation_id \
          where i.update_pending_message_id is not null \
            and d.lead_account_id <> i.delegate_account_id \
            and (i.update_pending_at <= now() - make_interval(secs => $1) \
                 or exists ( \
                   select 1 from secret_turn_lease l \
                    where l.agent_id = i.delegate_account_id and l.thread_root_id = d.thread_root_id \
                      and l.created_at <= i.update_pending_at \
                      and coalesce(l.ended_at, case when l.expires_at <= now() then l.expires_at end) >= i.update_pending_at)) \
          order by i.update_pending_at \
          limit $2 \
          for update of i skip locked",
    )
    .bind(DELEGATION_UPDATE_QUIET_SEC)
    .bind(DELEGATION_SWEEP_BATCH)
    .fetch_all(&mut *conn)
    .await?;
    for (delegation, delegate, message, lead, root, count) in due {
        sqlx::query(
            "update team_delegation_item set update_pending_message_id = null, update_pending_at = null \
              where delegation_id = $1::uuid and delegate_account_id = $2::uuid",
        )
        .bind(&delegation)
        .bind(&delegate)
        .execute(&mut *conn)
        .await?;
        if count >= DELEGATION_UPDATE_LIMIT {
            sqlx::query(
                "update message set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('delegationUpdateSkipped', 'limit') \
                  where id = $1::uuid",
            )
            .bind(&message)
            .execute(&mut *conn)
            .await?;
            continue;
        }
        // 읽지 않은 update 는 (위임자, 위임) 당 하나.
        let dropped: Vec<i64> = sqlx::query_scalar(
            "delete from inbox x using message m \
              where x.account_id = $1::uuid and x.reason = 'delegation_update' and x.read_at is null \
                and m.id = x.message_id and m.thread_root_id = $2::uuid and m.author_id = $3::uuid and x.message_id <> $4::uuid \
              returning x.id",
        )
        .bind(&lead)
        .bind(&root)
        .bind(&delegate)
        .bind(&message)
        .fetch_all(&mut *conn)
        .await?;
        // 지운 줄의 깨움도 닫는다 — 갈음된 부름이 깨움 행에만 열려 남지 않게.
        crate::core::wake_write::cancel_deleted(conn, &dropped).await;
        let converted = sqlx::query(
            "update inbox set reason = 'delegation_update' \
              where account_id = $1::uuid and message_id = $2::uuid and reason in ('mention', 'delegation_update')",
        )
        .bind(&lead)
        .bind(&message)
        .execute(&mut *conn)
        .await?;
        if converted.rows_affected() == 0 {
            sqlx::query(
                "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'delegation_update')",
            )
            .bind(&lead)
            .bind(&message)
            .execute(&mut *conn)
            .await?;
        }
        // 넣었든 바꿔 적었든 깨움 행을 맞춘다.
        crate::core::wake_write::along_one(conn, &message, &lead).await;
        sqlx::query(
            "update team_delegation_item set update_count = update_count + 1 \
              where delegation_id = $1::uuid and delegate_account_id = $2::uuid",
        )
        .bind(&delegation)
        .bind(&delegate)
        .execute(&mut *conn)
        .await?;
        fold_wakes_for_delegation(conn, &delegation, &lead, &root, &message, out).await?;
        out.woke.push(lead);
    }
    Ok(())
}

/// TS `sweepV2` — 자동 닫힘과 턴 끝 update 를 한 트랜잭션으로.
async fn sweep_v2(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let (_, closed) = auto_close_ids(&mut tx).await?;
    let mut out = Preempted::default();
    // F1b — 자동 닫힘이 마지막 자기 조각을 닫았으면 보류해 둔 형제와 함께 한 번 깨운다. 스위치가 꺼져 있으면 아무것도 하지 않는다.
    out.woke
        .extend(crate::core::split_collect::after_quiet_close(&mut tx, &closed).await?);
    flush_updates(&mut tx, &mut out).await?;
    // TS 는 깨운 위임자를 `new Set` 으로 한 번씩만 친다.
    let mut seen = std::collections::HashSet::new();
    out.woke.retain(|a| seen.insert(a.clone()));
    announce(&mut tx, &out).await?;
    tx.commit().await
}

/// TS `sweep` — 한 건의 실패는 기록만 하고 다음으로(행은 미결로 남아 다음 스윕이 다시 집는다).
pub async fn sweep(pool: &PgPool, v2: bool) -> Result<(), sqlx::Error> {
    let mut skip = Vec::new();
    for _ in 0..DELEGATION_SWEEP_BATCH {
        match expire_one(pool, v2, &mut skip).await {
            Ok(One::None) => break,
            Ok(One::Done) => {}
            // 값·id 를 남기지 않는다 — 종류만.
            Err(e) => eprintln!("loop delegation.deadline: one failed: {e}"),
        }
    }
    // DB 못 잡힌 위임 감시 — 다시 부르기 스위치가 꺼져 있으면 아무것도 하지 않는다. 실패는 그 안에서 삼킨다.
    crate::core::delegation_recall::sweep_unjudged().await;
    if v2 {
        sweep_v2(pool).await?;
    }
    Ok(())
}

/// `HARKROOM_DELEGATION_V2` 를 읽는다 — 값이 없으면 `None`(루프를 띄우지 않는다). 낱말은 TS 와 같다.
pub fn v2_switch(raw: Option<&str>) -> Option<bool> {
    crate::core::msg_post::delegation_v2(raw)
}

/// 15초마다 문지기 아래서 sweep. `v2` 는 기동 때 읽은 `HARKROOM_DELEGATION_V2`(값이 있을 때만 띄운다).
pub fn spawn(gate: PgPool, pool: PgPool, v2: bool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(DELEGATION_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "delegation.deadline", Side::Rust, || {
                sweep(&pool, v2)
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop delegation.deadline: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop delegation.deadline: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}
