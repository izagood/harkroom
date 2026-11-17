//! S5.4 AC2 — 에이전트 기억 읽기 두 줄. TS `routes/accountRoutes.ts` 의 `GET /accounts/agents/:id/memory`·
//! `GET /accounts/agents/:id/memory/:slug/revisions` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireOwnerOrAdmin('id')`(401·400·403·404, TS `checkOwnerOrAdmin` = [`check_owner_or_admin`]) →
//!   경로(zod, 400) → 에이전트인가(404 `no such agent`, 지운 에이전트도 대상 — `isAgentTarget`). **소유자와 admin 뿐이다** —
//!   에이전트 자신·다른 사람은 403, 소유자가 없는 에이전트는 admin 만.
//! - 질의는 TS `listMemoryEntries`(`ENTRY_COLUMNS`, slug 순)·`listMemoryRevisions`(최근 것부터) 와 같은 칸·같은 순서다.
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`AGENT_MEMORY_READ_PRIVILEGES`] — 없으면 `main.rs` 가
//!   이 줄을 붙이지 않아 TS 에 남는다.
//! - 정리 후보(`GET …/memory/audit`, 분류·유사도 판정)·백그라운드(`GET …/background`·`…/background/runs/:runId`)와
//!   기억 쓰기(PUT·DELETE·confirm·archive·unarchive)는 TS 에 남긴다.
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
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

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}
fn no_such_agent() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such agent")
}

/// TS `requireOwnerOrAdmin('id')` 다음 `z.string().uuid()` 다음 `isAgentTarget`(지운 에이전트 포함).
/// Ok(()) 면 지나간다. 순서가 TS 와 같아야 거절 갈래가 같다.
#[allow(clippy::result_large_err)]
async fn gate(read: &PgPool, me: &Account, id: &str, slug: Option<&str>) -> Result<(), Response> {
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
    let agent: Result<Option<i32>, _> =
        sqlx::query_scalar("select 1 from account where id = $1::uuid and kind = 'agent'")
            .bind(id)
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
    if let Err(r) = gate(&read, &me, &id, None).await {
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
    if let Err(r) = gate(&read, &me, &id, Some(&slug)).await {
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
