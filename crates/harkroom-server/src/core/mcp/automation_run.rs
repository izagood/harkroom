//! S5.4 통합 — MCP `automation.run`(082). TS `mcpPlugin.ts` 의 같은 도구와 `services/automations.ts::runAutomationForAgent` 를 옮긴다:
//! 인자(zod uuid) → 원인 판정(`agentRunOwner`, `automation.list` 와 같은 문장) → 소유자의 자동화인가·승인됐나 → 연쇄 상한 →
//! **자동화 행 잠금 아래 한 트랜잭션**에서 에이전트 쿼터(10분 1회·1시간 3회)·원인 한 번·회차 INSERT(`runAutomationNow` → `enqueueRun`).
//! 글은 Rust 도 쓰지 않는다 — 회차만 넣고 발송은 sweeper(TS) 몫이다(TS 도 같다).
//!
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · 일정 트리거의 시간대를 `chrono-tz` 가 모름(정확한 IANA 이름이 아님) ·
//!   1시간 회차가 `RATE_LIMIT_PER_HOUR` 에 닿은 경우(자동화를 끄고 위임장을 닫는 쓰기는 TS 만 한다 — 롤백한 뒤 넘기므로 TS 가 같은 판정을
//!   처음부터 다시 한다) · DB 오류(롤백 뒤) · 회차 행 해석 실패(커밋 **전**에 롤백하므로 이중 INSERT 가 없다).
//! - 쓰기 칸은 `automation_run` INSERT 여덟 칸뿐이다. `automation` 에는 쓰지 않는다 — `for update` 잠금이 표의 UPDATE 칸 하나를
//!   요구해 `automation.updated_at` UPDATE 를 받지만 그 칸에 쓰는 문장은 없다(`decide_approve::MANDATE_LINE_PRIVILEGES` 의 `for share` 와 같은 꼴).
use super::tools::err;
use crate::auth::Account;
use crate::core::msg_post;
use crate::core::msg_read::is_uuid;
use serde_json::Value;
use sqlx::{PgPool, Row};

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`main.rs`). 원인·자동화·연쇄 상한 판정은 읽기 풀로 한다.
pub const AUTOMATION_RUN_PRIVILEGES: &[(&str, &str)] = &[
    // 잠금(`for update`)·enqueueRun 의 행 읽기.
    ("automation.id", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.debounce_sec", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.updated_at", "UPDATE"),
    // 쿼터·원인 한 번·회차 상한 셈과 `returning`.
    ("automation_run.id", "SELECT"),
    ("automation_run.automation_id", "SELECT"),
    ("automation_run.event_key", "SELECT"),
    ("automation_run.trigger_kind", "SELECT"),
    ("automation_run.status", "SELECT"),
    ("automation_run.message_id", "SELECT"),
    ("automation_run.error", "SELECT"),
    ("automation_run.created_at", "SELECT"),
    ("automation_run.finished_at", "SELECT"),
    ("automation_run.initiated_by", "SELECT"),
    ("automation_run.cause_message_id", "SELECT"),
    ("automation_run.automation_id", "INSERT"),
    ("automation_run.event_key", "INSERT"),
    ("automation_run.trigger_kind", "INSERT"),
    ("automation_run.payload", "INSERT"),
    ("automation_run.not_before", "INSERT"),
    ("automation_run.initiated_by", "INSERT"),
    ("automation_run.cause_message_id", "INSERT"),
    ("automation_run.chain_depth", "INSERT"),
];

/// TS 상수(`automations.ts`).
const RATE_LIMIT_PER_HOUR: i32 = 20;
const AGENT_RUNS_PER_HOUR: i32 = 3;
const AGENT_RUN_MIN_GAP_MS: i64 = 10 * 60 * 1000;
const AGENT_RUN_CHAIN_DEPTH: i32 = 1;
/// `@harkroom/shared` `MENTION_CHAIN_LIMIT`(행이 없을 때).
const MENTION_CHAIN_LIMIT: i32 = 8;

/// TS `getAutomation`(소유자·지워지지 않음) 중 여기서 쓰는 칸.
const AUTOMATION_SQL: &str = "select a.id::text, a.owner_id::text, a.channel_id::text, a.name, a.trigger::text, \
       (a.approved_at is not null) from automation a where a.id = $1::uuid and a.owner_id = $2::uuid and a.deleted_at is null";
const CHAIN_LIMIT_SQL: &str =
    "select coalesce((select chain_limit from mention_policy where id = true), $1)::int";
