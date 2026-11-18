//! S5.4 RD1 — 읽기 전용 GET 모음. TS `routes/accountRoutes.ts` 의 `GET /invites` 와 `routes/connectorRoutes.ts` 의
//! `GET /connectors` 를 옮긴다.
//!
//! - `GET /invites` — 관문은 TS 와 같은 `requireCap('member.invite')`(401 → 403 `member.invite 권한이 필요하다`).
//!   발급 능력이 있으면 누가 낸 것이든 본다. 최근 200줄, `created_at desc`. 상태는 used → revoked → expired → pending 순.
//! - `GET /connectors` — `requireAccount`(401) → 에이전트면 403 `agents cannot manage API connectors` →
//!   admin 은 전부, 아니면 자기 것만(`order by c.name`). 칸은 TS `COLS` 그대로다 — 비밀 **값**은 고르지 않는다
//!   (`secret_id` 는 참조일 뿐이고 `secret` 표는 읽지 않는다).
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`MISC_READS_PRIVILEGES`] — 없으면 `main.rs` 가
//!   이 줄들을 붙이지 않아 TS 에 남는다.
//! - TS 에 남기는 것: `GET /leases`(투영 워커의 `currentUrl()` — 서버 메모리), `GET /accounts/agents`(허브의
//!   `runnerRefusal` — 서버 메모리), `GET /agent/config` 는 종료 수령을 쓰므로 쓰기 풀로 따로 켠다(`agent_config_read.rs`).
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::Extension;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한. `account_grant` 는 `requireCap` 판정과 `grantCount` 가 읽는다.
pub const MISC_READS_PRIVILEGES: &[(&str, &str)] = &[
    ("invite", "SELECT"),
    ("account", "SELECT"),
    ("account_grant", "SELECT"),
    ("api_connector", "SELECT"),
];

/// TS `GET /invites` 의 질의와 `InviteView` 꼴 — 칸 순서가 곧 JSON 순서다.
const INVITES_SQL: &str = concat!(
    "select json_build_object(",
    "'id', i.id::text, ",
    "'status', case when i.used_by is not null then 'used' when i.revoked_at is not null then 'revoked' ",
    "when i.expires_at is not null and i.expires_at <= now() then 'expired' else 'pending' end, ",
    "'createdAt', ",
    crate::iso!("i.created_at"),
    ", 'createdBy', json_build_object('id', i.created_by::text, 'handle', c.handle), ",
    "'expiresAt', ",
    crate::iso!("i.expires_at"),
    ", 'revokedAt', ",
    crate::iso!("i.revoked_at"),
    ", 'usedBy', case when i.used_by is null then null else json_build_object('id', i.used_by::text, 'handle', u.handle) end, ",
    "'email', i.email, 'mailStatus', i.mail_status, 'lastSentAt', ",
    crate::iso!("i.last_sent_at"),
    ")::text from invite i join account c on c.id = i.created_by left join account u on u.id = i.used_by ",
    "order by i.created_at desc limit 200"
);

/// TS `COLS`(connectorRoutes.ts) — 같은 칸, 같은 순서. 비밀 값 칸은 없다.
const CONNECTORS_SQL: &str = concat!(
    "select json_build_object(",
    "'id', c.id::text, 'name', c.name, 'ownerAccountId', c.owner_account_id::text, 'baseUrl', c.base_url, ",
    "'authKind', c.auth_kind, 'authHeader', c.auth_header, 'secretId', c.secret_id::text, 'methods', c.methods, ",
    "'tokenUrl', c.token_url, 'tokenForm', c.token_form, 'createdAt', ",
    crate::iso!("c.created_at"),
    ", 'updatedAt', ",
    crate::iso!("c.updated_at"),
    ", 'grantCount', (select count(*)::int from account_grant g where g.capability = 'api.call' and g.scope = 'connector:' || c.id::text)",
    ")::text from api_connector c where $1::boolean or c.owner_account_id = $2::uuid order by c.name"
);

fn arr(r: Vec<String>) -> String {
    format!("[{}]", r.join(","))
}

/// `GET /invites`.
pub async fn get_invites(
    State(read): State<Arc<PgPool>>,
    Extension(auth): Extension<crate::auth::Auth>,
) -> Response {
    let pool = read.as_ref();
    if let Err(r) = crate::perm::require_cap(pool, &auth, "member.invite", None).await {
        return r;
    }
    match sqlx::query_scalar::<_, String>(INVITES_SQL)
        .fetch_all(pool)
        .await
    {
        Ok(r) => json_ok(format!(r#"{{"invites":{}}}"#, arr(r))),
        Err(e) => internal(e),
    }
}

/// `GET /connectors`.
pub async fn get_connectors(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "agents cannot manage API connectors",
        );
    }
    match sqlx::query_scalar::<_, String>(CONNECTORS_SQL)
        .bind(me.is_admin)
        .bind(&me.id)
        .fetch_all(read.as_ref())
        .await
    {
        Ok(r) => json_ok(format!(r#"{{"connectors":{}}}"#, arr(r))),
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
        .get("/invites", get_invites)
        .get("/connectors", get_connectors)
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
