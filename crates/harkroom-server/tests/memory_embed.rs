//! 기억 조각 채우기(`loops::memory_embed`)와 마이그레이션 195 를 실제 Postgres(pgvector)로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다). 쓰는 쪽은
//! `HARKROOM_TEST_WRITE_DATABASE_URL`(있으면) 역할 = `MEMORY_EMBED_PRIVILEGES` 만.
use harkroom_server::embed::{EmbedConfig, Embedder};
use harkroom_server::loops::memory_embed::{Filled, MEMORY_EMBED_PRIVILEGES, fill, table_exists};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 입력 개수만큼 `dim` 차원 벡터를 주는 가짜 서비스. 본문에 `BOOM` 이 든 요청은 400, `DOWN` 이 들면 503. 받은 입력 수를 센다.
async fn fake(dim: usize) -> (String, Arc<AtomicUsize>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let seen = Arc::new(AtomicUsize::new(0));
    let count = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let mut buf = vec![];
            let mut chunk = [0u8; 8192];
            let body = loop {
                let n = s.read(&mut chunk).await.unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).into_owned();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let want: usize = head
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length: ")?
                                .parse()
                                .ok()
                        })
                        .unwrap_or(0);
                    if rest.len() >= want {
                        break rest.to_owned();
                    }
                }
                if n == 0 {
                    break String::new();
                }
            };
            let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let n = v["input"].as_array().map_or(0, Vec::len);
            count.fetch_add(n, Ordering::Relaxed);
            let status = if body.contains("BOOM") {
                "400 Bad Request"
            } else if body.contains("DOWN") {
                "503 Busy"
            } else {
                "200 OK"
            };
            let data: Vec<_> = (0..n)
                .map(|i| serde_json::json!({ "index": i, "embedding": vec![1.0; dim] }))
                .collect();
            let out = serde_json::json!({ "data": data }).to_string();
            let res = format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                out.len()
            );
            s.write_all(res.as_bytes()).await.ok();
            s.shutdown().await.ok();
        }
    });
    (base, seen)
}

fn embedder(base: &str, model: &str, dim: usize) -> Embedder {
    Embedder::new(EmbedConfig {
        base: base.to_owned(),
        model: model.to_owned(),
        dim,
    })
}

async fn put(admin: &PgPool, account: &str, slug: &str, description: Option<&str>, value: &str) {
    sqlx::query(
        "insert into agent_memory (account_id, slug, value, description) values ($1::uuid, $2, $3, $4) \
         on conflict (account_id, slug) do update set value = $3, description = $4, updated_at = now()",
    )
    .bind(account)
    .bind(slug)
    .bind(value)
    .bind(description)
    .execute(admin)
    .await
    .unwrap();
}

/// `(source, idx)` 들.
async fn parts(admin: &PgPool, slug: &str) -> Vec<(String, i32)> {
    sqlx::query_as("select source, idx from agent_memory_chunk where slug = $1 order by 1, 2")
        .bind(slug)
        .fetch_all(admin)
        .await
        .unwrap()
}

