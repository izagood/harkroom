//! 마이그레이션 실행기(`migrate.rs`, S5.4 M1)가 TS `migrate.ts` 와 같이 도는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! 시험마다 새 스키마를 만들어 `search_path` 로 가둔다 — 진짜 `schema_migrations` 는 건드리지 않는다.
//! advisory 잠금은 DB 단위라 이 파일의 시험이 병렬로 돌면 서로의 잠금을 본다 — 시험마다 [`serial`] 로 한 줄로 세운다.
use harkroom_server::migrate::{self, MIGRATION_LOCK_KEY};
use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions, PgConnection};
use std::str::FromStr;
use std::time::Duration;

async fn fresh(url: &str) -> (PgConnectOptions, String) {
    let schema = format!(
        "mig_{}",
        hex::encode(getrandom::u64().unwrap().to_be_bytes())
    );
    let mut admin = PgConnectOptions::from_str(url)
        .unwrap()
        .connect()
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .execute(&mut admin)
        .await
        .unwrap();
    let opts = PgConnectOptions::from_str(url)
        .unwrap()
        .options([("search_path", schema.as_str())]);
    (opts, schema)
}

async fn names(c: &mut PgConnection) -> Vec<String> {
    sqlx::query_scalar("select name from schema_migrations order by name")
        .fetch_all(c)
        .await
        .unwrap()
}

fn quiet(_: &str) {}

/// 이 파일의 시험을 한 줄로 세운다. 실행기 키와 다른 advisory 키를 이 연결이 쥐고, 연결이 닫히면(시험 끝) 풀린다.
/// 없으면 한 시험이 쥔 실행기 잠금을 다른 시험이 「잠금이 안 풀렸다」·「바로 적용됐다」로 잘못 읽는다.
async fn serial(url: &str) -> PgConnection {
    let mut c = PgConnectOptions::from_str(url)
        .unwrap()
        .connect()
        .await
        .unwrap();
    // 막는 `pg_advisory_lock` 으로 기다리면 그 문장이 열린 스냅숏이 되어 `create index concurrently` 시험이 그것을
    // 기다린다(교착). 실행기와 같이 try 로 두드린다.
    while !sqlx::query_scalar::<_, bool>("select pg_try_advisory_lock($1)")
        .bind(0x6d69_6774_6573_7473_i64)
        .fetch_one(&mut c)
        .await
        .unwrap()
    {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    c
}

macro_rules! db_url {
    () => {
        match std::env::var("HARKROOM_TEST_DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
                return;
            }
        }
    };
}

#[tokio::test]
async fn applies_pending_in_order_and_records_rows() {
    let url = db_url!();
    let _serial = serial(&url).await;
    let (opts, _) = fresh(&url).await;
    let mut c = opts.connect().await.unwrap();
    // 일부러 뒤섞어 넘긴다 — 이름 순으로 돌아야 002 가 001 의 표에 넣을 수 있다.
    let files = [
        (
            "002_b.sql",
            "insert into seq (n) values (2);\ncreate table lt as select current_setting('lock_timeout') as v;",
        ),
        (
            "001_a.sql",
            "create table seq (n int, at timestamptz default clock_timestamp());\ninsert into seq (n) values (1);",
        ),
    ];
    let applied = migrate::run(&mut c, &files, Duration::from_secs(30), &quiet)
        .await
        .unwrap();
    assert_eq!(applied, vec!["001_a.sql", "002_b.sql"]);
    assert_eq!(names(&mut c).await, vec!["001_a.sql", "002_b.sql"]);
    let order: Vec<i32> = sqlx::query_scalar("select n from seq order by at")
        .fetch_all(&mut c)
        .await
        .unwrap();
    assert_eq!(order, vec![1, 2]);
    // 트랜잭션 파일은 `set local lock_timeout = '5s'` 안에서 돈다(TS 와 같다) — 끝나면 풀린다.
    let lt: String = sqlx::query_scalar("select v from lt")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(lt, "5s");
    let after: String = sqlx::query_scalar("select current_setting('lock_timeout')")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(after, "0");
    // 세션 잠금은 끝나면 풀려 있다 — 이 연결이 쥔 advisory 잠금이 없다.
    // (`pg_try_advisory_lock` 으로 보면 같은 DB 에서 병렬로 도는 다른 시험이 쥔 잠금에 걸려 흔들린다.)
    let held: bool = sqlx::query_scalar(
        "select exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() \
         and objid = ($1::bigint & x'ffffffff'::bigint)::oid)",
    )
    .bind(MIGRATION_LOCK_KEY)
    .fetch_one(&mut c)
    .await
    .unwrap();
    assert!(!held);
}

