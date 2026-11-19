//! 자동화 sweep(S5.4) — TS `services/automations.ts` 의 `createAutomationSweeper`(`fireOneSchedule`·`deliverOne`·`refuseReason`·
//! `pauseForRefusal`)를 옮긴다. 아래 TODO 는 모두 끝났다 — 주인(`server_loop` 의 `automation`)을 `rust` 로 넘기는 것은 운영 판단이다
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
//! 이 모듈이 하는 것: 2 의 잡기·삭제·만료·거절 판정·글 올리기(사슬 깊이 있는 회차 포함)·`sent`/`skipped`/`failed(expired)` 기록·
//! `consecutive_failures = 0`, 거절(`refuseReason`)·글 거부(`bad_thread`) 회차의 `failed / <code>` + 3 `pauseForRefusal`
//! ([`pause_for_refusal`] — 자동화 멈춤 + [`end_automation_mandates_tx`] 로 위임장 끝내기·줄 회수, 같은 tx).
//! TS 처럼 sweep 에서는 위임 카드 갱신(`refreshMandateCards`)을 하지 않는다. 비밀 칸(`ingress_token_hash`·`ingress_secret_enc`)은 읽지 않는다.
//!
//! TODO(이것이 끝나야 주인을 `rust` 로 넘길 수 있다):
//! - [x] 1 `fireOneSchedule` — [`fire_one_schedule`]: [`DUE_SCHEDULE_SQL`](`$2` = 프로세스 시각, TS 와 같다) →
//!   [`enqueue_schedule_tx`](TS `enqueueRun` 의 schedule 갈래 — 디바운스는 schedule 에 걸리지 않고, 시간당 상한이면
//!   [`RATE_LIMIT_SQL`] + 위임장 끝내기) → `rate_limited` 가 아니면 [`SET_NEXT_AT_SQL`](`next_occurrence(trigger, now)`).
//!   남은 차이: chrono-tz 가 모르는 tz·zod 가 받지 않을 trigger 는 되돌려 TS 몫으로 둔다(`Fired::Left`).
//!   `pool.begin` 실패는 TS 에선 sweep 전체를 끝내지만 여기선 그 한 건만 넘긴다(다음 건도 같은 실패라 결과는 같다).
//! - [x] 3 `pauseForRefusal` + `endAutomationMandatesTx` — [`pause_for_refusal`]·[`end_automation_mandates_tx`].
//!   남은 차이: 위임장 `ended_at`·줄 `revoked_at` 이 TS 는 프로세스 시각(`new Date()`), 여기는 DB `now()`(tx 시작 시각)다.
//! - [x] `chain_depth` 가 있는 회차(에이전트가 돌린 회차, 082) — [`Origin::chain_depth`] 로 넘긴다. 글 경로가 TS `postMessage` 처럼
//!   `max(스캔 깊이, chain_depth)` 로 부름을 판정(`chain_bound`)하고 그 깊이를 저장한다.
//! - [x] 본문 갈래(URL·글 승인 낱말) — TS 의 링크 미리보기(`queueLinkPreviewFetch`)·글 승인(`applyChatApproval`)·카드 닫기
//!   (`closeAsksByReply`)는 **REST 라우트**(`routes/messageRoutes.ts`) 몫이고, TS sweeper 는 서비스 `postMessage` 를 바로 부르니
//!   그 셋을 하지 않는다. 그래서 여기서도 본문을 거르지 않는다(옛 `ts_body` 보류는 TS 보다 넓은 과잉이었다). [`Origin::service_call`]
//!   을 켜 라우트 몫 갈래를 끈다.
//! - [x] DB 테스트 — `tests/automation_sweep.rs`(TS 와 같은 결과인지).
//!
//! 넘기지 못한 회차(G4): 이 sweep 은 주인이 `rust` 일 때만 돌므로, 여기서 대기로 되돌린 회차는 TS 도 보내지 않아 1시간 뒤
//! `failed / expired` 로 조용히 끝났다. 이제 글 경로가 글을 못 만든 갈래(`ToTs`·`ChainLimit`·`BadAttachment`·`Rejected` — 자동화
//! 회차에는 에이전트 주인의 상한 부름 갈래 말고는 닿지 않는다)는 그 자리에서 `failed / unsupported:<갈래>` 로 적는다(자동화는
//! 멈추지 않는다 — 다음 회차는 본문·부름이 달라 나갈 수 있다). 일정 쪽 `Fired::Left`(chrono-tz 가 모르는 tz·읽을 수 없는 trigger)는
//! 자동화 id 를 로그에 남긴다 — 저장 때 zod·`Intl` 이 거르므로 닿기 어렵고, 멈춤(`paused_reason`)으로 바꾸려면 화면 문구가 함께
//! 필요해 이 모듈에서 정하지 않는다.
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_post::{Origin, Outcome, PostBody, PostState, gate_sql, post_in_tx};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;

