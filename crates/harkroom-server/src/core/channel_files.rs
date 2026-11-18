//! S5.4 CF1 — 채널에 오간 파일 목록(#232). TS `routes/attachmentRoutes.ts` 의 `GET /channels/:id/files` 와
//! `services/attachments.ts` 의 `listChannelFiles` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 경로 id(400) → 질의 `before`·`limit`(400) → `assertChannelVisible`(403)
//!   → 목록. 볼 수 없는 채널이면 개수도 파일명도 나가지 않는다(판정이 먼저).
//! - `limit` 은 **메시지** 수다(TS 와 같다) — 한 메시지의 첨부는 다 실린다. `hasMore` 는 이 쪽의 가장 오래된 메시지보다
//!   앞선, 첨부 있는 살아 있는 메시지가 남았는가.
//! - 읽기 풀만 쓴다. 읽기 역할에 [`CHANNEL_FILES_READ_PRIVILEGES`] 의 SELECT 가 다 있을 때만 `main.rs` 가 붙인다.
use crate::auth::RequireAccount;
use crate::directory::{coerce_int, form_pairs, internal, json_err, json_ok};
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 역할이 이 줄에 필요한 SELECT.
pub const CHANNEL_FILES_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("attachment", "SELECT"),
];

/// TS `listChannelFiles` 의 쪽 질의 — 칸 이름·순서·`toISOString()` 꼴까지 같게 JSON 으로 만든다.
const LIST_SQL: &str = concat!(
    "with page as (",
    "select m.id, m.seq, m.author_id, m.created_at from message m ",
    "where m.channel_id = $1::uuid and m.deleted_at is null ",
    "and ($2::bigint is null or m.seq < $2) ",
    "and exists (select 1 from attachment a where a.message_id = m.id) ",
    "order by m.seq desc limit $3), ",
    "rows as (select a.id, a.filename, a.content_type, a.size_bytes::int as size_bytes, ",
    "p.id as message_id, p.seq::int as message_seq, p.author_id, p.created_at, ",
    "row_number() over (order by p.seq desc, a.attached_at, a.created_at, a.id) as rn ",
    "from page p join attachment a on a.message_id = p.id) ",
    "select coalesce(json_agg(json_build_object(",
    "'id', id, 'filename', filename, 'contentType', content_type, 'sizeBytes', size_bytes, ",
    "'messageId', message_id, 'messageSeq', message_seq, 'authorId', author_id, ",
    "'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    ") order by rn), '[]')::text, min(message_seq)::bigint from rows"
);

/// TS 의 `hasMore` 질의.
const MORE_SQL: &str = "select 1 from message m where m.channel_id = $1::uuid and m.deleted_at is null \
     and m.seq < $2 and exists (select 1 from attachment a where a.message_id = m.id) limit 1";

/// zod `{ before: coerce.number().int().min(0).optional(), limit: coerce.number().int().min(1).max(200).optional() }`.
/// 모르는 키는 버린다(zod object 기본값). 같은 키가 둘이면 배열이 되어 zod 가 거절한다.
pub fn parse_query(raw: Option<&str>) -> Result<(Option<i64>, i64), &'static str> {
    let mut before = None;
    let mut limit = None;
    for (k, v) in form_pairs(raw.unwrap_or("")) {
        match k.as_str() {
            "before" => {
                if before.is_some() {
                    return Err("before");
                }
                let n = coerce_int(&v).ok_or("before")?;
                if n < 0 {
                    return Err("before");
                }
                before = Some(n);
            }
            "limit" => {
                if limit.is_some() {
                    return Err("limit");
                }
                let n = coerce_int(&v).ok_or("limit")?;
                if !(1..=200).contains(&n) {
                    return Err("limit");
                }
                limit = Some(n);
            }
            _ => {}
        }
    }
    Ok((before, limit.unwrap_or(50)))
}

/// `GET /channels/{id}/files`.
pub async fn list_channel_files(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    let (before, limit) = match parse_query(raw.as_deref()) {
        Ok(q) => q,
        Err(k) => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                &format!("querystring: invalid {k}"),
            );
        }
    };
    match super::channels::visible(read.as_ref(), &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this dm channel",
            );
        }
        Err(e) => return internal(e),
    }
    let (files, oldest) = match sqlx::query_as::<_, (String, Option<i64>)>(LIST_SQL)
        .bind(&id)
        .bind(before)
        .bind(limit)
        .fetch_one(read.as_ref())
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let has_more = match oldest {
        None => false,
        Some(seq) => match sqlx::query_scalar::<_, i32>(MORE_SQL)
            .bind(&id)
            .bind(seq)
            .fetch_optional(read.as_ref())
            .await
        {
            Ok(r) => r.is_some(),
            Err(e) => return internal(e),
        },
    };
    json_ok(format!("{{\"files\":{files},\"hasMore\":{has_more}}}"))
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/channels/{id}/files", list_channel_files)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_matches_zod() {
        assert_eq!(parse_query(None), Ok((None, 50)));
        assert_eq!(parse_query(Some("before=3&limit=200")), Ok((Some(3), 200)));
        assert_eq!(parse_query(Some("before=0")), Ok((Some(0), 50)));
        assert!(parse_query(Some("before=-1")).is_err());
        assert!(parse_query(Some("limit=0")).is_err());
        assert!(parse_query(Some("limit=201")).is_err());
        assert!(parse_query(Some("limit=1.5")).is_err());
        assert!(parse_query(Some("limit=x")).is_err());
        assert!(parse_query(Some("limit=1&limit=2")).is_err());
        assert_eq!(parse_query(Some("other=1")), Ok((None, 50)));
    }

    #[test]
    fn list_mirrors_ts_order_and_cols() {
        assert!(LIST_SQL.contains("order by p.seq desc, a.attached_at, a.created_at, a.id"));
        assert!(LIST_SQL.contains("order by m.seq desc limit $3"));
        for k in [
            "'id'",
            "'filename'",
            "'contentType'",
            "'sizeBytes'",
            "'messageId'",
            "'messageSeq'",
            "'authorId'",
            "'createdAt'",
        ] {
            assert!(LIST_SQL.contains(k), "{k}");
        }
        assert!(MORE_SQL.contains("m.seq < $2"));
    }
}
