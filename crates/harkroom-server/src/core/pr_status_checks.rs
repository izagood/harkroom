//! P4 — `POST /agent/pr-status-checks`(TS `routes/mergeRoutes.ts` → `services/prStatusChecks.ts` `checkPrStatus`).
//! 오퍼레이터가 gh 로 PR 상태를 읽기 **전에** 묻는 읽기 허락이다.
//!
//! - 순서는 TS 그대로: 본문 규칙(fastify — 413·415·깨진 JSON 400) → 인증 401 → 오퍼레이터로 선 에이전트 아님 403 `forbidden`
//!   → 본문 `{leaseId(uuid), token(1..200), repo(3..201), number(양의 정수)}` 아님 400 `bad_request`
//!   → 임대(같은 에이전트·오퍼레이터, 만료·종료 아님) 아님 403 `lease_invalid` → 저장소 이름 꼴 아님 400 `bad_repo`
//!   → `repo.read` 다음 `repo.merge` grant(정확·조직 scope, 임대 채널에서 준 사람이 지금 정할 수 있어야 함 — 골든 `repo_grant_for`)
//!   없음 403 `not_granted` → 200 `{allowed: true, repo}`. 모든 답에 `cache-control: no-store`(거절도 — TS 가 판정 뒤에 머리를 단다:
//!   본문 400·403 `forbidden` 에는 없다).
//! - 감사: 거절은 `pr.status.denied {number, code}`(target = scope 또는 repo 앞 201자), 허락은 `pr.status.checked {number, via}`.
//!   감사 실패는 삼킨다(TS `recordAudit`).
//! - TS 의 `now`(JS `new Date()`)는 DB 시계(ms 로 자름)로 본다 — `merge_checks.rs` 와 같다.
//! - fail-closed: 쓰기 풀에 [`PR_STATUS_CHECKS_PRIVILEGES`] 가 다 있을 때만 `main.rs` 가 붙인다 — 아니면 TS 에 남는다.
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 쓰기 풀에 있어야 하는 권한 — 임대 읽기·`repo_grant_for`(소유자·정할 수 있는 사람 판정)·감사.
pub const PR_STATUS_CHECKS_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("account_grant", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("audit_log", "INSERT"),
];

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, repo and number are required";

fn str_len_ok(v: Option<&Value>, min: usize, max: usize) -> bool {
    v.and_then(Value::as_str)
        .map(|s| s.encode_utf16().count())
        .is_some_and(|n| n >= min && n <= max)
}

/// zod `{leaseId, token, repo, number}.safeParse(req.body ?? {})` — 남는 키는 무시. 맞으면 (leaseId, token, repo, number).
fn parse(body: Option<&Value>) -> Option<(String, String, String, i64)> {
    let empty = Map::new();
    let o = match body {
        None | Some(Value::Null) => &empty,
        Some(v) => v.as_object()?,
    };
    let lease = o.get("leaseId")?.as_str()?;
    if !is_uuid(lease) {
        return None;
    }
    if !str_len_ok(o.get("token"), 1, 200) || !str_len_ok(o.get("repo"), 3, 201) {
        return None;
    }
    let n = o.get("number")?.as_f64()?;
    if !(n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0) {
        return None;
    }
    Some((
        lease.to_owned(),
        o.get("token")?.as_str()?.to_owned(),
        o.get("repo")?.as_str()?.to_owned(),
        n as i64,
    ))
}

fn grant_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select 1 from ({}) g",
            super::channels::frag("repo_grant_for")
        )
    })
}

