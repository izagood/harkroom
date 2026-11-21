//! 계정 쪽 거부 길을 실제 Postgres 와 Rust 라우트로 본다(TS 없이). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다
//! (CI 는 `db-tests` 잡이 `scripts/db-tests.sh` 로 Rust 마이그레이션을 건 새 DB 를 넘긴다). 시험마다 복제한 DB 라 넣은 행은 버려진다.
//!
//! e2e 스토리의 `api.denied` 단계를 옮긴 것이다(옛 TS `storyJourneys.test.ts` 가 돌던 판정):
//! - J3: member 가 `POST /accounts/agents` → 403 `forbidden`, 계정 행이 생기지 않는다.
//! - J5: admin 이 `POST /invites` 로 초대를 만든 **같은 세션**으로, 강등 직후 다시 부르면 403 `forbidden` — 역할을 캐시하지 않는다.
//! - J12: 열린 세션으로 `GET /auth/me` 가 200 이던 사람 계정을 지우면(`deleted_at`·`disabled_at`) 같은 세션이 401 `unauthorized`.
mod common;

use axum::http::{Method, StatusCode};
use harkroom_server::auth::{AuthPools, hash_token};
use harkroom_server::core::{agent_create, auth_light, invites_write};
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

/// 열린 세션 하나 — 돌려주는 것은 `Authorization` 머리 값.
async fn session(pool: &PgPool, account: &str, token: &str) -> String {
    sqlx::query(
        "insert into session(token_hash, account_id, expires_at) values ($1, $2::uuid, now() + interval '10 days')",
    )
    .bind(hash_token(token))
    .bind(account)
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
    let trust = Arc::new(harkroom_server::trust_proxy::TrustProxy::None);
    let r = agent_create::routes(
        agent_create::AgentCreateState {
            pool: pool.clone(),
            up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
            write: Some(pool.clone()),
            patch_write: None,
            patch_rename: false,
            patch_disable: false,
            trust: trust.clone(),
        },
        auth(),
        cors.clone(),
    )
    .router
    .merge(
        invites_write::routes(
            invites_write::InvitesWriteState {
                read: pool.clone(),
                write: pool.clone(),
                trust: trust.clone(),
                mailer: None,
            },
            auth(),
            cors.clone(),
        )
        .router,
    )
    .merge(
        auth_light::routes(
            auth_light::AuthLightState {
                read: pool.clone(),
                write: pool.clone(),
                trust,
            },
            auth(),
            cors,
        )
        .router,
    );
    format!("http://{}", common::serve(r).await)
}

async fn call(base: &str, m: Method, path: &str, bearer: &str, body: &str) -> (StatusCode, Value) {
    let mut h = vec![("authorization", bearer)];
    if !body.is_empty() {
        h.push(("content-type", "application/json"));
    }
    let (s, _, b) = common::send(base, m, path, &h, body).await;
    (s, serde_json::from_str(&b).unwrap_or(Value::Null))
}

fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn account_denials_hold_without_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("dn{}", std::process::id());
    let base = app(&pool).await;

    // J3 — member 는 에이전트를 만들 수 없다. 거부는 본문 판정·쓰기보다 먼저다.
    let member = human(&pool, &format!("{tag}-member"), "member").await;
    let member_tok = session(&pool, &member, &format!("{tag}-member-sess")).await;
    let agent_handle = format!("{tag}-bot");
    let (s, b) = call(
        &base,
        Method::POST,
        "/accounts/agents",
        &member_tok,
        &format!(r#"{{"handle":"{agent_handle}","displayName":"Bot"}}"#),
    )
    .await;
    assert_eq!(
        s,
        StatusCode::FORBIDDEN,
        "J3 member POST /accounts/agents: {b}"
    );
    assert_eq!(code(&b), "forbidden", "J3 code: {b}");
    let made: i64 = sqlx::query_scalar("select count(*) from account where handle = $1")
        .bind(&agent_handle)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(made, 0, "J3: 거부된 요청이 계정을 만들었다");

    // J5 — admin 세션으로 초대가 되다가, 강등 직후 **같은 세션**으로는 403.
    let admin = human(&pool, &format!("{tag}-admin"), "admin").await;
    let admin_tok = session(&pool, &admin, &format!("{tag}-admin-sess")).await;
    let (s, b) = call(&base, Method::POST, "/invites", &admin_tok, "{}").await;
    assert!(s.is_success(), "J5 강등 전 admin POST /invites: {s} {b}");
    let invites = || {
        let pool = pool.clone();
        let admin = admin.clone();
        async move {
            sqlx::query_scalar::<_, i64>("select count(*) from invite where created_by = $1::uuid")
                .bind(admin)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let before = invites().await;
    assert_eq!(before, 1, "J5 강등 전 초대 1건");
    sqlx::query("update account set role = 'member', is_admin = false where id = $1::uuid")
        .bind(&admin)
        .execute(&pool)
        .await
        .unwrap();
    let (s, b) = call(&base, Method::POST, "/invites", &admin_tok, "{}").await;
    assert_eq!(s, StatusCode::FORBIDDEN, "J5 강등 직후 POST /invites: {b}");
    assert_eq!(code(&b), "forbidden", "J5 code: {b}");
    assert_eq!(invites().await, before, "J5: 거부된 요청이 초대를 만들었다");

    // J12 — 열린 세션이 살아 있다가, 계정이 꺼지면(지운 계정과 같은 칸) 같은 세션이 401.
    let gone = human(&pool, &format!("{tag}-gone"), "member").await;
    let gone_tok = session(&pool, &gone, &format!("{tag}-gone-sess")).await;
    let (s, b) = call(&base, Method::GET, "/auth/me", &gone_tok, "").await;
    assert_eq!(s, StatusCode::OK, "J12 끄기 전 /auth/me: {b}");
    assert_eq!(b["id"], gone.as_str(), "J12 끄기 전 내 계정: {b}");
    sqlx::query(
        "update account set deleted_at = now(), disabled_at = coalesce(disabled_at, now()) where id = $1::uuid",
    )
    .bind(&gone)
    .execute(&pool)
    .await
    .unwrap();
    // 세션 행은 일부러 남긴다 — 세션 삭제가 빠져도 인증이 막는지 본다.
    let (s, b) = call(&base, Method::GET, "/auth/me", &gone_tok, "").await;
    assert_eq!(
        s,
        StatusCode::UNAUTHORIZED,
        "J12 꺼진 계정의 열린 세션: {b}"
    );
    assert_eq!(code(&b), "unauthorized", "J12 code: {b}");
}
