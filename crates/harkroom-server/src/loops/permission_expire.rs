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
use crate::core::ask_sync::{announce_updated, sync_ask_mirrors, wake_asker};
use crate::write::{AuditEntry, record_audit};
use serde_json::json;
use sqlx::PgPool;
use std::time::Duration;

/// 실패 기록의 머리.
const LABEL: &str = "loop permission.expire";

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
            closed_card = crate::core::card_state::close_card_copy(
                &mut tx,
                card_id,
                crate::core::card_state::CardClose::Expired,
                &at,
                true,
            )
            .await?
            .ask_closed;
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
    // 트랜잭션 밖 연결 하나 — 문장마다 따로 커밋된다(옮기기 전과 같다). 공용 뒤처리는 `core/ask_sync.rs`.
    let mut conn = pool.acquire().await?;
    announce_updated(&mut conn, card).await?;
    sync_ask_mirrors(&mut conn, LABEL, card).await?;
    if r.closed_card {
        // 행위자는 서버다 — 빈 값이라 자기 깨움 거름에 걸리지 않는다.
        wake_asker(&mut conn, LABEL, Some(&r.agent_id), "", card, "ask_closed").await;
    }
    Ok(())
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
