//! MCP `thread.plan.item` 의 `auto` 칸 — 계획판 자동 진행 켜기·끄기. TS `mcpPlugin.ts` 의 `auto !== undefined` 갈래와
//! `services/threadPlanAuto.ts` 의 `setPlanAuto`·`clearPlanAuto`(관리 에이전트 갈래)를 옮긴다.
//!
//! - 켜는 것은 **사람의 글**이다. 쓰는 이가 관리 에이전트이고, 근거 글이 이 스레드의 사람 글이며, 그 글이 **지금 이 에이전트
//!   턴 임대의 원인**이어야 한다. 임대는 서버가 실제로 그 글에 불린 에이전트에게만 주므로 아무 사람 글이나 근거로 고를 수 없다.
//! - 순서가 규칙이다(TS 와 같다): zod(→ TS) → 에이전트만(`agents_only`) → 다른 칸 없이(`auto_alone`) → 루트·가시성
//!   (`not_found`·`not_root`·`forbidden`) → 잠그고 판정(`no_plan`·`flagged`·`not_manager`·`unknown_until`·`source_not_cause`·
//!   `invalid_source`·`source_hidden`·`source_used`) → 쓰기 + `thread.plan.changed`(같은 tx) → 스레드 안 시스템 줄 → `{ ok, auto, changed }`.
//! - 범위는 켤 때 고정한다(단계 id → 그때 제목의 해시). 쓴 근거 글은 남아 같은 글로 다시 켜지 못한다.
//! - 권한은 [`PLAN_AUTO_PRIVILEGES`] 와 끄기 칸·글 올리기 권한 — 다 있어야 `main.rs` 가 붙인다(없으면 TS 에 남는다).
use super::plan_input::{AutoArg, parse_auto};
use super::plan_write::{emit_changed, gate};
use super::respond::text_result;
use super::tools::err;
use crate::auth::Account;
use crate::core::msg_post::PostState;
use crate::core::thread_plan_auto_off::{OFF_SQL, post_line};
use crate::loops::thread_plan_auto::plan_auto_range_of;
use serde_json::{Map, Value, json};
use sqlx::PgPool;

