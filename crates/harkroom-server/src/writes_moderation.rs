//! 신고·차단(S5.2 P4c) — TS `routes/moderationRoutes.ts`.
//!
//! 옮기는 것: `POST /admin/reports/{id}/resolve` · `PUT`·`DELETE /accounts/me/blocks/{id}` · `GET /admin/reports` · `GET /accounts/me/blocks`.
//! `POST /messages/{id}/report` 도 옮긴다 — 신고자별 상한(`REPORT_RULE`, 한 시간 30건)은 이 줄을 Rust 만 답하므로 이 프로세스의
//! 리미터([`report_limiter`])가 센다(TS 는 더 이상 이 줄을 받지 않아 둘로 갈라지지 않는다). 재시작하면 TS 처럼 셈이 비워진다.
//!
//! 순서는 TS 와 같다: 본문 읽기 → preHandler(`requireAdmin`·`requireAccount`) → zod. 이벤트는 없다(TS 도 내지 않는다).
//! 감사: 해결만 `message.report.resolved`(ip 는 `TRUST_PROXY` 규칙). 차단은 감사가 없다(TS 와 같다 — 상대에게 알리지 않는 개인 목록).
use crate::auth::{RequireAccount, RequireAdmin};
use crate::directory::{form_pairs, internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::routes::AppState;
use crate::write::{AuditEntry, Body, record_audit};
use crate::writes_settings::{bad, body_then, ip_of, write_pool};
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}
macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

/// TS `REPORT_RULE` — 신고자별 한 시간 30건.
pub const REPORT_RULE: crate::rate_limit::Rule = crate::rate_limit::Rule {
    window_ms: 60 * 60_000,
    max: 30,
};

/// 신고 상한 리미터 — TS `opts.limiter` 처럼 프로세스에 하나.
fn report_limiter() -> &'static crate::rate_limit::RateLimiter {
    static L: std::sync::OnceLock<crate::rate_limit::RateLimiter> = std::sync::OnceLock::new();
    L.get_or_init(crate::rate_limit::RateLimiter::default)
}

/// zod `{ reason: enum, note: string.trim().max(1000).optional() }` — 빈 note 는 `null`(TS `body.note || null`).
pub fn parse_report(body: &Body) -> Result<(String, Option<String>), &'static str> {
    let Body::Json(Value::Object(o)) = body else {
        return Err("expected object");
    };
    let reason = match o.get("reason") {
        Some(Value::String(r))
            if ["spam", "abuse", "inappropriate", "other"].contains(&r.as_str()) =>
        {
            r.clone()
        }
        _ => return Err("reason"),
    };
    let note = match o.get("note") {
        None => None,
        Some(Value::String(n)) => {
            let t = crate::core::ask::js_trim(n).to_owned();
            if crate::writes_settings::js_len(&t) > 1000 {
                return Err("note");
            }
            (!t.is_empty()).then_some(t)
        }
        _ => return Err("note"),
    };
    Ok((reason, note))
}

const REPORT_EXISTING: &str = concat!(
    "select json_build_object('id', id, 'createdAt', ",
    crate::iso!("created_at"),
    ")::text from message_report where message_id = $1::uuid and reporter_id = $2::uuid"
);

fn report_reply(code: StatusCode, report: &str, duplicate: bool) -> Response {
    (
        code,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        format!(
            "{{\"report\":{},\"duplicate\":{duplicate}}}",
            crate::core::mcp::respond::minify(report)
        ),
    )
        .into_response()
}

