//! S5.4 H1 — `/healthz`·`/readyz`·`/metrics` 를 앞단이 TS 와 같은 경로·꼴·코드·인증으로 답하는지, 되돌림 env 가 먹는지.
//! DB 를 쓰는 `/metrics` 200 시험은 `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
mod common;

use axum::http::{Method, StatusCode};
use common::{send, serve};
use harkroom_server::auth::hash_token;
use harkroom_server::health::canonical_avcs;
use harkroom_server::proxy::Upstream;
use harkroom_server::routes::{self, AppState, MOVED, OPEN, TsOverrides};
use serde_json::Value;

/// 가짜 TS — `/healthz` 는 TS 꼴로, 나머지는 `ts <path>`.
async fn ts() -> String {
    let app = axum::Router::new()
        .route(
            "/healthz",
            axum::routing::get(|| async {
                (
                    [("content-type", "application/json")],
                    r#"{"ok":true,"avcs":{"connected":true},"push":"ok","mail":"off","version":"9.9.9","commit":"abc1234","startedAt":"2026-01-01T00:00:00.000Z"}"#,
                )
            }),
        )
        .fallback(|req: axum::extract::Request| async move { format!("ts {}", req.uri().path()) });
    format!("http://{}", serve(app).await)
}

fn lazy_pool(url: &str) -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy(url)
        .unwrap()
}

async fn front(up: &str, pool: sqlx::PgPool, ts_env: &str) -> String {
    let state = AppState {
        up: Upstream::new(up),
        pool,
        write: None,
        trust: Default::default(),
        cors: std::sync::Arc::new(harkroom_server::cors::Cors::from_env_value(None)),
    };
    let app = routes::router(state, MOVED, &TsOverrides::parse(Some(ts_env)));
    format!("http://{}", serve(app).await)
}

const DEAD_DB: &str = "postgres://nobody@127.0.0.1:1/none";

