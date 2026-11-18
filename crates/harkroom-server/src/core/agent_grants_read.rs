//! S5.4 AG1 — 러너가 턴을 띄울 때 읽는 grant 두 줄. TS `mergeRoutes.ts`·`apiCallRoutes.ts` 와 같은 응답.
//!
//! - `GET /agent/merge-grants` → `{ repos, approvals }` (TS `mergeableRepos`·`openMergeApprovals`)
//! - `GET /agent/api-grants` → `{ connectors, delegatable }` (TS `callableConnectors`·`delegatableConnectors`)
//!
//! 약속:
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`AGENT_GRANTS_READ_PRIVILEGES`] — 없으면 `main.rs` 가
//!   두 줄을 TS 에 남긴다. 비밀 값은 읽지도 싣지도 않는다(연결 **이름**만).
//! - 오퍼레이터를 거친 에이전트만(아니면 403, 몸에 `cache-control` 없음). 200 에만 `cache-control: no-store`.
//! - 문장은 TS 서비스 문장을 그대로 옮겼다. `openMergeApprovals` 의 `$2`(JS `new Date()`)는 DB `now()` 로 본다.
use super::grant_reads::through_operator;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한.
pub const AGENT_GRANTS_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("account_grant", "SELECT"),
    ("merge_approval", "SELECT"),
    ("api_connector", "SELECT"),
];

const FORBIDDEN: &str = "only an agent through its operator can do this";

const MERGEABLE_REPOS_SQL: &str = "select scope from account_grant where account_id = $1::uuid and capability = 'repo.merge' \
     and (expires_at is null or expires_at > now()) order by scope";

const OPEN_APPROVALS_SQL: &str = "select id, scope, pr_number as number, head_sha as \"headSha\", gh_user as \"ghUser\", relax_checks as \"relaxChecks\", \
     channel_id as \"channelId\", thread_root_id as \"threadRootId\", expires_at as \"expiresAt\" \
     from merge_approval where agent_id = $1::uuid and used_at is null and expires_at > now() order by approved_at";

const CALLABLE_SQL: &str = "select distinct c.name from account_grant g join api_connector c on g.scope = 'connector:' || c.id::text \
     where g.account_id = $1::uuid and g.capability = 'api.call' and g.suspended_at is null \
     and (g.expires_at is null or g.expires_at > now()) order by c.name";

const DELEGATABLE_SQL: &str = "select distinct c.name from account_grant g join api_connector c on g.scope = 'connector:' || c.id::text \
     where g.account_id = $1::uuid and g.capability = 'api.call' and g.suspended_at is null and g.delegate_depth >= 1 \
     and (g.expires_at is null or g.expires_at > now()) order by c.name";

fn approvals_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| crate::core::channels::rows_sql(OPEN_APPROVALS_SQL, &["expiresAt"]))
}

/// TS `scope.slice('repo:'.length)` — 앞 다섯 글자를 무조건 자른다(접두가 달라도).
fn strip_repo(scope: &str) -> String {
    scope.chars().skip("repo:".len()).collect()
}

/// TS `openMergeApprovals` 의 행 → 응답 객체. serde_json 은 키를 정렬하므로 TS 키 순서를 지키려고 손으로 잇는다.
fn approval(r: &Value) -> String {
    let repo = Value::from(strip_repo(r["scope"].as_str().unwrap_or_default()));
    format!(
        "{{\"id\":{},\"repo\":{},\"number\":{},\"headSha\":{},\"ghUser\":{},\"relaxChecks\":{},\"channelId\":{},\"threadRootId\":{},\"expiresAt\":{}}}",
        r["id"],
        repo,
        r["number"],
        r["headSha"],
        r["ghUser"],
        r["relaxChecks"],
        r["channelId"],
        r["threadRootId"],
        r["expiresAt"]
    )
}

/// 200 + `no-store` — 몸은 이미 이은 JSON 글.
fn ok_text(body: String) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

fn str_array(v: &[String]) -> String {
    Value::from(v.to_vec()).to_string()
}

async fn names(pool: &PgPool, sql: &'static str, id: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(sql).bind(id).fetch_all(pool).await
}

pub async fn merge_grants(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
) -> Response {
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let run = async {
        let repos = names(&pool, MERGEABLE_REPOS_SQL, &me.id).await?;
        let text: String = sqlx::query_scalar(approvals_sql())
            .bind(&me.id)
            .fetch_one(&*pool)
            .await?;
        Ok::<_, sqlx::Error>((repos, text))
    };
    let (repos, text) = match run.await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let rows: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
    let repos: Vec<String> = repos.iter().map(|s| strip_repo(s)).collect();
    let approvals: Vec<String> = rows.iter().map(approval).collect();
    ok_text(format!(
        "{{\"repos\":{},\"approvals\":[{}]}}",
        str_array(&repos),
        approvals.join(",")
    ))
}

pub async fn api_grants(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
) -> Response {
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let run = async {
        let c = names(&pool, CALLABLE_SQL, &me.id).await?;
        let d = names(&pool, DELEGATABLE_SQL, &me.id).await?;
        Ok::<_, sqlx::Error>((c, d))
    };
    match run.await {
        Ok((c, d)) => ok_text(format!(
            "{{\"connectors\":{},\"delegatable\":{}}}",
            str_array(&c),
            str_array(&d)
        )),
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
        .get("/agent/merge-grants", merge_grants)
        .get("/agent/api-grants", api_grants)
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
    use serde_json::json;

    #[test]
    fn repo_slice_like_ts() {
        assert_eq!(strip_repo("repo:a/b"), "a/b");
        assert_eq!(strip_repo("repo"), "");
    }

    #[test]
    fn approval_keys_in_ts_order() {
        let v = approval(&json!({
            "id": "i", "scope": "repo:o/r", "number": 3, "headSha": "h", "ghUser": null,
            "relaxChecks": false, "channelId": "c", "threadRootId": "t", "expiresAt": "x"
        }));
        assert_eq!(
            v,
            r#"{"id":"i","repo":"o/r","number":3,"headSha":"h","ghUser":null,"relaxChecks":false,"channelId":"c","threadRootId":"t","expiresAt":"x"}"#
        );
    }
}