/// `POST /messages/{id}/report` — 사람만(403), 안 보이면 404, 자기 글 400 `own_message`, 다시 신고는 200 `duplicate: true`,
/// 상한 429(`retry-after`), 새 신고 201 + 감사 `message.reported`.
pub async fn report_message(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) = tri!(body_then::<RequireAccount>(req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let (reason, note) = tri!(parse_report(&body).map_err(bad));
    if me.kind != "human" {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only people can report messages",
        );
    }
    let pool = tri!(write_pool(&st));
    let not_found = || json_err(StatusCode::NOT_FOUND, "not_found", "no such message");
    let msg: Option<(String, Option<String>)> = db!(sqlx::query_as(
        "select channel_id::text, author_id::text from message where id = $1::uuid and deleted_at is null"
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await);
    let Some((channel, author)) = msg else {
        return not_found();
    };
    if !db!(crate::core::channels::visible(&st.pool, &me.id, &channel).await) {
        return not_found();
    }
    if author.as_deref() == Some(me.id.as_str()) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "own_message",
            "you cannot report your own message",
        );
    }
    let existing: Option<String> = db!(sqlx::query_scalar(REPORT_EXISTING)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(pool)
        .await);
    if let Some(r) = existing {
        return report_reply(StatusCode::OK, &r, true);
    }
    let verdict = report_limiter().hit(&format!("report:{}", me.id), REPORT_RULE);
    if !verdict.allowed {
        let mut r = json_err(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many reports, try again later",
        );
        if let Ok(v) =
            axum::http::HeaderValue::from_str(&verdict.retry_after_ms.div_ceil(1000).to_string())
        {
            r.headers_mut().insert("retry-after", v);
        }
        return r;
    }
    let inserted: Option<String> = db!(sqlx::query_scalar(concat!(
        "insert into message_report (message_id, reporter_id, reason, note, body_snapshot, message_edited_at) \
         select $1::uuid, $2::uuid, $3, $4, m.body, m.edited_at from message m where m.id = $1::uuid and m.deleted_at is null \
         on conflict (message_id, reporter_id) do nothing \
         returning json_build_object('id', id, 'createdAt', ",
        crate::iso!("created_at"),
        ")::text"
    ))
    .bind(&id)
    .bind(&me.id)
    .bind(&reason)
    .bind(note.as_deref())
    .fetch_optional(pool)
    .await);
    let Some(report) = inserted else {
        let raced: Option<String> = db!(sqlx::query_scalar(REPORT_EXISTING)
            .bind(&id)
            .bind(&me.id)
            .fetch_optional(pool)
            .await);
        return match raced {
            Some(r) => report_reply(StatusCode::OK, &r, true),
            None => not_found(),
        };
    };
    let ip = ip_of(&parts, &st.trust);
    record_audit(
        pool,
        AuditEntry {
            action: "message.reported",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "reason": reason }),
        },
    )
    .await;
    report_reply(StatusCode::CREATED, &report, false)
}

/// zod `{ resolution: enum('dismissed','removed') }`.
pub fn parse_resolution(body: &Body) -> Result<String, &'static str> {
    match body {
        Body::Json(Value::Object(o)) => match o.get("resolution") {
            Some(Value::String(r)) if r == "dismissed" || r == "removed" => Ok(r.clone()),
            _ => Err("resolution"),
        },
        _ => Err("expected object"),
    }
}