#[tokio::test]
async fn skips_already_applied_and_rolls_back_failures() {
    let url = db_url!();
    let _serial = serial(&url).await;
    let (opts, _) = fresh(&url).await;
    let mut c = opts.connect().await.unwrap();
    let first = [("001_a.sql", "create table t (x int);")];
    migrate::run(&mut c, &first, Duration::from_secs(30), &quiet)
        .await
        .unwrap();
    // 001 을 다시 돌리면 `create table` 이 깨진다 — 건너뛰어야 한다.
    let second = [
        ("001_a.sql", "create table t (x int);"),
        ("002_b.sql", "insert into t values (7);"),
    ];
    let applied = migrate::run(&mut c, &second, Duration::from_secs(30), &quiet)
        .await
        .unwrap();
    assert_eq!(applied, vec!["002_b.sql"]);
    // 깨진 트랜잭션 파일은 통째로 되돌리고 기록하지 않는다.
    let third = [(
        "003_c.sql",
        "insert into t values (8);\nselect * from no_such_table;",
    )];
    assert!(
        migrate::run(&mut c, &third, Duration::from_secs(30), &quiet)
            .await
            .is_err()
    );
    assert_eq!(names(&mut c).await, vec!["001_a.sql", "002_b.sql"]);
    let xs: Vec<i32> = sqlx::query_scalar("select x from t")
        .fetch_all(&mut c)
        .await
        .unwrap();
    assert_eq!(xs, vec![7]);
}

#[tokio::test]
async fn no_transaction_file_runs_outside_a_transaction() {
    let url = db_url!();
    let _serial = serial(&url).await;
    let (opts, _) = fresh(&url).await;
    let mut c = opts.connect().await.unwrap();
    // `create index concurrently` 는 트랜잭션 블록 안(여러 문장 한 질의 포함)에서 거절된다 — 통과하면 밖에서 돈 것이다.
    let files = [
        ("001_a.sql", "create table t (x int);"),
        (
            "002_idx.sql",
            "-- migrate: no-transaction\ndrop index concurrently if exists t_x;\ncreate index concurrently if not exists t_x\n  on t (x);",
        ),
    ];
    let applied = migrate::run(&mut c, &files, Duration::from_secs(30), &quiet)
        .await
        .unwrap();
    assert_eq!(applied, vec!["001_a.sql", "002_idx.sql"]);
    let valid: bool = sqlx::query_scalar(
        "select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid \
         where c.relname = 't_x' and c.relnamespace = current_schema()::regnamespace",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    assert!(valid);
    // 표지를 빼면 같은 파일은 거절된다(대조).
    let bad = [("003_idx.sql", "create index concurrently t_y on t (x);")];
    assert!(
        migrate::run(&mut c, &bad, Duration::from_secs(30), &quiet)
            .await
            .is_err()
    );
}

/// TS 실행기가 잠금을 쥐고 있는 것을 흉내 낸다 — 같은 키(0x6d726d72)를 다른 연결이 쥐면 Rust 실행기는 기다렸다가,
/// 놓인 **뒤에야** 표를 만들고 적용한다(롤링 업데이트에서 두 실행기가 한쪽씩 돈다).
#[tokio::test]
async fn waits_for_ts_runner_lock_then_runs_serially() {
    let url = db_url!();
    let _serial = serial(&url).await;
    let (opts, schema) = fresh(&url).await;
    let mut holder = opts.connect().await.unwrap();
    sqlx::query("select pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut holder)
        .await
        .unwrap();

    let logs = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let logs2 = logs.clone();
    let runner_opts = opts.clone();
    let task = tokio::spawn(async move {
        let mut c = runner_opts.connect().await.unwrap();
        let files = [(
            "001_a.sql",
            "create table ran (at timestamptz default clock_timestamp());\ninsert into ran default values;",
        )];
        let log = move |m: &str| logs2.lock().unwrap().push(m.to_string());
        migrate::run(&mut c, &files, Duration::from_millis(300), &log).await
    });

    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        !task.is_finished(),
        "runner must wait while the lock is held"
    );
    let table: Option<String> = sqlx::query_scalar("select to_regclass($1)::text")
        .bind(format!("{schema}.schema_migrations"))
        .fetch_one(&mut holder)
        .await
        .unwrap();
    assert_eq!(table, None, "nothing may run before the lock is released");
    assert!(
        logs.lock()
            .unwrap()
            .iter()
            .any(|m| m.contains("waiting for the migration lock"))
    );

    let released_at: f64 =
        sqlx::query_scalar("select extract(epoch from clock_timestamp())::float8")
            .fetch_one(&mut holder)
            .await
            .unwrap();
    sqlx::query("select pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut holder)
        .await
        .unwrap();

    let applied = tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(applied, vec!["001_a.sql"]);
    let ran_at: f64 = sqlx::query_scalar("select extract(epoch from at)::float8 from ran")
        .fetch_one(&mut holder)
        .await
        .unwrap();
    assert!(
        ran_at >= released_at,
        "applied at {ran_at}, lock released at {released_at}"
    );
}
