//! 인증 미들웨어(S5.1b). 정본은 TS `packages/server/src/auth/plugin.ts` 의 `onRequest` 훅이고, 이 파일은 그 판정을 **그대로**
//! 옮긴다 — Rust 로 옮긴 라우트가 TS 라우트와 같은 요청을 같은 계정으로 세우게. 아직 옮긴 라우트가 없으므로 앞단의 프록시 경로에는
//! 걸지 않는다(프록시는 `Authorization` 을 손대지 않고 TS 로 넘기고, TS 가 다시 판정한다).
//!
//! 판정 순서(TS 와 같다):
//! 1. `Authorization: Bearer <토큰>` 이 아니면 익명.
//! 2. `hkop_` 접두면 오퍼레이터 토큰 표만 본다. `X-Harkroom-Agent` 가 있으면 (오퍼레이터, 에이전트) 배정이 있어야 그 에이전트로
//!    선다 — 없으면 403 `not_assigned`. 이 헤더는 오퍼레이터 토큰에만 뜻이 있다.
//! 3. 아니면 세션(만료 전·삭제 안 된 계정) → 쓰는 동안 늘린다.
//! 4. 아니면 PAT(폐기 안 됨·에이전트 계정만) → 마지막 사용 시각을 5분에 한 번 적는다.
//!
//! 기록(세션 늘리기·PAT 사용 시각)이 실패해도 인증은 막지 않는다. 조회가 실패하면 500 이다(TS 훅이 던지면 500 인 것과 같다).
use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

/// TS `tokens.ts::hashToken` — sha256 hex.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// TS `AccountView` 의 인증이 읽는 칸. 고유 식별자는 문자열(uuid 텍스트)로 둔다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    pub kind: String,
    pub is_admin: bool,
    pub role: String,
    pub status: String,
    pub status_text: Option<String>,
    pub avatar_attachment_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operator {
    pub id: String,
    pub owner_account_id: String,
    pub name: String,
}

/// 어느 자격증명 표로 섰나 — TS `req.authVia`. 오퍼레이터 토큰으로 에이전트가 선 요청은 `account` 가 있어도 `Operator` 다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Session,
    Pat,
    Operator,
}

/// 한 요청의 인증 결과 — 미들웨어가 요청 extensions 에 넣는다. 익명이면 모든 칸이 비어 있다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Auth {
    pub account: Option<Account>,
    pub operator: Option<Operator>,
    pub credential_hash: Option<String>,
    pub via: Option<Via>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    Ok(Box<Auth>),
    /// 오퍼레이터 토큰이 배정되지 않은(또는 uuid 가 아닌) 에이전트를 밝혔다 → 403.
    NotAssigned,
}

type AccountRow = (
    String,
    String,
    String,
    String,
    bool,
    String,
    String,
    Option<String>,
    Option<String>,
);

impl From<AccountRow> for Account {
    fn from(r: AccountRow) -> Self {
        Self {
            id: r.0,
            handle: r.1,
            display_name: r.2,
            kind: r.3,
            is_admin: r.4,
            role: r.5,
            status: r.6,
            status_text: r.7,
            avatar_attachment_id: r.8,
        }
    }
}

// sqlx 0.9 는 `&'static str` 만 받는다 — SQL 을 컴파일 때 이어 붙인다(값은 전부 bind).
macro_rules! account_cols {
    () => {
        "a.id::text as id, a.handle, a.display_name, a.kind, a.is_admin, \
         a.role, a.status, a.status_text, a.avatar_attachment_id::text as avatar_attachment_id"
    };
}

// TS `sessionLifetime.ts` 와 같은 값(14일 늘림 · 남은 기간 7일 미만일 때만 · 처음 로그인에서 90일 상한).
// 셋이 갈라지면 「늘렸는데 상한을 넘는」 세션이 생긴다.
const RENEW_SESSION: &str = "update session \
    set expires_at = least(now() + interval '14 days', created_at + interval '90 days') \
  where token_hash = $1 \
    and expires_at > now() \
    and expires_at < now() + interval '7 days' \
    and expires_at < created_at + interval '90 days'";