/// 이 갈래가 끄기 칸([`crate::core::thread_plan_auto_off::THREAD_PLAN_AUTO_OFF_PRIVILEGES`])·글 올리기 권한 위에 쓰는 권한 —
/// homelab GRANT 와 같아야 한다. 임대·계정은 읽는 칸만.
pub const PLAN_AUTO_PRIVILEGES: &[(&str, &str)] = &[
    ("thread_plan.auto_used_sources", "SELECT"),
    ("thread_plan.auto_used_sources", "UPDATE"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.cause_message_id", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
];

const AGENTS_ONLY: &str = "자동 진행은 관리 에이전트만 적는다.";
const AUTO_ALONE: &str = "auto 는 type: \"plan\" 과 함께, 다른 칸 없이 쓴다.";

/// TS `select doc, flag_reason, auto_used_sources from thread_plan where root_id = $1 for update`.
const LOCK_SET_SQL: &str = "select doc::text, flag_reason, auto_used_sources::text[] \
     from thread_plan where root_id = $1::uuid for update";
/// TS `select doc, auto_until from thread_plan where root_id = $1 for update`.
const LOCK_CLEAR_SQL: &str = "select doc::text, (auto_until is not null) \
     from thread_plan where root_id = $1::uuid for update";
/// 지금 이 에이전트 턴의 원인 글인가. 끝났거나 만료된 임대는 세지 않는다.
const LEASE_SQL: &str = "select 1::int4 from secret_turn_lease \
     where agent_id = $1::uuid and cause_message_id = $2::uuid and ended_at is null and expires_at > now() limit 1";
/// 근거 글 — 이 스레드의, 지워지지 않은, 자동화가 쓰지 않은 사람 글. 가시성은 [`crate::core::msg_read::visible_sql`] 로 따로 본다.
const SOURCE_SQL: &str = "select m.author_id::text, m.mandate_id::text, m.channel_id::text \
     from message m join account a on a.id = m.author_id \
     where m.id = $1::uuid and coalesce(m.thread_root_id, m.id) = $2::uuid and m.deleted_at is null \
       and m.kind = 'user' and not jsonb_exists(m.meta, 'automation') \
       and a.kind = 'human' and a.deleted_at is null and a.disabled_at is null";
/// TS `setPlanAuto` 의 켜기. 시각은 ms 까지(TS `Date`).
const ON_SQL: &str = concat!(
    "update thread_plan \
     set auto_until = $2, auto_source = $3::uuid, auto_by = $4::uuid, auto_mandate = $5::uuid, \
         auto_at = date_trunc('milliseconds', now()), auto_woken = '{}'::jsonb, auto_range = $6::jsonb, \
         auto_used_sources = array_append(auto_used_sources, $3::uuid), \
         rev = rev + 1, updated_at = greatest(now(), updated_at + interval '1 millisecond') \
     where root_id = $1::uuid \
     returning channel_id::text, rev::int8, doc::text, auto_source::text, ",
    crate::iso!("auto_at")
);

fn q(s: &str) -> String {
    Value::from(s).to_string()
}

/// TS `jsonResult({ error: res.error })` — 코드만 있다(문구 없음).
fn refused(code: &str) -> String {
    text_result(&format!("{{\"error\":{{\"code\":{}}}}}", q(code)))
}

fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

/// 켜진 판의 `auto` 칸(TS `ThreadPlanRow.auto`).
struct On {
    until: String,
    source: String,
    by: String,
    at: String,
}

/// TS `jsonResult({ ok: true, auto: res.row.auto, changed: res.changed })`.
fn done_text(auto: Option<&On>, changed: bool) -> String {
    let auto = auto.map_or("null".to_owned(), |a| {
        format!(
            "{{\"until\":{},\"sourceMessageId\":{},\"by\":{},\"at\":{}}}",
            q(&a.until),
            q(&a.source),
            q(&a.by),
            q(&a.at)
        )
    });
    text_result(&format!(
        "{{\"ok\":true,\"auto\":{auto},\"changed\":{changed}}}"
    ))
}

/// TS `notice(…, '▶ 자동 진행 켜짐 · …', { planAutoState, i18n })`. 근거 글 링크를 함께 써 사람이 잘못 읽힌 것을 바로 본다.
fn on_line(until: &str, source: &str, by: &str) -> (String, Map<String, Value>) {
    let mut meta = Map::new();
    meta.insert(
        "planAutoState".into(),
        json!({ "on": true, "until": until, "sourceMessageId": source, "by": by }),
    );
    meta.insert(
        "i18n".into(),
        json!({ "key": "system.plan.autoOn", "args": { "accountId": by, "until": until } }),
    );
    (
        format!("▶ 자동 진행 켜짐 · {until}까지 · 근거 harkroom://message/{source}"),
        meta,
    )
}

/// TS `notice(…, '▶ 자동 진행 꺼짐', …)`(관리 에이전트 갈래).
fn off_line() -> (String, Map<String, Value>) {
    let mut meta = Map::new();
    meta.insert(
        "planAutoState".into(),
        json!({ "on": false, "reason": "manager" }),
    );
    meta.insert(
        "i18n".into(),
        json!({ "key": "system.plan.autoOffManager", "args": {} }),
    );
    ("▶ 자동 진행 꺼짐".to_owned(), meta)
}

fn manager_is(doc: &Value, agent: &str) -> bool {
    doc.get("managerId").and_then(Value::as_str) == Some(agent)
}

fn has_node(doc: &Value, id: &str) -> bool {
    ["steps", "groups"].iter().any(|k| {
        doc.get(*k).and_then(Value::as_array).is_some_and(|a| {
            a.iter()
                .any(|n| n.get("id").and_then(Value::as_str) == Some(id))
        })
    })
}

/// TS `setPlanAuto` 의 tx. `Err(code)` 는 거절(되감았다).
async fn set(
    w: &PgPool,
    root: &str,
    agent: &str,
    until: &str,
    source: &str,
) -> sqlx::Result<Result<On, &'static str>> {
    let mut tx = w.begin().await?;
    let cur: Option<(String, Option<String>, Vec<String>)> = sqlx::query_as(LOCK_SET_SQL)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((doc, flag, used)) = cur else {
        return Ok(Err("no_plan"));
    };
    if flag.is_some_and(|f| !f.is_empty()) {
        return Ok(Err("flagged"));
    }
    let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
    if !manager_is(&doc, agent) {
        return Ok(Err("not_manager"));
    }
    if !has_node(&doc, until) {
        return Ok(Err("unknown_until"));
    }
    let lease: Option<i32> = sqlx::query_scalar(LEASE_SQL)
        .bind(agent)
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?;
    if lease.is_none() {
        return Ok(Err("source_not_cause"));
    }
    let src: Option<(String, Option<String>, String)> = sqlx::query_as(SOURCE_SQL)
        .bind(source)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((by, mandate, channel)) = src else {
        return Ok(Err("invalid_source"));
    };
    // 근거 글을 쓴 사람이 지금도 그 채널을 볼 수 있어야 한다. 없는 채널은 막지 않는다(메시지의 채널은 FK 라 늘 있다).
    let visible: Option<bool> = sqlx::query_scalar(crate::core::msg_read::visible_sql())
        .bind(&by)
        .bind(&channel)
        .fetch_optional(&mut *tx)
        .await?;
    if visible == Some(false) {
        return Ok(Err("source_hidden"));
    }
    // uuid 는 대소문자를 가리지 않는다 — 저장된 값은 소문자다.
    if used.iter().any(|u| u.eq_ignore_ascii_case(source)) {
        return Ok(Err("source_used"));
    }
    // 범위는 여기서 고정한다. 사람이 허락한 것은 지금 이 단계들까지다.
    let range = Value::Object(plan_auto_range_of(&doc, until)).to_string();
    let (channel, rev, doc, source, at): (String, i64, String, String, String) =
        sqlx::query_as(ON_SQL)
            .bind(root)
            .bind(until)
            .bind(source)
            .bind(&by)
            .bind(mandate.as_deref())
            .bind(&range)
            .fetch_one(&mut *tx)
            .await?;
    let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
    emit_changed(&mut tx, &channel, root, rev, &doc, agent).await?;
    tx.commit().await?;
    Ok(Ok(On {
        until: until.to_owned(),
        source,
        by,
        at,
    }))
}

