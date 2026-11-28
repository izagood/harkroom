//! CR1 — 실행 자격 줄·에이전트 허용 목록·「설정함」 표지의 쓰기 권한과 표 제약을 실제 스키마에서 본다
//! (`core/exec_credential.rs`, migration 205). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::{Account, Auth, Via};
use harkroom_server::core::exec_combo::{self as ec, ComboError, KeyLinkInput};
use harkroom_server::core::exec_credential::{self as xc, CredentialInput};
use serde_json::{Value, json};
use sqlx::PgPool;

async fn mk(pool: &PgPool, handle: &str, kind: &str, role: &str) -> Account {
    let is_admin = matches!(role, "owner" | "admin");
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, $3, $4) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .bind(role)
    .bind(is_admin)
    .fetch_one(pool)
    .await
    .unwrap();
    Account {
        id,
        handle: handle.into(),
        display_name: handle.into(),
        kind: kind.into(),
        is_admin,
        role: role.into(),
        status: "online".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

async fn agent(pool: &PgPool, handle: &str, owner: &Account) -> Account {
    let a = mk(pool, handle, "agent", "member").await;
    sqlx::query(
        "insert into agent_config(account_id, owner_account_id) values ($1::uuid, $2::uuid)",
    )
    .bind(&a.id)
    .bind(&owner.id)
    .execute(pool)
    .await
    .unwrap();
    a
}

async fn secret(pool: &PgPool, name: &str, owner: &Account) -> String {
    sqlx::query_scalar(
        "insert into secret(name, kind, owner_account_id) values ($1, 'text', $2::uuid) returning id::text",
    )
    .bind(name)
    .bind(&owner.id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn operator(pool: &PgPool, name: &str, owner: &Account) -> String {
    sqlx::query_scalar(
        "insert into operator (owner_account_id, name, token_hash) values ($1::uuid, $2, $2) returning id::text",
    )
    .bind(&owner.id)
    .bind(name)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn session() -> Auth {
    Auth {
        via: Some(Via::Session),
        ..Auth::default()
    }
}

fn key_input(name: &str, link: &str) -> CredentialInput {
    CredentialInput::parse(&json!({
        "name": name, "kind": "key", "keyLinkId": link, "harnesses": ["claude-code", "codex"]
    }))
    .unwrap()
}

fn pool_input(name: &str, operator_id: &str, harness: &str, pool_name: &str) -> CredentialInput {
    CredentialInput::parse(&json!({
        "name": name, "kind": "pool", "operatorId": operator_id, "harness": harness, "poolName": pool_name
    }))
    .unwrap()
}

fn by_name<'a>(rows: &'a [Value], name: &str) -> &'a Value {
    rows.iter()
        .find(|r| r["name"] == name)
        .unwrap_or_else(|| panic!("no row {name}"))
}

async fn local_id(pool: &PgPool) -> String {
    sqlx::query_scalar("select id::text from exec_credential where kind = 'local'")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn exec_credential_writes_and_permissions() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let s = session();
    let admin = mk(&pool, "xr-admin", "human", "admin").await;
    let admin2 = mk(&pool, "xr-admin2", "human", "admin").await;
    let member = mk(&pool, "xr-member", "human", "member").await;
    let bot = agent(&pool, "xr-bot", &member).await;
    let admin_key = secret(&pool, "xr-admin-key", &admin).await;
    let link = ec::create_key_link(
        &pool,
        &admin,
        &s,
        &KeyLinkInput::parse(&json!({
            "name": "xr-link", "baseUrl": "https://api.example.com/v1", "secretId": admin_key
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let member_op = operator(&pool, "xr-member-op", &member).await;
    let admin_op = operator(&pool, "xr-admin-op", &admin).await;

    // ① 심어 둔 로컬 줄은 하나뿐이고, 더 만들 수 없다(표 제약).
    let local = local_id(&pool).await;
    assert!(
        sqlx::query("insert into exec_credential(name, kind) values ('xr-local-2', 'local')")
            .execute(&pool)
            .await
            .is_err()
    );

    // ② 키 줄 — 그 비밀의 소유자인 관리자만 만든다. 다른 관리자·일반 사람·에이전트·오퍼레이터 토큰은 거절.
    assert!(matches!(
        xc::create_credential(&pool, &admin2, &s, &key_input("xr-key", &link)).await,
        Err(ComboError::Forbidden)
    ));
    assert!(matches!(
        xc::create_credential(&pool, &member, &s, &key_input("xr-key", &link)).await,
        Err(ComboError::Forbidden)
    ));
    assert!(matches!(
        xc::create_credential(&pool, &bot, &s, &key_input("xr-key", &link)).await,
        Err(ComboError::Forbidden)
    ));
    let via_operator = Auth {
        via: Some(Via::Operator),
        ..Auth::default()
    };
    assert!(matches!(
        xc::create_credential(&pool, &admin, &via_operator, &key_input("xr-key", &link)).await,
        Err(ComboError::Forbidden)
    ));
    let key = xc::create_credential(&pool, &admin, &s, &key_input("xr-key", &link))
        .await
        .unwrap();
    // 같은 키 연결로 줄을 하나 더 만들 수 없다.
    assert!(matches!(
        xc::create_credential(&pool, &admin, &s, &key_input("xr-key-2", &link)).await,
        Err(ComboError::Conflict)
    ));
    // 자격 줄이 쓰는 키 연결은 지울 수 없다.
    assert!(matches!(
        ec::delete_key_link(&pool, &admin, &s, &link).await,
        Err(ComboError::Conflict)
    ));

    // ③ 풀 줄 — 그 오퍼레이터의 소유자만 만든다. 관리자라도 남의 기기 풀은 못 만든다.
    assert!(matches!(
        xc::create_credential(
            &pool,
            &admin,
            &s,
            &pool_input("xr-pool", &member_op, "claude-code", "main")
        )
        .await,
        Err(ComboError::Forbidden)
    ));
    let pool_cred = xc::create_credential(
        &pool,
        &member,
        &s,
        &pool_input("xr-pool", &member_op, "claude-code", "main"),
    )
    .await
    .unwrap();
    // 같은 이름의 풀이라도 기기가 다르면 다른 줄이다. 같은 (기기, 하네스, 이름)은 겹친다.
    let admin_pool = xc::create_credential(
        &pool,
        &admin,
        &s,
        &pool_input("xr-pool-admin", &admin_op, "claude-code", "main"),
    )
    .await
    .unwrap();
    assert_ne!(pool_cred, admin_pool);
    assert!(matches!(
        xc::create_credential(
            &pool,
            &member,
            &s,
            &pool_input("xr-pool-dup", &member_op, "claude-code", "main")
        )
        .await,
        Err(ComboError::Conflict)
    ));
    // 폐기된 오퍼레이터에는 못 만든다.
    let dead_op = operator(&pool, "xr-dead-op", &member).await;
    sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
        .bind(&dead_op)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        xc::create_credential(
            &pool,
            &member,
            &s,
            &pool_input("xr-pool-dead", &dead_op, "codex", "main")
        )
        .await,
        Err(ComboError::Forbidden)
    ));

    // ④ 목록 — 풀 이름·오퍼레이터 id 는 그 기기 소유자와 관리자에게만 실린다.
    let outsider = mk(&pool, "xr-outsider", "human", "member").await;
    let seen = xc::list_credentials(&pool, &outsider, &s).await.unwrap();
    let row = by_name(&seen, "xr-pool");
    assert_eq!(row["kind"], "pool");
    assert_eq!(row["poolName"], Value::Null);
    assert_eq!(row["operatorId"], Value::Null);
    let seen = xc::list_credentials(&pool, &member, &s).await.unwrap();
    assert_eq!(by_name(&seen, "xr-pool")["poolName"], "main");
    assert_eq!(by_name(&seen, "xr-pool-admin")["poolName"], Value::Null);
    let seen = xc::list_credentials(&pool, &admin, &s).await.unwrap();
    assert_eq!(by_name(&seen, "xr-pool")["poolName"], "main");
    assert_eq!(by_name(&seen, "xr-key")["usable"], true);
    assert_eq!(by_name(&seen, "local")["kind"], "local");
    assert!(xc::list_credentials(&pool, &bot, &s).await.is_err());

    // ⑤ 허용 목록 — 에이전트 소유자만. 처음에는 「설정 안 함」이다.
    let (configured, rows) = xc::list_allowed(&pool, &member, &s, &bot.id).await.unwrap();
    assert!(!configured && rows.is_empty());
    assert_eq!(xc::empty_list(configured), xc::EmptyList::Local);
    assert!(matches!(
        xc::allow_add(&pool, &admin, &s, &bot.id, &key).await,
        Err(ComboError::Forbidden)
    ));
    // 거절된 넣기는 표지를 세우지 않는다.
    let (configured, _) = xc::list_allowed(&pool, &member, &s, &bot.id).await.unwrap();
    assert!(!configured);
    xc::allow_add(&pool, &member, &s, &bot.id, &key)
        .await
        .unwrap();
    xc::allow_add(&pool, &member, &s, &bot.id, &pool_cred)
        .await
        .unwrap();
    xc::allow_add(&pool, &member, &s, &bot.id, &pool_cred)
        .await
        .unwrap();
    let (configured, rows) = xc::list_allowed(&pool, &member, &s, &bot.id).await.unwrap();
    assert!(configured);
    assert_eq!(rows.len(), 2);

    // ⑥ 기본 — 허용 목록에 있는 줄만, 에이전트당 하나.
    assert!(matches!(
        xc::set_default(&pool, &member, &s, &bot.id, &local).await,
        Err(ComboError::Forbidden)
    ));
    xc::set_default(&pool, &member, &s, &bot.id, &key)
        .await
        .unwrap();
    xc::set_default(&pool, &member, &s, &bot.id, &pool_cred)
        .await
        .unwrap();
    let defaults: Vec<String> = sqlx::query_scalar(
        "select credential_id::text from agent_exec_credential where agent_id = $1::uuid and is_default",
    )
    .bind(&bot.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(defaults, vec![pool_cred.clone()]);
    assert!(matches!(
        xc::set_default(&pool, &admin, &s, &bot.id, &key).await,
        Err(ComboError::Forbidden)
    ));

    // ⑦ 못 쓰는 줄은 목록에 남고 `usable: false` 다 — 비밀이 지워진 키 줄, 폐기된 오퍼레이터의 풀 줄.
    sqlx::query("delete from secret where id = $1::uuid")
        .bind(&admin_key)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
        .bind(&member_op)
        .execute(&pool)
        .await
        .unwrap();
    let (_, rows) = xc::list_allowed(&pool, &member, &s, &bot.id).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(by_name(&rows, "xr-key")["usable"], false);
    assert_eq!(by_name(&rows, "xr-pool")["usable"], false);

    // ⑧ 지우기 — 로컬은 아무도 못 지운다. 풀 줄은 남이 못 지운다. 줄이 지워져 목록이 비어도 표지는 남는다(막음).
    assert!(matches!(
        xc::delete_credential(&pool, &admin, &s, &local).await,
        Err(ComboError::Forbidden)
    ));
    assert!(matches!(
        xc::delete_credential(&pool, &outsider, &s, &pool_cred).await,
        Err(ComboError::Forbidden)
    ));
    assert!(matches!(
        xc::delete_credential(&pool, &member, &s, &key).await,
        Err(ComboError::Forbidden)
    ));
    // 비밀이 지워진 키 줄은 관리자 누구나 치운다.
    xc::delete_credential(&pool, &admin2, &s, &key)
        .await
        .unwrap();
    xc::delete_credential(&pool, &member, &s, &pool_cred)
        .await
        .unwrap();
    let (configured, rows) = xc::list_allowed(&pool, &member, &s, &bot.id).await.unwrap();
    assert!(rows.is_empty());
    assert!(configured, "cascade 로 비어도 「설정함」은 남는다");
    assert_eq!(xc::empty_list(configured), xc::EmptyList::Blocked);

    // ⑨ 로컬을 명시해 넣으면 다시 돌 수 있는 줄이 생긴다.
    xc::allow_add(&pool, &member, &s, &bot.id, &local)
        .await
        .unwrap();
    let (_, rows) = xc::list_allowed(&pool, &member, &s, &bot.id).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["kind"], "local");
    assert_eq!(rows[0]["usable"], true);
    xc::allow_remove(&pool, &member, &s, &bot.id, &local)
        .await
        .unwrap();
    assert!(matches!(
        xc::allow_remove(&pool, &member, &s, &bot.id, &local).await,
        Err(ComboError::Forbidden)
    ));

    // ⑩ 오퍼레이터 줄이 지워지면 풀 줄도 같이 지워진다(cascade).
    sqlx::query("delete from operator where id = $1::uuid")
        .bind(&admin_op)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        xc::delete_credential(&pool, &admin, &s, &admin_pool).await,
        Err(ComboError::NotFound)
    ));
}