#[tokio::test]
async fn healthz_is_open_and_carries_ts_state_and_version() {
    let base = front(&ts().await, lazy_pool(DEAD_DB), "").await;
    let (s, h, t) = send(&base, Method::GET, "/healthz", &[], "").await;
    assert_eq!(s, StatusCode::OK, "{t}");
    assert!(
        h["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    let v: Value = serde_json::from_str(&t).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["avcs"]["connected"], true);
    assert_eq!(v["push"], "ok");
    assert_eq!(v["mail"], "off");
    // 앞단 env 가 없으면 TS 값, 있으면 앞단 값 — 어느 쪽이든 문자열 또는 null 이고 지어내지 않는다.
    let commit = std::env::var("HARKROOM_COMMIT")
        .ok()
        .filter(|c| !c.trim().is_empty());
    assert_eq!(
        v["commit"],
        commit.map_or(Value::from("abc1234"), |c| Value::from(c.trim()))
    );
    assert!(v["version"].is_string());
    // startedAt 은 앞단 프로세스의 것(TS 의 것이 아니다), JS toISOString 꼴.
    let started = v["startedAt"].as_str().unwrap();
    assert_ne!(started, "2026-01-01T00:00:00.000Z");
    assert_eq!(started.len(), 24, "{started}");
    assert!(started.ends_with('Z') && started.as_bytes()[10] == b'T');
}

#[tokio::test]
async fn healthz_without_ts_reports_avcs_disconnected_and_drops_optional_fields() {
    let base = front("http://127.0.0.1:1", lazy_pool(DEAD_DB), "").await;
    let (s, _, t) = send(&base, Method::GET, "/healthz", &[], "").await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_str(&t).unwrap();
    assert_eq!(v["avcs"], serde_json::json!({ "connected": false }));
    assert!(v.get("push").is_none() && v.get("mail").is_none());
    assert!(v.get("commit").is_some() && v.get("version").is_some());
}

#[tokio::test]
async fn readyz_is_open_and_500s_when_db_is_down() {
    let base = front(&ts().await, lazy_pool(DEAD_DB), "").await;
    let (s, _, t) = send(&base, Method::GET, "/readyz", &[], "").await;
    assert_eq!(s, StatusCode::INTERNAL_SERVER_ERROR);
    let v: Value = serde_json::from_str(&t).unwrap();
    assert_eq!(v["error"]["code"], "internal");
}

#[tokio::test]
async fn metrics_requires_an_account() {
    let base = front(&ts().await, lazy_pool(DEAD_DB), "").await;
    let (s, _, t) = send(&base, Method::GET, "/metrics", &[], "").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "{t}");
}

#[tokio::test]
async fn ts_override_sends_health_rows_back_to_ts() {
    let base = front(&ts().await, lazy_pool(DEAD_DB), "GET /readyz,GET /metrics").await;
    assert_eq!(
        send(&base, Method::GET, "/readyz", &[], "").await.2,
        "ts /readyz"
    );
    assert_eq!(
        send(&base, Method::GET, "/metrics", &[], "").await.2,
        "ts /metrics"
    );
    // 되돌리지 않은 /healthz 는 그대로 앞단.
    let (_, _, t) = send(&base, Method::GET, "/healthz", &[], "").await;
    assert!(t.starts_with('{'), "{t}");
}

#[test]
fn open_rows_are_in_the_table_and_projection_status_stays_on_ts() {
    for k in OPEN {
        assert!(MOVED.iter().any(|m| m.key == *k), "{k}");
    }
    assert!(!MOVED.iter().any(|m| m.path == "/projection/status"));
    assert_eq!(
        canonical_avcs("https://avcs.example.com/"),
        Some("https://avcs.example.com".into())
    );
    assert_eq!(
        canonical_avcs("http://avcs.example.com:8080/a/"),
        Some("http://avcs.example.com:8080/a".into())
    );
    assert_eq!(canonical_avcs("ftp://avcs.example.com"), None);
}

#[tokio::test]
async fn metrics_and_readyz_with_db() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let acct: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ('h1_me', 'h1_me', 'human', 'h1_me') \
         on conflict (handle) do update set handle = excluded.handle returning id::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let token = "h1-metrics-session-token";
    sqlx::query("insert into session(token_hash, account_id, expires_at) values ($1, $2::uuid, now() + interval '1 day') on conflict do nothing")
        .bind(hash_token(token))
        .bind(&acct)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "update projection_config set avcs_base_url = 'https://avcs.example.com/' where id = true",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("insert into projection_cursor(repo, avcs_base_url, last_log_index) values ('o/r', 'https://avcs.example.com', 42), ('o/r', 'https://old.example.com', 7) on conflict do nothing")
        .execute(&pool)
        .await
        .unwrap();
    let base = front(&ts().await, pool, "").await;
    let (s, _, t) = send(&base, Method::GET, "/readyz", &[], "").await;
    assert_eq!((s, t.as_str()), (StatusCode::OK, r#"{"ok":true}"#));
    let auth = format!("Bearer {token}");
    let (s, h, t) = send(
        &base,
        Method::GET,
        "/metrics",
        &[("authorization", &auth)],
        "",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{t}");
    assert_eq!(
        h["content-type"],
        "text/plain; version=0.0.4; charset=utf-8"
    );
    for name in [
        "# TYPE harkroom_http_requests_total counter",
        "# TYPE harkroom_db_pool_total gauge",
        "# TYPE harkroom_db_pool_idle gauge",
        "# TYPE harkroom_projection_cursor gauge",
        "# TYPE harkroom_agent_oldest_unread_seconds gauge",
    ] {
        assert!(t.contains(name), "{name} in {t}");
    }
    // 현재 avcs 서버(끝 `/` 를 뗀 값)의 커서만 — 다른 서버의 같은 repo 행은 싣지 않는다.
    assert!(
        t.contains("harkroom_projection_cursor{repo=\"o/r\"} 42\n"),
        "{t}"
    );
    assert!(!t.contains("} 7\n"), "{t}");
}
