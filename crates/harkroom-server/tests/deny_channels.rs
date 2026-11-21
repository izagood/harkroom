//! 채널 쪽 거부 길을 실제 Postgres 와 Rust 라우트로 본다(TS 없이). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다
//! (CI 는 `db-tests` 잡이 `scripts/db-tests.sh` 로 Rust 마이그레이션을 건 새 DB 를 넘긴다).
//!
//! 옛 TS `membershipGate`·`channelOwnership` 시험과 e2e 스토리 `api.denied` J8 을 옮긴 것이다:
//! - 보관 채널에 멤버 추가·남 내보내기 400 `channel_archived`(행·시스템 글 그대로), 자기 나가기는 200.
//! - DM 에 멤버 추가 400 `channel_is_dm`, 팀 추가도 400 `channel_is_dm`(`channel_is_public` 이 아님).
//! - 비멤버는 비공개 채널에 멤버를 못 넣는다(403 `forbidden`).
//! - 채널 PATCH·DELETE 는 만든 사람만(남은 403 `forbidden`).
//! - J8: 비멤버가 비공개 채널 `GET /channels/:id/messages` → 403 `forbidden`.
mod common;

use axum::http::{Method, StatusCode};
use harkroom_server::auth::{AuthPools, hash_token};
use harkroom_server::core::{
    attachment_store::LocalStorage, channel_create_update, channel_delete, channel_members,
    channel_team_add, msg_list, msg_post,
};
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