/// `POST /admin/reports/{id}/resolve` — admin. 처리 안 된 신고만(아니면 404 `not_found` 「no such open report」). 204.
pub async fn resolve_report(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAdmin(me), parts) = tri!(body_then::<RequireAdmin>(req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let resolution = tri!(parse_resolution(&body).map_err(bad));
    let pool = tri!(write_pool(&st));
    let msg: Option<String> = db!(sqlx::query_scalar(
        "update message_report set resolved_at = now(), resolved_by = $2::uuid, resolution = $3 \
          where id = $1::uuid and resolved_at is null returning message_id::text"
    )
    .bind(&id)
    .bind(&me.id)
    .bind(&resolution)
    .fetch_optional(pool)
    .await);
    let Some(message_id) = msg else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such open report");
    };
    let ip = ip_of(&parts, &st.trust);
    record_audit(
        pool,
        AuditEntry {
            action: "message.report.resolved",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "resolution": resolution, "messageId": message_id }),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// `PUT /accounts/me/blocks/{id}` — 사람만(403), 자기 자신 400 `self_block`, 없는 계정 404. 204.
pub async fn put_block(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), _) = tri!(body_then::<RequireAccount>(req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    if me.kind != "human" {
        return json_err(StatusCode::FORBIDDEN, "forbidden", "only people can block");
    }
    // TS 는 글자 그대로 견준다(`id === me.id`) — 대소문자가 다른 같은 uuid 는 여기를 지나 아래 삽입에서 같은 줄이 된다.
    if id == me.id {
        return json_err(
            StatusCode::BAD_REQUEST,
            "self_block",
            "you cannot block yourself",
        );
    }
    let pool = tri!(write_pool(&st));
    let exists: Option<i32> = db!(
        sqlx::query_scalar("select 1 from account where id = $1::uuid")
            .bind(&id)
            .fetch_optional(pool)
            .await
    );
    if exists.is_none() {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such account");
    }
    db!(sqlx::query("insert into account_block (blocker_id, blocked_id) values ($1::uuid, $2::uuid) on conflict do nothing")
        .bind(&me.id)
        .bind(&id)
        .execute(pool)
        .await);
    StatusCode::NO_CONTENT.into_response()
}

/// `DELETE /accounts/me/blocks/{id}` — 내 줄만 지운다(없어도 204).
pub async fn delete_block(
    State(st): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), _) = tri!(body_then::<RequireAccount>(req).await);
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    let pool = tri!(write_pool(&st));
    db!(sqlx::query(
        "delete from account_block where blocker_id = $1::uuid and blocked_id = $2::uuid"
    )
    .bind(&me.id)
    .bind(&id)
    .execute(pool)
    .await);
    StatusCode::NO_CONTENT.into_response()
}

const BLOCKS: &str = concat!(
    "select json_build_object('blocks', coalesce(json_agg(json_build_object('accountId', b.blocked_id, 'createdAt', ",
    crate::iso!("b.created_at"),
    ") order by b.created_at desc), '[]'::json))::text from account_block b where b.blocker_id = $1::uuid"
);

/// `GET /accounts/me/blocks` — 내 차단 목록, 최근순.
pub async fn list_blocks(
    State(pool): State<PgPool>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    json_ok(db!(sqlx::query_scalar::<_, String>(BLOCKS)
        .bind(&me.id)
        .fetch_one(&pool)
        .await))
}

/// `GET /admin/reports` 질의 — zod `{ status: enum default 'open', limit: coerce int 1..200 default 100, after: uuid? }`. 모르는 키는 버린다.
#[derive(Debug, PartialEq, Eq)]
pub struct ReportsQuery {
    pub status: String,
    pub limit: i64,
    pub after: Option<String>,
}

pub fn parse_reports_query(raw: Option<&str>) -> Result<ReportsQuery, &'static str> {
    let mut q = ReportsQuery {
        status: "open".into(),
        limit: 100,
        after: None,
    };
    let mut seen: Vec<String> = vec![];
    for (k, v) in form_pairs(raw.unwrap_or("")) {
        if !matches!(k.as_str(), "status" | "limit" | "after") {
            continue;
        }
        if seen.contains(&k) {
            return Err("duplicate query key");
        }
        seen.push(k.clone());
        match k.as_str() {
            "status" => {
                if !matches!(v.as_str(), "open" | "resolved" | "all") {
                    return Err("status");
                }
                q.status = v;
            }
            "limit" => {
                let n = crate::directory::coerce_int(&v).ok_or("limit")?;
                if !(1..=200).contains(&n) {
                    return Err("limit");
                }
                q.limit = n;
            }
            _ => {
                if !is_zod_uuid(&v) {
                    return Err("after");
                }
                q.after = Some(v);
            }
        }
    }
    Ok(q)
}

