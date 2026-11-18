//! 자동화 sweep(S5.4) — TS `services/automations.ts` 의 `createAutomationSweeper`(`fireOneSchedule`·`deliverOne`·`refuseReason`·
//! `pauseForRefusal`)를 옮긴다. **골격이다** — 아래 TODO 가 끝나기 전에는 `server_loop` 의 `automation` 주인을 `ts` 로 둔다
//! (문지기 기본값이 `ts` 라 띄워도 돌지 않는다. 두 서버가 같은 회차를 보내는 일은 없다).
//!
//! TS 한 sweep(15초마다, 문지기 이름 `automation`, 프로세스 안 겹침은 `running` 깃발 = 여기선 tick 이 직렬):
//! 1. `fireOneSchedule` × 최대 20 — 한 건씩 자기 tx:
//!    `select id, trigger, next_at from automation where enabled and deleted_at is null and next_at is not null and next_at <= $now
//!     and not (id = any($skip)) order by next_at limit 1 for update skip locked`
//!    → `enqueueRun(eventKey = 'schedule:<next_at ISO>', triggerKind 'schedule', vars = timeVars(next_at, tz))`
//!    (시간당 상한 [`RATE_LIMIT_PER_HOUR`] 을 넘으면 enqueueRun 이 자동화를 일시정지하고 `rate_limited`)
//!    → `rate_limited` 가 아니면 `update automation set next_at = nextOccurrence(trigger, now)` (밀린 회차는 따라잡지 않는다) → 커밋.
//! 2. `deliverOne` × 최대 20 — [`DUE_SQL`] 로 대기 회차 하나를 `for update of r skip locked` 로 잡고:
//!    - 자동화 삭제 → `skipped / automation_deleted`
//!    - 보낼 수 있게 된 때(`max(created_at, not_before)`)부터 1시간 지남 → `failed / expired`
//!    - `refuseReason`(owner_deleted·owner_disabled·channel_deleted·channel_archived·forbidden) → `failed` + `pauseForRefusal`
//!    - 아니면 `postMessage`(작성자 = 자동화 주인, 본문 = `renderBody(body, vars + events + events.count)`, 재시도 키
//!      `automation:<run id>`, `meta.automation = {id,name,trigger,runId,initiatedBy?}`, `chainDepth = run.chain_depth`)
//!      → 글이면 `sent` + `consecutive_failures = 0`, 거절이면 `failed / <code>` + `pauseForRefusal`.
//!    - `finish` = `update automation_run set status, error, message_id, finished_at = now()`.
//!    - DB 순간 오류는 되돌리고 다음 sweep 이 다시 한다(회차는 `pending` 으로 남는다).
//! 3. `pauseForRefusal` = `update automation set enabled = false, next_at = null, paused_reason = 'post_refused:<code>',
//!    consecutive_failures = consecutive_failures + 1, updated_at = now()` + `endAutomationMandatesTx(automation_off)`.
//!
//! 이 모듈이 하는 것: 2 의 잡기·삭제·만료·거절 판정·글 올리기(사슬 깊이 없는 회차)·`sent`/`skipped`/`failed(expired)` 기록·
//! `consecutive_failures = 0`. 비밀 칸(`ingress_token_hash`·`ingress_secret_enc`)은 읽지 않는다.
//!
//! TODO(이것이 끝나야 주인을 `rust` 로 넘길 수 있다):
//! - [ ] 1 `fireOneSchedule` — tz 벽시계 계산(`nextOccurrence`·`timeVars`, DST 처리 `zonedToUtc`)이 Rust 에 없다(chrono-tz 필요)
//!   + `enqueueRun` 의 디바운스(`debounce_sec` 창 병합)·시간당 상한 일시정지. [`crate::core::mcp::automation_run::enqueue_tx`] 를 재사용할 것.
//! - [ ] 3 `pauseForRefusal` — `endAutomationMandatesTx`(위임장 끝내기 + 카드 갱신)가 Rust 에 없다. 지금은 거절·글 거부 회차를
//!   **되돌려 대기로 둔다**([`Delivered::Left`]).
//! - [ ] `chain_depth` 가 있는 회차(에이전트가 돌린 회차, 082) — 글 경로 [`crate::core::msg_post::Origin`] 에 사슬 깊이 입력이 없다. 대기로 둔다.
//! - [ ] Rust 글 경로가 TS 로 넘기는 본문([`crate::core::msg_post::ts_body`]·`Outcome::ToTs`)은 대기로 둔다(예약 글과 같다).
//! - [ ] DB 테스트(예약 글 테스트처럼 TS 와 같은 결과인지).
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_post::{Origin, Outcome, PostBody, PostState, gate_sql, post_in_tx, ts_body};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;