/// TS `repoGrantFor` — 정확 scope 와 조직 scope `repo:<owner>/*`.
async fn has_grant(
    w: &PgPool,
    cap: &str,
    agent: &str,
    scope: &str,
    channel: Option<&str>,
) -> sqlx::Result<bool> {
    let owner = scope
        .strip_prefix("repo:")
        .and_then(|s| s.split_once('/'))
        .map_or("", |(o, _)| o);
    Ok(sqlx::query_scalar::<_, i32>(grant_sql())
        .bind(agent)
        .bind(vec![scope.to_owned(), format!("repo:{owner}/*")])
        .bind(scope)
        .bind(channel)
        .bind(cap)
        .fetch_optional(w)
        .await?
        .is_some())
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// 판정 — `Ok(Ok(repo))` 허락, `Ok(Err(code))` 거절(감사는 이미 썼다).
async fn check(
    w: &PgPool,
    agent: &str,
    operator: &str,
    lease_id: &str,
    token: &str,
    repo: &str,
    number: i64,
) -> sqlx::Result<Result<String, &'static str>> {
    let now = super::merge_approval_peek::db_now(w).await?;
    let lease = super::lease_read::read_lease(w, lease_id, token, &now).await?;
    let lease_ok = lease.as_ref().is_some_and(|l| {
        l.agent_id == agent && l.operator_id.as_deref() == Some(operator) && !l.expired && !l.ended
    });
    let scope = super::merge_approval_peek::repo_scope(repo);
    let deny_target = scope.clone().unwrap_or_else(|| js_slice_201(repo));
    let deny = |code: &'static str| {
        let t = deny_target.as_str();
        async move {
            record_audit(
                w,
                AuditEntry {
                    action: "pr.status.denied",
                    actor_id: Some(agent),
                    actor_handle: None,
                    target: Some(t),
                    ip: None,
                    detail: json!({ "number": number, "code": code }),
                },
            )
            .await;
            Ok(Err(code))
        }
    };
    if !lease_ok {
        return deny("lease_invalid").await;
    }
    let Some(scope_v) = scope.clone() else {
        return deny("bad_repo").await;
    };
    let channel = lease.as_ref().and_then(|l| l.channel_id.as_deref());
    let via = if has_grant(w, "repo.read", agent, &scope_v, channel).await? {
        "read"
    } else if has_grant(w, "repo.merge", agent, &scope_v, channel).await? {
        "merge"
    } else {
        return deny("not_granted").await;
    };
    record_audit(
        w,
        AuditEntry {
            action: "pr.status.checked",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&scope_v),
            ip: None,
            detail: json!({ "number": number, "via": via }),
        },
    )
    .await;
    Ok(Ok(scope_v["repo:".len()..].to_owned()))
}

/// JS `s.slice(0, 201)` — UTF-16 단위로 자른다(서로게이트 반쪽은 버린다).
fn js_slice_201(s: &str) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        n += c.len_utf16();
        if n > 201 {
            break;
        }
        out.push(c);
    }
    out
}

/// `POST /agent/pr-status-checks`.
pub async fn route(
    State(w): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let parsed = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((_, v)) => v,
        Err(r) => return r,
    };
    let (agent, operator) = match (&me.kind[..], &auth.operator) {
        ("agent", Some(op)) => (me.id.clone(), op.id.clone()),
        _ => return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN),
    };
    let Some((lease_id, token, repo, number)) = parse(parsed.as_ref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    };
    match check(&w, &agent, &operator, &lease_id, &token, &repo, number).await {
        Err(e) => internal(e),
        Ok(Err(code)) => no_store(json_err(
            if code == "bad_repo" {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::FORBIDDEN
            },
            code,
            &format!("pr status not allowed: {code}"),
        )),
        Ok(Ok(repo)) => no_store(
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                json!({ "allowed": true, "repo": repo }).to_string(),
            )
                .into_response(),
        ),
    }
}

/// 코어 라우터에 합칠 줄(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .post("/agent/pr-status-checks", route)
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
        router: t.router.with_state(Arc::new(write)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_shape_follows_zod() {
        let ok = json!({"leaseId": "00000000-0000-4000-8000-000000000001", "token": "t", "repo": "a/b", "number": 3, "extra": 1});
        assert_eq!(parse(Some(&ok)).map(|p| p.3), Some(3));
        assert!(parse(None).is_none());
        assert!(parse(Some(&json!([]))).is_none());
        let mut bad = ok.clone();
        bad["number"] = json!(0);
        assert!(parse(Some(&bad)).is_none());
        bad["number"] = json!(1.5);
        assert!(parse(Some(&bad)).is_none());
        let mut bad = ok.clone();
        bad["repo"] = json!("ab");
        assert!(parse(Some(&bad)).is_none());
        let mut bad = ok.clone();
        bad["token"] = json!("");
        assert!(parse(Some(&bad)).is_none());
        let mut bad = ok;
        bad["leaseId"] = json!("nope");
        assert!(parse(Some(&bad)).is_none());
    }

    #[test]
    fn slice_201_counts_utf16() {
        assert_eq!(js_slice_201(&"a".repeat(300)).len(), 201);
        assert_eq!(js_slice_201("x/y"), "x/y");
        // 😀 는 UTF-16 두 단위 — 200자 뒤에 오면 반쪽이 되므로 버린다.
        let s = format!("{}😀", "a".repeat(200));
        assert_eq!(js_slice_201(&s), "a".repeat(200));
    }
}
