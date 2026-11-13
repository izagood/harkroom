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
        write: None,
        trust: Default::default(),
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

/// TS 서버 소스(`packages/server/src/**/*.ts`)에서 `app.<method>('<path>'` 와 `app.route({ method, url: '<path>'`(메서드 모두로 친다)를
/// 긁는다. 경로가 문자열 리터럴이 아니면(변수) 건너뛴다. `:param` 은 axum 꼴 `{param}` 으로 바꾼다.
fn ts_routes() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).expect("read_dir") {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "ts") {
                out.push(p);
            }
        }
    }
    fn literal(s: &str) -> Option<String> {
        let s = s.trim_start();
        let q = s.chars().next().filter(|c| matches!(c, '\'' | '"' | '`'))?;
        let rest = &s[1..];
        let end = rest.find(q)?;
        let lit = &rest[..end];
        (lit.starts_with('/') && !lit.contains("${")).then(|| {
            lit.split('/')
                .map(|seg| match seg.strip_prefix(':') {
                    Some(name) => format!("{{{name}}}"),
                    None => seg.to_string(),
                })
                .collect::<Vec<_>>()
                .join("/")
        })
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/server/src");
    let mut files = vec![];
    walk(&root, &mut files);
    let mut out = vec![];
    for f in files {
        let src = std::fs::read_to_string(&f).unwrap();
        let mut i = 0;
        while let Some(at) = src[i..].find("app.") {
            let s = &src[i + at + 4..];
            i += at + 4;
            let method = ["get", "post", "put", "patch", "delete"]
                .into_iter()
                .find(|m| {
                    s.starts_with(m) && matches!(s.as_bytes().get(m.len()), Some(b'(' | b'<'))
                });
            if let Some(m) = method {
                // 제네릭 `<{ Params: … }>` 를 건너뛴다(중첩 꺾쇠까지).
                let mut rest = &s[m.len()..];
                if rest.starts_with('<') {
                    let mut depth = 0;
                    let mut cut = None;
                    for (k, c) in rest.char_indices() {
                        match c {
                            '<' => depth += 1,
                            '>' => {
                                depth -= 1;
                                if depth == 0 {
                                    cut = Some(k + 1);
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                    rest = &rest[cut.expect("닫히지 않은 제네릭")..];
                }
                if let Some(p) = rest.strip_prefix('(').and_then(literal) {
                    out.push((m.to_uppercase(), p));
                }
            } else if s.starts_with("route(") {
                let body = &s[..s.find("handler").unwrap_or(s.len().min(400))];
                if let Some(u) = body.find("url:").and_then(|k| literal(&body[k + 4..])) {
                    for m in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
                        out.push((m.to_string(), u.clone()));
                    }
                }
            }
        }
    }
    out
}

fn segs(p: &str) -> Vec<&str> {
    p.trim_matches('/').split('/').collect()
}

fn is_param(seg: &str) -> bool {
    seg.starts_with('{')
}

/// 옮긴 줄이 `{param}` 을 가질 때, 같은 메서드의 TS **고정** 경로를 덮으면 안 된다 — 예: Rust 가 `GET /accounts/{id}` 를 맡는데 TS 에
/// `GET /accounts/agents` 가 있으면, 라우터는 `/accounts/agents` 도 Rust 로 보낸다(Rust 표에 고정 줄이 없으므로). TS(find-my-way)는 고정 경로를
/// 먼저 고르니 답이 달라진다. 이 경우 그 고정 경로도 같은 묶음에서 옮기거나 표에 두지 않는다.
fn shadowed(moved: &[Moved], ts: &[(String, String)]) -> Vec<String> {
    let mut bad = vec![];
    for m in moved {
        let (method, path) = m.key.split_once(' ').unwrap();
        let mp = segs(path);
        if !mp.iter().any(|s| is_param(s)) {
            continue;
        }
        for (tm, tp) in ts {
            if tm != method || tp == path {
                continue;
            }
            let tps = segs(tp);
            if tps.len() != mp.len() {
                continue;
            }
            let covers = mp.iter().zip(&tps).all(|(a, b)| is_param(a) || a == b);
            // TS 쪽이 그 자리에서 더 고정적인(=param 이 아닌) 칸을 가질 때만 겹침이다. 같은 꼴(이름만 다른 param)은 같은 경로다.
            let more_static = mp
                .iter()
                .zip(&tps)
                .any(|(a, b)| is_param(a) && !is_param(b));
            let moved_too = moved.iter().any(|o| o.key == format!("{tm} {tp}"));
            if covers && more_static && !moved_too {
                bad.push(format!("{} 가 TS 고정 경로 {tm} {tp} 를 덮는다", m.key));
            }
        }
    }
    bad
}

#[test]
fn ts_route_scan_finds_known_routes() {
    let ts = ts_routes();
    // 긁기가 망가져 빈 목록이 되면 아래 겹침 시험이 아무것도 안 보고 통과한다 — 아는 줄로 확인한다.
    for want in [
        ("GET", "/accounts"),
        ("POST", "/dms"),
        ("PUT", "/mcp-servers/{name}"),
        ("GET", "/threads/{rootId}/plan"),
        ("DELETE", "/teams/{id}/invokers/{accountId}"),
    ] {
        assert!(
            ts.iter().any(|(m, p)| m == want.0 && p == want.1),
            "TS 라우트 긁기가 {want:?} 를 못 찾았다 ({}줄)",
            ts.len()
        );
    }
    assert!(ts.len() > 150, "{}줄", ts.len());
}

#[test]
fn moved_rows_exist_in_ts() {
    let ts = ts_routes();
    for m in MOVED {
        let (method, path) = m.key.split_once(' ').unwrap();
        assert!(
            ts.iter().any(|(tm, tp)| tm == method && tp == path),
            "{} 는 TS 에 없는 경로다 — 옮기는 것은 이미 있는 줄뿐이다",
            m.key
        );
    }
}

#[test]
fn moved_params_do_not_shadow_ts_static_paths() {
    let ts = ts_routes();
    assert_eq!(shadowed(MOVED, &ts), Vec::<String>::new());
    // 시험이 겹침을 실제로 잡는지 — TS 의 `GET /accounts/agents`·`DELETE /accounts/me` 같은 고정 줄을 덮는 가짜 표.
    const FAKE: &[Moved] = &[Moved {
        key: "PUT /mcp-servers/{name}",
        path: "/mcp-servers/{name}",
        route: || axum::routing::put(moved_handler),
    }];
    let fake_ts = vec![
        ("PUT".to_string(), "/mcp-servers/{name}".to_string()),
        ("PUT".to_string(), "/mcp-servers/defaults".to_string()),
        ("GET".to_string(), "/mcp-servers/other".to_string()),
    ];
    assert_eq!(
        shadowed(FAKE, &fake_ts),
        vec![
            "PUT /mcp-servers/{name} 가 TS 고정 경로 PUT /mcp-servers/defaults 를 덮는다"
                .to_string()
        ]
    );
}
