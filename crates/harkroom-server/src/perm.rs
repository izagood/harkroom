//! 인가 판정(S5.2 P0). 정본은 TS `packages/server/src/auth/permissions.ts` 의 `can()` 과 `auth/plugin.ts` 의 `requireCap` 이고,
//! 이 파일은 그 판정을 **그대로** 옮긴다 — Rust 로 옮긴 라우트가 TS 라우트와 같은 요청을 같은 답으로 막게.
//!
//! 순서가 곧 규칙이다(TS 와 같다):
//! 1. `repo.merge`·`repo.read`·`api.call`·`tool.allow` 는 여기서 언제나 거짓 — 각자 정확 일치 판정이 따로 있다.
//! 2. `member.reset_password` 는 역할(owner·admin)로만.
//! 3. 대상이 있고 그 대상을 소유하면 참.
//! 4. guest 가 아니고 member 기본 capability 면 참.
//! 5. grant(대상 scope 또는 전역 '') — guest 는 전역 grant 를 세지 않는다.
//! 6. owner·admin 이면 참.
//!
//! capability 목록은 `packages/shared/src/permissions.ts` 가 정본이다. 아래 `drift` 시험이 그 파일을 읽어 어긋나면 실패한다.
use crate::auth::{Account, Auth};
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use sqlx::PgPool;

/// TS `CAPABILITIES` 와 같은 순서·같은 글자.
pub const CAPABILITIES: &[&str] = &[
    "channel.create",
    "channel.manage",
    "channel.auto_mention",
    "team.create",
    "team.manage",
    "agent.create",
    "agent.manage",
    "agent.privileged",
    "member.invite",
    "audit.read",
    "member.reset_password",
    "operator.register",
    "operator.manage",
    "repo.merge",
    "repo.read",
    "api.call",
    "secret.create",
    "tool.allow",
];

/// TS `MEMBER_DEFAULT_CAPABILITIES`.
pub const MEMBER_DEFAULT_CAPABILITIES: &[&str] = &["operator.register"];

/// `can()` 이 언제나 거짓인 것 — 각자 따로 판정한다(TS 의 앞 네 줄).
const NEVER_VIA_CAN: &[&str] = &["repo.merge", "repo.read", "api.call", "tool.allow"];

/// TS `PermissionTarget['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    Agent,
    Team,
    Channel,
    Operator,
}

impl TargetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Team => "team",
            Self::Channel => "channel",
            Self::Operator => "operator",
        }
    }
    fn owner_sql(self) -> &'static str {
        // TS `isOwnerOf` 의 표와 같다. TS 처럼 uuid 가 아닌 id 는 pg 형 오류(500)가 된다 — 판정이 갈리지 않게 그대로 둔다.
        match self {
            Self::Agent => {
                "select 1 from agent_config where account_id = $2::uuid and owner_account_id = $1::uuid"
            }
            Self::Team => "select 1 from agent_team where id = $2::uuid and created_by = $1::uuid",
            Self::Channel => "select 1 from channel where id = $2::uuid and created_by = $1::uuid",
            Self::Operator => {
                "select 1 from operator where id = $2::uuid and owner_account_id = $1::uuid"
            }
        }
    }
}

/// 판정 대상 — TS `{ kind, id }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target<'a> {
    pub kind: TargetKind,
    pub id: &'a str,
}

/// TS `isOwnerOf`. 아직 없는 표·칸(42P01·42703)은 「소유 아님」이고, 그 밖의 오류는 오류다.
pub async fn is_owner_of(
    pool: &PgPool,
    account_id: &str,
    t: &Target<'_>,
) -> Result<bool, sqlx::Error> {
    let r: Result<Option<i32>, sqlx::Error> = sqlx::query_scalar(t.kind.owner_sql())
        .bind(account_id)
        .bind(t.id)
        .fetch_optional(pool)
        .await;
    match r {
        Ok(row) => Ok(row.is_some()),
        Err(e) => match e.as_database_error().and_then(|d| d.code()) {
            Some(c) if c == "42P01" || c == "42703" => Ok(false),
            _ => Err(e),
        },
    }
}

/// TS `hasGrant`. 전역('') grant 는 대상 한정을 덮는다. `global == false` 면 전역 줄을 보지 않는다(guest).
pub async fn has_grant(
    pool: &PgPool,
    account_id: &str,
    cap: &str,
    scope: &str,
    global: bool,
) -> Result<bool, sqlx::Error> {
    if !global && scope.is_empty() {
        return Ok(false);
    }
    let r: Option<i32> = sqlx::query_scalar(
        "select 1 from account_grant \
          where account_id = $1::uuid and capability = $2 and (($4 and scope = '') or scope = $3) \
            and (expires_at is null or expires_at > now()) limit 1",
    )
    .bind(account_id)
    .bind(cap)
    .bind(scope)
    .bind(global)
    .fetch_optional(pool)
    .await?;
    Ok(r.is_some())
}

fn is_admin_role(a: &Account) -> bool {
    a.role == "owner" || a.role == "admin"
}

