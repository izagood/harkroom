//! 권한 요청 만료 sweep(S5.3 C5c-2b) — TS `services/permissionRequests.ts` 의 `createPermissionExpirySweeper`·
//! `expirePermissionRequests` 와, 그 뒤처리가 부르는 `messages.ts` 의 `syncAskMirrors`·`syncAskBundles`·`wakeAsker` 를 옮긴다.
//!
//! - 한 묶음(최대 [`PERMISSION_EXPIRE_BATCH`])을 한 트랜잭션에서: 시한이 지난 기다리는 요청을 `for update skip locked` 로 잡아
//!   `status = 'expired'`·`decided_at` → 그 카드 meta 의 `permissionRequest` 에 `{status:'expired', decidedAt}` →
//!   아직 열린(답·닫힘 없는) 선택 카드면 `ask` 에 `{closedAt, closedReason:'expired'}`(닫은 사람 없음). 커밋.
//! - 커밋 뒤 요청마다(실패는 기록만 — 만료는 이미 커밋됐다): 감사 `permission.expired`(actor 없음, detail `{requestId}`) →
//!   카드 `message.updated` → 거울·묶음 맞추기 → 이번에 카드를 닫았으면 요청한 에이전트를 한 번 깨운다(`ask_closed`).
//! - TS 는 시각을 앱 시계(`args.now`)로 쓴다. 여기서는 DB `now()` 하나(트랜잭션 안에서 같은 값)를 고르는 조건·`decided_at`·
//!   meta 의 시각 글자에 같이 쓴다(C5c-2a 와 같은 선택).
//! - 이중 실행: 평소엔 문지기(이름 `permission.expire`)가 한쪽만 돌린다. 그 아래에서도 행 단위 `skip locked` + `status = 'pending'`
//!   이 한 요청을 한 번만 만료하고(감사·깨움도 한 번), 카드 닫기는 `closedAt is null` 조건이라 두 번 써지지 않는다.
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_read::message_by_id;
use crate::write::{AuditEntry, emit_event, record_audit};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

/// TS `PERMISSION_EXPIRE_BATCH`.
pub const PERMISSION_EXPIRE_BATCH: i64 = 50;
/// TS `PERMISSION_EXPIRE_SWEEP_INTERVAL_MS`.
pub const PERMISSION_EXPIRE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// 이 루프가 쓰는 권한 — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
/// 칸 단위로 좁힌다: 요청은 `status`·`decided_at` 만, 카드·거울은 `meta` 만 고친다.
pub const PERMISSION_EXPIRE_PRIVILEGES: &[(&str, &str)] = &[
    ("permission_request.status", "UPDATE"),
    ("permission_request.decided_at", "UPDATE"),
    ("message.meta", "UPDATE"),
    ("inbox", "INSERT"),
    ("audit_log", "INSERT"),
    ("event_outbox", "INSERT"),
];
pub const PERMISSION_EXPIRE_SEQUENCE_PRIVILEGES: &[(&str, &str)] =
    &[("event_outbox_id_seq", "USAGE")];

/// 만료한 요청 한 줄.
#[derive(Debug, Clone)]
pub struct Expired {
    pub id: String,
    pub agent_id: String,
    pub card_message_id: Option<String>,
    /// 이번 만료가 카드를 실제로 닫았나(이미 사람이 닫은 카드는 그때 깨웠다).
    pub closed_card: bool,
}

/// TS `expirePermissionRequests` — 한 묶음을 만료하고(뒤처리까지 마친 뒤) 만료한 줄을 돌려준다.
/// `request_id` 가 있으면 그 요청만(결정 경로가 만료를 만났을 때 — 지금은 TS 만 부른다).
pub async fn expire_permission_requests(
    pool: &PgPool,
    request_id: Option<&str>,
) -> Result<Vec<Expired>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    // TS `toISOString()` 꼴(밀리초·Z) — meta 의 시각 글자를 TS 가 쓴 것과 같은 모양으로.
    let at: String = sqlx::query_scalar(
        "select to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .fetch_one(&mut *tx)
    .await?;
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "update permission_request set status = 'expired', decided_at = now() \
          where id in (select id from permission_request \
                        where status = 'pending' and expires_at <= now() and ($1::uuid is null or id = $1::uuid) \
                        order by expires_at limit $2 for update skip locked) \
          returning id::text, agent_id::text, card_message_id::text",
    )
    .bind(request_id)
    .bind(PERMISSION_EXPIRE_BATCH)
    .fetch_all(&mut *tx)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, agent_id, card) in rows {
        let mut closed_card = false;
        if let Some(card_id) = &card {
            sqlx::query(
                "update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb) \
                  where id = $1::uuid and meta ? 'permissionRequest'",
            )
            .bind(card_id)
            .bind(json!({ "status": "expired", "decidedAt": at }).to_string())
            .execute(&mut *tx)
            .await?;
            let closed = sqlx::query(
                "update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb) \
                  where id = $1::uuid and meta ? 'ask' and meta->'ask'->>'closedAt' is null \
                    and meta->'ask'->'answeredWith' is null",
            )
            .bind(card_id)
            .bind(json!({ "closedAt": at, "closedReason": "expired" }).to_string())
            .execute(&mut *tx)
            .await?;
            closed_card = closed.rows_affected() > 0;
        }
        out.push(Expired {
            id,
            agent_id,
            card_message_id: card,
            closed_card,
        });
    }
    tx.commit().await?;
    for r in &out {
        if let Err(e) = follow_up(pool, r).await {
            eprintln!("loop permission.expire: follow-up failed: {e}");
        }
    }
    Ok(out)
}

