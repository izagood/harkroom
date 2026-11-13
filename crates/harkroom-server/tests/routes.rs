//! 라우트 표(`routes.rs`)가 옮긴 줄만 Rust 로 답하고 나머지는 TS 로 넘기는지, 그리고 대조 시험 틀이 어긋남을 잡는지 본다.
//! DB 는 쓰지 않는다 — 풀은 연결하지 않는 lazy 풀이고, 익명 요청은 인증에서 DB 를 읽지 않는다.
mod common;

use axum::http::{Method, StatusCode};
use axum::routing::{get, post};
use common::{Case, contrast, send, serve};
use harkroom_server::proxy::Upstream;
use harkroom_server::routes::{self, AppState, MOVED, Moved, TsOverrides};

async fn upstream() -> String {
    let app = axum::Router::new().fallback(|req: axum::extract::Request| async move {
        format!("ts {} {}", req.method(), req.uri().path())
    });
    format!("http://{}", serve(app).await)
}

fn lazy_pool() -> sqlx::PgPool {
    // 포트 1 — 쓰면 실패한다. 이 시험의 요청은 DB 를 읽지 않아야 한다.
    sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap()
}

async fn moved_handler() -> &'static str {
    "rust moved"
}

const TABLE: &[Moved] = &[
    Moved {
        key: "GET /moved",
        path: "/moved",
        route: || get(moved_handler),
    },
    Moved {
        key: "POST /items/{id}",
        path: "/items/{id}",
        route: || post(moved_handler),
    },
];

async fn front(table: &'static [Moved], ts: &str) -> String {
    let state = AppState {
        up: Upstream::new(&upstream().await),
        pool: lazy_pool(),
    };
    let app = routes::router(state, table, &TsOverrides::parse(Some(ts)));
    format!("http://{}", serve(app).await)
}

async fn body(base: &str, m: Method, path: &str) -> (StatusCode, String) {
    let (s, _, t) = send(base, m, path, &[], "").await;
    (s, t)
}

#[tokio::test]
async fn moved_rows_answer_here_and_everything_else_goes_to_ts() {
    let f = front(TABLE, "").await;
    assert_eq!(body(&f, Method::GET, "/moved").await.1, "rust moved");
    assert_eq!(
        body(&f, Method::POST, "/moved").await.1,
        "ts POST /moved",
        "옮기지 않은 메서드는 405 가 아니라 TS 로 간다"
    );
    assert_eq!(body(&f, Method::POST, "/items/abc").await.1, "rust moved");
    assert_eq!(
        body(&f, Method::GET, "/items/abc").await.1,
        "ts GET /items/abc"
    );
    assert_eq!(body(&f, Method::GET, "/other").await.1, "ts GET /other");
    let (s, t) = body(&f, Method::GET, "/front/healthz").await;
    assert_eq!(s, 200);
    assert!(t.contains("\"front\":\"rust\""));
}

#[tokio::test]
async fn env_override_sends_a_row_back_to_ts() {
    let f = front(TABLE, " get  /moved ").await;
    assert_eq!(body(&f, Method::GET, "/moved").await.1, "ts GET /moved");
    assert_eq!(body(&f, Method::POST, "/items/x").await.1, "rust moved");
    let f = front(TABLE, "*").await;
    assert_eq!(
        body(&f, Method::POST, "/items/x").await.1,
        "ts POST /items/x"
    );
}

#[test]
fn override_parsing_and_unknown_keys() {
    let o = TsOverrides::parse(Some("GET /moved, post /items/{id},GET /typo,"));
    assert!(!o.all);
    assert_eq!(o.unknown(TABLE), vec!["GET /typo"]);
    assert_eq!(routes::active(TABLE, &o), Vec::<&str>::new());
    assert_eq!(TsOverrides::parse(None), TsOverrides::default());
    assert_eq!(
        routes::active(TABLE, &TsOverrides::default()),
        vec!["GET /moved", "POST /items/{id}"]
    );
}

/// 표의 key 가 `"<메서드> <path>"` 와 같고 겹치지 않는지 — 되돌림 env 가 key 로 줄을 찾으므로 어긋나면 되돌림이 안 먹는다.
#[test]
fn moved_table_keys_are_method_and_path() {
    for table in [MOVED, TABLE] {
        let mut seen = std::collections::HashSet::new();
        for m in table {
            let (method, path) = m.key.split_once(' ').expect(m.key);
            assert_eq!(path, m.path, "{}", m.key);
            assert!(
                ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method),
                "{}",
                m.key
            );
            assert!(seen.insert(m.key), "겹친 줄 {}", m.key);
        }
    }
}

#[tokio::test]
async fn contrast_harness_catches_status_media_and_body_drift() {
    use serde_json::json;
    // axum 의 json 기능은 켜지 않았다 — 손으로 JSON 응답을 만든다.
    #[allow(non_snake_case)]
    fn Json(v: serde_json::Value) -> ([(&'static str, &'static str); 1], String) {
        ([("content-type", "application/json")], v.to_string())
    }
    let ts = axum::Router::new()
        .route(
            "/same",
            get(|| async { Json(json!({"a":1,"b":[1,2],"at":"t1"})) }),
        )
        .route("/status", get(|| async { (StatusCode::FORBIDDEN, "no") }))
        .route("/body", get(|| async { Json(json!({"a":1})) }));
    let rs = axum::Router::new()
        // 키 순서·시각만 다르다 → 같다고 본다.
        .route(
            "/same",
            get(|| async { Json(json!({"at":"t2","b":[1,2],"a":1})) }),
        )
        .route(
            "/status",
            get(|| async { (StatusCode::UNAUTHORIZED, "no") }),
        )
        .route("/body", get(|| async { Json(json!({"a":2})) }));
    let ts = format!("http://{}", serve(ts).await);
    let rs = format!("http://{}", serve(rs).await);
    let diff = contrast(
        &ts,
        &rs,
        &[
            Case::get("same", "/same").ignore("/at"),
            Case::get("status", "/status"),
            Case::get("body", "/body"),
        ],
    )
    .await;
    assert_eq!(diff.len(), 2, "{diff:#?}");
    assert!(diff[0].starts_with("status"));
    assert!(diff[1].starts_with("body"));
}