/// TS `SWEEP_INTERVAL_MS`.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(15);
/// TS `SWEEP_BATCH_SIZE`.
pub const SWEEP_BATCH_SIZE: usize = 20;
/// TS `RATE_LIMIT_PER_HOUR`.
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
    // `pause_for_refusal` — `consecutive_failures + 1` 은 그 칸을 읽는다.
    ("automation.consecutive_failures", "SELECT"),
    ("automation.enabled", "UPDATE"),
    ("automation.next_at", "UPDATE"),
    ("automation.paused_reason", "UPDATE"),
    ("automation.updated_at", "UPDATE"),
    // `end_automation_mandates_tx` — `for update` 는 UPDATE 권한 한 칸 이상, `returning`·where 는 SELECT.
    ("mandate.id", "SELECT"),
    ("mandate.automation_id", "SELECT"),
    ("mandate.ended_at", "SELECT"),
    ("mandate.ended_at", "UPDATE"),
    ("mandate.end_reason", "UPDATE"),
    ("mandate_line.mandate_id", "SELECT"),
    ("mandate_line.revoked_at", "SELECT"),
    ("mandate_line.revoked_at", "UPDATE"),
    ("account.id", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    // `fire_one_schedule` — 잡기(where·`returning` 칸)와 TS `enqueueRun`(schedule 갈래).
    ("automation.trigger", "SELECT"),
    ("automation.next_at", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.debounce_sec", "SELECT"),
    ("automation_run.event_key", "SELECT"),
    ("automation_run.automation_id", "INSERT"),
    ("automation_run.event_key", "INSERT"),
    ("automation_run.trigger_kind", "INSERT"),
    ("automation_run.payload", "INSERT"),
    ("automation_run.not_before", "INSERT"),
    ("automation_run.initiated_by", "INSERT"),
    ("automation_run.cause_message_id", "INSERT"),
    ("automation_run.chain_depth", "INSERT"),
];

/// TS `fireOneSchedule` 의 잡기 그대로. `$2` 는 TS 처럼 프로세스 시각(`now()`)이다. `next_at` 은 ms(TS `Date` 정밀도).
pub const DUE_SCHEDULE_SQL: &str = "select id::text, trigger, (floor(extract(epoch from next_at) * 1000))::bigint from automation \
     where enabled and deleted_at is null and next_at is not null and next_at <= $2::timestamptz \
       and not (id = any($1::uuid[])) \
     order by next_at limit 1 \
     for update skip locked";
/// TS `enqueueRun` 의 자동화 행 읽기.
pub const ENQUEUE_ROW_SQL: &str =
    "select enabled, debounce_sec from automation where id = $1::uuid and deleted_at is null";
/// TS `enqueueRun` 의 시간당 회차 셈.
pub const RECENT_RUNS_SQL: &str = "select count(*)::int as n from automation_run \
     where automation_id = $1::uuid and created_at > now() - interval '1 hour'";
/// TS `enqueueRun` 의 시간당 상한 일시정지.
pub const RATE_LIMIT_SQL: &str = "update automation set enabled = false, paused_reason = 'rate_limited', next_at = null, updated_at = now() \
     where id = $1::uuid";
/// TS `enqueueRun` 의 INSERT(schedule 갈래 — 디바운스 없음이라 `not_before` null, 에이전트 칸 null).
/// `returning` 은 TS `RUN_COLS` 대신 id 만(sweeper 는 회차 행을 쓰지 않는다).
pub const INSERT_SCHEDULE_RUN_SQL: &str = "insert into automation_run (automation_id, event_key, trigger_kind, payload, not_before, \
                                 initiated_by, cause_message_id, chain_depth) \
     values ($1::uuid, $2, $3, $4::jsonb, null, null, null, null) \
     on conflict (automation_id, event_key) do nothing \
     returning id::text";
/// TS `fireOneSchedule` 의 다음 시각.
pub const SET_NEXT_AT_SQL: &str =
    "update automation set next_at = $2::timestamptz where id = $1::uuid";

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

/// TS `pauseForRefusal` 의 update 그대로.
pub const PAUSE_SQL: &str = "update automation set enabled = false, next_at = null, paused_reason = $2, \
       consecutive_failures = consecutive_failures + 1, updated_at = now() \
     where id = $1::uuid";
/// TS `endAutomationMandatesTx` 의 잡기.
pub const LIVE_MANDATES_SQL: &str =
    "select id::text from mandate where automation_id = $1::uuid and ended_at is null for update";
/// TS `endMandateTx` 의 끝내기(멱등 — 이미 끝났으면 행 없음).
pub const END_MANDATE_SQL: &str = "update mandate set ended_at = now(), end_reason = $2 \
     where id = $1::uuid and ended_at is null returning id::text";
/// TS `endMandateTx` 의 줄 회수.
pub const REVOKE_LINES_SQL: &str =
    "update mandate_line set revoked_at = now() where mandate_id = $1::uuid and revoked_at is null";

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

/// TS `endAutomationMandatesTx` — 트랜잭션 안에서 그 자동화의 살아 있는 위임장을 모두 끝내고 줄을 닫는다. 잡은 id(TS 와 같다).
/// `reason` 은 `automation_off` | `automation_changed`.
pub async fn end_automation_mandates_tx(
    tx: &mut sqlx::PgConnection,
    automation_id: &str,
    reason: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(LIVE_MANDATES_SQL)
        .bind(automation_id)
        .fetch_all(&mut *tx)
        .await?;
    for id in &ids {
        let ended: Option<String> = sqlx::query_scalar(END_MANDATE_SQL)
            .bind(id)
            .bind(reason)
            .fetch_optional(&mut *tx)
            .await?;
        if ended.is_some() {
            sqlx::query(REVOKE_LINES_SQL)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    Ok(ids)
}

/// TS `pauseForRefusal` — 게시가 거부되면 그 자리에서 멈추고 위임장을 끝낸다(`automation_off`).
pub async fn pause_for_refusal(
    tx: &mut sqlx::PgConnection,
    automation_id: &str,
    code: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(PAUSE_SQL)
        .bind(automation_id)
        .bind(format!("post_refused:{code}"))
        .execute(&mut *tx)
        .await?;
    end_automation_mandates_tx(tx, automation_id, "automation_off").await?;
    Ok(())
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
    if let Some(code) = refuse_reason(&mut tx, &owner, &channel).await? {
        finish(&mut tx, &id, "failed", Some(code), None).await?;
        pause_for_refusal(&mut tx, &automation_id, code).await?;
        tx.commit().await?;
        return Ok(Delivered::Failed(code.into()));
    }
    let text = render_body(&body, &body_vars(&payload));

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
        chain_depth,
        // TS sweeper 는 서비스 `postMessage` 를 바로 부른다 — 라우트 몫(카드 고르기·카드 닫기)은 없다.
        service_call: true,
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
        // TS `result.failure` — `failed / <code>` + `pauseForRefusal`. 머리 없는 글이라 실제로는 닿지 않는다.
        Outcome::BadThread => {
            finish(&mut tx, &id, "failed", Some("bad_thread"), None).await?;
            pause_for_refusal(&mut tx, &automation_id, "bad_thread").await?;
            tx.commit().await?;
            return Ok(Delivered::Failed("bad_thread".into()));
        }
        // 글 경로가 글을 만들지 않은 갈래 — 주인이 `rust` 인 동안 TS 도 보내지 않으니 대기로 두면 1시간 뒤 `expired` 로
        // 조용히 끝난다(G4). 그 자리에서 까닭을 적는다. post_in_tx 가 이미 되돌렸어도 이 tx 는 sweeper 것이다.
        Outcome::ToTs => return unsupported(tx, &id, "to_ts").await,
        Outcome::ChainLimit => return unsupported(tx, &id, "chain_limit").await,
        Outcome::BadAttachment => return unsupported(tx, &id, "bad_attachment").await,
        Outcome::Rejected(_) => return unsupported(tx, &id, "rejected").await,
    };
    let Some(msg) = msg else {
        // 글 행에서 id 를 읽지 못했다(일어나지 않는다).
        return unsupported(tx, &id, "no_message_id").await;
    };
    finish(&mut tx, &id, "sent", None, Some(&msg)).await?;
    sqlx::query("update automation set consecutive_failures = 0 where id = $1::uuid")
        .bind(&automation_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Delivered::Sent(msg))
}

/// 글 경로가 글을 만들지 않은 회차를 `failed / unsupported:<갈래>` 로 닫는다(G4 — 모듈 문서).
async fn unsupported(
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    id: &str,
    why: &str,
) -> Result<Delivered, sqlx::Error> {
    let code = format!("unsupported:{why}");
    eprintln!("loop automation: run {id} not posted ({code})");
    finish(&mut tx, id, "failed", Some(&code), None).await?;
    tx.commit().await?;
    Ok(Delivered::Failed(code))
}

/// TS `EnqueueResult` 중 schedule 갈래가 닿는 것.
#[derive(Debug, PartialEq, Eq)]
pub enum Enqueued {
    Inactive,
    RateLimited,
    Duplicate,
    Queued(String),
}

/// TS `eventSummary(vars, eventKey)`.
pub fn event_summary(vars: &Map<String, Value>, event_key: &str) -> String {
    let get = |k: &str| {
        vars.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let any = |k: &str| vars.get(k).and_then(Value::as_str);
    let head = if let Some(n) = get("pr.number") {
        format!("#{n} ")
    } else if let Some(sha) = get("sha") {
        // JS `slice(0, 7)` 는 UTF-16 단위다 — sha 는 ASCII 라 문자 단위와 같다.
        format!("{} ", sha.chars().take(7).collect::<String>())
    } else {
        String::new()
    };
    let text = [
        "pr.title",
        "commit.message",
        "release.tag",
        "workflow.name",
        "payload.title",
        "payload.status",
    ]
    .iter()
    .find_map(|k| any(k))
    .unwrap_or(event_key);
    format!("{head}{text}")
}

/// TS `enqueueRun` 의 payload — `{ vars, events: [{ key, summary }] }`.
pub fn run_payload(vars: &Map<String, Value>, event_key: &str) -> Value {
    json!({
        "vars": vars,
        "events": [{ "key": event_key, "summary": event_summary(vars, event_key) }],
    })
}

/// 일정 한 건의 순수 계획 — 저장된 trigger 로 `timeVars` 와 다음 시각 계산기를 고른다.
/// `None` 이면 Rust 가 계산할 수 없는 일정(chrono-tz 가 모르는 tz 등)이라 TS 몫으로 남긴다.
#[derive(Debug, PartialEq, Eq)]
pub enum SchedulePlan {
    /// `kind == 'schedule'` — 변수와 일정.
    Schedule(Map<String, Value>, crate::core::automation_time::Schedule),
    /// 다른 trigger 에 `next_at` 이 있는 경우 — TS 는 변수 `{}`, 다음 시각 null.
    Other,
}

pub fn plan_schedule(trigger: &Value, fired_for_ms: i64) -> Option<SchedulePlan> {
    use crate::core::automation_time::{Schedule, time_vars};
    if trigger.get("kind").and_then(Value::as_str) != Some("schedule") {
        return Some(SchedulePlan::Other);
    }
    let s = Schedule::parse(trigger)?;
    let vars = time_vars(fired_for_ms, s.tz)?;
    Some(SchedulePlan::Schedule(vars, s))
}

impl SchedulePlan {
    /// TS `t.kind === 'schedule' ? nextOccurrence(t, now()) : null` → ISO.
    pub fn next_at(&self, now_ms: i64) -> Option<String> {
        match self {
            SchedulePlan::Schedule(_, s) => {
                crate::core::automation_time::next_occurrence(s, now_ms)
                    .and_then(crate::core::automation_time::iso)
            }
            SchedulePlan::Other => None,
        }
    }
}

/// TS `enqueueRun`(triggerKind `schedule`, ignoreEnabled 없음, 에이전트 칸 없음). schedule 은 디바운스로 모으지 않으므로
/// `mergeIntoGathering` 갈래와 `not_before` 는 늘 비어 있다(TS 조건 `triggerKind !== 'schedule'`).
pub async fn enqueue_schedule_tx(
    tx: &mut sqlx::PgConnection,
    automation_id: &str,
    event_key: &str,
    vars: &Map<String, Value>,
) -> Result<Enqueued, sqlx::Error> {
    let row: Option<(bool, Option<i32>)> = sqlx::query_as(ENQUEUE_ROW_SQL)
        .bind(automation_id)
        .fetch_optional(&mut *tx)
        .await?;
    match row {
        Some((true, _)) => {}
        _ => return Ok(Enqueued::Inactive),
    }
    let n: i32 = sqlx::query_scalar(RECENT_RUNS_SQL)
        .bind(automation_id)
        .fetch_one(&mut *tx)
        .await?;
    if i64::from(n) >= RATE_LIMIT_PER_HOUR {
        sqlx::query(RATE_LIMIT_SQL)
            .bind(automation_id)
            .execute(&mut *tx)
            .await?;
        end_automation_mandates_tx(tx, automation_id, "automation_off").await?;
        return Ok(Enqueued::RateLimited);
    }
    let id: Option<String> = sqlx::query_scalar(INSERT_SCHEDULE_RUN_SQL)
        .bind(automation_id)
        .bind(event_key)
        .bind("schedule")
        .bind(run_payload(vars, event_key))
        .fetch_optional(&mut *tx)
        .await?;
    Ok(id.map_or(Enqueued::Duplicate, Enqueued::Queued))
}

/// `fire_one_schedule` 의 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Fired {
    None,
    Done(Enqueued),
    /// Rust 가 계산할 수 없는 일정(자동화 id) — 되돌려 두었다(모듈 문서 G4).
    Left(String),
}

/// TS `fireOneSchedule` — 시각이 된 schedule 하나를 회차로 만든다. 밀린 회차는 따라잡지 않는다.
/// `now` 는 TS 처럼 잡기 시각과 다음 시각 계산에 각각 새로 읽는다.
pub async fn fire_one_schedule(
    pool: &PgPool,
    skip: &mut Vec<String>,
    now: impl Fn() -> i64,
) -> Result<Fired, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let Some(now_iso) = crate::core::automation_time::iso(now()) else {
        tx.rollback().await?;
        return Ok(Fired::None);
    };
    let row: Option<(String, Value, i64)> = sqlx::query_as(DUE_SCHEDULE_SQL)
        .bind(&*skip)
        .bind(&now_iso)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((id, trigger, next_at_ms)) = row else {
        tx.commit().await?;
        return Ok(Fired::None);
    };
    skip.push(id.clone());

    let (Some(plan), Some(fired_iso)) = (
        plan_schedule(&trigger, next_at_ms),
        crate::core::automation_time::iso(next_at_ms),
    ) else {
        tx.rollback().await?;
        return Ok(Fired::Left(id));
    };
    // 회차 키는 **예정 시각**이다 — 같은 회차를 두 프로세스가 집어도 하나만 남는다.
    let event_key = format!("schedule:{fired_iso}");
    let empty = Map::new();
    let vars = match &plan {
        SchedulePlan::Schedule(v, _) => v,
        SchedulePlan::Other => &empty,
    };
    let result = enqueue_schedule_tx(&mut tx, &id, &event_key, vars).await?;
    if result != Enqueued::RateLimited {
        sqlx::query(SET_NEXT_AT_SQL)
            .bind(&id)
            .bind(plan.next_at(now()))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Fired::Done(result))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// TS `sweep` — `fireOneSchedule` × 20 뒤 `deliverOne` × 20. 보낸 수.
pub async fn sweep(pool: &PgPool, st: &PostState) -> Result<usize, sqlx::Error> {
    let mut skip_a = Vec::new();
    for _ in 0..SWEEP_BATCH_SIZE {
        match fire_one_schedule(pool, &mut skip_a, now_ms).await {
            Ok(Fired::None) => break,
            Ok(Fired::Left(id)) => {
                eprintln!(
                    "loop automation: automation {id} has a schedule Rust cannot read (tz/trigger) — left as is"
                )
            }
            Ok(Fired::Done(_)) => {}
            // TS 처럼 한 건 오류는 로그만 남기고 다음 건으로 간다(`'done'`).
            Err(e) => eprintln!("loop automation: schedule sweep failed: {e}"),
        }
    }
    let mut skip = Vec::new();
    let mut n = 0;
    for _ in 0..SWEEP_BATCH_SIZE {
        match deliver_one(pool, st, &mut skip, now_ms()).await {
            Ok(Delivered::None) => break,
            Ok(Delivered::Sent(_)) => n += 1,
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
    fn event_summary_matches_ts() {
        let mut v = Map::new();
        assert_eq!(event_summary(&v, "schedule:x"), "schedule:x");
        v.insert("sha".into(), "abcdef0123".into());
        v.insert("commit.message".into(), "fix".into());
        assert_eq!(event_summary(&v, "k"), "abcdef0 fix");
        v.insert("pr.number".into(), "12".into());
        v.insert("pr.title".into(), "T".into());
        assert_eq!(event_summary(&v, "k"), "#12 T");
        // `??` 는 빈 문자열을 넘기지 않는다.
        let mut w = Map::new();
        w.insert("pr.title".into(), "".into());
        assert_eq!(event_summary(&w, "k"), "");
    }

    #[test]
    fn schedule_plan_and_payload() {
        // 2025-11-16 00:00 UTC = 09:00 Asia/Seoul.
        let fired = 1_763_251_200_000;
        let t = json!({"kind": "schedule", "freq": "daily", "time": "09:00", "tz": "Asia/Seoul"});
        let plan = plan_schedule(&t, fired).expect("plan");
        let SchedulePlan::Schedule(vars, _) = &plan else {
            panic!("schedule")
        };
        assert_eq!(vars["date"], "2025-11-16");
        assert_eq!(
            plan.next_at(fired).as_deref(),
            Some("2025-11-17T00:00:00.000Z")
        );
        let key = format!(
            "schedule:{}",
            crate::core::automation_time::iso(fired).unwrap()
        );
        let p = run_payload(vars, &key);
        assert_eq!(p["events"][0]["summary"], key.as_str());
        assert_eq!(p["vars"]["yesterday"], "2025-11-15");
        // 모르는 tz 는 TS 몫.
        let bad = json!({"kind": "schedule", "freq": "daily", "time": "09:00", "tz": "UTC+9"});
        assert_eq!(plan_schedule(&bad, fired), None);
        // 다른 trigger 는 변수 없음·다음 시각 null.
        let other = plan_schedule(&json!({"kind": "manual"}), fired).unwrap();
        assert_eq!(other, SchedulePlan::Other);
        assert_eq!(other.next_at(fired), None);
    }

    #[test]
    fn never_touches_ingress_secrets() {
        for sql in [
            DUE_SQL,
            DUE_SCHEDULE_SQL,
            ENQUEUE_ROW_SQL,
            RECENT_RUNS_SQL,
            RATE_LIMIT_SQL,
            INSERT_SCHEDULE_RUN_SQL,
            SET_NEXT_AT_SQL,
            FINISH_SQL,
            PAUSE_SQL,
            LIVE_MANDATES_SQL,
            END_MANDATE_SQL,
            REVOKE_LINES_SQL,
        ] {
            assert!(!sql.contains("ingress_token_hash") && !sql.contains("ingress_secret_enc"));
        }
        assert!(
            AUTOMATION_SWEEP_PRIVILEGES
                .iter()
                .all(|(c, _)| !c.contains("ingress_"))
        );
    }
}