/// 채널 하나 — `archived` 면 보관, 멤버는 `members`.
async fn channel(
    pool: &PgPool,
    name: &str,
    visibility: &str,
    creator: &str,
    archived: bool,
    members: &[&str],
) -> String {
    let id: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by, archived_at) \
         values ($1, 'standard', $2, $3::uuid, case when $4 then now() end) returning id::text",
    )
    .bind(name)
    .bind(visibility)
    .bind(creator)
    .bind(archived)
    .fetch_one(pool)
    .await
    .unwrap();
    for m in members {
        sqlx::query(
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&id)
        .bind(*m)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn app(pool: &PgPool) -> String {
    let auth = || AuthPools {
        read: pool.clone(),
        write: Some(pool.clone()),
    };
    let cors = Arc::new(harkroom_server::cors::Cors::from_env_value(None));
    let up = || harkroom_server::proxy::Upstream::new("http://127.0.0.1:0");
    let store = std::env::temp_dir().join(format!("deny-channels-{}", std::process::id()));
    let r = channel_members::routes(
        channel_members::MembersState {
            post: msg_post::PostState {
                read: pool.clone(),
                write: pool.clone(),
                up: up(),
                implicit_ok: false,
            },
            trust: TrustProxy::None,
        },
        auth(),
        cors.clone(),
    )
    .router
    .merge(
        channel_team_add::routes(
            channel_team_add::TeamAddState {
                write: pool.clone(),
                trust: TrustProxy::None,
            },
            auth(),
            cors.clone(),
        )
        .router,
    )
    .merge(
        channel_create_update::routes(
            channel_create_update::CreateUpdateState {
                read: pool.clone(),
                write: pool.clone(),
                trust: TrustProxy::None,
            },
            auth(),
            cors.clone(),
        )
        .router,
    )
    .merge(
        channel_delete::routes(
            channel_delete::DeleteState {
                read: pool.clone(),
                write: pool.clone(),
                trust: TrustProxy::None,
                storage: LocalStorage::new(store).unwrap(),
            },
            auth(),
            cors.clone(),
        )
        .router,
    )
    .merge(msg_list::routes(pool.clone(), auth(), cors).router);
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

async fn n(pool: &PgPool, sql: &'static str, a: &str, b: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(a)
        .bind(b)
        .fetch_one(pool)
        .await
        .unwrap()
}

const MEMBER_ROW: &str =
    "select count(*) from channel_member where channel_id = $1::uuid and account_id = $2::uuid";
async fn system_rows(pool: &PgPool, channel: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from message where channel_id = $1::uuid and kind = 'system'",
    )
    .bind(channel)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn channel_denials_hold_without_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("dc{}", std::process::id());
    let base = app(&pool).await;
    let admin = human(&pool, &format!("{tag}-admin"), "admin").await;
    let creator = human(&pool, &format!("{tag}-creator"), "member").await;
    let user = human(&pool, &format!("{tag}-user"), "member").await;
    let outsider = human(&pool, &format!("{tag}-outsider"), "member").await;
    let admin_tok = session(&pool, &admin, &format!("{tag}-a")).await;
    let creator_tok = session(&pool, &creator, &format!("{tag}-c")).await;
    let user_tok = session(&pool, &user, &format!("{tag}-u")).await;
    let outsider_tok = session(&pool, &outsider, &format!("{tag}-o")).await;

    // ── 보관 채널: 추가·남 내보내기는 400 channel_archived, 행·시스템 글이 그대로. 자기 나가기는 된다.
    let arch = channel(
        &pool,
        &format!("{tag}-arch"),
        "private",
        &creator,
        true,
        &[&admin, &user],
    )
    .await;
    let sys_before = system_rows(&pool, &arch).await;
    let (s, b) = call(
        &base,
        Method::POST,
        &format!("/channels/{arch}/members"),
        &admin_tok,
        &format!(r#"{{"accountId":"{outsider}"}}"#),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "보관 채널 멤버 추가: {b}");
    assert_eq!(code(&b), "channel_archived", "보관 채널 추가 code: {b}");
    assert_eq!(
        n(&pool, MEMBER_ROW, &arch, &outsider).await,
        0,
        "거부된 추가가 행을 남겼다"
    );
    let (s, b) = call(
        &base,
        Method::DELETE,
        &format!("/channels/{arch}/members/{user}"),
        &admin_tok,
        "",
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "보관 채널 남 내보내기: {b}");
    assert_eq!(code(&b), "channel_archived", "보관 채널 제거 code: {b}");
    assert_eq!(
        n(&pool, MEMBER_ROW, &arch, &user).await,
        1,
        "거부된 제거가 행을 지웠다"
    );
    assert_eq!(
        system_rows(&pool, &arch).await,
        sys_before,
        "거부가 시스템 글을 남겼다"
    );
    let (s, b) = call(
        &base,
        Method::DELETE,
        &format!("/channels/{arch}/members/{user}"),
        &user_tok,
        "",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "보관 채널에서 자기 나가기: {b}");
    assert_eq!(
        n(&pool, MEMBER_ROW, &arch, &user).await,
        0,
        "나간 행이 남았다"
    );

    // ── DM: 멤버 추가·팀 추가 모두 400 channel_is_dm.
    let dm: String =
        sqlx::query_scalar("insert into channel(kind, topic) values ('dm', '') returning id::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    for m in [&admin, &user] {
        sqlx::query(
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&dm)
        .bind(m)
        .execute(&pool)
        .await
        .unwrap();
    }
    let (s, b) = call(
        &base,
        Method::POST,
        &format!("/channels/{dm}/members"),
        &admin_tok,
        &format!(r#"{{"accountId":"{outsider}"}}"#),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "DM 멤버 추가: {b}");
    assert_eq!(code(&b), "channel_is_dm", "DM 추가 code: {b}");
    assert_eq!(n(&pool, MEMBER_ROW, &dm, &outsider).await, 0);
    let team: String = sqlx::query_scalar(
        "insert into agent_team(name, created_by, invoke_scope, owner_account_id) \
         values ($1, $2::uuid, 'community', $2::uuid) returning id::text",
    )
    .bind(format!("{tag}-team"))
    .bind(&admin)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (s, b) = call(
        &base,
        Method::POST,
        &format!("/channels/{dm}/teams/{team}/add"),
        &admin_tok,
        "",
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "DM 팀 추가: {b}");
    assert_eq!(
        code(&b),
        "channel_is_dm",
        "DM 팀 추가는 channel_is_public 이 아니다: {b}"
    );

    // ── 비공개 채널: 비멤버는 멤버를 못 넣고(J8 과 같은 가시성), 메시지도 못 읽는다.
    let private = channel(
        &pool,
        &format!("{tag}-priv"),
        "private",
        &creator,
        false,
        &[&creator],
    )
    .await;
    let (s, b) = call(
        &base,
        Method::POST,
        &format!("/channels/{private}/members"),
        &outsider_tok,
        &format!(r#"{{"accountId":"{outsider}"}}"#),
    )
    .await;
    assert_eq!(
        s,
        StatusCode::FORBIDDEN,
        "비멤버가 자기를 비공개 채널에 넣기: {b}"
    );
    assert_eq!(code(&b), "forbidden", "비멤버 추가 code: {b}");
    assert_eq!(n(&pool, MEMBER_ROW, &private, &outsider).await, 0);
    // J8
    let (s, b) = call(
        &base,
        Method::GET,
        &format!("/channels/{private}/messages"),
        &outsider_tok,
        "",
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "J8 비멤버 GET messages: {b}");
    assert_eq!(code(&b), "forbidden", "J8 code: {b}");
    let (s, b) = call(
        &base,
        Method::GET,
        &format!("/channels/{private}/messages"),
        &creator_tok,
        "",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "J8 대조: 멤버는 읽는다: {b}");

    // ── channelOwnership: 만든 사람만 PATCH·DELETE.
    let (s, b) = call(
        &base,
        Method::PATCH,
        &format!("/channels/{private}"),
        &creator_tok,
        r#"{"topic":"mine"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "만든 사람 PATCH: {b}");
    let (s, b) = call(
        &base,
        Method::PATCH,
        &format!("/channels/{private}"),
        &outsider_tok,
        r#"{"topic":"theirs"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "남의 PATCH: {b}");
    assert_eq!(code(&b), "forbidden", "남의 PATCH code: {b}");
    let topic: String = sqlx::query_scalar("select topic from channel where id = $1::uuid")
        .bind(&private)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(topic, "mine", "거부된 PATCH 가 주제를 바꿨다");
    let (s, b) = call(
        &base,
        Method::DELETE,
        &format!("/channels/{arch}"),
        &outsider_tok,
        "",
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "남의 DELETE: {b}");
    assert_eq!(code(&b), "forbidden", "남의 DELETE code: {b}");
    let left: i64 = sqlx::query_scalar("select count(*) from channel where id = $1::uuid")
        .bind(&arch)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 1, "거부된 DELETE 가 채널을 지웠다");
    let (s, b) = call(
        &base,
        Method::DELETE,
        &format!("/channels/{arch}"),
        &creator_tok,
        "",
    )
    .await;
    assert!(
        s != StatusCode::FORBIDDEN && s.is_success(),
        "만든 사람 DELETE(보관 채널): {s} {b}"
    );
}
