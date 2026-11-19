//! CORS — 앞단이 **직접 답하는** 응답에 TS 서버와 같은 머리를 붙인다(TS `buildServer.ts` 의 `@fastify/cors` 등록, 11.3.0).
//!
//! 왜: 0.4.635 판올림(11-14)에서 앞단이 답하는 라우트 응답에 CORS 머리가 없어 데스크톱(`tauri://localhost`)의 교차 출처 요청이
//! 「Load failed」로 막혔다. TS 로 넘기는 응답은 TS 가 이미 붙이므로 여기선 손대지 않는다(이 층은 옮긴 줄·코어 라우터에만 건다).
//!
//! 규칙(`@fastify/cors` 와 같음, 값은 `golden/cors.json` = TS 상수 — `packages/server/test/rustCorsGolden.test.ts` 가 대조):
//! - 허용 출처는 env `CORS_ORIGINS`(TS 와 같은 변수·같은 해석). 비면 요청 출처를 그대로 돌려준다(TS `origin: true`).
//!   목록에 `*` 가 있으면 `*`.
//! - 모든 응답(성공·4xx·5xx)에 `Vary: Origin`(출처가 `*` 이면 없음) · `Access-Control-Expose-Headers`(출처와 상관없이).
//!   `Access-Control-Allow-Origin` 은 허용된 출처일 때만(요청에 Origin 이 없으면 없음). credentials 는 끔(머리 없음).
//! - `OPTIONS` 는 프리플라이트로 바로 답한다: Origin 이나 `Access-Control-Request-Method` 가 없으면 400 `text/plain`
//!   「Invalid Preflight Request」, 있으면 204 + 허용 메서드·머리·max-age.
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::Value;
use std::sync::{Arc, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origins {
    /// `CORS_ORIGINS` 가 비었다 — 요청 출처를 그대로 돌려준다.
    Reflect,
    /// 목록에 `*` 가 있었다.
    Star,
    List(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Cors {
    pub origins: Origins,
}

impl Cors {
    /// TS `parseOrigins(CORS_ORIGINS)` 와 같은 해석.
    pub fn from_env_value(raw: Option<&str>) -> Self {
        let list: Vec<String> = raw
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        let origins = if list.is_empty() {
            Origins::Reflect
        } else if list.iter().any(|o| o == "*") {
            Origins::Star
        } else {
            Origins::List(list)
        };
        Self { origins }
    }

    fn allow_origin(&self, req_origin: Option<&str>) -> Option<String> {
        match &self.origins {
            Origins::Star => Some("*".into()),
            Origins::Reflect => req_origin.map(str::to_owned),
            Origins::List(l) => req_origin
                .filter(|o| l.iter().any(|x| x == o))
                .map(str::to_owned),
        }
    }
}

struct Values {
    methods: String,
    allowed: String,
    exposed: String,
    max_age: String,
}

fn values() -> &'static Values {
    static V: OnceLock<Values> = OnceLock::new();
    V.get_or_init(|| {
        let v: Value =
            serde_json::from_str(include_str!("../golden/cors.json")).expect("golden/cors.json");
        let join = |k: &str| {
            v[k].as_array()
                .expect(k)
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        };
        Values {
            methods: join("methods"),
            allowed: join("allowedHeaders"),
            exposed: join("exposedHeaders"),
            max_age: v["maxAge"].as_u64().expect("maxAge").to_string(),
        }
    })
}

fn set(h: &mut HeaderMap, name: header::HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        h.insert(name, v);
    }
}

/// `@fastify/cors` 의 `addOriginToVaryHeader` — 있던 `Vary` 에 `Origin` 을 덧붙인다(`*` 면 그대로, 이미 있으면 그대로).
fn add_vary_origin(h: &mut HeaderMap) {
    let existing: Vec<String> = h
        .get_all(header::VARY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    if existing
        .iter()
        .any(|v| v == "*" || v.eq_ignore_ascii_case("origin"))
    {
        return;
    }
    let mut all = existing;
    all.push("Origin".into());
    set(h, header::VARY, &all.join(", "));
}

/// 요청에 붙는 공통 머리(TS 는 `onRequest` 에서 붙여 오류 응답에도 실린다).
fn add_common(cors: &Cors, req_origin: Option<&str>, h: &mut HeaderMap) {
    if cors.origins != Origins::Star {
        add_vary_origin(h);
    }
    if let Some(o) = cors.allow_origin(req_origin) {
        set(h, header::ACCESS_CONTROL_ALLOW_ORIGIN, &o);
    }
    set(h, header::ACCESS_CONTROL_EXPOSE_HEADERS, &values().exposed);
}

/// 프리플라이트(`OPTIONS`) 답 — [`layer`] 와 [`preflight_layer`] 가 같이 쓴다.
fn preflight(cors: &Cors, req: &Request, origin: Option<&str>) -> Response {
    let has_acrm = req
        .headers()
        .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let mut res = if origin.is_none() || !has_acrm {
        let mut r = Response::new(Body::from("Invalid Preflight Request"));
        *r.status_mut() = StatusCode::BAD_REQUEST;
        r.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        r
    } else {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NO_CONTENT;
        let h = r.headers_mut();
        set(h, header::ACCESS_CONTROL_ALLOW_METHODS, &values().methods);
        set(h, header::ACCESS_CONTROL_ALLOW_HEADERS, &values().allowed);
        set(h, header::ACCESS_CONTROL_MAX_AGE, &values().max_age);
        h.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
        r
    };
    add_common(cors, origin, res.headers_mut());
    res
}

fn origin_of(req: &Request) -> Option<String> {
    req.headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// 층: `axum::middleware::from_fn_with_state(Arc<Cors>, cors::layer)`. 인증 층보다 **바깥**에 건다(401·403 에도 실리게).
pub async fn layer(State(cors): State<Arc<Cors>>, req: Request, next: Next) -> Response {
    let origin = origin_of(&req);
    if req.method() == Method::OPTIONS {
        return preflight(&cors, &req, origin.as_deref());
    }
    let mut res = next.run(req).await;
    add_common(&cors, origin.as_deref(), res.headers_mut());
    res
}

/// 앞단 전체에 거는 층 — **모든 경로**의 `OPTIONS` 를 앞단이 답한다(TS 로 넘기지 않는다). TS 의 `@fastify/cors` 는 전역 등록이라
/// 경로마다 다른 프리플라이트가 없다 — 그래서 경로를 가리지 않고 [`layer`] 와 같은 답을 낸다. 본 요청은 손대지 않는다
/// (옮긴 줄은 [`layer`] 가, TS 로 넘기는 응답은 TS 가 이미 머리를 붙인다).
pub async fn preflight_layer(State(cors): State<Arc<Cors>>, req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let origin = origin_of(&req);
        return preflight(&cors, &req, origin.as_deref());
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_parse_like_ts() {
        assert_eq!(Cors::from_env_value(None).origins, Origins::Reflect);
        assert_eq!(Cors::from_env_value(Some(" , ")).origins, Origins::Reflect);
        assert_eq!(Cors::from_env_value(Some("a,*")).origins, Origins::Star);
        assert_eq!(
            Cors::from_env_value(Some(" tauri://localhost , http://x ")).origins,
            Origins::List(vec!["tauri://localhost".into(), "http://x".into()])
        );
    }

    #[test]
    fn allow_origin_rules() {
        let list = Cors::from_env_value(Some("tauri://localhost"));
        assert_eq!(
            list.allow_origin(Some("tauri://localhost")).as_deref(),
            Some("tauri://localhost")
        );
        assert_eq!(list.allow_origin(Some("https://evil.example")), None);
        assert_eq!(list.allow_origin(None), None);
        let reflect = Cors::from_env_value(None);
        assert_eq!(
            reflect.allow_origin(Some("https://any")).as_deref(),
            Some("https://any")
        );
        assert_eq!(reflect.allow_origin(None), None);
    }

    #[test]
    fn vary_appends_once() {
        let mut h = HeaderMap::new();
        add_vary_origin(&mut h);
        assert_eq!(h.get(header::VARY).unwrap(), "Origin");
        add_vary_origin(&mut h);
        assert_eq!(h.get(header::VARY).unwrap(), "Origin");
        let mut h = HeaderMap::new();
        h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
        add_vary_origin(&mut h);
        assert_eq!(h.get(header::VARY).unwrap(), "Accept-Encoding, Origin");
    }

    #[test]
    fn golden_values() {
        assert_eq!(values().methods, "GET, POST, PUT, PATCH, DELETE");
        assert!(values().exposed.contains("retry-after"));
        assert_eq!(values().max_age, "600");
    }

    /// 앞단 전체 층: 어느 경로든(TS 로 넘길 fallback 포함) `OPTIONS` 를 앞단이 답하고, 본 요청은 그대로 지나간다.
    #[tokio::test]
    async fn preflight_layer_answers_every_path() {
        use tower_service::Service;
        let cors = Arc::new(Cors::from_env_value(Some("tauri://localhost")));
        let mut app = axum::Router::new()
            .fallback(|| async { StatusCode::IM_A_TEAPOT })
            .layer(axum::middleware::from_fn_with_state(cors, preflight_layer));
        let pre = axum::http::Request::builder()
            .method(Method::OPTIONS)
            .uri("/threads/x/plan")
            .header(header::ORIGIN, "tauri://localhost")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
            .body(Body::empty())
            .unwrap();
        let r = app.call(pre).await.unwrap();
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            r.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "tauri://localhost"
        );
        assert!(
            r.headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_METHODS)
        );
        let bad = axum::http::Request::builder()
            .method(Method::OPTIONS)
            .uri("/accounts/x/avatar")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.call(bad).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        let get = axum::http::Request::builder()
            .uri("/anything")
            .header(header::ORIGIN, "tauri://localhost")
            .body(Body::empty())
            .unwrap();
        let r = app.call(get).await.unwrap();
        assert_eq!(r.status(), StatusCode::IM_A_TEAPOT);
        // 본 요청 머리는 이 층이 붙이지 않는다(TS 가 붙인 머리와 겹치지 않게).
        assert!(
            !r.headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
}
