//! 클레임 토큰 해시 심기(`claim_seed.rs`)가 TS `seedClaimToken` 과 같은 규칙으로 도는지 본다.
//! - 기동 거절·빈 값: 진짜 바이너리를 띄운다(DB 없이 돈다 — 형식은 DB 에 닿기 전에 본다).
//! - 심기·두 번 기동: `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//!   `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 쓰기 풀 심기는 그 역할(`CLAIM_SEED_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
use harkroom_server::claim_seed::{CLAIM_SEED_PRIVILEGES, seed};
use sqlx::PgPool;
use std::process::Command;

fn front() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_harkroom-server-rs"));
    for k in [
        "CLAIM_TOKEN_HASH",
        "HARKROOM_RUST_MIGRATE",
        "DATABASE_MIGRATE_URL",
        "DATABASE_URL",
        "DATABASE_WRITE_URL",
        "UPSTREAM_URL",
    ] {
        c.env_remove(k);
    }
    c
}

fn random_hash() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).unwrap();
    hex::encode(b)
}

#[test]
fn wrong_shape_refuses_start() {
    for bad in ["hk_claim_rawtoken", "abc", &"g".repeat(64)] {
        let out = front().env("CLAIM_TOKEN_HASH", bad).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(1), "{bad}: {err}");
        assert!(
            err.contains("refusing to start — CLAIM_TOKEN_HASH must be a sha256 hex digest"),
            "{bad}: {err}"
        );
    }
}

#[test]
fn empty_value_skips_seeding() {
    // 비면 심기를 건너뛰고 다음 단계(서버 env 읽기)로 간다 — 거기서 `DATABASE_URL` 이 없어 멈추는 것으로 본다.
    for empty in ["", "   "] {
        let out = front().env("CLAIM_TOKEN_HASH", empty).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(!err.contains("CLAIM_TOKEN_HASH"), "{err}");
        assert!(!err.contains("claim token"), "{err}");
        assert!(err.contains("DATABASE_URL is required"), "{err}");
    }
}

/// `used_at` 을 글자로(시각 형 없이 대조한다). 행이 없으면 `None`.
async fn row(pool: &PgPool, hash: &str) -> Option<(Option<String>,)> {
    sqlx::query_as("select used_at::text from claim_token where token_hash = $1")
        .bind(hash)
        .fetch_optional(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn seed_once_and_keep_used_at() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, CLAIM_SEED_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    // 쓰기 풀 심기: 처음엔 넣고, 소진된 뒤 다시 심어도 `used_at` 을 되살리지 않는다.
    let h = random_hash();
    assert!(seed(&w, &h).await.unwrap());
    assert_eq!(row(&admin, &h).await, Some((None,)));
    sqlx::query("update claim_token set used_at = now() - interval '1 hour' where token_hash = $1")
        .bind(&h)
        .execute(&admin)
        .await
        .unwrap();
    let used = row(&admin, &h).await.unwrap().0.unwrap();
    assert!(!seed(&w, &h).await.unwrap());
    assert_eq!(row(&admin, &h).await, Some((Some(used),)));
}

#[tokio::test]
async fn binary_seeds_on_start_and_second_start_keeps_used_at() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let h = random_hash();
    // 진짜 바이너리를 `HARKROOM_RUST_MIGRATE=only`(마이그레이션 Job 꼴)로 띄운다 — 마이그레이션 직후 심고 끝난다.
    // 대문자·공백을 섞어 TS 와 같이 다듬는지도 본다.
    let start = || {
        front()
            .env("HARKROOM_RUST_MIGRATE", "only")
            .env("DATABASE_MIGRATE_URL", &url)
            .env("CLAIM_TOKEN_HASH", format!(" {} ", h.to_uppercase()))
            .output()
            .unwrap()
    };
    let first = start();
    let err = String::from_utf8_lossy(&first.stderr);
    assert_eq!(first.status.code(), Some(0), "{err}");
    assert!(err.contains("front: claim token seeded"), "{err}");
    assert_eq!(row(&admin, &h).await, Some((None,)));

    // 클레임으로 소진된 뒤 재시작.
    sqlx::query("update claim_token set used_at = now() - interval '1 hour' where token_hash = $1")
        .bind(&h)
        .execute(&admin)
        .await
        .unwrap();
    let used = row(&admin, &h).await.unwrap().0.unwrap();
    let second = start();
    let err = String::from_utf8_lossy(&second.stderr);
    assert_eq!(second.status.code(), Some(0), "{err}");
    assert!(
        err.contains("front: claim token already present — left as is"),
        "{err}"
    );
    assert_eq!(row(&admin, &h).await, Some((Some(used),)));
}
