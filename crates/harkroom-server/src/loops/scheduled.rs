//! 예약 글 발송 sweep(S5.4 L1) — TS `services/scheduledMessages.ts` 의 `createScheduledMessageSweeper`·`sendOneDue`·`refuseReason` 을 옮긴다.
//!
//! - 15초마다 문지기(이름 `scheduled`) 아래서 한 sweep 에 최대 [`SWEEP_BATCH_SIZE`] 건. 한 건씩 **자기 트랜잭션**에서:
//!   발송할 행 하나를 `for update skip locked` 로 잡고 → 보낼 수 없는 이유(채널 없음·보관·멤버 아님)면 `failed_reason` →
//!   아니면 글 올리기 경로([`crate::core::msg_post::post_in_tx`] — REST·MCP 글과 같은 insert·부름·`message.created` 이벤트)를
//!   재시도 키 = 예약 id 로 지나고 → `sent_message_id`(거절이면 그 코드를 `failed_reason`) → 커밋.
//! - 이중 발송 없음: 문지기가 한쪽만 돌리고, 그 아래에서도 행 락(`skip locked`)이 같은 행을 두 tick 이 동시에 잡지 못하게 한다.
//!   글이 커밋된 뒤 `sent_message_id` 를 찍기 전에 죽으면 다음 tick 이 같은 키로 다시 올리고, 글 경로는 이미 만든 글을 돌려준다(재생).
//! - DB 순간 오류는 `failed_reason` 을 찍지 않는다(되돌리고 다음 sweep 이 다시 한다 — TS 와 같다).
//! - Rust 글 경로가 아직 TS 로 넘기는 글(링크 미리보기·글 승인 체에 걸리는 본문, TS 몫 스레드·부름)은 **보내지 않고 대기로 둔다**
//!   (이번 sweep 에서만 건너뛴다). TS 백엔드를 지운 뒤(11-21)로는 그런 예약을 대신 보낼 쪽이 없다 — 대기로 남는다.
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_post::{Origin, Outcome, PostBody, PostState, gate_sql, post_in_tx, ts_body};
use serde_json::Value;
use sqlx::PgPool;
use std::time::Duration;

/// TS `SWEEP_INTERVAL_MS`.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(15);
/// TS `SWEEP_BATCH_SIZE`.
pub const SWEEP_BATCH_SIZE: usize = 20;

/// 글 쓰기 권한([`crate::core::msg_post::MESSAGE_POST_PRIVILEGES`]) 위에 이 루프가 더 쓰는 칸. 없으면 `main.rs` 가 띄우지 않는다.
pub const SCHEDULED_PRIVILEGES: &[(&str, &str)] = &[
    ("scheduled_message.sent_message_id", "UPDATE"),
    ("scheduled_message.failed_reason", "UPDATE"),
];

/// TS `sendOneDue` 의 select 그대로.
const DUE_SQL: &str = "select id::text, channel_id::text, author_id::text, thread_root_id::text, body \
     from scheduled_message \
     where send_at <= now() and sent_message_id is null and failed_reason is null and canceled_at is null \
       and not (id = any($1::uuid[])) \
     order by send_at limit 1 for update skip locked";

/// 한 건 처리의 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    /// 잡을 것이 없다.
    None,
    /// 보냈다(재생 포함) — 글 id.
    Posted(String),
    /// 영구 실패로 적었다 — 사유.
    Failed(String),
    /// Rust 글 경로가 맡지 않는 글 — 대기로 두었다.
    Left,
}

