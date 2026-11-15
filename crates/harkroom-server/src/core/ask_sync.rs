//! 선택 카드 뒤처리 공용(S5.3 C3b-1) — TS `messages.ts` 의 `wakeAsker`·`syncAskBundles`·`syncAskMirrors` 와, 글 하나의
//! `message.updated` 알림. 처음엔 권한 요청 만료 루프(`loops/permission_expire.rs`) 안에 풀(`&PgPool`)로 있었고,
//! 카드 답·닫기 라우트(`core/ask.rs`)가 **한 트랜잭션 안에서** 같은 일을 하려고 여기로 옮겼다.
//!
//! - 쓰기·다시 읽기는 받은 연결(`&mut PgConnection`) 하나로 한다 — 트랜잭션 연결을 주면 판정·쓰기·이벤트가 한 tx 에 든다.
//!   루프는 풀에서 연결을 잡아 넘긴다(동작은 옮기기 전과 같다).
//! - 받는 사람도 같은 연결로 계산한다(`audience_on`) — 연결을 쥔 채 같은 풀에서 또 빌리면 작은 풀(루프 sweep 3)이 바닥난다.
//! - 깨움 실패는 TS 처럼 삼킨다(답은 남는다). 연결이 트랜잭션 안이면 `begin()` 이 SAVEPOINT 를 쓰므로, 깨움의 실패가
//!   바깥 tx 를 망가뜨리지 않고 그 깨움만 되돌린다.
use super::audience::audience_on;
use super::msg_read::message_by_id;
use crate::write::emit_event;
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

/// TS `wakeAsker` — 물어본 쪽 inbox 한 줄 + `inbox.updated`. 자기 자신은 깨우지 않는다. 던지지 않는다.
/// `label` 은 실패 기록의 머리(어느 길에서 깨웠나).
pub async fn wake_asker(
    conn: &mut PgConnection,
    label: &str,
    asker_id: Option<&str>,
    actor_id: &str,
    message_id: &str,
    reason: &str,
) {
    let Some(asker) = asker_id.filter(|a| !a.is_empty() && *a != actor_id) else {
        return;
    };
    let r: Result<(), sqlx::Error> = async {
        let mut sp = conn.begin().await?;
        sqlx::query(
            "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, $3)",
        )
        .bind(asker)
        .bind(message_id)
        .bind(reason)
        .execute(&mut *sp)
        .await?;
        emit_event(
            &mut sp,
            &json!({ "type": "inbox.updated", "accountId": asker }),
        )
        .await?;
        sp.commit().await?;
        Ok(())
    }
    .await;
    if let Err(e) = r {
        eprintln!("{label}: [{reason}] wake failed: {e}");
    }
}

/// 글 하나의 `message.updated` 를 outbox 로(받는 사람은 그 채널의 audience). 지운 글·없는 글은 조용히 건너뛴다.
pub async fn announce_updated(
    conn: &mut PgConnection,
    message_id: &str,
) -> Result<(), sqlx::Error> {
    let Some(row) = message_by_id(&mut *conn, message_id).await? else {
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
    let audience = audience_on(&mut *conn, &channel).await?.to_json();
    emit_event(
        conn,
        &json!({ "type": "message.updated", "message": message, "audience": audience }),
    )
    .await
    .map(|_| ())
}

/// TS `syncAskBundles` — 이 원본을 줄로 담은(지우지 않은) 묶음 카드마다 `message.updated`.
/// TS 는 실패를 삼킨다 — 여기서는 `Err` 를 돌려주고, 삼킬지는 부르는 쪽이 정한다(루프는 기록만, 라우트는 tx 를 버린다).
pub async fn sync_ask_bundles(
    conn: &mut PgConnection,
    root_id: &str,
) -> Result<(), sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select id::text from message \
          where meta->>'kind' = 'askBundle' and deleted_at is null \
            and meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', $1::text))",
    )
    .bind(root_id)
    .fetch_all(&mut *conn)
    .await?;
    for id in ids {
        announce_updated(conn, &id).await?;
    }
    Ok(())
}

/// TS `syncAskMirrors` — 원본이 정해졌으면(답 또는 닫힘) 아직 열린 거울을 같은 결과로 닫고, 거울을 낸 쪽을 깨우고, 알린다. 멱등.
/// 묶음 맞추기 실패는 TS 처럼 기록만 하고 이어 간다.
pub async fn sync_ask_mirrors(
    conn: &mut PgConnection,
    label: &str,
    root_id: &str,
) -> Result<(), sqlx::Error> {
    // 묶음 알림 실패가 tx 를 망가뜨리지 않게 SAVEPOINT 안에서.
    let bundles: Result<(), sqlx::Error> = async {
        let mut sp = conn.begin().await?;
        sync_ask_bundles(&mut sp, root_id).await?;
        sp.commit().await
    }
    .await;
    if let Err(e) = bundles {
        eprintln!("{label}: bundle sync failed: {e}");
    }
    // TS `readAskRow` — 지운 글·물음이 아닌 글은 건너뛴다.
    let Some(ask): Option<Value> = sqlx::query_scalar(
        "select meta->'ask' from message where id = $1::uuid and deleted_at is null \
            and jsonb_typeof(meta->'ask') = 'object'",
    )
    .bind(root_id)
    .fetch_optional(&mut *conn)
    .await?
    else {
        return Ok(());
    };
    let s = |k: &str| ask.get(k).and_then(Value::as_str).map(str::to_owned);
    let (rows, reason, actor): (Vec<(String, Option<String>)>, &str, String) = if let Some(with) =
        ask.get("answeredWith").filter(|v| !v.is_null())
    {
        let with = with
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| with.to_string());
        let rows = sqlx::query_as(
            "update message set meta = jsonb_set(jsonb_set(jsonb_set(meta::jsonb, \
                    '{ask,answeredWith}', to_jsonb($2::text)), \
                    '{ask,answeredBy}', coalesce(to_jsonb($3::text), 'null'::jsonb)), \
                    '{ask,answeredAt}', to_jsonb(coalesce($4::text, \
                      to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))) \
              where meta->'ask'->>'mirrorOf' = $1 and deleted_at is null \
                and meta->'ask'->>'answeredWith' is null \
              returning id::text, author_id::text",
        )
        .bind(root_id)
        .bind(with)
        .bind(s("answeredBy"))
        .bind(s("answeredAt"))
        .fetch_all(&mut *conn)
        .await?;
        (rows, "ask_answered", s("answeredBy").unwrap_or_default())
    } else if let Some(closed_at) = s("closedAt") {
        let rows = sqlx::query_as(
            "update message set meta = jsonb_set(jsonb_set(jsonb_set(meta::jsonb, \
                    '{ask,closedAt}', to_jsonb($2::text)), \
                    '{ask,closedBy}', coalesce(to_jsonb($3::text), 'null'::jsonb)), \
                    '{ask,closedReason}', to_jsonb($4::text)) \
              where meta->'ask'->>'mirrorOf' = $1 and deleted_at is null \
                and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null \
              returning id::text, author_id::text",
        )
        .bind(root_id)
        .bind(closed_at)
        .bind(s("closedBy"))
        .bind(s("closedReason").unwrap_or_else(|| "declined".to_owned()))
        .fetch_all(&mut *conn)
        .await?;
        (rows, "ask_closed", s("closedBy").unwrap_or_default())
    } else {
        return Ok(());
    };
    for (id, author) in rows {
        wake_asker(conn, label, author.as_deref(), &actor, &id, reason).await;
        announce_updated(conn, &id).await?;
    }
    Ok(())
}
