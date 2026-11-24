//! Q1 판정이 읽는 문장([`HELD_SQL`])을 실제 Postgres 틀에 대 본다 — 표·칸 이름이 틀리면 여기서 빨개진다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
use harkroom_server::core::self_serve::{HELD_READ_PRIVILEGES, Held, read_held};
use sqlx::PgPool;

#[tokio::test]
async fn held_sql_runs_against_real_schema() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&pool, HELD_READ_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    // 아무것도 받지 않은 계정 — 빈 결과(문장이 틀에 맞게 돈다).
    let held = read_held(
        &pool,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
    )
    .await
    .unwrap();
    assert_eq!(held, Held::default());
}
