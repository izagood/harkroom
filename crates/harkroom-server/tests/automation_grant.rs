//! MCP `automation.propose` 의 Rust INSERT 가 **`AUTOMATION_PROPOSE_PRIVILEGES` 의 칸 단위 GRANT 만으로** 도는지 실제 Postgres 로 본다.
//! 대조(`contrast`)의 쓰기 역할은 `pg_read_all_data` 를 가져 `returning *` 같은 넓은 SELECT 를 가린다 — 여기서는 그것 없이
//! GRANT 목록만 가진 역할로 돌린다. 수신 비밀 칸(`ingress_token_hash`·`ingress_secret_enc`)을 읽는 문장이면 빨개진다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
use harkroom_server::core::mcp::automation_propose::{AUTOMATION_PROPOSE_PRIVILEGES, insert_sql};
use sqlx::{PgPool, Row};

async fn run_as(
    admin: &PgPool,
    role: &str,
    sql: &str,
    owner: &str,
    ch: &str,
) -> Result<String, sqlx::Error> {
    let mut tx = admin.begin().await?;
    sqlx::query(sqlx::AssertSqlSafe(format!("set local role {role}")))
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(owner)
        .bind(owner)
        .bind(ch)
        .bind("grant probe")
        .bind("body")
        .bind(r#"{"kind":"webhook"}"#)
        .bind(None::<i32>)
        .fetch_one(&mut *tx)
        .await?;
    let id: String = row.try_get("id")?;
    tx.rollback().await?;
    Ok(id)
}

#[tokio::test]
async fn propose_insert_runs_with_column_grants_only() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let owner: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('ag_owner', 'ag_owner', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('ag-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    // GRANT 목록만 가진 역할 — pg_read_all_data 없음. 롤은 클러스터 단위다(시험 DB 는 템플릿 복제라
    // 클러스터를 같이 쓴다) — 같은 클러스터에서 다시 돌아도 부딪히지 않게 이 실행의 채널 id 로 이름을 가른다.
    let role = format!("ap_gp_{}", ch.replace('-', ""));
    let role = role.as_str();
    sqlx::query(sqlx::AssertSqlSafe(format!("create role {role} nologin")))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "grant usage on schema public to {role}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    for (col, privilege) in AUTOMATION_PROPOSE_PRIVILEGES {
        let (table, column) = col.split_once('.').expect("표.칸");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "grant {privilege} ({column}) on {table} to {role}"
        )))
        .execute(&admin)
        .await
        .unwrap();
    }
    for secret in ["ingress_token_hash", "ingress_secret_enc"] {
        let can: bool =
            sqlx::query_scalar("select has_column_privilege($1, 'automation', $2, 'SELECT')")
                .bind(role)
                .bind(secret)
                .fetch_one(&admin)
                .await
                .unwrap();
        assert!(!can, "{secret} 는 SELECT 를 주지 않는다");
    }

    // Rust 가 실제로 보내는 문장은 이 GRANT 만으로 돈다.
    let id = run_as(&admin, role, insert_sql(), &owner, &ch)
        .await
        .expect("칸 단위 GRANT 만으로 INSERT·returning 이 돈다");
    assert_eq!(id.len(), 36);

    // 같은 문장을 `returning *` 로 바꾸면 비밀 칸 SELECT 가 없어 막힌다 — 이 시험이 그 차이를 잡는다는 바닥.
    let star = insert_sql().replace(
        &format!("returning {})", "id, owner_id, channel_id, name, body, trigger, enabled, next_at, paused_reason, consecutive_failures, ingress_enabled_at, debounce_sec, proposed_by, approved_at, created_at, updated_at"),
        "returning *)",
    );
    assert!(star.contains("returning *)"));
    let e = run_as(&admin, role, &star, &owner, &ch)
        .await
        .expect_err("returning * 는 막혀야 한다");
    assert!(e.to_string().contains("permission denied"), "{e}");

    let left: i64 =
        sqlx::query_scalar("select count(*) from automation where name = 'grant probe'")
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(left, 0, "시험 INSERT 는 되돌린다");
    println!("automation.propose: 칸 단위 GRANT 만으로 통과, returning * 는 permission denied");
}