const LOCK_SQL: &str = "select 1 from automation where id = $1::uuid for update";
const QUOTA_SQL: &str = "select floor(extract(epoch from max(created_at)) * 1000)::bigint, \
       floor(extract(epoch from now()) * 1000)::bigint, count(*)::int from automation_run \
        where automation_id = $1::uuid and initiated_by is not null and created_at > now() - interval '1 hour'";
const CAUSE_USED_SQL: &str = "select 1 from automation_run where cause_message_id = $1::uuid and initiated_by is not null limit 1";
const ENQUEUE_ROW_SQL: &str =
    "select enabled, debounce_sec from automation where id = $1::uuid and deleted_at is null";
const RECENT_SQL: &str = "select count(*)::int from automation_run \
     where automation_id = $1::uuid and created_at > now() - interval '1 hour'";
/// TS `enqueueRun` 의 INSERT(수동 회차 — `not_before` 는 늘 null). `returning` 은 TS `RUN_COLS` 칸.
const INSERT_SQL: &str = "insert into automation_run (automation_id, event_key, trigger_kind, payload, not_before, \
                                 initiated_by, cause_message_id, chain_depth) \
     values ($1::uuid, $2, 'manual', $3::jsonb, null, $4::uuid, $5::uuid, $6) \
     on conflict (automation_id, event_key) do nothing \
     returning id::text, automation_id::text, event_key, trigger_kind, status, message_id::text, error, \
       floor(extract(epoch from created_at) * 1000)::bigint as created_ms, \
       floor(extract(epoch from finished_at) * 1000)::bigint as finished_ms, \
       initiated_by::text, cause_message_id::text";

fn refusal(code: &str) -> &'static str {
    match code {
        "no_cause" => {
            "only the automation owner can ask you to run it — this turn was not started by a human message that called you"
        }
        "cause_stale" => {
            "the request that started this turn is more than an hour old; ask the owner to ask again"
        }
        "cause_used" => "this request already ran an automation once; ask the owner to ask again",
        "cause_not_human" => {
            "this turn was started by an agent; the automation owner must ask you directly"
        }
        "automation_reentry" => {
            "this turn was started by an automation post; automations cannot re-run themselves through agents"
        }
        "not_found" => "no automation with this id owned by the person who asked",
        "not_approved" => "the proposal is not approved yet (Settings › Automations › Approve)",
        "agent_quota" => {
            "agents may run one automation at most once per 10 minutes and 3 times per hour"
        }
        "chain_capped" => "the mention chain limit is reached",
        _ => "not queued",
    }
}

fn refuse(code: &str) -> Option<String> {
    Some(err(code, refusal(code)))
}

/// zod `{ automationId: z.string().uuid() }` — 모르는 키는 버린다.
fn parse(args: &Value) -> Option<String> {
    let id = args.as_object()?.get("automationId")?.as_str()?;
    is_uuid(id).then(|| id.to_owned())
}

struct Automation {
    id: String,
    owner: String,
    channel: String,
    name: String,
    trigger: String,
}

pub async fn answer(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
) -> Option<String> {
    let automation_id = parse(args)?;
    let Some(cause) = cause else {
        return refuse("no_cause");
    };
    type W = (String, bool, bool, bool);
    let who: Option<W> = sqlx::query_as(super::reads3::RUN_OWNER_SQL)
        .bind(cause)
        .bind(&me.id)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some((owner, author_is_agent, from_automation, fresh)) = who else {
        return refuse("no_cause");
    };
    if !fresh {
        return refuse("cause_stale");
    }
    if author_is_agent {
        return refuse("cause_not_human");
    }
    if from_automation {
        return refuse("automation_reentry");
    }
    type A = (String, String, String, String, String, bool);
    let row: Option<A> = sqlx::query_as(AUTOMATION_SQL)
        .bind(&automation_id)
        .bind(&owner)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some((id, owner, channel, name, trigger, approved)) = row else {
        return refuse("not_found");
    };
    if !approved {
        return refuse("not_approved");
    }
    let a = Automation {
        id,
        owner,
        channel,
        name,
        trigger,
    };
    let chain_limit: i32 = sqlx::query_scalar(CHAIN_LIMIT_SQL)
        .bind(MENTION_CHAIN_LIMIT)
        .fetch_one(read)
        .await
        .ok()?;
    if AGENT_RUN_CHAIN_DEPTH >= chain_limit {
        return refuse("chain_capped");
    }
    let vars = vars_for(&a.trigger)?;
    // TS `manual:${randomUUID()}` — v4 를 DB 에서 받는다(크레이트에 uuid 가 없다).
    let event_key: String = sqlx::query_scalar("select 'manual:' || gen_random_uuid()::text")
        .fetch_one(read)
        .await
        .ok()?;
    // TS `enqueueRun` payload — `eventSummary` 는 PR·sha·제목 변수가 없으니 이벤트 키 그대로다.
    let payload = serde_json::json!({
        "vars": vars,
        "events": [{ "key": event_key, "summary": event_key }],
    });
    match enqueue(write, &a, cause, &me.id, &event_key, &payload).await {
        Enq::Queued(run) => {
            let text = format!(
                "{{\"run\":{run},\"automation\":{{\"id\":{},\"name\":{},\"channelId\":{},\"ownerId\":{}}},\"next\":{}}}",
                Value::from(a.id.as_str()),
                Value::from(a.name.as_str()),
                Value::from(a.channel.as_str()),
                Value::from(a.owner.as_str()),
                Value::from(
                    "Queued. The post goes out under the owner's name within ~15s; tell the requester in chat."
                ),
            );
            Some(super::respond::text_result(&text))
        }
        Enq::Refused(code) => refuse(code),
        Enq::ToTs => None,
    }
}

