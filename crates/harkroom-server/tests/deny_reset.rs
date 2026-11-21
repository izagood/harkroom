//! 비밀번호 재설정 코드의 거부 길을 실제 Postgres 와 Rust 라우트로 본다(TS 없이). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다
//! (CI 는 `db-tests` 잡이 `scripts/db-tests.sh` 로 Rust 마이그레이션을 건 새 DB 를 넘긴다).
//!
//! 옛 TS `passwordReset` 시험과 e2e 스토리 `api.denied` J11 을 옮긴 것이다:
//! - 발급(`POST /accounts/:id/password-reset-code`): member 는 403 `forbidden`(전역 grant 로도 못 넓힘), step-up 없으면 403
//!   `step_up_required`, owner 대상 403 `owner_target`(J11), admin 이 다른 admin 대상 403 `forbidden`, 자기 자신 400 `self`.
//! - 사용(`POST /auth/password-reset`): 한 번만, 새로 발급하면 옛 코드는 죽고, 발급자가 강등되면 죽고, 남의 로그인 ID 로도
//!   못 쓴다 — 모두 같은 400 `invalid_reset_code`.
mod common;

use axum::http::{Method, StatusCode};
use harkroom_server::auth::{AuthPools, hash_token};
use harkroom_server::core::{account_reset_code_issue, password_reset_use};
use harkroom_server::rate_limit::RateLimiter;
use harkroom_server::trust_proxy::TrustProxy;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

async fn human(pool: &PgPool, handle: &str, role: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, 'human', $1, $2, $2 in ('owner','admin')) returning id::text",
    )
    .bind(handle)
    .bind(role)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// 열린 세션 — `stepped_up` 이면 비밀번호를 다시 확인한 세션(10분).
async fn session(pool: &PgPool, account: &str, token: &str, stepped_up: bool) -> String {
    sqlx::query(
        "insert into session(token_hash, account_id, expires_at, stepped_up_until) \
         values ($1, $2::uuid, now() + interval '10 days', case when $3 then now() + interval '10 minutes' end)",
    )
    .bind(hash_token(token))
    .bind(account)
    .bind(stepped_up)
    .execute(pool)
    .await
    .unwrap();
    format!("Bearer {token}")
}

async fn app(pool: &PgPool) -> String {
    let auth = || AuthPools {
        read: pool.clone(),
        write: Some(pool.clone()),
    };
    let cors = Arc::new(harkroom_server::cors::Cors::from_env_value(None));
    let trust = Arc::new(TrustProxy::None);
    let r = account_reset_code_issue::routes(
        account_reset_code_issue::ResetCodeIssueState {
            read: pool.clone(),
            write: pool.clone(),
            trust: trust.clone(),
        },
        auth(),
        cors.clone(),
    )
    .router
    .merge(
        password_reset_use::routes(
            password_reset_use::PasswordResetUseState {
                write: pool.clone(),
                trust,
                limiter: Arc::new(RateLimiter::default()),
            },
            cors,
        )
        .router,
    );
    format!("http://{}", common::serve(r).await)
}

async fn call(base: &str, m: Method, path: &str, bearer: &str, body: &str) -> (StatusCode, Value) {
    let mut h = vec![];
    if !bearer.is_empty() {
        h.push(("authorization", bearer));
    }
    if !body.is_empty() {
        h.push(("content-type", "application/json"));
    }
    let (s, _, b) = common::send(base, m, path, &h, body).await;
    (s, serde_json::from_str(&b).unwrap_or(Value::Null))
}

fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or_default()
}

async fn issue(base: &str, tok: &str, target: &str) -> (StatusCode, Value) {
    call(
        base,
        Method::POST,
        &format!("/accounts/{target}/password-reset-code"),
        tok,
        "",
    )
    .await
}

async fn use_code(base: &str, login: &str, reset: &str) -> (StatusCode, Value) {
    call(
        base,
        Method::POST,
        "/auth/password-reset",
        "",
        &serde_json::json!({ "loginId": login, "code": reset, "newPassword": "Reset-pass-2026!" })
            .to_string(),
    )
    .await
}

