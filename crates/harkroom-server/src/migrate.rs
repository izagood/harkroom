//! 마이그레이션 실행기(S5.4 M1) — TS `packages/server/src/db/migrate.ts` 를 그대로 옮긴 것. **기본 꺼짐**:
//! `HARKROOM_RUST_MIGRATE=1` 이고 `DATABASE_MIGRATE_URL`(DDL 을 돌릴 수 있는 역할)이 있을 때만 기동 때 돈다.
//! 켜면 스키마 대조(`schema.rs`)보다 먼저 돈다.
//!
//! TS 와 같아야 하는 것(롤링 업데이트에서 TS 실행기와 같은 DB 에 동시에 붙는다):
//! - 잠금: 세션 수준 advisory 잠금 키 [`MIGRATION_LOCK_KEY`] 를 `pg_try_advisory_lock` 으로 [`LOCK_RETRY`] 마다 두드린다
//!   (막혀 기다리면 스냅숏을 쥔 채 서서 상대의 `create index concurrently` 와 서로 기다린다 — TS 주석 참고).
//! - 표: `schema_migrations (name text primary key)` — 파일 이름만 적는다.
//! - 순서: 파일 이름 오름차순. 이미 적힌 이름은 건너뛴다.
//! - 트랜잭션 파일은 `begin` · `set local lock_timeout = '5s'` · 본문 · 기록 · `commit`.
//!   [`NO_TRANSACTION_MARK`] 가 있는 파일은 문장을 하나씩 트랜잭션 밖에서 보내고 끝에 기록한다(원자성 없음).
//! - `statement_timeout` 은 이 세션에서 0 으로 푼다.
use regex::Regex;
use sqlx::{Connection, PgConnection};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

include!(concat!(env!("OUT_DIR"), "/migrations_sql.rs"));

/// TS `MIGRATION_LOCK_KEY` — 'mrmr'.
pub const MIGRATION_LOCK_KEY: i64 = 0x6d72_6d72;
/// TS `MIGRATION_LOCK_TIMEOUT`.
pub const MIGRATION_LOCK_TIMEOUT: &str = "5s";
/// TS `LOCK_RETRY_MS`.
pub const LOCK_RETRY: Duration = Duration::from_millis(250);
/// TS `LOCK_WAIT_LOG_MS`.
pub const LOCK_WAIT_LOG: Duration = Duration::from_secs(30);
/// TS `runMigrationsWhenReachable` 의 기본 시한.
pub const REACHABLE_DEADLINE: Duration = Duration::from_secs(5 * 60);

/// TS `NO_TRANSACTION_MARK` (`/^\s*--\s*migrate:\s*no-transaction\s*$/im`).
pub static NO_TRANSACTION_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^\s*--\s*migrate:\s*no-transaction\s*$").unwrap());

/// 실행기를 켜는 스위치 — `HARKROOM_RUST_MIGRATE=1` 만 켠다(`HARKROOM_BACKGROUND_ENABLED` 와 같은 꼴).
pub fn enabled(v: Option<&str>) -> bool {
    v == Some("1")
}

/// 기동 설정. `Ok(None)` 이면 돌리지 않는다(기본). 켰는데 URL 이 없으면 `Err` — 기동을 멈춘다.
pub fn config(get: impl Fn(&str) -> Option<String>) -> Result<Option<String>, String> {
    if !enabled(get("HARKROOM_RUST_MIGRATE").as_deref()) {
        return Ok(None);
    }
    match get("DATABASE_MIGRATE_URL").filter(|u| !u.trim().is_empty()) {
        Some(u) => Ok(Some(u)),
        None => Err(
            "HARKROOM_RUST_MIGRATE=1 but DATABASE_MIGRATE_URL is not set (needs a DDL-capable role)"
                .into(),
        ),
    }
}

/// TS `splitStatements` — 주석 줄은 버리고, 줄 끝 `;` 에서 끊는다.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for line in sql.split('\n') {
        if line.trim_start().starts_with("--") {
            continue;
        }
        cur.push(line);
        if line.trim_end().ends_with(';') {
            let stmt = cur.join("\n").trim().to_string();
            if stmt != ";" {
                out.push(stmt);
            }
            cur.clear();
        }
    }
    let rest = cur.join("\n").trim().to_string();
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