/// 커밋 뒤 한 줄의 뒤처리(TS 의 `for (const r of rows)` 몸통).
async fn follow_up(pool: &PgPool, r: &Expired) -> Result<(), sqlx::Error> {
    // 만료는 서버가 한 일이다 — 행위자는 없다(security n2). 대상은 그 에이전트.
    record_audit(
        pool,
        AuditEntry {
            action: "permission.expired",
            actor_id: None,
            actor_handle: None,
            target: Some(&r.agent_id),
            ip: None,
            detail: json!({ "requestId": r.id }),
        },
    )
    .await;
    let Some(card) = &r.card_message_id else {
        return Ok(());
    };
    announce_updated(pool, card).await?;
    sync_ask_mirrors(pool, card).await?;
    if r.closed_card {
        // 행위자는 서버다 — 빈 값이라 자기 깨움 거름에 걸리지 않는다.
        wake_asker(pool, Some(&r.agent_id), "", card, "ask_closed").await;
    }
    Ok(())
}

/// TS `wakeAsker` — 물어본 쪽 inbox 한 줄 + `inbox.updated`. 자기 자신은 깨우지 않는다. 던지지 않는다.
pub async fn wake_asker(
    pool: &PgPool,
    asker_id: Option<&str>,
    actor_id: &str,
    message_id: &str,
    reason: &str,
) {
    let Some(asker) = asker_id.filter(|a| !a.is_empty() && *a != actor_id) else {
        return;
    };
    let r: Result<(), sqlx::Error> = async {
        sqlx::query(
            "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, $3)",
        )
        .bind(asker)
        .bind(message_id)
        .bind(reason)
        .execute(pool)
        .await?;
        let mut conn = pool.acquire().await?;
        emit_event(
            &mut conn,
            &json!({ "type": "inbox.updated", "accountId": asker }),
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(e) = r {
        eprintln!("loop permission.expire: [{reason}] wake failed: {e}");
    }
}

/// TS `syncAskBundles` — 이 원본을 줄로 담은(지우지 않은) 묶음 카드마다 `message.updated`. 던지지 않는다.
pub async fn sync_ask_bundles(pool: &PgPool, root_id: &str) {
    let r: Result<(), sqlx::Error> = async {
        let ids: Vec<String> = sqlx::query_scalar(
            "select id::text from message \
              where meta->>'kind' = 'askBundle' and deleted_at is null \
                and meta->'askBundle'->'items' @> jsonb_build_array(jsonb_build_object('rootId', $1::text))",
        )
        .bind(root_id)
        .fetch_all(pool)
        .await?;
        for id in ids {
            announce_updated(pool, &id).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        eprintln!("loop permission.expire: bundle sync failed: {e}");
    }
}

/// TS `syncAskMirrors` — 원본이 정해졌으면(답 또는 닫힘) 아직 열린 거울을 같은 결과로 닫고, 거울을 낸 쪽을 깨우고, 알린다. 멱등.
pub async fn sync_ask_mirrors(pool: &PgPool, root_id: &str) -> Result<(), sqlx::Error> {
    sync_ask_bundles(pool, root_id).await;
    // TS `readAskRow` — 지운 글·물음이 아닌 글은 건너뛴다.
    let Some(ask): Option<Value> = sqlx::query_scalar(
        "select meta->'ask' from message where id = $1::uuid and deleted_at is null \
            and jsonb_typeof(meta->'ask') = 'object'",
    )
    .bind(root_id)
    .fetch_optional(pool)
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
            .fetch_all(pool)
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
        .fetch_all(pool)
        .await?;
        (rows, "ask_closed", s("closedBy").unwrap_or_default())
    } else {
        return Ok(());
    };
    for (id, author) in rows {
        wake_asker(pool, author.as_deref(), &actor, &id, reason).await;
        announce_updated(pool, &id).await?;
    }
    Ok(())
}

/// 글 하나의 `message.updated` 를 outbox 로(받는 사람은 그 채널의 audience).
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
    emit_event(
        &mut conn,
        &json!({ "type": "message.updated", "message": message, "audience": audience }),
    )
    .await
    .map(|_| ())
}

/// TS `sweep` — 묶음이 꽉 차는 동안 이어 돈다. 만료한 수.
pub async fn sweep(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let mut n = 0;
    loop {
        let expired = expire_permission_requests(pool, None).await?.len();
        n += expired;
        if (expired as i64) < PERMISSION_EXPIRE_BATCH {
            return Ok(n);
        }
    }
}

/// 1분마다 문지기 아래서 sweep. `gate` 는 문지기 풀, `pool` 은 sweep 풀(다른 루프와 같다).
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(PERMISSION_EXPIRE_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "permission.expire", Side::Rust, || async {
                sweep(&pool).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop permission.expire: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop permission.expire: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}
