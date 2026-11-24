//! 매일 기억 정리(`loops::memory_daily`) — 넣기·건너뛰기·끄기·집기·닫기를 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
use harkroom_server::core::mcp::bg_claim::claim;
use harkroom_server::loops::memory_daily::{
    MEMORY_DAILY_PRIVILEGES, SPREAD_SECS, produce, produce_for,
};
use sqlx::PgPool;

async fn agent(p: &PgPool, handle: &str, harness: &str, on: bool) -> String {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(handle)
    .fetch_one(p)
    .await
    .unwrap();
    sqlx::query(
        "insert into agent_config (account_id, harness, memory_cleanup_on) values ($1::uuid, $2, $3) \
         on conflict (account_id) do update set harness = excluded.harness, memory_cleanup_on = excluded.memory_cleanup_on",
    )
    .bind(&id)
    .bind(harness)
    .bind(on)
    .execute(p)
    .await
    .unwrap();
    sqlx::query("insert into agent_memory (account_id, slug, value, description, kind) values ($1::uuid, 'mem/a/b', 'v', 'd', 'topic')")
        .bind(&id)
        .execute(p)
        .await
        .unwrap();
    id
}

async fn jobs(p: &PgPool, id: &str) -> i64 {
    sqlx::query_scalar("select count(*) from bg_job where account_id = $1::uuid")
        .bind(id)
        .fetch_one(p)
        .await
        .unwrap()
}

#[tokio::test]
async fn daily_cleanup_runs_once_and_skips_idle() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let p = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, MEMORY_DAILY_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    // 켜짐·하네스·끄기.
    let on = agent(&p, "md_on", "claude-code", true).await;
    let off = agent(&p, "md_off", "claude-code", false).await;
    let codex = agent(&p, "md_codex", "codex", true).await;
    let now: f64 = sqlx::query_scalar("select extract(epoch from now())::float8")
        .fetch_one(&p)
        .await
        .unwrap();
    let (d1, d2, d3) = ("2026-01-01", "2026-01-02", "2026-01-03");
    assert_eq!(produce_for(&w, d1, now).await.unwrap(), 1);
    assert_eq!(produce_for(&w, d1, now).await.unwrap(), 0); // 하루 한 번
    assert_eq!(
        (
            jobs(&p, &on).await,
            jobs(&p, &off).await,
            jobs(&p, &codex).await
        ),
        (1, 0, 0)
    );
    // 흩기 — 시각부터 SPREAD 안.
    let late: f64 = sqlx::query_scalar(
        "select extract(epoch from not_before)::float8 - $2 from bg_job where account_id = $1::uuid",
    )
    .bind(&on)
    .bind(now)
    .fetch_one(&p)
    .await
    .unwrap();
    assert!(
        (-1.0..f64::from(SPREAD_SECS) + 1.0).contains(&late),
        "{late}"
    );

    // 집기 — 아직 때가 아니면 없고, 때가 되면 전역 스위치가 꺼져 있어도 낮에도 집힌다.
    let noon = 1_794_754_800_000 + 12 * 3_600_000;
    sqlx::query("update bg_job set not_before = now() + interval '1 hour'")
        .execute(&p)
        .await
        .unwrap();
    assert!(
        claim(&p, &p, &on, noon, false)
            .await
            .unwrap()
            .contains("none")
    );
    sqlx::query("update bg_job set not_before = now() - interval '1 hour'")
        .execute(&p)
        .await
        .unwrap();
    let got = claim(&p, &p, &on, noon, false).await.unwrap();
    assert!(got.contains("cleanup") && got.contains("daily"), "{got}");
    assert!(
        claim(&p, &p, &on, noon, false)
            .await
            .unwrap()
            .contains("none")
    );

    // 건너뛰기 — 끝난 정리 뒤 쓰기가 없으면 넣지 않고, 쓰기가 생기면 넣는다.
    sqlx::query("update bg_job set status = 'done', finished_at = now()")
        .execute(&p)
        .await
        .unwrap();
    assert_eq!(produce_for(&w, d2, now).await.unwrap(), 0);
    sqlx::query("update agent_memory set updated_at = now() + interval '1 second' where account_id = $1::uuid")
        .bind(&on)
        .execute(&p)
        .await
        .unwrap();
    assert_eq!(produce_for(&w, d3, now).await.unwrap(), 1);

    // 24시간 넘게 안 집힌 것은 닫힌다.
    sqlx::query(
        "update bg_job set not_before = now() - interval '25 hours' where status = 'queued'",
    )
    .execute(&p)
    .await
    .unwrap();
    assert!(
        claim(&p, &p, &on, noon, true)
            .await
            .unwrap()
            .contains("none")
    );
    assert_eq!(harkroom_server::loops::bg::close(&p).await.unwrap().1, 1);

    // 워크스페이스 설정 — 지금 시각이면 오늘 것이 서고, 끄면 아무것도 안 한다.
    sqlx::query("delete from bg_job").execute(&p).await.unwrap();
    sqlx::query("update workspace_profile set memory_cleanup_tz = 'UTC', memory_cleanup_time = ((now() at time zone 'UTC') - interval '1 minute')::time")
        .execute(&p)
        .await
        .unwrap();
    assert_eq!(produce(&w).await.unwrap(), 1);
    sqlx::query("delete from bg_job").execute(&p).await.unwrap();
    sqlx::query("update workspace_profile set memory_cleanup_time = ((now() at time zone 'UTC') - interval '5 hours')::time")
        .execute(&p)
        .await
        .unwrap();
    assert_eq!(produce(&w).await.unwrap(), 0);
    sqlx::query("update workspace_profile set memory_cleanup_on = false, memory_cleanup_time = ((now() at time zone 'UTC') - interval '1 minute')::time")
        .execute(&p)
        .await
        .unwrap();
    assert_eq!(produce(&w).await.unwrap(), 0);

    // 설정 저장 — 어느 칸이 틀렸는지 코드로 가른다.
    use harkroom_server::core::agent_memory_write::schedule_error;
    for (time, tz, want) in [
        ("03:00", "Asia/Seoul", None),
        ("3:00", "Asia/Seoul", Some("bad_time")),
        ("03:00", "Asia/Seol", Some("bad_tz")),
        ("24:00", "Asia/Seol", Some("bad_time")),
    ] {
        assert_eq!(
            schedule_error(&p, time, tz).await.unwrap(),
            want,
            "{time} {tz}"
        );
    }
}