/// TS 의 `/^[0-9a-f]{8}-…-[0-9a-f]{12}$/i`. uuid 가 아니면 조회하지 않는다(pg 형 오류 500 을 403 앞에서 막는다).
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `Authorization` 에서 Bearer 토큰을 꺼낸다. TS 처럼 `Bearer ` 는 대소문자를 가린다.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// `X-Harkroom-Agent`. 없으면 `Ok(None)`. 여러 번 왔으면 Node 는 `, ` 로 이어 붙여 uuid 검사에서 떨어지므로 여기서도 떨어뜨린다.
fn agent_header(headers: &HeaderMap) -> Result<Option<&str>, ()> {
    let mut it = headers.get_all("x-harkroom-agent").iter();
    let Some(first) = it.next() else {
        return Ok(None);
    };
    if it.next().is_some() {
        return Err(());
    }
    first.to_str().map(Some).map_err(|_| ())
}

pub async fn resolve(pool: &PgPool, headers: &HeaderMap) -> Result<Resolved, sqlx::Error> {
    let Some(raw) = bearer(headers) else {
        return Ok(Resolved::Ok(Box::default()));
    };
    let hash = hash_token(raw);

    if raw.starts_with("hkop_") {
        let op: Option<(String, String, String)> = sqlx::query_as(
            "select id::text as id, owner_account_id::text as owner_account_id, name \
               from operator where token_hash = $1 and revoked_at is null",
        )
        .bind(&hash)
        .fetch_optional(pool)
        .await?;
        let Some((id, owner_account_id, name)) = op else {
            return Ok(Resolved::Ok(Box::default()));
        };
        let op = Operator {
            id,
            owner_account_id,
            name,
        };
        let agent_id = match agent_header(headers) {
            Ok(None) | Ok(Some("")) => None,
            Ok(Some(v)) => Some(v),
            Err(()) => return Ok(Resolved::NotAssigned),
        };
        let mut auth = Auth {
            account: None,
            credential_hash: Some(hash),
            via: Some(Via::Operator),
            operator: Some(op),
        };
        let Some(agent_id) = agent_id else {
            return Ok(Resolved::Ok(Box::new(auth)));
        };
        if !is_uuid(agent_id) {
            return Ok(Resolved::NotAssigned);
        }
        let agent: Option<AccountRow> = sqlx::query_as(concat!(
            "select ",
            account_cols!(),
            " from agent_assignment asg join account a on a.id = asg.agent_id \
              where asg.operator_id = $1::uuid and asg.agent_id = $2::uuid \
                and a.kind = 'agent' and a.deleted_at is null"
        ))
        .bind(&auth.operator.as_ref().expect("set above").id)
        .bind(agent_id)
        .fetch_optional(pool)
        .await?;
        return match agent {
            Some(a) => {
                auth.account = Some(a.into());
                Ok(Resolved::Ok(Box::new(auth)))
            }
            None => Ok(Resolved::NotAssigned),
        };
    }

    let session: Option<AccountRow> = sqlx::query_as(concat!(
        "select ",
        account_cols!(),
        " from session s join account a on a.id = s.account_id \
          where s.token_hash = $1 and s.expires_at > now() and a.deleted_at is null"
    ))
    .bind(&hash)
    .fetch_optional(pool)
    .await?;
    if let Some(a) = session {
        let _ = sqlx::query(RENEW_SESSION).bind(&hash).execute(pool).await;
        return Ok(Resolved::Ok(Box::new(Auth {
            account: Some(a.into()),
            operator: None,
            credential_hash: Some(hash),
            via: Some(Via::Session),
        })));
    }

    let pat: Option<AccountRow> = sqlx::query_as(concat!(
        "select ",
        account_cols!(),
        " from pat p join account a on a.id = p.account_id \
          where p.token_hash = $1 and p.revoked_at is null and a.deleted_at is null and a.kind = 'agent'"
    ))
    .bind(&hash)
    .fetch_optional(pool)
    .await?;
    if let Some(a) = pat {
        let _ = sqlx::query(
            "update pat set last_used_at = now() \
              where token_hash = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')",
        )
        .bind(&hash)
        .execute(pool)
        .await;
        return Ok(Resolved::Ok(Box::new(Auth {
            account: Some(a.into()),
            operator: None,
            credential_hash: Some(hash),
            via: Some(Via::Pat),
        })));
    }
    Ok(Resolved::Ok(Box::default()))
}

