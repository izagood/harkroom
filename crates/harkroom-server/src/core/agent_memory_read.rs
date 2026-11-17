//! S5.4 AC2 — 에이전트 기억 읽기 두 줄. TS `routes/accountRoutes.ts` 의 `GET /accounts/agents/:id/memory`·
//! `GET /accounts/agents/:id/memory/:slug/revisions` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireOwnerOrAdmin('id')`(401·400·403·404, TS `checkOwnerOrAdmin` = [`check_owner_or_admin`]) →
//!   경로(zod, 400) → 에이전트인가(404 `no such agent`, 지운 에이전트도 대상 — `isAgentTarget`). **소유자와 admin 뿐이다** —
//!   에이전트 자신·다른 사람은 403, 소유자가 없는 에이전트는 admin 만.
//! - 질의는 TS `listMemoryEntries`(`ENTRY_COLUMNS`, slug 순)·`listMemoryRevisions`(최근 것부터) 와 같은 칸·같은 순서다.
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`AGENT_MEMORY_READ_PRIVILEGES`] — 없으면 `main.rs` 가
//!   이 줄을 붙이지 않아 TS 에 남는다.
//! - 정리 후보(`GET …/memory/audit`, 분류·유사도 판정)·백그라운드 읽기(`GET …/background`·`…/background/runs/:runId`)는
//!   TS 에 남긴다. 기억 쓰기·백그라운드 켜고 끄기는 [`super::agent_memory_write`].
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한. `account`·`agent_config` 는 인가(`checkOwnerOrAdmin`)와 에이전트 판정이 읽는다.
pub const AGENT_MEMORY_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_memory", "SELECT"),
    ("agent_memory_revision", "SELECT"),
];

/// zod `slug: z.string().min(1).max(255)` — UTF-16 단위.
const SLUG_MAX: usize = 255;

pub(super) fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}
/// fastify `maxParamLength`(기본 100). find-my-way 는 길을 찾을 때 경로 파라미터가 이보다 길면 라우트·훅(인증
/// 포함)에 닿기 전에 414 `FST_ERR_MAX_PARAM_LENGTH` 를 낸다. 길이는 퍼센트 인코딩을 **모두 푼 뒤**(예약 문자 `%2F`
/// 등도 한 글자)의 UTF-16 단위다 — fastify 5.12·find-my-way 9.9 로 확인했다(`한`×100 → 200, `😀`×51 → 414,
/// `/`×101 → 414). 같은 답을 내려고 인증 층 바깥에서 같은 길이로 본다. 이 표의 정적 조각은 모두 100자보다
/// 짧으므로 「어느 조각이든 100자 초과」가 「파라미터가 100자 초과」와 같다.
const FASTIFY_MAX_PARAM_LENGTH: usize = 100;

/// 퍼센트 인코딩을 푼 뒤 UTF-16 길이. 잘못된 인코딩(TS 는 400 `FST_ERR_BAD_URL`)이면 None — 여기서는 판정하지 않는다.
fn decoded_utf16_len(seg: &str) -> Option<usize> {
    let b = seg.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let (h, l) = (*b.get(i + 1)?, *b.get(i + 2)?);
            out.push(hex(h)? << 4 | hex(l)?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out)
        .ok()
        .map(|s| s.encode_utf16().count())
}

pub(super) async fn max_param_length(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if req.uri().path().split('/').any(|seg| {
        seg.len() > FASTIFY_MAX_PARAM_LENGTH
            && decoded_utf16_len(seg).is_some_and(|n| n > FASTIFY_MAX_PARAM_LENGTH)
    }) {
        // 본문 꼴은 fastify `onMaxParamLength` 와 같다(`error` 가 문자열이라 대조의 오류 코드는 양쪽 다 없다).
        // 요청 경로는 되돌려 싣지 않는다.
        let body = serde_json::json!({
            "error": "Bad Request",
            "code": "FST_ERR_MAX_PARAM_LENGTH",
            "message": "path is exceeding the max param length",
            "statusCode": 414,
        });
        return (
            StatusCode::URI_TOO_LONG,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            body.to_string(),
        )
            .into_response();
    }
    next.run(req).await
}

pub(super) fn no_such_agent() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such agent")
}

/// TS `requireOwnerOrAdmin('id')` 다음 `z.string().uuid()` 다음 `isAgentTarget`(지운 에이전트 포함).
/// Ok(()) 면 지나간다. 순서가 TS 와 같아야 거절 갈래가 같다.
#[allow(clippy::result_large_err)]
pub(super) async fn gate(
    read: &PgPool,
    me: &Account,
    id: &str,
    slug: Option<&str>,
    live: bool,
) -> Result<(), Response> {
    access(read, me, id, slug).await?;
    agent_target(read, id, live).await
}

