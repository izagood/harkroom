//! 신고·차단(S5.2 P4c) — TS `routes/moderationRoutes.ts`.
//!
//! 옮기는 것: `POST /admin/reports/{id}/resolve` · `PUT`·`DELETE /accounts/me/blocks/{id}` · `GET /admin/reports` · `GET /accounts/me/blocks`.
//! **옮기지 않는 것: `POST /messages/{id}/report`** — 신고자별 상한(`REPORT_RULE`, 한 시간 30건)을 TS 프로세스 메모리의
//! `createRateLimiter` Map 이 센다. 두 프로세스가 따로 세면 상한이 갈라져 두 배가 된다 → 그 상한을 DB 로 옮기거나 S5.3 코어와 함께.
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
