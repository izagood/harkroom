//! 백그라운드 회차 닫기(`loops::bg`)가 TS `bgJobs.ts` 의 `close` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`BG_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_BG_DUAL` 이 있으면 이중 실행 모드 — TS 가 깔아 둔 일감을 TS 와 **동시에** 닫아 닫은 수만 찍는다(판정은 TS 쪽).
use harkroom_server::loops::bg::{BG_PRIVILEGES, close};
use harkroom_server::loops::{GateResult, Side, run_gated};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

/// 닫힐 조건에 걸린 줄 수(전체) — TS 와 Rust 가 다 닫았는지 본다.
async fn closable(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from bg_job where (status = 'running' and claimed_at < now() - interval '15 minutes') \
            or (status = 'queued' and day < (now() at time zone 'Asia/Seoul')::date)",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn bg_close_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-bg-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, BG_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if std::env::var("HARKROOM_BG_DUAL").is_ok() {
        // 기다리지 않는다 — TS 는 이 연결을 보고 시작한다.
        let (mut t, mut e) = (0u64, 0u64);
        let mut overlapped = 0u64;
        loop {
            let before = closable(&admin).await;
            let (a, b) = close(&w).await.unwrap();
            t += a;
            e += b;
            if before > 0 {
                overlapped += 1;
            }
            if a + b == 0 && closable(&admin).await == 0 {
                break;
            }
        }
        println!("bg-dual rust timeout {t} expired {e} overlapped {overlapped}");
        return;
    }

    let acct: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('bg_rs', 'bg_rs', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    // 닫힐 것: 20분 전에 집은 running · 어제(KST) queued. 남을 것: 5분 전에 집은 running · 오늘(KST) queued · 옛 done.
    let ins = |kind: &'static str,
               day: &'static str,
               status: &'static str,
               claimed: &'static str| {
        let admin = admin.clone();
        let acct = acct.clone();
        async move {
            let sql = format!(
                "insert into bg_job (account_id, kind, day, status, claimed_at) values ($1::uuid, $2, {day}, $3, {claimed}) returning id::text"
            );
            let id: String = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                .bind(&acct)
                .bind(kind)
                .bind(status)
                .fetch_one(&admin)
                .await
                .unwrap();
            id
        }
    };
    let today = "(now() at time zone 'Asia/Seoul')::date";
    let yesterday = "(now() at time zone 'Asia/Seoul')::date - 1";
    let stale = ins("distill", today, "running", "now() - interval '20 minutes'").await;
    let fresh = ins("cleanup", today, "running", "now() - interval '5 minutes'").await;
    let old = ins("organize", yesterday, "queued", "null").await;
    let now_q = ins("distill", yesterday, "done", "null").await;
    let todays = ins("organize", today, "queued", "null").await;

    let (t, e) = close(&w).await.unwrap();
    assert_eq!((t, e), (1, 1));
    let rows: Vec<(String, String, Option<String>, bool)> = sqlx::query_as(
        "select id::text, status, error, finished_at is not null from bg_job where account_id = $1::uuid",
    )
    .bind(&acct)
    .fetch_all(&admin)
    .await
    .unwrap();
    let get = |id: &str| rows.iter().find(|r| r.0 == id).unwrap().clone();
    assert_eq!(get(&stale).1, "failed");
    assert_eq!(get(&stale).2.as_deref(), Some("timeout"));
    assert!(get(&stale).3);
    assert_eq!(get(&old).1, "skipped");
    assert_eq!(get(&old).2.as_deref(), Some("expired"));
    assert_eq!(get(&fresh).1, "running");
    assert_eq!(get(&todays).1, "queued");
    assert_eq!(get(&now_q).1, "done");
    // 다시 돌려도 아무것도 안 한다.
    assert_eq!(close(&w).await.unwrap(), (0, 0));

    // C5 조건 — 문지기 풀 1·sweep 풀 1 에서도 돈다.
    let stale2 = ins(
        "cleanup",
        "(now() at time zone 'Asia/Seoul')::date - 2",
        "running",
        "now() - interval '30 minutes'",
    )
    .await;
    let one = || {
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&write_url)
    };
    let (gate1, work1) = (one().await.unwrap(), one().await.unwrap());
    let r = run_gated(&gate1, "bg", Side::Ts, || async {
        close(&work1).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    let st: String = sqlx::query_scalar("select status from bg_job where id = $1::uuid")
        .bind(&stale2)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(st, "failed");
}
