//! 에이전트×기기 허용 표(`core::device_allow`)를 실제 Postgres 로 본다 — 쓰기 역할의 권한만으로 배정에 맞춰지는지, 개인 자격증명 규칙이
//! 읽을 때 적용되는지. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 맞추기·읽기는 그 역할(`DEVICE_ALLOW_PRIVILEGES` 만 더 가진 쓰기 역할)로 한다.
use harkroom_server::core::device_allow::{DEVICE_ALLOW_PRIVILEGES, list, sync_with};
use sqlx::PgPool;

async fn account(admin: &PgPool, kind: &str, tag: &str) -> String {
    sqlx::query_scalar(
        "insert into account (kind, handle, display_name, login_id) \
         values ($1, $2, $2, case when $1 = 'human' then $2 end) returning id::text",
    )
    .bind(kind)
    .bind(format!("da-{tag}-{}", &uuid_like()[..8]))
    .fetch_one(admin)
    .await
    .unwrap()
}

fn uuid_like() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{n:x}{:x}", std::process::id())
        .chars()
        .rev()
        .collect()
}

async fn operator(admin: &PgPool, owner: &str, tag: &str) -> String {
    sqlx::query_scalar(
        "insert into operator (owner_account_id, name, token_hash) values ($1::uuid, $2, $3) returning id::text",
    )
    .bind(owner)
    .bind(format!("da-{tag}"))
    .bind(format!("da-{tag}-{}", uuid_like()))
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn assign(admin: &PgPool, agent: &str, op: &str, by: &str) {
    sqlx::query(
        "insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1::uuid, $2::uuid, $3::uuid) \
         on conflict (agent_id) do update set operator_id = excluded.operator_id",
    )
    .bind(agent)
    .bind(op)
    .bind(by)
    .execute(admin)
    .await
    .unwrap();
}

#[tokio::test]
async fn follows_assignment_and_applies_the_personal_rule() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, DEVICE_ALLOW_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    let owner = account(&admin, "human", "owner").await;
    let other = account(&admin, "human", "other").await;
    let agent = account(&admin, "agent", "agent").await;
    let bystander = account(&admin, "agent", "by").await;
    let own_op = operator(&admin, &owner, "own").await;
    let foreign_op = operator(&admin, &other, "foreign").await;
    sqlx::query(
        "insert into agent_config (account_id, owner_account_id) values ($1::uuid, $2::uuid)",
    )
    .bind(&agent)
    .bind(&owner)
    .execute(&admin)
    .await
    .unwrap();

    // 배정 없음 → 줄 없음.
    sync_with(&w, Some(&agent)).await.unwrap();
    assert!(list(&w, &agent).await.unwrap().is_empty());

    // 배정 → 한 줄. 다시 맞춰도 한 줄이다.
    assign(&admin, &agent, &foreign_op, &owner).await;
    assign(&admin, &bystander, &own_op, &owner).await;
    sync_with(&w, Some(&agent)).await.unwrap();
    sync_with(&w, Some(&agent)).await.unwrap();
    let rows = list(&w, &agent).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["operatorId"], foreign_op.as_str());
    assert_eq!(rows[0]["addedBy"], owner.as_str());
    assert_eq!(rows[0]["effective"], true);
    // 한 에이전트만 맞추면 다른 에이전트의 줄은 건드리지 않는다(아직 없다).
    assert!(list(&w, &bystander).await.unwrap().is_empty());

    // 개인 자격증명이 되면 남의 기기 줄은 유효하지 않게 읽힌다(줄은 그대로).
    sqlx::query(
        "update agent_config set credential_scope = 'personal' where account_id = $1::uuid",
    )
    .bind(&agent)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(list(&w, &agent).await.unwrap()[0]["effective"], false);

    // 소유자 기기로 옮기면 옛 줄이 빠지고 새 줄이 유효하다.
    assign(&admin, &agent, &own_op, &owner).await;
    sync_with(&w, Some(&agent)).await.unwrap();
    let rows = list(&w, &agent).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["operatorId"], own_op.as_str());
    assert_eq!(rows[0]["effective"], true);

    // 회수된 오퍼레이터의 줄은 유효하지 않다.
    sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
        .bind(&own_op)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(list(&w, &agent).await.unwrap()[0]["effective"], false);

    // 전체 맞추기 — 다른 에이전트의 줄도 채우고, 배정이 지워진 줄은 지운다.
    sqlx::query("delete from agent_assignment where agent_id = $1::uuid")
        .bind(&agent)
        .execute(&admin)
        .await
        .unwrap();
    sync_with(&w, None).await.unwrap();
    assert!(list(&w, &agent).await.unwrap().is_empty());
    assert_eq!(list(&w, &bystander).await.unwrap().len(), 1);
}