/// TS `runMigrations` — `conn` 은 이 실행에만 쓰는 연결이다(잠금은 세션 수준).
pub async fn run(
    conn: &mut PgConnection,
    files: &[(&str, &str)],
    lock_wait_log: Duration,
    log: &(dyn Fn(&str) + Sync),
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::raw_sql("set statement_timeout = 0")
        .execute(&mut *conn)
        .await?;
    let res = run_locked(conn, files, lock_wait_log, log).await;
    // 잠금 해제 실패로 원래 에러를 덮지 않는다.
    let _ = sqlx::query("select pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *conn)
        .await;
    let _ = sqlx::raw_sql("reset statement_timeout")
        .execute(&mut *conn)
        .await;
    res
}

async fn run_locked(
    conn: &mut PgConnection,
    files: &[(&str, &str)],
    lock_wait_log: Duration,
    log: &(dyn Fn(&str) + Sync),
) -> Result<Vec<String>, sqlx::Error> {
    let started = Instant::now();
    let mut next_log = lock_wait_log;
    while !sqlx::query_scalar::<_, bool>("select pg_try_advisory_lock($1) as ok")
        .bind(MIGRATION_LOCK_KEY)
        .fetch_one(&mut *conn)
        .await?
    {
        if started.elapsed() >= next_log {
            log(&format!(
                "migrations: waiting for the migration lock held by another instance ({}s)",
                started.elapsed().as_secs()
            ));
            next_log += lock_wait_log;
        }
        tokio::time::sleep(LOCK_RETRY).await;
    }
    sqlx::raw_sql("create table if not exists schema_migrations (name text primary key)")
        .execute(&mut *conn)
        .await?;
    let mut sorted: Vec<&(&str, &str)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut applied_now = Vec::new();
    for (name, sql) in sorted {
        let done = sqlx::query("select 1 from schema_migrations where name = $1")
            .bind(*name)
            .fetch_optional(&mut *conn)
            .await?;
        if done.is_some() {
            continue;
        }
        if NO_TRANSACTION_MARK.is_match(sql) {
            for stmt in split_statements(sql) {
                sqlx::raw_sql(sqlx::AssertSqlSafe(stmt))
                    .execute(&mut *conn)
                    .await?;
            }
            record(conn, name).await?;
        } else {
            let mut tx = conn.begin().await?;
            // `set local` — 커밋·롤백과 함께 풀린다. 위 advisory 잠금 두드리기에는 걸리지 않는다.
            sqlx::raw_sql("set local lock_timeout = '5s'")
                .execute(&mut *tx)
                .await?;
            sqlx::raw_sql(sqlx::AssertSqlSafe(*sql))
                .execute(&mut *tx)
                .await?;
            record(&mut tx, name).await?;
            tx.commit().await?; // 실패하면 tx 가 떨어지며 rollback 한다.
        }
        applied_now.push(name.to_string());
    }
    Ok(applied_now)
}

async fn record(conn: &mut PgConnection, name: &str) -> Result<(), sqlx::Error> {
    sqlx::query("insert into schema_migrations (name) values ($1)")
        .bind(name)
        .execute(conn)
        .await
        .map(|_| ())
}

/// TS `runMigrationsWhenReachable` — DB 에 아직 닿지 못하면(연결 실패) 시한까지 기다린다. 닿은 뒤의 실패는 그대로 낸다.
pub async fn run_when_reachable(url: &str, deadline: Duration) -> Result<Vec<String>, String> {
    let started = Instant::now();
    let mut conn = loop {
        match PgConnection::connect(url).await {
            Ok(c) => break c,
            Err(e) if started.elapsed() < deadline => {
                eprintln!("migrations: database unreachable, retrying ({e})");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(format!("migrations: database unreachable: {e}")),
        }
    };
    let res = run(&mut conn, MIGRATION_FILES, LOCK_WAIT_LOG, &|m| {
        eprintln!("{m}")
    })
    .await
    .map_err(|e| format!("migrations: {e}"));
    let _ = conn.close().await;
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_default_off() {
        assert_eq!(config(|_| None), Ok(None));
        // URL 만 있어도 스위치가 없으면 돌지 않는다.
        assert_eq!(
            config(|k| (k == "DATABASE_MIGRATE_URL").then(|| "postgres://db.example.com/x".into())),
            Ok(None)
        );
        assert!(!enabled(Some("true")));
        assert!(!enabled(Some("0")));
    }

    #[test]
    fn switch_on_without_url_fails_fast() {
        let r = config(|k| (k == "HARKROOM_RUST_MIGRATE").then(|| "1".into()));
        assert!(r.unwrap_err().contains("DATABASE_MIGRATE_URL"));
        let u = "postgres://migrator@db.example.com/harkroom";
        let r = config(|k| match k {
            "HARKROOM_RUST_MIGRATE" => Some("1".into()),
            "DATABASE_MIGRATE_URL" => Some(u.into()),
            _ => None,
        });
        assert_eq!(r, Ok(Some(u.into())));
    }

    #[test]
    fn same_constants_as_ts() {
        assert_eq!(MIGRATION_LOCK_KEY, 1_836_215_666);
        assert_eq!(&MIGRATION_LOCK_KEY.to_be_bytes()[4..], b"mrmr");
        assert_eq!(MIGRATION_LOCK_TIMEOUT, "5s");
    }

    #[test]
    fn embedded_files_match_known_names() {
        let names: Vec<&str> = MIGRATION_FILES.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, crate::schema::KNOWN_MIGRATIONS);
        assert!(MIGRATION_FILES.iter().all(|(_, s)| !s.trim().is_empty()));
    }

    #[test]
    fn no_transaction_mark_and_split() {
        assert!(NO_TRANSACTION_MARK.is_match("-- x\n  -- Migrate: no-transaction  \nselect 1;"));
        assert!(!NO_TRANSACTION_MARK.is_match("select 1; -- migrate: no-transaction"));
        let sql = "-- migrate: no-transaction\ndrop index concurrently if exists a;\ncreate index concurrently if not exists a\n  on t (x);\n;\nselect 1";
        assert_eq!(
            split_statements(sql),
            vec![
                "drop index concurrently if exists a;",
                "create index concurrently if not exists a\n  on t (x);",
                "select 1",
            ]
        );
    }
}
