//! S5.4 — `POST /agent/merge-approvals/peek`(TS `mergeRoutes.ts` → `peekMergeApproval`). 머지 래퍼의 사전 확인(security F2): 이 임대로
//! 판정하면 소모될 1회 승인을 **소모 없이** 본다. `{ approval: { id, ghUser, relaxChecks } | null }`.
//!
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`MERGE_APPROVAL_PEEK_PRIVILEGES`] — 없으면 `main.rs` 가
//!   라우트를 붙이지 않아 TS 가 받는다(fail-closed).
//! - 임대 문장은 TS 정본(`READ_LEASE_SQL`)을 `golden/sql_fragments.json` 에서 읽는다(`command_match.rs` 와 같다). 「사람이 띄운 턴」
//!   판정(`causeByHuman`)은 그 문장의 칸으로 [`cause_by_human`] 이 한다.
//! - 오퍼레이터를 거친 에이전트만(403 은 DB 를 읽기 전). 400 은 zod `base` 와 같은 꼴. `cache-control: no-store` 는 200 에만.
//! - TS 의 `now`(JS `new Date()`)는 DB 시계(ms 로 자름)로 본다.
use super::grant_reads::{ok_no_store, through_operator};
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한(임대 문장의 `mayDecideSql` 이 읽는 표 포함).
pub const MERGE_APPROVAL_PEEK_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("merge_approval", "SELECT"),
];

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, repo, number and a 40-hex headSha are required";

/// TS `peekMergeApproval` 의 select — 같은 조건·같은 정렬.
const PEEK_SQL: &str = "select id::text, gh_user, relax_checks from merge_approval \
     where agent_id = $1::uuid and scope = $2 and pr_number = $3 and head_sha = $4 \
       and channel_id = $5::uuid and thread_root_id = $6::uuid and used_at is null and expires_at > $7::timestamptz \
       and (not ci_override or $8::boolean) \
     order by approved_at desc limit 1";

fn lease_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select t.\"agentId\"::text, t.\"operatorId\"::text, t.\"channelId\"::text, t.\"threadRootId\"::text, \
             t.expired, t.ended, t.\"causeKind\", t.\"causeAskAuthorId\"::text, t.\"askAnsweredBy\", \
             t.\"askAnswererKind\", t.\"askAnswererOwnsAgent\" from ({}) t",
            crate::core::channels::frag("grant_read_lease")
        )
    })
}

/// zod `base` 를 통과한 본문.
#[derive(Debug, Clone, PartialEq)]
pub struct PeekBody {
    pub lease_id: String,
    pub token: String,
    pub repo: String,
    pub number: i64,
    pub head_sha: String,
}

/// zod `.string().min(a).max(b)` — 길이는 UTF-16 코드 단위.
pub(crate) fn str_len_ok(v: &Value, min: usize, max: usize) -> Option<&str> {
    let s = v.as_str()?;
    (min..=max).contains(&s.encode_utf16().count()).then_some(s)
}

fn is_sha40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// zod `.number().int().positive()` — JSON 숫자이고 정수이며 0 보다 크다(`5.0` 도 정수다).
pub(crate) fn positive_int(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return (n > 0).then_some(n);
    }
    if v.as_u64().is_some() {
        return None; // i64 를 넘는 수 — pg int 와 맞을 수 없다(TS 는 쿼리 오류). 400 으로 닫는다.
    }
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f > 0.0 && f <= 9_007_199_254_740_991.0).then_some(f as i64)
}

/// zod `z.object(base).safeParse(req.body ?? {})` — 모르는 키는 버리고, 객체가 아니면 실패.
pub fn parse_body(body: Option<&Value>) -> Option<PeekBody> {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => v.as_object()?,
    };
    let lease_id = o.get("leaseId")?.as_str()?;
    if !is_uuid(lease_id) {
        return None;
    }
    let token = str_len_ok(o.get("token")?, 1, 200)?;
    let repo = str_len_ok(o.get("repo")?, 3, 201)?;
    let number = positive_int(o.get("number")?)?;
    let head_sha = o.get("headSha")?.as_str()?;
    if !is_sha40(head_sha) {
        return None;
    }
    Some(PeekBody {
        lease_id: lease_id.to_owned(),
        token: token.to_owned(),
        repo: repo.to_owned(),
        number,
        head_sha: head_sha.to_owned(),
    })
}

/// TS `repoScope` — `repo:${repo.trim().toLowerCase()}` 가 `REPO_SCOPE_RE`
/// (`^repo:[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9._-]{1,100}$`)에 맞을 때만.
pub fn repo_scope(repo: &str) -> Option<String> {
    let s = repo.trim().to_lowercase();
    let (owner, name) = s.split_once('/')?;
    let tail =
        |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-');
    let ob = owner.as_bytes();
    let owner_ok = (1..=100).contains(&ob.len())
        && (ob[0].is_ascii_lowercase() || ob[0].is_ascii_digit())
        && ob.iter().all(|&c| tail(c));
    let name_ok = (1..=100).contains(&name.len()) && name.bytes().all(tail);
    (owner_ok && name_ok).then(|| format!("repo:{s}"))
}