/// TS `runAutomationNow` 의 `vars` — 일정 트리거면 `timeVars(now, tz)`(프로세스 시각, TS 와 같다), 아니면 빈 객체.
/// 계산은 [`automation_time`](crate::core::automation_time) 이 TS 산법 그대로 한다. `chrono-tz` 가 모르는 tz 이름
/// (TS `Intl` 은 대소문자 무시·별칭으로 받을 수 있다)만 TS 로 넘긴다(`None`).
fn vars_for(trigger: &str) -> Option<Value> {
    let t: Value = serde_json::from_str(trigger).ok()?;
    if t.get("kind").and_then(Value::as_str) == Some("schedule") {
        let tz = crate::core::automation_time::parse_tz(t.get("tz")?.as_str()?)?;
        let now = i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis(),
        )
        .ok()?;
        return crate::core::automation_time::time_vars(now, tz).map(Value::Object);
    }
    Some(Value::Object(serde_json::Map::new()))
}

/// 회차 넣기의 결말 — 시험(`tests/automation_grant.rs`)이 무권한 롤로 [`enqueue_tx`] 를 돌려 본다.
pub enum Enq {
    Queued(String),
    Refused(&'static str),
    ToTs,
}

async fn enqueue(
    write: &PgPool,
    a: &Automation,
    cause: &str,
    agent: &str,
    event_key: &str,
    payload: &Value,
) -> Enq {
    let Ok(mut tx) = write.begin().await else {
        return Enq::ToTs;
    };
    let out = enqueue_tx(&mut tx, &a.id, cause, agent, event_key, payload).await;
    match out {
        Ok(Enq::Queued(run)) => {
            if tx.commit().await.is_ok() {
                Enq::Queued(run)
            } else {
                Enq::ToTs
            }
        }
        // 거절도 TS 처럼 롤백한다(`inactive`·`duplicate` 는 TS 가 커밋하지만 쓴 것이 없어 같다).
        Ok(other) => {
            let _ = tx.rollback().await;
            other
        }
        Err(e) => {
            let _ = tx.rollback().await;
            let cause_conflict = e.as_database_error().is_some_and(|d| {
                d.code().as_deref() == Some("23505")
                    && d.constraint() == Some("automation_run_agent_cause")
            });
            if cause_conflict {
                Enq::Refused("cause_used")
            } else {
                Enq::ToTs
            }
        }
    }
}

/// 자동화 행 잠금 아래의 쿼터·원인 한 번·회차 INSERT. 커밋·롤백은 부른 쪽이 한다.
pub async fn enqueue_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    automation_id: &str,
    cause: &str,
    agent: &str,
    event_key: &str,
    payload: &Value,
) -> Result<Enq, sqlx::Error> {
    sqlx::query(LOCK_SQL)
        .bind(automation_id)
        .fetch_optional(&mut **tx)
        .await?;
    let (last, now, n): (Option<i64>, i64, i32) = sqlx::query_as(QUOTA_SQL)
        .bind(automation_id)
        .fetch_one(&mut **tx)
        .await?;
    let used = sqlx::query(CAUSE_USED_SQL)
        .bind(cause)
        .fetch_optional(&mut **tx)
        .await?;
    if used.is_some() {
        return Ok(Enq::Refused("cause_used"));
    }
    if n >= AGENT_RUNS_PER_HOUR || last.is_some_and(|l| now - l < AGENT_RUN_MIN_GAP_MS) {
        return Ok(Enq::Refused("agent_quota"));
    }
    // enqueueRun — 「지금 한 번」은 꺼진 자동화도 돌리고(ignoreEnabled), 수동이라 디바운스로 모으지 않는다.
    let row: Option<(bool, Option<i32>)> = sqlx::query_as(ENQUEUE_ROW_SQL)
        .bind(automation_id)
        .fetch_optional(&mut **tx)
        .await?;
    if row.is_none() {
        return Ok(Enq::Refused("inactive"));
    }
    let recent: i32 = sqlx::query_scalar(RECENT_SQL)
        .bind(automation_id)
        .fetch_one(&mut **tx)
        .await?;
    if recent >= RATE_LIMIT_PER_HOUR {
        // 끄기·위임장 닫기는 TS 만 한다 — 롤백하고 넘긴다.
        return Ok(Enq::ToTs);
    }
    let ins = sqlx::query(INSERT_SQL)
        .bind(automation_id)
        .bind(event_key)
        .bind(payload.to_string())
        .bind(agent)
        .bind(cause)
        .bind(AGENT_RUN_CHAIN_DEPTH)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(ins) = ins else {
        return Ok(Enq::Refused("duplicate"));
    };
    // 해석 실패는 커밋 전에 넘긴다 — 롤백되므로 TS 가 다시 넣어도 회차는 하나다.
    Ok(run_view(&ins).map_or(Enq::ToTs, Enq::Queued))
}