/// TS `SWEEP_INTERVAL_MS`.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(15);
/// TS `SWEEP_BATCH_SIZE`.
pub const SWEEP_BATCH_SIZE: usize = 20;
/// TS `RATE_LIMIT_PER_HOUR` (TODO: 회차 만들기 — 위 모듈 문서).
pub const RATE_LIMIT_PER_HOUR: i64 = 20;
/// TS `PENDING_EXPIRY_MS`.
pub const PENDING_EXPIRY_MS: i64 = 60 * 60 * 1000;

/// 글 쓰기 권한([`crate::core::msg_post::MESSAGE_POST_PRIVILEGES`]) 위에 이 루프가 더 쓰는 칸. 없으면 `main.rs` 가 띄우지 않는다.
/// 비밀 칸은 없다.
pub const AUTOMATION_SWEEP_PRIVILEGES: &[(&str, &str)] = &[
    ("automation_run.id", "SELECT"),
    ("automation_run.automation_id", "SELECT"),
    ("automation_run.trigger_kind", "SELECT"),
    ("automation_run.payload", "SELECT"),
    ("automation_run.created_at", "SELECT"),
    ("automation_run.not_before", "SELECT"),
    ("automation_run.initiated_by", "SELECT"),
    ("automation_run.chain_depth", "SELECT"),
    ("automation_run.status", "SELECT"),
    ("automation_run.status", "UPDATE"),
    ("automation_run.error", "UPDATE"),
    ("automation_run.message_id", "UPDATE"),
    ("automation_run.finished_at", "UPDATE"),
    ("automation.id", "SELECT"),
    ("automation.owner_id", "SELECT"),
    ("automation.channel_id", "SELECT"),
    ("automation.name", "SELECT"),
    ("automation.body", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.consecutive_failures", "UPDATE"),
    ("account.id", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
];

/// TS `deliverOne` 의 select 그대로(칸은 Rust 튜플에 맞춤). TS 의 `$2`(프로세스 시각) 자리는 DB `now()` 다.
pub const DUE_SQL: &str = "select r.id::text, r.automation_id::text, r.trigger_kind, r.payload, \
       (extract(epoch from r.created_at) * 1000)::bigint, (extract(epoch from r.not_before) * 1000)::bigint, \
       r.initiated_by::text, r.chain_depth, a.owner_id::text, a.channel_id::text, a.name, a.body, \
       a.deleted_at is not null \
     from automation_run r join automation a on a.id = r.automation_id \
     where r.status = 'pending' and not (r.id = any($1::uuid[])) \
       and (r.not_before is null or r.not_before <= now()) \
     order by r.created_at limit 1 \
     for update of r skip locked";

const FINISH_SQL: &str = "update automation_run set status = $2, error = $3, message_id = $4::uuid, finished_at = now() where id = $1::uuid";

type DueRow = (
    String,
    String,
    String,
    Value,
    i64,
    Option<i64>,
    Option<String>,
    Option<i32>,
    String,
    String,
    String,
    String,
    bool,
);

/// 한 건 처리의 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivered {
    None,
    Sent(String),
    Skipped,
    Failed(String),
    /// Rust 가 아직 맡지 않는 갈래(모듈 문서 TODO) — 되돌려 대기로 두었다.
    Left,
}

/// TS `renderBody` — `{{ name }}` 을 `vars` 로 바꾸고, 모르는 이름은 그대로 둔다.
pub fn render_body(template: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let replaced = after.find("}}").and_then(|end| {
            let name = after[..end].trim_matches(|c: char| c.is_whitespace());
            let ok = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
            // JS `\s*` 앞뒤 공백 외에 안쪽 공백이 있으면 맞지 않는다 — trim 뒤 이름 칸 검사로 같다.
            if ok {
                vars.get(name).map(|v| (v.clone(), end))
            } else {
                None
            }
        });
        match replaced {
            Some((v, end)) => {
                out.push_str(&v);
                rest = &after[end + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// TS `deliverOne` 의 본문 변수 — `payload.vars` + `events`(병합 목록) + `events.count`.
fn body_vars(payload: &Value) -> HashMap<String, String> {
    let mut vars: HashMap<String, String> = payload
        .get("vars")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let events: Vec<&str> = payload
        .get("events")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|e| e.get("summary").and_then(Value::as_str).unwrap_or(""))
                .collect()
        })
        .unwrap_or_default();
    vars.insert(
        "events".into(),
        events
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    vars.insert("events.count".into(), events.len().max(1).to_string());
    vars
}

async fn finish(
    tx: &mut sqlx::PgConnection,
    id: &str,
    status: &str,
    error: Option<&str>,
    message_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(FINISH_SQL)
        .bind(id)
        .bind(status)
        .bind(error)
        .bind(message_id)
        .execute(tx)
        .await
        .map(|_| ())
}

/// TS `refuseReason`.
async fn refuse_reason(
    tx: &mut sqlx::PgConnection,
    owner: &str,
    channel: &str,
) -> Result<Option<&'static str>, sqlx::Error> {
    let o: Option<(bool, bool)> = sqlx::query_as(
        "select deleted_at is not null, disabled_at is not null from account where id = $1::uuid",
    )
    .bind(owner)
    .fetch_optional(&mut *tx)
    .await?;
    match o {
        None | Some((true, _)) => return Ok(Some("owner_deleted")),
        Some((_, true)) => return Ok(Some("owner_disabled")),
        _ => {}
    }
    let exists: Option<i32> = sqlx::query_scalar("select 1 from channel where id = $1::uuid")
        .bind(channel)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Ok(Some("channel_deleted"));
    }
    let gate: Option<(bool, bool)> = sqlx::query_as(gate_sql())
        .bind(channel)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
    Ok(match gate {
        Some((true, true)) => Some("channel_archived"),
        Some((false, _)) => Some("forbidden"),
        _ => None,
    })
}

/// TS `deliverOne` — 대기 회차 하나를 잡아 처리한다.
pub async fn deliver_one(
    pool: &PgPool,
    st: &PostState,
    skip: &mut Vec<String>,
    now_ms: i64,
) -> Result<Delivered, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row: Option<DueRow> = sqlx::query_as(DUE_SQL)
        .bind(&*skip)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((
        id,
        automation_id,
        trigger_kind,
        payload,
        created_ms,
        not_before_ms,
        initiated_by,
        chain_depth,
        owner,
        channel,
        name,
        body,
        deleted,
    )) = row
    else {
        tx.commit().await?;
        return Ok(Delivered::None);
    };
    skip.push(id.clone());

    if deleted {
        finish(&mut tx, &id, "skipped", Some("automation_deleted"), None).await?;
        tx.commit().await?;
        return Ok(Delivered::Skipped);
    }
    let ready_at = created_ms.max(not_before_ms.unwrap_or(0));
    if now_ms - ready_at > PENDING_EXPIRY_MS {
        finish(&mut tx, &id, "failed", Some("expired"), None).await?;
        tx.commit().await?;
        return Ok(Delivered::Failed("expired".into()));
    }
    if refuse_reason(&mut tx, &owner, &channel).await?.is_some() {
        // TODO: `finish(failed, code)` + `pauseForRefusal`(위임장 끝내기 포함) — 모듈 문서.
        tx.rollback().await?;
        return Ok(Delivered::Left);
    }
    if chain_depth.is_some() {
        // TODO: 글 경로에 사슬 깊이 입력이 생기면 넘긴다.
        tx.rollback().await?;
        return Ok(Delivered::Left);
    }
    let text = render_body(&body, &body_vars(&payload));
    if ts_body(&text) {
        tx.rollback().await?;
        return Ok(Delivered::Left);
    }

    let kind: Option<String> = sqlx::query_scalar("select kind from account where id = $1::uuid")
        .bind(&owner)
        .fetch_optional(&mut *tx)
        .await?;
    let ch_kind: Option<String> =
        sqlx::query_scalar("select kind from channel where id = $1::uuid")
            .bind(&channel)
            .fetch_optional(&mut *tx)
            .await?;
    let audience = audience_for(&st.read, &channel).await?.to_json();
    let mut auto =
        json!({ "id": automation_id, "name": name, "trigger": trigger_kind, "runId": id });
    if let Some(by) = &initiated_by {
        auto["initiatedBy"] = Value::String(by.clone());
    }
    let mut meta = Map::new();
    meta.insert("automation".into(), auto);
    let origin = Origin {
        meta,
        ..Origin::default()
    };
    let input = PostBody {
        body: text,
        attachment_ids: Vec::new(),
        thread_root: None,
        also_in_channel: false,
    };
    let key = format!("automation:{id}");
    let out = post_in_tx(
        st,
        &channel,
        &owner,
        kind.as_deref() == Some("agent"),
        &input,
        Some(&key),
        &audience,
        ch_kind.as_deref() == Some("dm"),
        &origin,
    )
    .await?;
    let posted = |row: &str| -> Option<String> {
        serde_json::from_str::<Value>(row)
            .ok()?
            .get("id")?
            .as_str()
            .map(str::to_owned)
    };
    let msg = match out {
        Outcome::Posted { row, .. } | Outcome::Replayed(row) => posted(&row),
        // 거절 코드(`bad_thread` 등)·TS 몫 — TODO: `failed` + `pauseForRefusal`.
        _ => None,
    };
    let Some(msg) = msg else {
        tx.rollback().await?;
        return Ok(Delivered::Left);
    };
    finish(&mut tx, &id, "sent", None, Some(&msg)).await?;
    sqlx::query("update automation set consecutive_failures = 0 where id = $1::uuid")
        .bind(&automation_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Delivered::Sent(msg))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// TS `sweep` — TODO: 앞에 `fireOneSchedule` × 20. 지금은 발송 단계만. 보낸 수.
pub async fn sweep(pool: &PgPool, st: &PostState) -> Result<usize, sqlx::Error> {
    let mut skip = Vec::new();
    let mut n = 0;
    for _ in 0..SWEEP_BATCH_SIZE {
        match deliver_one(pool, st, &mut skip, now_ms()).await {
            Ok(Delivered::None) => break,
            Ok(Delivered::Sent(_)) => n += 1,
            Ok(Delivered::Left) => {
                eprintln!("loop automation: left a run for TS (owner should stay ts)")
            }
            Ok(_) => {}
            Err(e) => eprintln!("loop automation: deliver failed: {e}"),
        }
    }
    Ok(n)
}

/// 15초마다 문지기(`automation`) 아래서 sweep. 주인이 `rust` 일 때만 돈다(기본 `ts`).
pub fn spawn(gate: PgPool, pool: PgPool, implicit_ok: bool) -> tokio::task::JoinHandle<()> {
    let st = PostState {
        read: pool.clone(),
        write: pool.clone(),
        up: crate::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok,
    };
    tokio::spawn(async move {
        let mut every = tokio::time::interval(SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "automation", Side::Rust, || async {
                sweep(&pool, &st).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop automation: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop automation: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_body_matches_ts() {
        let mut v = HashMap::new();
        v.insert("a".to_string(), "X".to_string());
        v.insert("events.count".to_string(), "2".to_string());
        assert_eq!(render_body("hi {{a}} {{ a }} {{b}}", &v), "hi X X {{b}}");
        assert_eq!(render_body("{{events.count}}}", &v), "2}");
        assert_eq!(render_body("{{ a b }} {{", &v), "{{ a b }} {{");
    }

    #[test]
    fn body_vars_events_default_count_one() {
        let v = body_vars(&json!({}));
        assert_eq!(v["events"], "");
        assert_eq!(v["events.count"], "1");
        let v = body_vars(&json!({"vars": {"x": "1"}, "events": [{"key": "k", "summary": "s"}]}));
        assert_eq!(v["x"], "1");
        assert_eq!(v["events"], "- s");
    }

    #[test]
    fn never_touches_ingress_secrets() {
        for sql in [DUE_SQL, FINISH_SQL] {
            assert!(!sql.contains("ingress_token_hash") && !sql.contains("ingress_secret_enc"));
        }
        assert!(
            AUTOMATION_SWEEP_PRIVILEGES
                .iter()
                .all(|(c, _)| !c.contains("ingress_"))
        );
    }
}
