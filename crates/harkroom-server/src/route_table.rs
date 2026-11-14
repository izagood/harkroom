//! 코어 라우터의 HTTP 줄을 **붙이면서 동시에 적는** 표. 앞단은 기동 때 이 표를 `front: rust core routes [...]` 로 찍고,
//! CI 대조 시험(`packages/server/test/rustFrontDb.test.ts`)이 그 줄을 읽어 **Rust 가 답하는 모든 줄**에 `Origin: tauri://localhost`
//! 본 요청·프리플라이트를 보내 TS 와 CORS 머리를 맞춰 본다.
//!
//! 왜: CORS 층 빠짐이 11-14 하루에 두 번 났다(#2120 옮긴 줄 「Load failed」, #2127 `/operators*`). 줄마다 시험을 손으로 더하면
//! 새 줄이 빠진다 — 그래서 줄을 붙이는 길과 시험이 읽는 목록을 한 곳으로 묶는다. 이 표를 거치지 않고 `.route` 로 붙인
//! HTTP 줄은 목록에 없다 → 코어 라우터의 HTTP 줄은 이 표로만 붙인다. 소켓 줄(`/ws`·`/operator`)은 [`Table::socket`] 으로 적어
//! 목록에는 따로 실린다(교차 출처 fetch 가 아니라 CORS 대조에서 뺀다).
use axum::Router;
use axum::handler::Handler;
use axum::routing::{MethodFilter, on};

pub struct Table<S> {
    router: Router<S>,
    keys: Vec<String>,
    sockets: Vec<String>,
}

impl<S: Clone + Send + Sync + 'static> Default for Table<S> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S: Clone + Send + Sync + 'static> Table<S> {
    pub fn new() -> Self {
        Self {
            router: Router::new(),
            keys: Vec::new(),
            sockets: Vec::new(),
        }
    }

    fn add<H, T>(mut self, filter: MethodFilter, method: &str, path: &str, h: H) -> Self
    where
        H: Handler<T, S>,
        T: 'static,
    {
        self.router = self.router.route(path, on(filter, h));
        self.keys.push(format!("{method} {path}"));
        self
    }

    pub fn get<H: Handler<T, S>, T: 'static>(self, path: &str, h: H) -> Self {
        self.add(MethodFilter::GET, "GET", path, h)
    }
    pub fn post<H: Handler<T, S>, T: 'static>(self, path: &str, h: H) -> Self {
        self.add(MethodFilter::POST, "POST", path, h)
    }
    pub fn patch<H: Handler<T, S>, T: 'static>(self, path: &str, h: H) -> Self {
        self.add(MethodFilter::PATCH, "PATCH", path, h)
    }
    pub fn delete<H: Handler<T, S>, T: 'static>(self, path: &str, h: H) -> Self {
        self.add(MethodFilter::DELETE, "DELETE", path, h)
    }
    pub fn put<H: Handler<T, S>, T: 'static>(self, path: &str, h: H) -> Self {
        self.add(MethodFilter::PUT, "PUT", path, h)
    }

    /// 소켓 줄(GET 업그레이드) — 목록에는 `sockets` 로 따로.
    pub fn socket<H: Handler<T, S>, T: 'static>(mut self, path: &str, h: H) -> Self {
        self.router = self.router.route(path, on(MethodFilter::GET, h));
        self.sockets.push(format!("GET {path}"));
        self
    }

    /// 지금까지 붙인 줄 전체에 층을 씌운다(`Router::route_layer`·`Router::layer` 그대로).
    pub fn map(mut self, f: impl FnOnce(Router<S>) -> Router<S>) -> Self {
        self.router = f(self.router);
        self
    }

    /// 다른 표를 합친다(목록도 합친다).
    pub fn merge(mut self, other: Table<S>) -> Self {
        self.router = self.router.merge(other.router);
        self.keys.extend(other.keys);
        self.sockets.extend(other.sockets);
        self
    }

    pub fn finish(self) -> Routes<S> {
        Routes {
            router: self.router,
            http: self.keys,
            sockets: self.sockets,
        }
    }
}

/// 코어 줄과 **같은 경로의 다른 메서드**를 TS 로 넘긴다 — 경로마다 `MethodRouter` 의 「메서드 없음」 자리에 `proxy::forward` 를 단다.
///
/// 왜: axum 은 경로가 맞고 메서드가 없으면 405 를 낸다. 앞단 라우터(`routes.rs`)의 `.fallback(forward)` 는 **경로가 없을 때**만
/// 불리므로, 코어가 `GET /channels/{id}/messages` 만 붙이면 같은 경로의 `POST`(글 쓰기)가 TS 로 가지 못하고 405 가 된다.
/// 옮긴 줄(S5.2)은 `routes.rs` 가 경로마다 같은 일을 한다. 이미 자기 fallback 이 있는 경로는 건드리지 않는다(axum `default_fallback`).
/// 코어 라우터를 다 합친 **뒤**, 앞단 라우터와 합치기 **전**에 한 번 부른다(`main.rs`).
pub fn ts_fallback(router: Router, up: crate::proxy::Upstream) -> Router {
    router.method_not_allowed_fallback(
        move |ci: axum::extract::ConnectInfo<std::net::SocketAddr>,
              req: axum::http::Request<axum::body::Body>| {
            let up = up.clone();
            async move { crate::proxy::forward(axum::extract::State(up), ci, req).await }
        },
    )
}

pub struct Routes<S> {
    pub router: Router<S>,
    /// `"METHOD /path"` — 교차 출처로 불리는 HTTP 줄.
    pub http: Vec<String>,
    pub sockets: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_every_route_and_same_path_methods_merge() {
        let r = Table::<()>::new()
            .get("/a", || async { "a" })
            .patch("/b/{id}", || async { "p" })
            .delete("/b/{id}", || async { "d" })
            .socket("/s", || async { "s" })
            .finish();
        assert_eq!(r.http, vec!["GET /a", "PATCH /b/{id}", "DELETE /b/{id}"]);
        assert_eq!(r.sockets, vec!["GET /s"]);
    }
}