fn opt_iso(ms: Option<i64>) -> Value {
    ms.map_or(Value::Null, |m| Value::from(msg_post::iso_ms(m)))
}

/// TS `RUN_COLS` 글자(키 순서 그대로).
fn run_view(row: &sqlx::postgres::PgRow) -> Option<String> {
    let s = |k: &str| row.try_get::<String, _>(k).ok().map(Value::from);
    let os = |k: &str| {
        row.try_get::<Option<String>, _>(k)
            .ok()
            .map(|v| v.map_or(Value::Null, Value::from))
    };
    let created: i64 = row.try_get("created_ms").ok()?;
    let finished: Option<i64> = row.try_get("finished_ms").ok()?;
    Some(format!(
        "{{\"id\":{},\"automationId\":{},\"eventKey\":{},\"triggerKind\":{},\"status\":{},\"messageId\":{},\"error\":{},\
         \"createdAt\":{},\"finishedAt\":{},\"initiatedBy\":{},\"causeMessageId\":{}}}",
        s("id")?,
        s("automation_id")?,
        s("event_key")?,
        s("trigger_kind")?,
        s("status")?,
        os("message_id")?,
        os("error")?,
        Value::from(msg_post::iso_ms(created)),
        opt_iso(finished),
        os("initiated_by")?,
        os("cause_message_id")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_matches_zod() {
        let id = "0b9f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
        assert_eq!(
            parse(&serde_json::json!({ "automationId": id, "x": 1 })).as_deref(),
            Some(id)
        );
        assert!(parse(&serde_json::json!({ "automationId": "nope" })).is_none());
        assert!(parse(&serde_json::json!({})).is_none());
        assert!(parse(&serde_json::json!([])).is_none());
        assert!(parse(&serde_json::json!({ "automationId": 1 })).is_none());
    }

    #[test]
    fn refusal_texts_match_ts() {
        // TS mcpPlugin `automationRefusal` — duplicate·inactive 는 'not queued'.
        assert_eq!(refusal("duplicate"), "not queued");
        assert_eq!(refusal("inactive"), "not queued");
        assert_eq!(
            refusal("agent_quota"),
            "agents may run one automation at most once per 10 minutes and 3 times per hour"
        );
    }

    #[test]
    fn writes_only_automation_run() {
        // `automation` 에 쓰는 문장이 없다 — UPDATE 권한은 잠금용이다.
        for sql in [
            AUTOMATION_SQL,
            LOCK_SQL,
            QUOTA_SQL,
            CAUSE_USED_SQL,
            ENQUEUE_ROW_SQL,
            RECENT_SQL,
            INSERT_SQL,
        ] {
            let l = sql.to_lowercase();
            assert!(!l.contains("update automation"), "{sql}");
            assert!(!l.contains("returning *"), "{sql}");
        }
        assert!(
            AUTOMATION_RUN_PRIVILEGES
                .iter()
                .filter(|(_, p)| *p == "UPDATE")
                .eq([("automation.updated_at", "UPDATE")].iter())
        );
    }
}
