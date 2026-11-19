//! 위임 끝 → 권한 카드 갱신 공용(S5.4 결정 5). TS `services/mandateEnd.ts` 의 `endMandate`·`refreshMandateCards` 를 옮긴다.
//!
//! - [`end_mandate`] — 한 트랜잭션에서 위임을 끝내고(`endMandateTx`: `mandate.ended_at`·`end_reason`) 살아 있는 줄을 회수한다
//!   (`mandate_line.revoked_at`). 커밋 뒤 [`refresh_mandate_cards`]. 이미 끝났으면 false(멱등).
//! - [`refresh_mandate_cards`] — 끝난 위임을 단 **열린**(pending) 권한 카드의 meta 에 `permissionRequest.mandate.endedAt` 을
//!   적고 `message.updated` 를 낸다(글 직렬화는 `msg_read::message_by_id`, 청중은 `audience_on` — [`super::ask_sync::announce_updated`]).
//!   뒤처리라 던지지 않는다(TS 와 같다 — 위임은 이미 끝났다, 판정은 `ended_at` 을 본다).
//! - SQL 순서·JSON 모양은 TS 그대로. `endedAt` 은 JS `Date#toISOString` 꼴(밀리초·Z).
//! - 권한은 [`PERM_CARD_PRIVILEGES`]·[`PERM_CARD_SEQUENCE_PRIVILEGES`] — 이 모듈을 쓰는 줄은 자기 권한 표에 이것을 더한다.
use super::ask_sync::announce_updated;
use sqlx::PgPool;

/// 이 모듈이 쓰는 칸 권한(WHERE·RETURNING 의 SELECT, SET 의 UPDATE). 읽기(`permission_request`·글 직렬화·청중)는
/// `pg_read_all_data` 로 받는다.
pub const PERM_CARD_PRIVILEGES: &[(&str, &str)] = &[
    // `endMandateTx`
    ("mandate.id", "SELECT"),
    ("mandate.ended_at", "SELECT"),
    ("mandate.ended_at", "UPDATE"),
    ("mandate.end_reason", "UPDATE"),
    ("mandate_line.mandate_id", "SELECT"),
    ("mandate_line.revoked_at", "SELECT"),
    ("mandate_line.revoked_at", "UPDATE"),
    // `refreshMandateCards`
    ("message.id", "SELECT"),
    ("message.meta", "SELECT"),
    ("message.meta", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const PERM_CARD_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `endMandateTx` 의 끝내기(이미 끝났으면 행 없음). TS 의 `$2`(프로세스 시각) 자리는 DB `now()` 다 — 한 tx 안이라 줄 회수와 같은 시각.
pub const END_MANDATE_SQL: &str = "update mandate set ended_at = now(), end_reason = $2 \
     where id = $1::uuid and ended_at is null returning id::text";
/// TS `endMandateTx` 의 줄 회수.
pub const REVOKE_LINES_SQL: &str =
    "update mandate_line set revoked_at = now() where mandate_id = $1::uuid and revoked_at is null";

/// TS `refreshMandateCards` 의 카드 찾기. `endedAt` 은 `toISOString()` 꼴로 DB 에서 만든다.
pub const CARDS_SQL: &str = "select r.card_message_id::text, \
       to_char(d.ended_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
     from permission_request r join mandate d on d.id = r.mandate_id \
     where r.mandate_id = any($1::uuid[]) and d.ended_at is not null \
       and r.status = 'pending' and r.card_message_id is not null";

/// TS `refreshMandateCards` 의 meta 갱신 그대로.
pub const STAMP_CARD_SQL: &str = "update message set meta = jsonb_set(meta, '{permissionRequest,mandate}', \
       coalesce(meta->'permissionRequest'->'mandate', '{}'::jsonb) || jsonb_build_object('endedAt', $2::text)) \
     where id = $1::uuid and meta ? 'permissionRequest' \
       and (meta->'permissionRequest'->'mandate'->>'endedAt') is null";

/// TS `endMandateTx` — 받은 트랜잭션 안에서 끝낸다. 끝냈으면 true(이미 끝났으면 false). 카드 갱신은 커밋 뒤 호출자 몫.
pub async fn end_mandate_tx(
    tx: &mut sqlx::PgConnection,
    mandate_id: &str,
    reason: &str,
) -> Result<bool, sqlx::Error> {
    let ended: Option<String> = sqlx::query_scalar(END_MANDATE_SQL)
        .bind(mandate_id)
        .bind(reason)
        .fetch_optional(&mut *tx)
        .await?;
    if ended.is_none() {
        return Ok(false);
    }
    sqlx::query(REVOKE_LINES_SQL)
        .bind(mandate_id)
        .execute(&mut *tx)
        .await?;
    Ok(true)
}

/// TS `endMandate` — 위임을 끝내고(한 트랜잭션) 카드를 갱신한다. 끝냈으면 true.
pub async fn end_mandate(
    pool: &PgPool,
    mandate_id: &str,
    reason: &str,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let ended = end_mandate_tx(&mut tx, mandate_id, reason).await?;
    tx.commit().await?;
    if !ended {
        return Ok(false);
    }
    refresh_mandate_cards(pool, &[mandate_id.to_owned()]).await;
    Ok(true)
}

/// TS `refreshMandateCards` — 던지지 않는다(실패는 기록만, TS 의 `console.error` 자리).
pub async fn refresh_mandate_cards(pool: &PgPool, mandate_ids: &[String]) {
    if mandate_ids.is_empty() {
        return;
    }
    if let Err(e) = refresh_inner(pool, mandate_ids).await {
        eprintln!("mandate end card refresh error: {e}");
    }
}

async fn refresh_inner(pool: &PgPool, mandate_ids: &[String]) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let cards: Vec<(String, String)> = sqlx::query_as(CARDS_SQL)
        .bind(mandate_ids)
        .fetch_all(&mut *conn)
        .await?;
    for (card, ended_at) in cards {
        let upd = sqlx::query(STAMP_CARD_SQL)
            .bind(&card)
            .bind(&ended_at)
            .execute(&mut *conn)
            .await?;
        if upd.rows_affected() == 0 {
            continue;
        }
        announce_updated(&mut conn, &card).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_matches_ts_shape() {
        assert!(STAMP_CARD_SQL.contains("'{permissionRequest,mandate}'"));
        assert!(STAMP_CARD_SQL.contains("jsonb_build_object('endedAt', $2::text)"));
        assert!(CARDS_SQL.contains("r.status = 'pending'"));
        assert!(CARDS_SQL.contains("MS\"Z\""));
    }

    #[test]
    fn privileges_cover_writes() {
        for need in [
            ("mandate.ended_at", "UPDATE"),
            ("mandate.end_reason", "UPDATE"),
            ("mandate_line.revoked_at", "UPDATE"),
            ("message.meta", "UPDATE"),
            ("event_outbox", "INSERT"),
        ] {
            assert!(PERM_CARD_PRIVILEGES.contains(&need), "{need:?}");
        }
    }
}