async fn codes(pool: &PgPool, account: &str) -> i64 {
    sqlx::query_scalar("select count(*) from password_reset_code where account_id = $1::uuid")
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn reset_code_denials_hold_without_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("rs{}", std::process::id());
    let base = app(&pool).await;
    let owner = human(&pool, &format!("{tag}-owner"), "owner").await;
    let admin = human(&pool, &format!("{tag}-admin"), "admin").await;
    let admin2 = human(&pool, &format!("{tag}-admin2"), "admin").await;
    let member = human(&pool, &format!("{tag}-member"), "member").await;
    let target_login = format!("{tag}-target");
    let target = human(&pool, &target_login, "member").await;
    let admin_up = session(&pool, &admin, &format!("{tag}-a-up"), true).await;
    let admin_plain = session(&pool, &admin, &format!("{tag}-a"), false).await;
    let member_up = session(&pool, &member, &format!("{tag}-m-up"), true).await;

    // member 는 발급 못 함 — 전역 grant 를 직접 넣어도 역할로만 갖는 capability 다.
    sqlx::query(
        "insert into account_grant(account_id, capability, scope, granted_by) \
         values ($1::uuid, 'member.reset_password', '', $2::uuid)",
    )
    .bind(&member)
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let (s, b) = issue(&base, &member_up, &target).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "member 발급: {b}");
    assert_eq!(code(&b), "forbidden", "member 발급 code: {b}");

    // step-up 없이는 발급하지 않는다.
    let (s, b) = issue(&base, &admin_plain, &target).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "step-up 없는 발급: {b}");
    assert_eq!(code(&b), "step_up_required", "step-up code: {b}");

    // J11 — owner 는 대상이 될 수 없다. admin 은 다른 admin 도 못 한다. 자기 자신은 400.
    let (s, b) = issue(&base, &admin_up, &owner).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "J11 owner 대상: {b}");
    assert_eq!(code(&b), "owner_target", "J11 code: {b}");
    let (s, b) = issue(&base, &admin_up, &admin2).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "admin 이 admin 대상: {b}");
    assert_eq!(code(&b), "forbidden", "admin 대상 code: {b}");
    let (s, b) = issue(&base, &admin_up, &admin).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "자기 자신: {b}");
    assert_eq!(code(&b), "self", "자기 자신 code: {b}");
    for who in [&owner, &admin2, &admin] {
        assert_eq!(codes(&pool, who).await, 0, "거부된 발급이 코드 행을 남겼다");
    }

    // 한 번만 쓴다 · 남의 로그인 ID 로는 못 쓴다.
    let (s, b) = issue(&base, &admin_up, &target).await;
    assert_eq!(s, StatusCode::CREATED, "member 대상 발급: {b}");
    let first = b["code"].as_str().unwrap().to_owned();
    let (s, b) = use_code(&base, &format!("{tag}-member"), &first).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "남의 로그인 ID: {b}");
    assert_eq!(code(&b), "invalid_reset_code", "남의 로그인 ID code: {b}");
    let (s, b) = use_code(&base, &target_login, &first).await;
    assert_eq!(s, StatusCode::OK, "맞는 코드: {b}");
    let (s, b) = use_code(&base, &target_login, &first).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "두 번째 사용: {b}");
    assert_eq!(code(&b), "invalid_reset_code", "두 번째 사용 code: {b}");

    // 새로 발급하면 이전 코드는 죽는다.
    let (_, b) = issue(&base, &admin_up, &target).await;
    let old = b["code"].as_str().unwrap().to_owned();
    let (s, b) = issue(&base, &admin_up, &target).await;
    assert_eq!(s, StatusCode::CREATED, "재발급: {b}");
    let (s, b) = use_code(&base, &target_login, &old).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "재발급 뒤 옛 코드: {b}");
    assert_eq!(code(&b), "invalid_reset_code", "옛 코드 code: {b}");

    // 발급 뒤 발급자가 강등되면 그 코드는 죽는다(security F1).
    let (_, b) = issue(&base, &admin_up, &target).await;
    let live = b["code"].as_str().unwrap().to_owned();
    sqlx::query("update account set role = 'member', is_admin = false where id = $1::uuid")
        .bind(&admin)
        .execute(&pool)
        .await
        .unwrap();
    let (s, b) = use_code(&base, &target_login, &live).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "강등된 발급자의 코드: {b}");
    assert_eq!(code(&b), "invalid_reset_code", "강등 code: {b}");
    // 강등된 같은 세션으로는 더 발급하지 못한다.
    let (s, b) = issue(&base, &admin_up, &target).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "강등 뒤 발급: {b}");
    assert_eq!(code(&b), "forbidden", "강등 뒤 발급 code: {b}");
}