/// TS `sendOneDue` — 발송할 한 건을 잡아 처리한다. `skip` 은 이번 sweep 에서 이미 건드린 id(되돌린 행을 곧바로 다시 집지 않게).
pub async fn send_one_due(
    pool: &PgPool,
    st: &PostState,
    skip: &mut Vec<String>,
) -> Result<Sent, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row: Option<(String, String, String, Option<String>, String)> = sqlx::query_as(DUE_SQL)
        .bind(&*skip)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((id, channel, author, root, body)) = row else {
        tx.commit().await?;
        return Ok(Sent::None);
    };
    skip.push(id.clone());

    // TS `refuseReason` — 같은 술어(`channelPostGate`)를 락을 쥔 그 트랜잭션에서.
    let exists: Option<i32> = sqlx::query_scalar("select 1 from channel where id = $1::uuid")
        .bind(&channel)
        .fetch_optional(&mut *tx)
        .await?;
    let refused = if exists.is_none() {
        Some("channel_deleted")
    } else {
        let gate: Option<(bool, bool)> = sqlx::query_as(gate_sql())
            .bind(&channel)
            .bind(&author)
            .fetch_optional(&mut *tx)
            .await?;
        match gate {
            Some((true, true)) => Some("channel_archived"),
            Some((false, _)) => Some("forbidden"),
            _ => None,
        }
    };
    if let Some(r) = refused {
        mark(&mut tx, "failed_reason", r, &id).await?;
        tx.commit().await?;
        return Ok(Sent::Failed(r.to_owned()));
    }
    if ts_body(&body) {
        tx.rollback().await?;
        return Ok(Sent::Left);
    }

    let kind: Option<String> = sqlx::query_scalar("select kind from account where id = $1::uuid")
        .bind(&author)
        .fetch_optional(&mut *tx)
        .await?;
    let ch_kind: Option<String> =
        sqlx::query_scalar("select kind from channel where id = $1::uuid")
            .bind(&channel)
            .fetch_optional(&mut *tx)
            .await?;
    let audience = audience_for(&st.read, &channel).await?.to_json();
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: root,
        also_in_channel: false,
    };
    // 글은 글 경로가 자기 연결에서 커밋한다(TS `postMessage(pool, …)` 와 같다). 재시도 키 = 예약 id.
    let out = post_in_tx(
        st,
        &channel,
        &author,
        kind.as_deref() == Some("agent"),
        &input,
        Some(&id),
        &audience,
        ch_kind.as_deref() == Some("dm"),
        &Origin::default(),
    )
    .await?;
    let posted = |row: &str| -> Option<String> {
        serde_json::from_str::<Value>(row)
            .ok()?
            .get("id")?
            .as_str()
            .map(str::to_owned)
    };
    let sent = match out {
        Outcome::Posted { row, mandate, .. } => {
            if let Some(c) = &mandate {
                crate::write::record_audit(
                    &st.write,
                    crate::write::AuditEntry {
                        action: "mandate.created",
                        actor_id: Some(c.actor_id()),
                        actor_handle: None,
                        target: Some(&c.mandate_id),
                        ip: None,
                        detail: c.audit_detail(),
                    },
                )
                .await;
            }
            posted(&row)
        }
        Outcome::Replayed(row) => posted(&row),
        // 위임 상한은 MCP `message.delegate` 만 낸다.
        Outcome::ToTs | Outcome::ChainLimit | Outcome::Rejected(_) => {
            tx.rollback().await?;
            return Ok(Sent::Left);
        }
        // TS 는 `postMessage` 가 거부한 코드를 그대로 적는다.
        Outcome::BadThread => {
            mark(&mut tx, "failed_reason", "bad_thread", &id).await?;
            tx.commit().await?;
            return Ok(Sent::Failed("bad_thread".into()));
        }
        Outcome::BadAttachment => {
            mark(&mut tx, "failed_reason", "bad_attachment", &id).await?;
            tx.commit().await?;
            return Ok(Sent::Failed("bad_attachment".into()));
        }
    };
    let Some(msg) = sent else {
        mark(&mut tx, "failed_reason", "unknown", &id).await?;
        tx.commit().await?;
        return Ok(Sent::Failed("unknown".into()));
    };
    mark(&mut tx, "sent_message_id", &msg, &id).await?;
    tx.commit().await?;
    Ok(Sent::Posted(msg))
}

async fn mark(
    tx: &mut sqlx::PgConnection,
    col: &str,
    val: &str,
    id: &str,
) -> Result<(), sqlx::Error> {
    let sql = if col == "sent_message_id" {
        "update scheduled_message set sent_message_id = $1::uuid where id = $2::uuid"
    } else {
        "update scheduled_message set failed_reason = $1 where id = $2::uuid"
    };
    sqlx::query(sql)
        .bind(val)
        .bind(id)
        .execute(tx)
        .await
        .map(|_| ())
}

/// TS `sweep` — 최대 [`SWEEP_BATCH_SIZE`] 건. 한 건의 일시 오류는 기록하고 다음 건으로 간다(TS 와 같다). 보낸 수.
pub async fn sweep(pool: &PgPool, st: &PostState) -> Result<usize, sqlx::Error> {
    let mut skip = Vec::new();
    let mut n = 0;
    for _ in 0..SWEEP_BATCH_SIZE {
        match send_one_due(pool, st, &mut skip).await {
            Ok(Sent::None) => break,
            Ok(Sent::Posted(_)) => n += 1,
            Ok(Sent::Left) => {
                eprintln!("loop scheduled: left a row for the TS post path (owner should stay ts)")
            }
            Ok(Sent::Failed(_)) => {}
            Err(e) => eprintln!("loop scheduled: send failed: {e}"),
        }
    }
    Ok(n)
}

/// 15초마다 문지기 아래서 sweep. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀(글 경로의 읽기·쓰기도 이 풀).
pub fn spawn(gate: PgPool, pool: PgPool, implicit_ok: bool) -> tokio::task::JoinHandle<()> {
    let st = PostState {
        read: pool.clone(),
        write: pool.clone(),
        // 루프는 TS 로 넘길 요청이 없다 — `Outcome::ToTs` 는 대기로 둔다.
        up: crate::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok,
    };
    tokio::spawn(async move {
        let mut every = tokio::time::interval(SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "scheduled", Side::Rust, || async {
                sweep(&pool, &st).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop scheduled: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop scheduled: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}