/// TS `can()`.
pub async fn can(
    pool: &PgPool,
    actor: &Account,
    cap: &str,
    target: Option<&Target<'_>>,
) -> Result<bool, sqlx::Error> {
    if NEVER_VIA_CAN.contains(&cap) {
        return Ok(false);
    }
    if cap == "member.reset_password" {
        return Ok(is_admin_role(actor));
    }
    if let Some(t) = target
        && is_owner_of(pool, &actor.id, t).await?
    {
        return Ok(true);
    }
    let guest = actor.role == "guest";
    if !guest && MEMBER_DEFAULT_CAPABILITIES.contains(&cap) {
        return Ok(true);
    }
    let scope = target.map_or(String::new(), |t| format!("{}:{}", t.kind.as_str(), t.id));
    if has_grant(pool, &actor.id, cap, &scope, !guest).await? {
        return Ok(true);
    }
    Ok(is_admin_role(actor))
}

fn json(status: StatusCode, body: String) -> Response {
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    r
}

const UNAUTHORIZED: &str =
    r#"{"error":{"code":"unauthorized","message":"authentication required"}}"#;
const INTERNAL: &str = r#"{"error":{"code":"internal","message":"internal error"}}"#;

/// TS `requireCap(cap, target)` — 라우트 처리기 맨 앞에서 부른다. 통과하면 계정을, 아니면 그대로 돌려줄 응답을 준다.
///
/// - 계정이 없으면 401 `unauthorized`(TS 와 같다).
/// - TS 는 대상 파라미터가 비어 있으면 대상 없이 판정한다 — 여기서도 `target` 의 id 가 빈 글이면 `None` 으로 읽는다.
/// - 거절은 403 `forbidden`, 문구 `<cap> 권한이 필요하다`.
///
/// `cap` 은 `CAPABILITIES` 안의 것이어야 한다(라우트 표에 고정값으로만 쓴다). 모르는 값은 개발 실수라 debug 에서 터진다.
// 거절이 곧 axum 응답이라 그대로 돌려준다(요청마다 한 번, 상자에 담을 이득이 없다).
#[allow(clippy::result_large_err)]
pub async fn require_cap(
    pool: &PgPool,
    auth: &Auth,
    cap: &'static str,
    target: Option<Target<'_>>,
) -> Result<Account, Response> {
    debug_assert!(CAPABILITIES.contains(&cap), "unknown capability {cap}");
    let Some(actor) = auth.account.clone() else {
        return Err(json(StatusCode::UNAUTHORIZED, UNAUTHORIZED.to_string()));
    };
    let target = target.filter(|t| !t.id.is_empty());
    match can(pool, &actor, cap, target.as_ref()).await {
        Ok(true) => Ok(actor),
        Ok(false) => Err(json(StatusCode::FORBIDDEN, forbidden_body(cap))),
        Err(e) => {
            eprintln!(
                "front: permission lookup failed: {}",
                e.as_database_error().map_or("io", |_| "db")
            );
            Err(json(
                StatusCode::INTERNAL_SERVER_ERROR,
                INTERNAL.to_string(),
            ))
        }
    }
}

fn forbidden_body(cap: &str) -> String {
    // cap 은 고정 목록의 ASCII 라 JSON 이스케이프가 필요 없다(debug_assert 가 지킨다).
    format!(r#"{{"error":{{"code":"forbidden","message":"{cap} 권한이 필요하다"}}}}"#)
}

#[cfg(test)]
mod drift {
    use super::*;

    /// TS 의 `export const NAME ... = [ ... ]` 배열에서 따옴표 글자만 꺼낸다(주석 줄은 건너뛴다).
    fn ts_array(src: &str, name: &str) -> Vec<String> {
        let start = src.find(&format!("export const {name}")).expect(name);
        let rest = &src[start..];
        let open = rest.find('[').unwrap();
        // `readonly Capability[]` 처럼 타입 주석의 `[]` 를 건너뛴다.
        let (open, rest) = if rest[open..].starts_with("[]") {
            let r = &rest[open + 2..];
            (r.find('[').unwrap(), r)
        } else {
            (open, rest)
        };
        let close = rest[open..].find(']').unwrap() + open;
        rest[open + 1..close]
            .lines()
            .map(|l| l.split("//").next().unwrap())
            .flat_map(|l| l.split(','))
            .map(|s| s.trim().trim_matches('\''))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn capability_lists_match_shared_ts() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/src/permissions.ts"
        ))
        .unwrap();
        assert_eq!(ts_array(&src, "CAPABILITIES"), CAPABILITIES);
        assert_eq!(
            ts_array(&src, "MEMBER_DEFAULT_CAPABILITIES"),
            MEMBER_DEFAULT_CAPABILITIES
        );
    }

    #[test]
    fn forbidden_body_matches_api_error_body() {
        for cap in CAPABILITIES {
            let raw = forbidden_body(cap);
            let b: crate::api::ApiErrorBody = serde_json::from_str(&raw).unwrap();
            assert_eq!(b.error.code, "forbidden");
            assert_eq!(b.error.message, format!("{cap} 권한이 필요하다"));
            assert_eq!(serde_json::to_string(&b).unwrap(), raw);
        }
    }
}
