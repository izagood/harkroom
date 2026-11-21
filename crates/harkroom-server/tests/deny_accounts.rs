//! 계정 쪽 거부 길을 실제 Postgres 와 Rust 라우트로 본다(TS 없이). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다
//! (CI 는 `db-tests` 잡이 `scripts/db-tests.sh` 로 Rust 마이그레이션을 건 새 DB 를 넘긴다). 시험마다 복제한 DB 라 넣은 행은 버려진다.
//!
//! e2e 스토리의 `api.denied` 단계를 옮긴 것이다(옛 TS `storyJourneys.test.ts` 가 돌던 판정):
//! - J3: member 가 `POST /accounts/agents` → 403 `forbidden`, 계정 행이 생기지 않는다.
//! - J5: admin 이 `POST /invites` 로 초대를 만든 **같은 세션**으로, 강등 직후 다시 부르면 403 `forbidden` — 역할을 캐시하지 않는다.
//! - J12: 열린 세션으로 `GET /auth/me` 가 200 이던 사람 계정을 지우면(`deleted_at`·`disabled_at`) 같은 세션이 401 `unauthorized`.
//!
//! 옛 TS `grantRoutes`·`permissions`·`dmInvokeGate` 시험의 라우트 거부 길(두 번째 시험):
//! - J9: guest 는 전역 `channel.create` grant 가 있어도 `POST /channels` → 403 `forbidden`(member 는 201).
//! - member 는 grant 를 못 준다(`PUT /accounts/:id/grants` 403 `forbidden`), admin 임명은 owner 만(`PUT /accounts/:id/role` 403).
//! - 새 DM 은 부를 수 있는 에이전트와만 연다(`POST /dms` 403 `agent_not_invokable`), 꺼 둔 에이전트도 같다.
//!
//! 옛 TS `accountStatus`·`auth`(비밀번호 변경) 시험의 거부 길(세 번째 시험):
//! - 에이전트의 `PUT /accounts/me/status` → 400 `invalid_account`, 상태 그대로. 81자 문구 → 400 `invalid_request`, 문구 그대로.
//! - `POST /auth/password`: 자격 없음 401 `unauthorized` · 현재 비밀번호 틀림 401 `invalid_credentials`(해시 그대로) ·
//!   새 비밀번호 7자 400 `invalid_request` · 성공(204)하면 지금 세션은 살고 다른 세션은 401.
mod common;

use axum::http::{Method, StatusCode};
use harkroom_server::auth::{AuthPools, hash_token};
use harkroom_server::core::{
    account_grant_give, account_role, account_self, agent_create, auth_light, auth_password,
    channel_create_update, dm_open, invites_write,
};
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
    let mut h = Vec::new();
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

async fn app2(pool: &PgPool) -> String {
    let auth = || AuthPools {
        read: pool.clone(),
        write: Some(pool.clone()),
    };
    let cors = Arc::new(harkroom_server::cors::Cors::from_env_value(None));
    let trust = Arc::new(harkroom_server::trust_proxy::TrustProxy::None);
    let r = channel_create_update::routes(
        channel_create_update::CreateUpdateState {
            read: pool.clone(),
            write: pool.clone(),
            trust: harkroom_server::trust_proxy::TrustProxy::None,
        },
        auth(),
        cors.clone(),
    )
    .router
    .merge(
        account_grant_give::routes(
            account_grant_give::AccountGrantGiveState {
                write: pool.clone(),
                trust: trust.clone(),
                up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
            },
            auth(),
            cors.clone(),
        )
        .router,
    )
    .merge(
        account_role::routes(
            account_role::AccountRoleState {
                write: pool.clone(),
                trust,
            },
            auth(),
            cors.clone(),
        )
        .router,
    )
    .merge(
        dm_open::routes(
            dm_open::DmOpenState {
                read: pool.clone(),
                write: pool.clone(),
                get_dms: false,
            },
            auth(),
            cors,
        )
        .router,
    );
    format!("http://{}", common::serve(r).await)
}