/// TS 와 같은 `{ error: { code, message } }` 꼴. 문구는 고정값만 쓴다.
fn error(status: StatusCode, body: &'static str) -> Response {
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
const OPERATOR_REQUIRED: &str =
    r#"{"error":{"code":"unauthorized","message":"오퍼레이터 토큰이 필요하다"}}"#;
const FORBIDDEN_ADMIN: &str = r#"{"error":{"code":"forbidden","message":"admin required"}}"#;
const NOT_ASSIGNED: &str =
    r#"{"error":{"code":"not_assigned","message":"이 오퍼레이터에 배정되지 않은 에이전트다"}}"#;
const INTERNAL: &str = r#"{"error":{"code":"internal","message":"internal error"}}"#;

/// 옮긴 라우트에 거는 미들웨어: `axum::middleware::from_fn_with_state(pool, auth::layer)`. 판정을 요청 extensions 에 `Auth` 로 넣는다.
pub async fn layer(State(pool): State<PgPool>, mut req: Request, next: Next) -> Response {
    match resolve(&pool, req.headers()).await {
        Ok(Resolved::Ok(auth)) => {
            req.extensions_mut().insert(*auth);
            next.run(req).await
        }
        Ok(Resolved::NotAssigned) => error(StatusCode::FORBIDDEN, NOT_ASSIGNED),
        Err(e) => {
            // DB 오류 원문은 응답에 싣지 않는다(연결 문자열·표 이름이 섞일 수 있다).
            eprintln!(
                "front: auth lookup failed: {}",
                e.as_database_error().map_or("io", |_| "db")
            );
            error(StatusCode::INTERNAL_SERVER_ERROR, INTERNAL)
        }
    }
}

fn auth_of(parts: &Parts) -> Auth {
    // 미들웨어를 걸지 않은 라우트에서 추출기를 쓰면 익명으로 읽힌다 — 열리는 쪽이 아니라 닫히는 쪽으로 틀린다.
    parts.extensions.get::<Auth>().cloned().unwrap_or_default()
}

/// TS `requireAccount` — 계정으로 선 요청만. 아니면 401.
pub struct RequireAccount(pub Account, pub Auth);

impl<S: Send + Sync> FromRequestParts<S> for RequireAccount {
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Response> {
        let auth = auth_of(parts);
        match auth.account.clone() {
            Some(a) => Ok(Self(a, auth)),
            None => Err(error(StatusCode::UNAUTHORIZED, UNAUTHORIZED)),
        }
    }
}

/// TS `requireAdmin` — 계정이 없어도 403 이다(TS 가 그렇다).
pub struct RequireAdmin(pub Account);

impl<S: Send + Sync> FromRequestParts<S> for RequireAdmin {
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Response> {
        match auth_of(parts).account {
            Some(a) if a.is_admin => Ok(Self(a)),
            _ => Err(error(StatusCode::FORBIDDEN, FORBIDDEN_ADMIN)),
        }
    }
}

/// TS `requireOperator` — 오퍼레이터 토큰으로 온 요청만. 사람·에이전트 토큰은 401.
pub struct RequireOperator(pub Operator, pub Auth);

impl<S: Send + Sync> FromRequestParts<S> for RequireOperator {
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Response> {
        let auth = auth_of(parts);
        match auth.operator.clone() {
            Some(o) => Ok(Self(o, auth)),
            None => Err(error(StatusCode::UNAUTHORIZED, OPERATOR_REQUIRED)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_node_sha256_hex() {
        // node -e "console.log(require('crypto').createHash('sha256').update('abc').digest('hex'))"
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn uuid_check_matches_ts_regex() {
        assert!(is_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(is_uuid("0F8FAD5B-D9CB-469F-A165-70867728950E"));
        assert!(!is_uuid("0f8fad5bd9cb469fa16570867728950e"));
        assert!(!is_uuid("0f8fad5b-d9cb-469f-a165-70867728950g"));
        assert!(!is_uuid(""));
    }

    #[test]
    fn bearer_is_case_sensitive_like_ts() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer x"));
        assert_eq!(bearer(&h), Some("x"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("bearer x"));
        assert_eq!(bearer(&h), None);
    }

    #[test]
    fn repeated_agent_header_is_rejected() {
        let mut h = HeaderMap::new();
        assert_eq!(agent_header(&h), Ok(None));
        h.append("x-harkroom-agent", HeaderValue::from_static("a"));
        assert_eq!(agent_header(&h), Ok(Some("a")));
        h.append("x-harkroom-agent", HeaderValue::from_static("b"));
        assert_eq!(agent_header(&h), Err(()));
    }
}