/// TS `clearPlanAuto`(관리 에이전트 갈래)의 tx. `Ok(changed)` — 꺼져 있었으면 아무것도 바꾸지 않는다.
async fn clear(w: &PgPool, root: &str, agent: &str) -> sqlx::Result<Result<bool, &'static str>> {
    let mut tx = w.begin().await?;
    let cur: Option<(String, bool)> = sqlx::query_as(LOCK_CLEAR_SQL)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((doc, on)) = cur else {
        return Ok(Err("no_plan"));
    };
    let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
    if !manager_is(&doc, agent) {
        return Ok(Err("not_manager"));
    }
    if !on {
        tx.commit().await?;
        return Ok(Ok(false));
    }
    let (channel, rev, doc): (String, i64, String) = sqlx::query_as(OFF_SQL)
        .bind(root)
        .fetch_one(&mut *tx)
        .await?;
    let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
    emit_changed(&mut tx, &channel, root, rev, &doc, agent).await?;
    tx.commit().await?;
    Ok(Ok(true))
}

/// `thread.plan.item` 의 `auto` 칸. `auto` 가 없거나 zod 가 거절할 꼴이면 `None`(TS 가 답한다).
pub async fn answer(read: &PgPool, post: &PostState, me: &Account, args: &Value) -> Option<String> {
    let item = parse_auto(args)?;
    if me.kind != "agent" {
        return Some(err("agents_only", AGENTS_ONLY));
    }
    if !item.alone {
        return Some(err("auto_alone", AUTO_ALONE));
    }
    let channel = match gate(read, me, &item.root).await? {
        Ok(c) => c,
        Err(t) => return Some(t),
    };
    let w = &post.write;
    Some(match item.auto {
        AutoArg::Off => match clear(w, &item.root, &me.id).await {
            Err(_) => internal(),
            Ok(Err(code)) => refused(code),
            Ok(Ok(false)) => done_text(None, false),
            Ok(Ok(true)) => {
                let (body, meta) = off_line();
                if post_line(
                    post,
                    &channel,
                    &item.root,
                    &me.id,
                    body,
                    meta,
                    "threadPlanAuto",
                )
                .await
                .is_err()
                {
                    return Some(internal());
                }
                done_text(None, true)
            }
        },
        AutoArg::On { until, source } => {
            match set(w, &item.root, &me.id, &until, &source).await {
                Err(_) => internal(),
                Ok(Err(code)) => refused(code),
                Ok(Ok(on)) => {
                    // TS 는 받은 인자 그대로 링크를 쓴다.
                    let (body, meta) = on_line(&until, &source, &on.by);
                    if post_line(
                        post,
                        &channel,
                        &item.root,
                        &me.id,
                        body,
                        meta,
                        "threadPlanAuto",
                    )
                    .await
                    .is_err()
                    {
                        return Some(internal());
                    }
                    done_text(Some(&on), true)
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const M: &str = "00000000-0000-4000-8000-0000000000b1";

    #[test]
    fn on_line_like_ts() {
        let (body, meta) = on_line("s3", M, A);
        assert_eq!(
            body,
            format!("▶ 자동 진행 켜짐 · s3까지 · 근거 harkroom://message/{M}")
        );
        assert_eq!(
            meta["planAutoState"],
            json!({ "on": true, "until": "s3", "sourceMessageId": M, "by": A })
        );
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.plan.autoOn", "args": { "accountId": A, "until": "s3" } })
        );
    }

    #[test]
    fn off_line_like_ts() {
        let (body, meta) = off_line();
        assert_eq!(body, "▶ 자동 진행 꺼짐");
        assert_eq!(
            meta["planAutoState"],
            json!({ "on": false, "reason": "manager" })
        );
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.plan.autoOffManager", "args": {} })
        );
    }

    #[test]
    fn answers_keep_ts_key_order() {
        let on = On {
            until: "g2".into(),
            source: M.into(),
            by: A.into(),
            at: "2026-01-02T03:04:05.678Z".into(),
        };
        let t = done_text(Some(&on), true);
        assert!(t.contains("ok"));
        let (i, j, k, l) = (
            t.find("until").unwrap(),
            t.find("sourceMessageId").unwrap(),
            t.find("by").unwrap(),
            t.find("changed").unwrap(),
        );
        assert!(i < j && j < k && k < l);
        assert!(done_text(None, false).contains("null"));
        // 거절은 코드만 — 문구 칸이 없다.
        assert!(!refused("source_used").contains("message"));
    }

    #[test]
    fn manager_and_node() {
        let doc = json!({ "managerId": A, "steps": [{ "id": "s1" }], "groups": [{ "id": "g1" }] });
        assert!(manager_is(&doc, A));
        assert!(!manager_is(&doc, M));
        assert!(!manager_is(&json!({ "managerId": null }), A));
        assert!(has_node(&doc, "s1") && has_node(&doc, "g1"));
        assert!(!has_node(&doc, "s2"));
    }

    #[test]
    fn privileges_are_column_level() {
        assert!(PLAN_AUTO_PRIVILEGES.iter().all(|(t, _)| t.contains('.')));
        assert!(PLAN_AUTO_PRIVILEGES.contains(&("thread_plan.auto_used_sources", "UPDATE")));
    }
}