/// TS 와 같은 칸·정렬. `$1` 상태, `$2` after(없으면 null), `$3` limit+1.
const REPORTS: &str = concat!(
    "select coalesce(json_agg(row_to_json(x) order by x.ord_at, x.id), '[]'::json)::text from (select r.id, r.reason, r.note, ",
    crate::iso!("r.created_at"),
    " as \"createdAt\", ",
    crate::iso!("r.resolved_at"),
    " as \"resolvedAt\", r.resolved_by as \"resolvedBy\", r.resolution, r.reporter_id as \"reporterId\", \
      m.id as \"messageId\", m.channel_id as \"channelId\", m.thread_root_id as \"threadRootId\", m.author_id as \"authorId\", \
      r.body_snapshot as \"bodyAtReport\", ",
    crate::iso!("r.message_edited_at"),
    " as \"editedAtReport\", case when m.deleted_at is null then m.body end as body, ",
    crate::iso!("m.edited_at"),
    " as \"editedAt\", m.deleted_at is not null as \"messageDeleted\", r.created_at as ord_at \
      from message_report r join message m on m.id = r.message_id \
      where ($1 = 'all' or ($1 = 'open' and r.resolved_at is null) or ($1 = 'resolved' and r.resolved_at is not null)) \
        and ($2::uuid is null or (r.created_at, r.id) > (select c.created_at, c.id from message_report c where c.id = $2::uuid)) \
      order by r.created_at asc, r.id asc limit $3) x"
);

/// `GET /admin/reports` — admin. `{ reports, nextAfter }`.
pub async fn list_reports(
    State(pool): State<PgPool>,
    _: RequireAdmin,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = match parse_reports_query(raw.as_deref()) {
        Ok(q) => q,
        Err(m) => return bad(m),
    };
    let text: String = db!(sqlx::query_scalar(REPORTS)
        .bind(&q.status)
        .bind(&q.after)
        .bind(q.limit + 1)
        .fetch_one(&pool)
        .await);
    let mut rows: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
    let more = rows.len() as i64 > q.limit;
    rows.truncate(q.limit as usize);
    for r in &mut rows {
        if let Some(o) = r.as_object_mut() {
            o.remove("ord_at");
        }
    }
    let next = if more {
        rows.last()
            .and_then(|r| r.get("id"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    json_ok(json!({ "reports": rows, "nextAfter": next }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_body_like_zod() {
        let b = |v: serde_json::Value| Body::Json(v);
        assert_eq!(
            parse_report(&b(json!({ "reason": "spam", "x": 1 }))),
            Ok(("spam".to_owned(), None))
        );
        assert_eq!(
            parse_report(&b(json!({ "reason": "other", "note": "  hi  " }))),
            Ok(("other".to_owned(), Some("hi".to_owned())))
        );
        assert_eq!(
            parse_report(&b(json!({ "reason": "abuse", "note": "   " }))),
            Ok(("abuse".to_owned(), None))
        );
        assert_eq!(parse_report(&b(json!({ "reason": "nope" }))), Err("reason"));
        assert_eq!(
            parse_report(&b(json!({ "reason": "spam", "note": null }))),
            Err("note")
        );
        let long = "a".repeat(1001);
        assert_eq!(
            parse_report(&b(json!({ "reason": "spam", "note": long }))),
            Err("note")
        );
        assert_eq!(REPORT_RULE.max, 30);
    }

    #[test]
    fn resolution_and_query_shapes() {
        assert_eq!(
            parse_resolution(&Body::Json(json!({ "resolution": "removed" }))),
            Ok("removed".into())
        );
        assert!(parse_resolution(&Body::Json(json!({ "resolution": "deleted" }))).is_err());
        assert!(parse_resolution(&Body::None).is_err());
        assert_eq!(
            parse_reports_query(None),
            Ok(ReportsQuery {
                status: "open".into(),
                limit: 100,
                after: None
            })
        );
        assert_eq!(
            parse_reports_query(Some("status=all&limit=2&x=1"))
                .unwrap()
                .limit,
            2
        );
        assert!(parse_reports_query(Some("status=closed")).is_err());
        assert!(parse_reports_query(Some("limit=201")).is_err());
        assert!(parse_reports_query(Some("after=nope")).is_err());
    }
}
