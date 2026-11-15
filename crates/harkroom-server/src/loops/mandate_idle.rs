//! 위임 idle 끝 sweep(S5.3 C5c-2a) — TS `services/mandateEnd.ts` 의 `createMandateIdleSweeper`·`endIdleMandates`·`refreshMandateCards` 를 옮긴다.
//!
//! - 한 묶음(최대 [`MANDATE_IDLE_BATCH`])을 한 트랜잭션에서: 7일 활동이 없던 열린 위임(자동화 위임 제외)을
//!   `for update skip locked` 로 잡아 `ended_at`·`end_reason = 'idle'` → 그 위임의 줄을 `revoked_at`. 커밋.
//! - 커밋 뒤: 그 위임을 단 **열린**(pending) 권한 카드의 meta 에 `permissionRequest.mandate.endedAt`(처음 값만) → `message.updated` →
//!   위임마다 감사 `mandate.ended`(detail `{reason:'idle'}`). 뒤처리라 실패는 기록만 한다 — 위임은 이미 끝났다(판정은 `ended_at` 을 본다).
//! - 묶음이 꽉 찼으면 다음 묶음을 바로 돈다(TS 와 같다).
//! - 이중 실행: 평소엔 문지기(이름 `mandate.idle`)가 한쪽만 돌린다. 그 아래에서도 행 단위 `skip locked` + `ended_at is null` 이
//!   한 위임을 한 번만 끝낸다(감사 줄도 한 번). 카드 갱신은 `endedAt is null` 조건이라 두 번 써지지 않는다.
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_read::message_by_id;
use crate::write::{AuditEntry, record_audit};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

/// TS `MANDATE_IDLE_BATCH`.
pub const MANDATE_IDLE_BATCH: i64 = 200;
/// TS `MANDATE_IDLE_SWEEP_INTERVAL_MS`.
pub const MANDATE_IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// 이 루프가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
/// `for update` 잠금은 고치는 칸의 UPDATE 권한으로 충분하다.
pub const MANDATE_IDLE_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate.ended_at", "UPDATE"),
    ("mandate.end_reason", "UPDATE"),
    ("mandate_line.revoked_at", "UPDATE"),
    ("message.meta", "UPDATE"),
    ("audit_log", "INSERT"),
    ("event_outbox", "INSERT"),
];
pub const MANDATE_IDLE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `endIdleMandates` — 한 묶음을 끝내고 끝낸 위임 id 를 돌려준다(뒤처리까지 마친 뒤).
pub async fn end_idle_mandates(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let ids: Vec<String> = sqlx::query_scalar(
        "update mandate set ended_at = now(), end_reason = 'idle' \
          where id in (select id from mandate where ended_at is null and automation_id is null \
                         and last_activity_at <= now() - interval '7 days' \
                       order by last_activity_at limit $1 for update skip locked) \
          returning id::text",
    )
    .bind(MANDATE_IDLE_BATCH)
    .fetch_all(&mut *tx)
    .await?;
    if !ids.is_empty() {
        sqlx::query(
            "update mandate_line set revoked_at = now() where mandate_id = any($1::uuid[]) and revoked_at is null",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    if !ids.is_empty() {
        refresh_mandate_cards(pool, &ids).await;
        for id in &ids {
            record_audit(
                pool,
                AuditEntry {
                    action: "mandate.ended",
                    actor_id: None,
                    actor_handle: None,
                    target: Some(id),
                    ip: None,
                    detail: json!({ "reason": "idle" }),
                },
            )
            .await;
        }
    }
    Ok(ids)
}

/// TS `refreshMandateCards` — 끝난 위임을 단 열린 권한 카드에 `endedAt` 을 적고 `message.updated`. 던지지 않는다.
pub async fn refresh_mandate_cards(pool: &PgPool, ids: &[String]) {
    let r: Result<(), sqlx::Error> = async {
        let cards: Vec<(String, String)> = sqlx::query_as(
            "select r.card_message_id::text, \
                    to_char(d.ended_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
               from permission_request r join mandate d on d.id = r.mandate_id \
              where r.mandate_id = any($1::uuid[]) and d.ended_at is not null \
                and r.status = 'pending' and r.card_message_id is not null",
        )
        .bind(ids)
        .fetch_all(pool)
        .await?;
        for (card_id, ended_at) in cards {
            let upd = sqlx::query(
                "update message set meta = jsonb_set(meta, '{permissionRequest,mandate}', \
                        coalesce(meta->'permissionRequest'->'mandate', '{}'::jsonb) || jsonb_build_object('endedAt', $2::text)) \
                  where id = $1::uuid and meta ? 'permissionRequest' \
                    and (meta->'permissionRequest'->'mandate'->>'endedAt') is null",
            )
            .bind(&card_id)
            .bind(&ended_at)
            .execute(pool)
            .await?;
            if upd.rows_affected() == 0 {
                continue;
            }
            announce_updated(pool, &card_id).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        eprintln!("loop mandate.idle: card refresh failed: {e}");
    }
}

/// 카드 하나의 `message.updated` 를 outbox 로.
async fn announce_updated(pool: &PgPool, message_id: &str) -> Result<(), sqlx::Error> {
    let Some(row) = message_by_id(pool, message_id).await? else {
        return Ok(());
    };
    let Ok(message) = serde_json::from_str::<Value>(&row) else {
        return Ok(());
    };
    let channel = message
        .get("channelId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let audience = audience_for(pool, &channel).await?.to_json();
    let mut conn = pool.acquire().await?;
    crate::write::emit_event(
        &mut conn,
        &json!({ "type": "message.updated", "message": message, "audience": audience }),
    )
    .await
    .map(|_| ())
}

/// TS `sweep` — 묶음이 꽉 차는 동안 이어 돈다. 끝낸 위임 수.
pub async fn sweep(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let mut n = 0;
    loop {
        let ended = end_idle_mandates(pool).await?.len();
        n += ended;
        if (ended as i64) < MANDATE_IDLE_BATCH {
            return Ok(n);
        }
    }
}

/// 10분마다 문지기 아래서 sweep. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다(wake 와 같은 까닭).
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(MANDATE_IDLE_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "mandate.idle", Side::Rust, || async {
                sweep(&pool).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop mandate.idle: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop mandate.idle: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}
