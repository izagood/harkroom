//! 시험끼리 쓰는 HTTP 도구(S5.2 P0): 앱을 띄우고, 요청을 보내고, 두 구현(TS·Rust)의 답을 대조한다.
#![allow(dead_code)] // 시험 파일마다 쓰는 것이 다르다.
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use std::net::SocketAddr;

pub async fn serve(app: axum::Router) -> SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    a
}

/// `base` 는 `http://host:port`(끝 `/` 없음).
pub async fn send(
    base: &str,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (StatusCode, HeaderMap, String) {
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build_http::<Body>();
    let mut b = Request::builder()
        .method(method)
        .uri(format!("{base}{path}"));
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let res = client
        .request(b.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let h = res.headers().clone();
    let bytes = http_body_util::BodyExt::collect(res.into_body())
        .await
        .unwrap()
        .to_bytes();
    (status, h, String::from_utf8_lossy(&bytes).into_owned())
}

/// 대조 시험의 요청 하나. 같은 요청을 TS 와 Rust 에 보내 답이 같은지 본다.
pub struct Case<'a> {
    pub name: &'a str,
    pub method: Method,
    pub path: &'a str,
    pub headers: Vec<(&'a str, &'a str)>,
    pub body: &'a str,
    /// 비교에서 뺄 JSON 포인터(`/createdAt`, `/items/0/lastSeenAt` …) — 요청마다 달라지는 값만 적는다.
    pub ignore: Vec<&'a str>,
}

impl<'a> Case<'a> {
    pub fn get(name: &'a str, path: &'a str) -> Self {
        Self {
            name,
            method: Method::GET,
            path,
            headers: vec![],
            body: "",
            ignore: vec![],
        }
    }
    pub fn header(mut self, k: &'a str, v: &'a str) -> Self {
        self.headers.push((k, v));
        self
    }
    pub fn ignore(mut self, ptr: &'a str) -> Self {
        self.ignore.push(ptr);
        self
    }
}

/// 대조에서 보는 것: 상태 코드 · content-type 의 미디어 형식(`; charset` 은 뺀다) · 본문.
/// 본문은 JSON 이면 값으로 비교한다(키 순서·공백은 보지 않는다 — UI 는 값으로 읽는다). JSON 이 아니면 글자 그대로.
#[derive(Debug, PartialEq)]
pub struct Seen {
    pub status: u16,
    pub media: String,
    pub body: Body2,
}

#[derive(Debug, PartialEq)]
pub enum Body2 {
    Json(serde_json::Value),
    Text(String),
}

pub fn normalize(status: StatusCode, h: &HeaderMap, text: &str, ignore: &[&str]) -> Seen {
    let media = h
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap().trim().to_ascii_lowercase())
        .unwrap_or_default();
    let body = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(mut v) => {
            for p in ignore {
                if let Some(x) = v.pointer_mut(p) {
                    *x = serde_json::Value::String("<ignored>".into());
                }
            }
            Body2::Json(v)
        }
        Err(_) => Body2::Text(text.to_string()),
    };
    Seen {
        status: status.as_u16(),
        media,
        body,
    }
}

/// 모든 요청을 두 구현에 보내고, 어긋난 것을 사람이 읽을 글로 모은다. 빈 Vec 이면 같다.
pub async fn contrast(ts: &str, rs: &str, cases: &[Case<'_>]) -> Vec<String> {
    let mut out = vec![];
    for c in cases {
        let (s1, h1, t1) = send(ts, c.method.clone(), c.path, &c.headers, c.body).await;
        let (s2, h2, t2) = send(rs, c.method.clone(), c.path, &c.headers, c.body).await;
        let a = normalize(s1, &h1, &t1, &c.ignore);
        let b = normalize(s2, &h2, &t2, &c.ignore);
        if a != b {
            out.push(format!(
                "{} ({} {}):\n  ts   = {a:?}\n  rust = {b:?}",
                c.name, c.method, c.path
            ));
        }
    }
    out
}