/// TS `causeByHuman` — cause 작성자가 사람이거나, cause 가 이 에이전트 자신의 카드이고 정할 수 있는 사람이 답했다.
pub fn cause_by_human(
    agent: &str,
    cause_kind: Option<&str>,
    ask_author: Option<&str>,
    answered_by: Option<&str>,
    answerer_kind: Option<&str>,
    answerer_owns: bool,
) -> bool {
    if cause_kind == Some("human") {
        return true;
    }
    ask_author == Some(agent)
        && answered_by.is_some_and(|a| !a.is_empty())
        && answerer_kind == Some("human")
        && answerer_owns
}

pub(crate) fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

type LeaseRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<bool>,
);

/// DB 시계를 JS `toISOString()` 꼴로(ms 로 자름) — TS 의 `new Date()` 자리.
pub(crate) async fn db_now(pool: &PgPool) -> sqlx::Result<String> {
    sqlx::query_scalar(
        "select to_char(date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .fetch_one(pool)
    .await
}

async fn peek(pool: &PgPool, agent: &str, operator: &str, b: &PeekBody) -> sqlx::Result<Value> {
    let now = db_now(pool).await?;
    let lease: Option<LeaseRow> = sqlx::query_as(lease_sql())
        .bind(&b.lease_id)
        .bind(sha256_hex(&b.token))
        .bind(&now)
        .fetch_optional(pool)
        .await?;
    let Some((a, o, channel, thread, expired, ended, kind, author, by, by_kind, owns)) = lease
    else {
        return Ok(json!({ "approval": null }));
    };
    if a != agent || o.as_deref() != Some(operator) || expired || ended {
        return Ok(json!({ "approval": null }));
    }
    let Some(scope) = repo_scope(&b.repo) else {
        return Ok(json!({ "approval": null }));
    };
    let human = cause_by_human(
        &a,
        kind.as_deref(),
        author.as_deref(),
        by.as_deref(),
        by_kind.as_deref(),
        owns == Some(true),
    );
    let row: Option<(String, Option<String>, bool)> = sqlx::query_as(PEEK_SQL)
        .bind(agent)
        .bind(&scope)
        .bind(b.number)
        .bind(&b.head_sha)
        .bind(channel.as_deref())
        .bind(thread.as_deref())
        .bind(&now)
        .bind(human)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some((id, gh_user, relax)) => {
            json!({ "approval": { "id": id, "ghUser": gh_user, "relaxChecks": relax } })
        }
        None => json!({ "approval": null }),
    })
}

/// `POST /agent/merge-approvals/peek`.
pub async fn peek_route(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let parsed = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((_, v)) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let Some(b) = parse_body(parsed.as_ref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    };
    let operator = auth
        .operator
        .as_ref()
        .map(|o| o.id.as_str())
        .unwrap_or_default();
    match peek(&pool, &me.id, operator, &b).await {
        Ok(v) => ok_no_store(&v),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `command_match.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    read: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .post("/agent/merge-approvals/peek", peek_route)
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
        router: t.router.with_state(Arc::new(read)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: &str = "00000000-0000-4000-8000-000000000001";
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn body_like_zod() {
        let ok = json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 7, "headSha": SHA, "x": 1 });
        let b = parse_body(Some(&ok)).unwrap();
        assert_eq!(b.number, 7);
        assert_eq!(
            parse_body(Some(
                &json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 7.0, "headSha": SHA })
            ))
            .map(|b| b.number),
            Some(7)
        );
        for bad in [
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 0, "headSha": SHA }),
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 1.5, "headSha": SHA }),
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": "7", "headSha": SHA }),
            json!({ "leaseId": L, "token": "", "repo": "o/r", "number": 7, "headSha": SHA }),
            json!({ "leaseId": L, "token": "t", "repo": "or", "number": 7, "headSha": SHA }),
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 7, "headSha": SHA.to_uppercase() }),
            json!({ "leaseId": "x", "token": "t", "repo": "o/r", "number": 7, "headSha": SHA }),
            json!([]),
        ] {
            assert!(parse_body(Some(&bad)).is_none(), "{bad}");
        }
        assert!(parse_body(None).is_none());
    }

    #[test]
    fn repo_scope_follows_ts() {
        assert_eq!(
            repo_scope(" Owner/Repo.x ").as_deref(),
            Some("repo:owner/repo.x")
        );
        assert_eq!(repo_scope("o/*"), None);
        assert_eq!(repo_scope("-o/r"), None);
        assert_eq!(repo_scope("o/r/x"), None);
        assert_eq!(repo_scope("o/"), None);
    }

    #[test]
    fn cause_by_human_like_ts() {
        let a = "agent";
        assert!(cause_by_human(a, Some("human"), None, None, None, false));
        assert!(cause_by_human(
            a,
            Some("agent"),
            Some(a),
            Some("p"),
            Some("human"),
            true
        ));
        assert!(!cause_by_human(
            a,
            Some("agent"),
            Some("other"),
            Some("p"),
            Some("human"),
            true
        ));
        assert!(!cause_by_human(
            a,
            Some("agent"),
            Some(a),
            Some(""),
            Some("human"),
            true
        ));
        assert!(!cause_by_human(
            a,
            Some("agent"),
            Some(a),
            Some("p"),
            Some("human"),
            false
        ));
        assert!(!cause_by_human(
            a,
            None,
            Some(a),
            Some("p"),
            Some("agent"),
            true
        ));
    }
}
