//! 보존 기간 정리 sweep(`loops::retention`)이 TS `retention.ts` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`RETENTION_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_RETENTION_DUAL=1` 이면 이중 실행 모드 — TS 가 깔아 둔 줄을 TS sweep 과 **동시에** 지워 지운 수만 찍는다(판정은 TS 쪽).
use harkroom_server::loops::retention::{
    RETENTION_BATCH, RETENTION_PRIVILEGES, Retention, delete_enabled,
};
use harkroom_server::loops::{GateResult, Side, run_gated};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

async fn old_sessions(pool: &PgPool, account: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from session where account_id = $1::uuid and expires_at < now() - interval '30 days'",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn retention_sweep_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-retention-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, RETENTION_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if let Ok(account) = std::env::var("HARKROOM_RETENTION_DUAL") {
        // 기다리지 않는다 — 한 배치가 몇 ms 라 TS 가 먼저 다 지우면 겹침을 보이지 못한다(TS 는 이 연결을 보고 시작한다).
        let mut st = Retention::new(true);
        let mut deleted = 0u64;
        // 지울 줄이 남아 있는 동안 돈 sweep 수 — TS 와 실제로 겹쳤다는 증거(둘이 같은 ctid 묶음을 고르므로 늦은 쪽은 줄 잠금을
        // 기다린 뒤 0 건일 수 있다. 그래도 겹친 것이고, 합이 정확한지가 판정이다).
        let mut overlapped = 0u64;
        loop {
            let before = old_sessions(&admin, &account).await;
            let out = st.sweep(&w, |_| {}).await.unwrap();
            let n: u64 = out.iter().map(|(_, d)| d).sum();
            deleted += n;
            if before > 0 {
                overlapped += 1;
            }
            if n == 0 && old_sessions(&admin, &account).await == 0 {
                break;
            }
        }
        println!("retention-dual rust deleted {deleted} overlapped {overlapped}");
        return;
    }

    // 스위치는 정확히 "1" 일 때만.
    assert!(delete_enabled(Some("1")));
    for v in [None, Some(""), Some("true"), Some("0"), Some(" 1")] {
        assert!(!delete_enabled(v), "{v:?}");
    }

    let acct: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('ret_rs', 'ret_rs', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('ret-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let msg: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'r', 'user') returning id::text",
    )
    .bind(&ch)
    .bind(&acct)
    .fetch_one(&admin)
    .await
    .unwrap();
    // 지울 것: 만료 31일 지난 세션 1200(배치 1000 을 넘김)·8일 된 키 3. 남길 것: 만료 29일 세션·만료 전 세션·6일 된 키.
    sqlx::query(
        "insert into session(token_hash, account_id, expires_at) \
         select 'ret-old-' || g, $1::uuid, now() - interval '31 days' from generate_series(1, 1200) g",
    )
    .bind(&acct)
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into session(token_hash, account_id, expires_at) values \
         ('ret-keep-29', $1::uuid, now() - interval '29 days'), ('ret-keep-live', $1::uuid, now() + interval '1 day')",
    )
    .bind(&acct)
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into idempotency_key(key, message_id, author_id, channel_id, created_at) \
         select 'ret-old-' || g, $1::uuid, $2::uuid, $3::uuid, now() - interval '8 days' from generate_series(1, 3) g \
         union all select 'ret-keep', $1::uuid, $2::uuid, $3::uuid, now() - interval '6 days'",
    )
    .bind(&msg)
    .bind(&acct)
    .bind(&ch)
    .execute(&admin)
    .await
    .unwrap();

    // 꺼짐: 세기만, 매번 센다.
    let mut off = Retention::new(false);
    for _ in 0..2 {
        let mut logs = vec![];
        let out = off.sweep(&w, |m| logs.push(m)).await.unwrap();
        assert_eq!(out, vec![("idempotency_key", 0), ("session", 0)]);
        assert_eq!(
            logs,
            vec![
                "retention: idempotency_key eligible=3 (dry-run)".to_string(),
                "retention: session eligible=1200 (dry-run)".to_string(),
            ]
        );
    }
    assert_eq!(old_sessions(&admin, &acct).await, 1200);

    // 켜짐: 첫 sweep 은 지우기 전에 한 번 세고, 배치만큼만 지운다.
    let mut on = Retention::new(true);
    let mut logs = vec![];
    let out = on.sweep(&w, |m| logs.push(m)).await.unwrap();
    assert_eq!(
        out,
        vec![("idempotency_key", 3), ("session", RETENTION_BATCH as u64)]
    );
    assert_eq!(
        logs,
        vec![
            "retention: idempotency_key eligible=3 (before deleting)".to_string(),
            "retention: session eligible=1200 (before deleting)".to_string(),
            "retention: idempotency_key deleted=3".to_string(),
            format!("retention: session deleted={RETENTION_BATCH}"),
        ]
    );
    let mut logs = vec![];
    let out = on.sweep(&w, |m| logs.push(m)).await.unwrap();
    assert_eq!(out, vec![("idempotency_key", 0), ("session", 200)]);
    assert_eq!(logs, vec!["retention: session deleted=200".to_string()]);

    let kept: Vec<String> = sqlx::query_scalar(
        "select token_hash from session where account_id = $1::uuid order by token_hash",
    )
    .bind(&acct)
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(kept, vec!["ret-keep-29", "ret-keep-live"]);
    let keys: Vec<String> =
        sqlx::query_scalar("select key from idempotency_key where key like 'ret-%' order by key")
            .fetch_all(&admin)
            .await
            .unwrap();
    assert_eq!(keys, vec!["ret-keep"]);

    // C5 조건 — 문지기 풀과 sweep 풀이 각각 연결 하나뿐이어도 sweep 이 돈다(잠금 연결을 쥔 채 같은 풀에서 빌리지 않는다).
    sqlx::query(
        "insert into session(token_hash, account_id, expires_at) \
         select 'ret-gated-' || g, $1::uuid, now() - interval '31 days' from generate_series(1, 5) g",
    )
    .bind(&acct)
    .execute(&admin)
    .await
    .unwrap();
    let one = || {
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&write_url)
    };
    let (gate1, work1) = (one().await.unwrap(), one().await.unwrap());
    let mut st = Retention::new(true);
    let r = run_gated(&gate1, "retention", Side::Ts, || async {
        st.sweep(&work1, |_| {}).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    assert_eq!(old_sessions(&admin, &acct).await, 0);
}