/// `requireOwnerOrAdmin('id')` 다음 경로 zod 까지(에이전트 판정 앞). 쓰기 줄은 이 다음에 본문을 읽고 [`agent_target`] 을 본다.
#[allow(clippy::result_large_err)]
pub(super) async fn access(
    read: &PgPool,
    me: &Account,
    id: &str,
    slug: Option<&str>,
) -> Result<(), Response> {
    match check_owner_or_admin(read, me, id).await {
        Ok(Verdict::Owner | Verdict::Admin) => {}
        Ok(Verdict::Refused(s, c, m)) => return Err(json_err(s, c, m)),
        Err(e) => return Err(internal(e)),
    }
    if !crate::lists::is_zod_uuid(id) {
        return Err(bad("params"));
    }
    if let Some(s) = slug {
        let n = s.encode_utf16().count();
        if n == 0 || n > SLUG_MAX {
            return Err(bad("params"));
        }
    }
    Ok(())
}

/// TS `isAgentTarget(id, { live })` — `live` 면 지운 에이전트는 404.
#[allow(clippy::result_large_err)]
pub(super) async fn agent_target(read: &PgPool, id: &str, live: bool) -> Result<(), Response> {
    let agent: Result<Option<i32>, _> = sqlx::query_scalar(
        "select 1 from account where id = $1::uuid and kind = 'agent' and ($2 = false or deleted_at is null)",
    )
    .bind(id)
    .bind(live)
    .fetch_optional(read)
    .await;
    match agent {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(no_such_agent()),
        Err(e) => Err(internal(e)),
    }
}

/// 시각은 JS `Date#toJSON` 꼴(밀리초·Z).
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// TS `listMemoryEntries` — `ENTRY_COLUMNS` 와 같은 칸·같은 순서, slug 순.
const ENTRIES_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'slug', slug, 'value', value, 'updatedAt', ",
    iso!("updated_at"),
    ", 'description', description, 'createdAt', ",
    iso!("created_at"),
    ", 'readCount', read_count, 'lastReadAt', ",
    iso!("last_read_at"),
    ", 'kind', kind, 'recallCount', recall_count, 'lastRecalledAt', ",
    iso!("last_recalled_at"),
    ", 'flaggedAt', ",
    iso!("flagged_at"),
    ", 'flagReason', flag_reason, 'archivedAt', ",
    iso!("archived_at"),
    ") order by slug), '[]'::json)::text from agent_memory where account_id = $1::uuid"
);

/// TS `listMemoryRevisions` — 최근 것부터(`replaced_at desc, id desc`).
const REVISIONS_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'id', id::int, 'value', value, 'description', description, 'updatedAt', ",
    iso!("updated_at"),
    ", 'replacedAt', ",
    iso!("replaced_at"),
    ", 'flagged', flagged, 'reason', reason, 'detail', detail, 'kind', kind",
    ") order by replaced_at desc, id desc), '[]'::json)::text ",
    "from agent_memory_revision where account_id = $1::uuid and slug = $2"
);

pub async fn list_memory(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = gate(&read, &me, &id, None, false).await {
        return r;
    }
    match sqlx::query_scalar::<_, String>(ENTRIES_SQL)
        .bind(&id)
        .fetch_one(&*read)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"memories\":{rows}}}")),
        Err(e) => internal(e),
    }
}

pub async fn list_revisions(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, slug)): Path<(String, String)>,
) -> Response {
    if let Err(r) = gate(&read, &me, &id, Some(&slug), false).await {
        return r;
    }
    match sqlx::query_scalar::<_, String>(REVISIONS_SQL)
        .bind(&id)
        .bind(&slug)
        .fetch_one(&*read)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"revisions\":{rows}}}")),
        Err(e) => internal(e),
    }
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/accounts/agents/{id}/memory", list_memory)
        .get(
            "/accounts/agents/{id}/memory/{slug}/revisions",
            list_revisions,
        )
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            // 인증보다 먼저(바깥) — fastify 는 414 를 라우트를 찾는 단계에서 낸다.
            .route_layer(axum::middleware::from_fn(max_param_length))
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
    use super::decoded_utf16_len as len;

    #[test]
    fn decoded_length_matches_find_my_way() {
        assert_eq!(len(&"x".repeat(100)), Some(100));
        assert_eq!(len(&"x".repeat(101)), Some(101));
        // 한글 한 자는 인코딩 9글자지만 1자, 이모지는 UTF-16 2단위.
        assert_eq!(len(&"%ED%95%9C".repeat(60)), Some(60));
        assert_eq!(len(&"%F0%9F%98%80".repeat(51)), Some(102));
        // 예약 문자·`%` 이스케이프도 한 글자로 센다.
        assert_eq!(len(&"%2F".repeat(34)), Some(34));
        assert_eq!(len("%2f%25%40"), Some(3));
        assert_eq!(len("a%20b"), Some(3));
        // 잘못된 인코딩 — TS 는 400(FST_ERR_BAD_URL), 여기서는 판정하지 않는다.
        assert_eq!(len("%G1"), None);
        assert_eq!(len("ab%"), None);
        assert_eq!(len("ab%4"), None);
        assert_eq!(len("%FF"), None);
    }
}
