//! S5.4 H1 — `/healthz`·`/readyz`·`/metrics` 를 앞단이 TS 와 같은 경로·꼴·코드·인증으로 답하는지, 되돌림 env 가 먹는지.
//! DB 를 쓰는 `/metrics` 200 시험은 `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
mod common;

use axum::http::{Method, StatusCode};
use common::{send, serve};
use harkroom_server::auth::hash_token;
use harkroom_server::health::{AVCS_STALL_MS, avcs_connected, canonical_avcs};
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

fn env_or(k: &str) -> Option<String> {
    std::env::var(k)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 앞단이 TS 없이 내는 네 칸 — `version`(env → 구운 판)·`commit`(env → null)·`push`(sweeper 없음 → off)·`mail`(SMTP env 없음 → off).
fn assert_own_fields(v: &Value) {
    let conf: Value = serde_json::from_str(include_str!(
        "../../../packages/desktop/src-tauri/tauri.conf.json"
    ))
    .unwrap();
    // 구운 판은 정본 파일의 판과 같다(`build.rs`).
    assert_eq!(
        harkroom_server::health::BUILD_VERSION,
        conf["version"].as_str()
    );
    let want_version =
        env_or("HARKROOM_VERSION").unwrap_or_else(|| conf["version"].as_str().unwrap().into());
    assert_eq!(v["version"], Value::from(want_version));
    assert_eq!(
        v["commit"],
        env_or("HARKROOM_COMMIT").map_or(Value::Null, Value::from)
    );
    assert_eq!(v["push"], "off");
    let mail_env = std::env::vars().any(|(k, v)| {
        (k.starts_with("HARKROOM_SMTP_") || k == "HARKROOM_MAIL_FROM") && !v.trim().is_empty()
    });
    if !mail_env {
        assert_eq!(v["mail"], "off");
    }
    // startedAt 은 앞단 프로세스의 것(TS 의 것이 아니다), JS toISOString 꼴.
    let started = v["startedAt"].as_str().unwrap();
    assert_ne!(started, "2026-01-01T00:00:00.000Z");
    assert_eq!(started.len(), 24, "{started}");
    assert!(started.ends_with('Z') && started.as_bytes()[10] == b'T');
}

#[tokio::test]
async fn healthz_is_open_and_does_not_borrow_version_from_ts() {
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
    // avcs 도 TS 에서 옮겨 싣지 않는다 — 가짜 TS 는 `connected: true` 지만 앞단은 `projection_status` 를 본다(DB 가 죽었으니 false).
    assert_eq!(v["avcs"], serde_json::json!({ "connected": false }));
    // 가짜 TS 의 push·mail·version·commit(ok·off·9.9.9·abc1234)은 싣지 않는다.
    assert_ne!(v["version"], "9.9.9");
    assert_ne!(v["commit"], "abc1234");
    assert_own_fields(&v);
}

#[tokio::test]
async fn healthz_without_ts_still_answers_all_fields() {
    let base = front("http://127.0.0.1:1", lazy_pool(DEAD_DB), "").await;
    let (s, _, t) = send(&base, Method::GET, "/healthz", &[], "").await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_str(&t).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["avcs"], serde_json::json!({ "connected": false }));
    assert!(v["version"].is_string(), "{t}");
    assert_own_fields(&v);
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "avcs",
            "commit",
            "mail",
            "ok",
            "push",
            "startedAt",
            "version"
        ]
    );
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
fn open_rows_are_in_the_table_and_projection_status_is_moved() {
    for k in OPEN {
        assert!(MOVED.iter().any(|m| m.key == *k), "{k}");
    }
    // a6f481561 이 GET /projection/status 를 Rust 로 옮겼다(TS 가 투영 루프를 돌 때는 빈 상태를 답한다).
    assert!(MOVED.iter().any(|m| m.path == "/projection/status"));
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

/// `avcs.connected` 는 투영 루프가 쓴 줄에서 — 설정됐고·붙었고·마지막 폴링이 5분 안일 때만 true.
#[test]
fn avcs_connected_needs_configured_connected_and_fresh_poll() {
    let now = 10_000_000;
    assert!(avcs_connected(true, true, Some(now - 1_000), now));
    assert!(avcs_connected(true, true, Some(now - AVCS_STALL_MS), now));
    // 루프가 멈춘 뒤 남은 낡은 true 는 믿지 않는다.
    assert!(!avcs_connected(
        true,
        true,
        Some(now - AVCS_STALL_MS - 1),
        now
    ));
    assert!(!avcs_connected(true, true, None, now));
    assert!(!avcs_connected(false, true, Some(now), now));
    assert!(!avcs_connected(true, false, Some(now), now));
}