#[tokio::test]
async fn fills_refreshes_and_forgets() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    assert!(
        table_exists(&w).await.unwrap(),
        "pgvector 이미지인데 표가 없다"
    );
    let missing = harkroom_server::write::missing_in(&w, MEMORY_EMBED_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    let account: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('embed-a', 'embed-a', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let (base, seen) = fake(3).await;
    let e = embedder(&base, "m1", 3);
    let mut failed = HashSet::new();

    // 1) 백필 — core 는 빼고, 긴 본문은 여러 조각, 요약은 따로.
    put(&admin, &account, "core", None, "core").await;
    put(
        &admin,
        &account,
        "mem/long",
        Some("요약"),
        &"가".repeat(2000),
    )
    .await;
    put(&admin, &account, "mem/short", None, "짧음").await;
    let got = fill(&w, &e, &mut failed).await.unwrap();
    assert_eq!((got.docs, got.refused, got.stopped), (2, 0, false));
    assert_eq!(parts(&admin, "mem/short").await, [("body".into(), 0)]);
    let long = parts(&admin, "mem/long").await;
    assert_eq!(long.len(), 4);
    assert_eq!(long.last().unwrap(), &("description".into(), 0));
    assert!(parts(&admin, "core").await.is_empty());
    assert_eq!(got.chunks, 5);

    // 2) 안 바뀌면 다시 묻지 않는다 — 시각·보관만 바뀐 것도.
    let before = seen.load(Ordering::Relaxed);
    sqlx::query(
        "update agent_memory set updated_at = now(), archived_at = now() where slug = 'mem/short'",
    )
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(fill(&w, &e, &mut failed).await.unwrap(), Filled::default());
    assert_eq!(seen.load(Ordering::Relaxed), before);
    assert_eq!(parts(&admin, "mem/short").await.len(), 1, "보관해도 남는다");

    // 3) 본문이 줄면 옛 조각이 남지 않는다. 요약만 바뀌어도 다시 만든다.
    put(&admin, &account, "mem/long", None, "줄임").await;
    put(&admin, &account, "mem/short", Some("생김"), "짧음").await;
    assert_eq!(fill(&w, &e, &mut failed).await.unwrap().docs, 2);
    assert_eq!(parts(&admin, "mem/long").await, [("body".into(), 0)]);
    assert_eq!(parts(&admin, "mem/short").await.len(), 2);

    // 4) 거절된 글은 그것만 건너뛰고 되풀이해 묻지 않는다.
    put(&admin, &account, "mem/boom", None, "BOOM").await;
    let got = fill(&w, &e, &mut failed).await.unwrap();
    assert_eq!((got.docs, got.refused, got.stopped), (0, 1, false));
    assert_eq!(fill(&w, &e, &mut failed).await.unwrap(), Filled::default());

    // 5) 서비스가 죽으면 멈추고 옛 조각은 그대로다. 살아나면 잇는다.
    put(&admin, &account, "mem/long", None, "DOWN").await;
    let got = fill(&w, &e, &mut failed).await.unwrap();
    assert!(got.stopped && got.docs == 0);
    assert_eq!(parts(&admin, "mem/long").await.len(), 1);
    put(&admin, &account, "mem/long", None, "다시").await;
    assert_eq!(fill(&w, &e, &mut failed).await.unwrap().docs, 1);

    // 6) 모델·차원이 바뀌면 전부 다시 만든다.
    let (base2, _) = fake(2).await;
    let e2 = embedder(&base2, "m2", 2);
    assert_eq!(fill(&w, &e2, &mut HashSet::new()).await.unwrap().docs, 2);
    let dims: Vec<i32> = sqlx::query_scalar("select distinct dim from agent_memory_chunk")
        .fetch_all(&admin)
        .await
        .unwrap();
    assert_eq!(dims, [2]);

    // 7) 숨긴 기억은 조각을 지우고 다시 만들지 않는다. 기억이 지워지면 같이 지워진다.
    sqlx::query("update agent_memory set flagged_at = now() where slug = 'mem/short'")
        .execute(&admin)
        .await
        .unwrap();
    fill(&w, &e2, &mut HashSet::new()).await.unwrap();
    assert!(parts(&admin, "mem/short").await.is_empty());
    sqlx::query("delete from agent_memory where slug = 'mem/long'")
        .execute(&admin)
        .await
        .unwrap();
    assert!(parts(&admin, "mem/long").await.is_empty());

    // 8) 확장을 못 켜는 역할이면 조용히 넘어간다(표 없음). 되돌리는 트랜잭션 안에서 본다.
    let mut tx = admin.begin().await.unwrap();
    sqlx::raw_sql(
        "drop extension vector cascade; drop table agent_memory_chunk; \
         create role embed_noext nologin; grant execute on function memory_chunk_setup() to embed_noext; \
         set local role embed_noext;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let made: bool = sqlx::query_scalar("select memory_chunk_setup()")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(!made);
    let there: bool = sqlx::query_scalar("select to_regclass('agent_memory_chunk') is not null")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(!there);
    tx.rollback().await.unwrap();
}