async fn agent(pool: &PgPool, handle: &str, scope: &str, owner: &str, disabled: bool) -> String {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, role, is_admin, disabled_at) \
         values ($1, $1, 'agent', 'member', false, case when $2 then now() end) returning id::text",
    )
    .bind(handle)
    .bind(disabled)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "insert into agent_config(account_id, invoke_scope, owner_account_id) values ($1::uuid, $2, $3::uuid)",
    )
    .bind(&id)
    .bind(scope)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn count(pool: &PgPool, sql: &'static str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn role_grant_and_dm_denials_hold_without_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("dr{}", std::process::id());
    let base = app2(&pool).await;
    let owner = human(&pool, &format!("{tag}-owner"), "owner").await;
    let admin = human(&pool, &format!("{tag}-admin"), "admin").await;
    let member = human(&pool, &format!("{tag}-member"), "member").await;
    let guest = human(&pool, &format!("{tag}-guest"), "guest").await;
    let admin_tok = session(&pool, &admin, &format!("{tag}-a")).await;
    let member_tok = session(&pool, &member, &format!("{tag}-m")).await;
    let guest_tok = session(&pool, &guest, &format!("{tag}-g")).await;

    // J9 — guest 는 전역 grant 를 세지 않는다. 같은 grant 를 가진 채로 POST /channels 가 403, 채널 행이 생기지 않는다.
    for who in [&guest, &member] {
        sqlx::query(
            "insert into account_grant(account_id, capability, scope, granted_by) \
             values ($1::uuid, 'channel.create', '', $2::uuid)",
        )
        .bind(who)
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    }
    let gname = format!("{tag}-guest-ch");
    let (s, b) = call(
        &base,
        Method::POST,
        "/channels",
        &guest_tok,
        &format!(r#"{{"name":"{gname}"}}"#),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "J9 guest POST /channels: {b}");
    assert_eq!(code(&b), "forbidden", "J9 code: {b}");
    assert_eq!(
        count(
            &pool,
            "select count(*) from channel where name = $1",
            &gname
        )
        .await,
        0,
        "J9: 거부된 요청이 채널을 만들었다"
    );
    // 대조: 같은 전역 grant 를 가진 member 는 만든다(거부가 라우트 전체 고장이 아님을 확인).
    let mname = format!("{tag}-member-ch");
    let (s, b) = call(
        &base,
        Method::POST,
        "/channels",
        &member_tok,
        &format!(r#"{{"name":"{mname}"}}"#),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "member POST /channels: {b}");

    // grantRoutes — member 는 grant 를 못 준다. grant 행 수가 그대로.
    let grants = "select count(*) from account_grant where account_id = $1::uuid";
    let before = count(&pool, grants, &member).await;
    let (s, b) = call(
        &base,
        Method::PUT,
        &format!("/accounts/{member}/grants"),
        &member_tok,
        r#"{"capability":"channel.create","scope":""}"#,
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "member PUT grants: {b}");
    assert_eq!(code(&b), "forbidden", "member PUT grants code: {b}");
    assert_eq!(
        count(&pool, grants, &member).await,
        before,
        "거부된 grant 가 행을 만들었다"
    );

    // admin 임명·해제는 owner 만. admin 도 member 도 남을 admin 으로 못 올린다. 역할이 그대로.
    let role = "select count(*) from account where id = $1::uuid and role = 'member'";
    for (who, tok) in [("admin", &admin_tok), ("member", &member_tok)] {
        let (s, b) = call(
            &base,
            Method::PUT,
            &format!("/accounts/{member}/role"),
            tok,
            r#"{"role":"admin"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{who} PUT role admin: {b}");
        assert_eq!(code(&b), "forbidden", "{who} PUT role code: {b}");
        assert_eq!(
            count(&pool, role, &member).await,
            1,
            "{who}: 거부된 임명이 역할을 바꿨다"
        );
    }
    // guest 강등 뒤에는 같은 세션·같은 전역 grant 로 만들던 것이 막힌다(역할을 요청마다 읽는다).
    let (s, b) = call(
        &base,
        Method::PUT,
        &format!("/accounts/{member}/role"),
        &admin_tok,
        r#"{"role":"guest"}"#,
    )
    .await;
    assert!(s.is_success(), "admin 이 member 를 guest 로: {s} {b}");
    let (s, b) = call(
        &base,
        Method::POST,
        "/channels",
        &member_tok,
        &format!(r#"{{"name":"{mname}-2"}}"#),
    )
    .await;
    assert_eq!(
        s,
        StatusCode::FORBIDDEN,
        "guest 강등 직후 POST /channels: {b}"
    );
    assert_eq!(code(&b), "forbidden", "강등 뒤 code: {b}");

    // dmInvokeGate — 남의 owner 범위 에이전트·꺼 둔 에이전트와는 새 DM 을 못 연다. DM 채널이 생기지 않는다.
    let own_bot = agent(&pool, &format!("{tag}-own-bot"), "owner", &owner, false).await;
    let off_bot = agent(&pool, &format!("{tag}-off-bot"), "community", &owner, true).await;
    let com_bot = agent(&pool, &format!("{tag}-com-bot"), "community", &owner, false).await;
    let dms = "select count(*) from channel_member m join channel c on c.id = m.channel_id where c.kind = 'dm' and m.account_id = $1::uuid";
    for (name, bot) in [("owner 범위", &own_bot), ("꺼 둔", &off_bot)] {
        let (s, b) = call(
            &base,
            Method::POST,
            "/dms",
            &admin_tok,
            &format!(r#"{{"accountIds":["{bot}"]}}"#),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{name} 에이전트 새 DM: {b}");
        assert_eq!(
            code(&b),
            "agent_not_invokable",
            "{name} 에이전트 DM code: {b}"
        );
        assert_eq!(
            count(&pool, dms, bot).await,
            0,
            "{name}: 거부된 DM 이 채널을 만들었다"
        );
    }
    // 대조: community 에이전트와는 열린다.
    let (s, b) = call(
        &base,
        Method::POST,
        "/dms",
        &admin_tok,
        &format!(r#"{{"accountIds":["{com_bot}"]}}"#),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "community 에이전트 DM: {b}");
}

async fn app3(pool: &PgPool) -> String {
    let auth = || AuthPools {
        read: pool.clone(),
        write: Some(pool.clone()),
    };
    let cors = Arc::new(harkroom_server::cors::Cors::from_env_value(None));
    let trust = Arc::new(harkroom_server::trust_proxy::TrustProxy::None);
    let r = account_self::routes(
        account_self::AccountSelfState {
            read: pool.clone(),
            write: pool.clone(),
            trust: trust.clone(),
        },
        auth(),
        cors.clone(),
    )
    .router
    .merge(
        auth_password::routes(
            auth_password::AuthPasswordState {
                write: pool.clone(),
                trust: trust.clone(),
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

#[tokio::test]
async fn status_and_password_denials_hold_without_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("sp{}", std::process::id());
    let base = app3(&pool).await;
    let status_of = |id: String| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "select status, status_text from account where id = $1::uuid",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    // accountStatus — 에이전트는 상태를 못 바꾼다(400 invalid_account), 행도 그대로.
    let owner = human(&pool, &format!("{tag}-owner"), "member").await;
    let bot = agent(&pool, &format!("{tag}-bot"), "owner", &owner, false).await;
    let bot_tok = session(&pool, &bot, &format!("{tag}-bot-sess")).await;
    let (s, b) = call(
        &base,
        Method::PUT,
        "/accounts/me/status",
        &bot_tok,
        r#"{"status":"dnd","statusText":"x"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "에이전트 상태 변경: {b}");
    assert_eq!(code(&b), "invalid_account", "에이전트 상태 code: {b}");
    assert_eq!(
        status_of(bot.clone()).await,
        ("available".to_string(), None),
        "에이전트 상태가 바뀌었다"
    );

    // 사람: 정한 문구는 81자 요청으로 지워지지 않는다(400 invalid_request).
    let me = human(&pool, &format!("{tag}-me"), "member").await;
    let me_tok = session(&pool, &me, &format!("{tag}-me-sess")).await;
    let (s, b) = call(
        &base,
        Method::PUT,
        "/accounts/me/status",
        &me_tok,
        r#"{"status":"dnd","statusText":"lunch"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "사람 상태 변경: {b}");
    let long = "가".repeat(81);
    let (s, b) = call(
        &base,
        Method::PUT,
        "/accounts/me/status",
        &me_tok,
        &format!(r#"{{"status":"away","statusText":"{long}"}}"#),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "81자 문구: {b}");
    assert_eq!(code(&b), "invalid_request", "81자 code: {b}");
    assert_eq!(
        status_of(me.clone()).await,
        ("dnd".to_string(), Some("lunch".to_string())),
        "81자 거절이 상태를 바꿨다"
    );

    // 비밀번호 변경 거부 — 자격 없음 401.
    let pw_hash = harkroom_server::password::hash("pw123456");
    sqlx::query("update account set password_hash = $1 where id = $2::uuid")
        .bind(&pw_hash)
        .bind(&me)
        .execute(&pool)
        .await
        .unwrap();
    let (s, b) = call(
        &base,
        Method::POST,
        "/auth/password",
        "",
        r#"{"currentPassword":"pw123456","newPassword":"new123456"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "자격 없는 비밀번호 변경: {b}");
    assert_eq!(code(&b), "unauthorized", "자격 없음 code: {b}");
    let hash_now = || {
        let pool = pool.clone();
        let me = me.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>(
                "select password_hash from account where id = $1::uuid",
            )
            .bind(me)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    // 현재 비밀번호 틀림 — 401 invalid_credentials, 해시 그대로.
    let (s, b) = call(
        &base,
        Method::POST,
        "/auth/password",
        &me_tok,
        r#"{"currentPassword":"wrong-password","newPassword":"another123"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "틀린 현재 비밀번호: {b}");
    assert_eq!(
        code(&b),
        "invalid_credentials",
        "틀린 현재 비밀번호 code: {b}"
    );
    assert_eq!(
        hash_now().await.as_deref(),
        Some(pw_hash.as_str()),
        "틀린 요청이 해시를 바꿨다"
    );
    // 새 비밀번호가 짧다 — 400 invalid_request, 해시 그대로.
    let (s, b) = call(
        &base,
        Method::POST,
        "/auth/password",
        &me_tok,
        r#"{"currentPassword":"pw123456","newPassword":"short"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "짧은 새 비밀번호: {b}");
    assert_eq!(code(&b), "invalid_request", "짧은 새 비밀번호 code: {b}");
    assert_eq!(
        hash_now().await.as_deref(),
        Some(pw_hash.as_str()),
        "짧은 요청이 해시를 바꿨다"
    );

    // 성공하면 지금 세션은 살고 다른 세션은 끊긴다.
    let other_tok = session(&pool, &me, &format!("{tag}-me-sess2")).await;
    let (s, _) = call(&base, Method::GET, "/auth/me", &other_tok, "").await;
    assert_eq!(s, StatusCode::OK, "바꾸기 전 다른 세션");
    let (s, b) = call(
        &base,
        Method::POST,
        "/auth/password",
        &me_tok,
        r#"{"currentPassword":"pw123456","newPassword":"newpassword123"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "비밀번호 변경: {b}");
    assert_ne!(
        hash_now().await.as_deref(),
        Some(pw_hash.as_str()),
        "해시가 그대로다"
    );
    let (s, _) = call(&base, Method::GET, "/auth/me", &me_tok, "").await;
    assert_eq!(s, StatusCode::OK, "바꾼 세션은 산다");
    let (s, b) = call(&base, Method::GET, "/auth/me", &other_tok, "").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "다른 세션은 끊긴다: {b}");
    assert_eq!(code(&b), "unauthorized", "다른 세션 code: {b}");
}
