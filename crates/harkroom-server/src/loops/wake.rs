//! 예약 깨움 sweep(S5.3 C5b) — TS `services/agentWakes.ts::createAgentWakeSweeper` 의 `fireOneDue`·`sweep` 을 옮긴다.
//!
//! - 한 건씩 자기 트랜잭션: `for update skip locked` 로 시각이 된 깨움 하나를 잡고 → `inbox`(reason `wake`) 한 줄 →
//!   `fired_at` → 대기 줄 meta 에 `firedAt`(처음 값만) → 커밋. TS 와 같은 순서·같은 조건이라 두 구현이 **동시에** 돌아도
//!   한 깨움은 한 번만 뜬다(skip locked + `fired_at is null`). 평소에는 문지기(`run_gated`, 루프 이름 `wake`)가 한쪽만 돌린다.
//! - 이벤트는 커밋 뒤에 outbox 로 낸다(TS 와 같은 이름·모양): `message.updated`(닫힌 대기 줄) · 보고처가 있으면
//!   `thread.reportWakes.changed`(값 없이 신호만) · `inbox.updated`(러너의 `inbox.poll` 을 깨운다). 신호가 실패해도 깨움은 이미 끝났다.
//! - 한 건이 실패해도 나머지를 멈추지 않고, 행은 대기로 남아 다음 sweep 이 다시 시도한다(TS 와 같다).
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_read::message_by_id;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

/// TS `WAKE_SWEEP_INTERVAL_MS`.
pub const WAKE_SWEEP_INTERVAL: Duration = Duration::from_secs(15);
/// TS `WAKE_SWEEP_BATCH_SIZE`.
pub const WAKE_SWEEP_BATCH_SIZE: usize = 20;

/// 이 루프가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
/// `for update` 잠금은 `fired_at` 칸의 UPDATE 권한으로 충분하다.
pub const WAKE_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_wake.fired_at", "UPDATE"),
    ("inbox", "INSERT"),
    ("message.meta", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const WAKE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// 커밋까지 끝난 깨움 하나 — 이벤트를 낼 재료.
struct Fired {
    account_id: String,
    message_id: String,
    report_to: Option<(String, String)>,
}

/// TS `fireOneDue` — 시각이 된 깨움 하나를 띄운다. 없으면 `Ok(false)`. 잡은 행은 `skip` 에 넣어 같은 sweep 에서 다시 잡지 않는다.
pub async fn fire_one_due(pool: &PgPool, skip: &mut Vec<String>) -> Result<bool, sqlx::Error> {
    let fired = {
        let mut tx = pool.begin().await?;
        let row: Option<(String, String, String)> = sqlx::query_as(
            "select id::text, account_id::text, message_id::text from agent_wake \
              where wake_at <= now() and fired_at is null and canceled_at is null \
                and not (id = any($1::uuid[])) \
              order by wake_at limit 1 for update skip locked",
        )
        .bind(&*skip)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((id, account_id, message_id)) = row else {
            tx.commit().await?;
            return Ok(false);
        };
        skip.push(id.clone());
        let r: Result<Option<Value>, sqlx::Error> = async {
            // TS 와 같이 `insertInbox` 관문(숨김 되돌리기)을 거치지 않는다 — 자기 자신을 깨우는 것이다.
            sqlx::query("insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'wake')")
                .bind(&account_id)
                .bind(&message_id)
                .execute(&mut *tx)
                .await?;
            crate::core::wake_write::along_one(&mut tx, &message_id, &account_id).await;
            sqlx::query("update agent_wake set fired_at = now() where id = $1::uuid")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            // TS `stampWakeClosed(…, 'firedAt')` — 처음 값을 지킨다.
            sqlx::query(
                "update message set meta = jsonb_set(meta, '{wake,firedAt}', \
                   to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) \
                 where id = $1::uuid and jsonb_typeof(meta->'wake') = 'object' and meta->'wake'->>'firedAt' is null",
            )
            .bind(&message_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query_scalar("select meta->'wake'->'reportTo' from message where id = $1::uuid")
                .bind(&message_id)
                .fetch_one(&mut *tx)
                .await
        }
        .await;
        let report = match r {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.rollback().await;
                // 한 건의 실패로 나머지를 멈추지 않는다 — 행은 대기로 남는다.
                eprintln!("loop wake: fire failed: {e}");
                return Ok(true);
            }
        };
        tx.commit().await?;
        Fired {
            account_id,
            message_id,
            report_to: report.as_ref().and_then(report_to),
        }
    };
    announce(pool, &fired).await;
    Ok(true)
}

/// TS `asReportTo` — 두 칸이 다 문자열일 때만.
fn report_to(v: &Value) -> Option<(String, String)> {
    Some((
        v.get("channelId")?.as_str()?.to_owned(),
        v.get("threadRootId")?.as_str()?.to_owned(),
    ))
}

async fn emit(pool: &PgPool, event: &Value) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    crate::write::emit_event(&mut conn, event).await.map(|_| ())
}

/// 커밋 뒤 신호 셋 — 실패는 기록만(다음 읽기가 맞춘다).
async fn announce(pool: &PgPool, f: &Fired) {
    let updated = async {
        let Some(row) = message_by_id(pool, &f.message_id).await? else {
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
        emit(
            pool,
            &json!({ "type": "message.updated", "message": message, "audience": audience }),
        )
        .await
    }
    .await;
    if let Err(e) = updated {
        eprintln!("loop wake: message.updated failed: {e}");
    }
    if let Some((channel, root)) = &f.report_to {
        let r = async {
            let audience = audience_for(pool, channel).await?.to_json();
            emit(
                pool,
                &json!({ "type": "thread.reportWakes.changed", "channelId": channel, "rootId": root, "audience": audience }),
            )
            .await
        }
        .await;
        if let Err(e) = r {
            eprintln!("loop wake: reportWakes signal failed: {e}");
        }
    }
    if let Err(e) = emit(
        pool,
        &json!({ "type": "inbox.updated", "accountId": f.account_id }),
    )
    .await
    {
        eprintln!("loop wake: inbox.updated failed: {e}");
    }
}

/// TS `sweep` — 한 번에 최대 [`WAKE_SWEEP_BATCH_SIZE`] 건. 띄운 수를 돌려준다.
pub async fn sweep(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let mut skip = vec![];
    let mut n = 0;
    for _ in 0..WAKE_SWEEP_BATCH_SIZE {
        if !fire_one_due(pool, &mut skip).await? {
            break;
        }
        n += 1;
    }
    Ok(n)
}

/// 15초마다 문지기 아래서 sweep. 주인이 `ts`(기본)면 tick 마다 잠금·주인만 보고 건너뛴다.
/// 한 tick 은 문지기 연결 1 + sweep 연결 1(+이벤트 1)을 쓴다 — 풀은 3 이상이어야 한다(`main.rs`).
/// 루프를 띄운다. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 이 쓰는 풀 — 잠금 연결을 쥔 채 같은 풀에서 sweep 연결을
/// 빌리면 작은 풀에서 sweep 이 연결을 못 얻는다(C5 조건). 주인이 `rust` 일 때만 실제로 돈다.
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(WAKE_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "wake", Side::Rust, || async {
                sweep(&pool).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop wake: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop wake: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}
