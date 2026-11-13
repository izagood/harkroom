//! 라우트 표(S5.2 P0) — 어느 (메서드, 경로) 를 Rust 가 답하고 어느 것을 TS 로 넘기는지 한 곳에서 정한다.
//!
//! - `MOVED` 에 적힌 줄만 Rust 가 답한다. 나머지는 전부 `proxy::forward` 로 TS 에 간다(지금까지와 같다).
//! - 같은 경로라도 옮기지 않은 메서드는 TS 로 간다 — 경로마다 `MethodRouter::fallback(forward)` 를 단다(405 가 나지 않게).
//! - 운영에서 줄 하나를 TS 로 되돌릴 때는 다시 빌드하지 않고 env `HARKROOM_FRONT_TS_ROUTES` 를 쓴다:
//!   `"GET /accounts,GET /dms"` 처럼 줄 key 를 쉼표로, 또는 `*` 로 전부. 되돌린 줄은 마운트하지 않으므로 그대로 TS 로 넘어간다.
//! - 인증 미들웨어(`auth::layer`)는 옮긴 메서드에만 건다. TS 로 넘기는 요청은 앞단에서 DB 를 읽지 않는다.
//!
//! 줄을 더할 때(P1~) 주의: axum 은 고정 경로를 `{param}` 보다 먼저 고른다. `/x/{id}` 를 옮기면 `/x/me` 처럼 TS 에만 있는
//! 고정 경로도 같은 메서드면 Rust 로 온다 — 그 PR 이 TS 라우트 목록과 대조해 막는다(`tests/routes.rs` 의 시험이 표 안의 겹침을 본다).
use crate::proxy::{self, Upstream};
use axum::Router;
use axum::extract::FromRef;
use axum::routing::MethodRouter;
use sqlx::PgPool;
use std::collections::{BTreeMap, HashSet};

/// 옮긴 라우트가 받는 상태. 프록시는 `Upstream` 만 꺼내 쓴다.
#[derive(Clone)]
pub struct AppState {
    pub up: Upstream,
    pub pool: PgPool,
}

impl FromRef<AppState> for Upstream {
    fn from_ref(s: &AppState) -> Self {
        s.up.clone()
    }
}

impl FromRef<AppState> for PgPool {
    fn from_ref(s: &AppState) -> Self {
        s.pool.clone()
    }
}

/// 표의 한 줄. `key` 는 `"GET /accounts"` 꼴로 되돌림 env 에 쓰는 이름이고, `path` 는 axum 경로(`/x/{id}`)다.
pub struct Moved {
    pub key: &'static str,
    pub path: &'static str,
    /// 이 메서드 하나만 담은 `MethodRouter`(예: `|| axum::routing::get(handler)`).
    pub route: fn() -> MethodRouter<AppState>,
}

/// Rust 가 답하는 줄. 묶음마다 더한다 — P1 읽기① 디렉터리(`directory.rs`) · P2 읽기② 목록(`lists.rs`).
/// `/x/{id}` 꼴을 더하면 `tests/routes.rs::moved_params_do_not_shadow_ts_static_paths` 가 TS 고정 경로와의 겹침을 본다.
pub const MOVED: &[Moved] = &[
    Moved {
        key: "GET /accounts",
        path: "/accounts",
        route: || axum::routing::get(crate::directory::accounts),
    },
    Moved {
        key: "GET /dms",
        path: "/dms",
        route: || axum::routing::get(crate::directory::dms),
    },
    Moved {
        key: "GET /mcp-servers",
        path: "/mcp-servers",
        route: || axum::routing::get(crate::directory::mcp_servers),
    },
    Moved {
        key: "GET /audit",
        path: "/audit",
        route: || axum::routing::get(crate::directory::audit),
    },
    // P2 읽기② 목록(`lists.rs`).
    Moved {
        key: "GET /teams",
        path: "/teams",
        route: || axum::routing::get(crate::lists::teams),
    },
    Moved {
        key: "GET /teams/{id}",
        path: "/teams/{id}",
        route: || axum::routing::get(crate::lists::team),
    },
    Moved {
        key: "GET /handle-groups",
        path: "/handle-groups",
        route: || axum::routing::get(crate::lists::handle_groups),
    },
    Moved {
        key: "GET /handle-groups/{id}",
        path: "/handle-groups/{id}",
        route: || axum::routing::get(crate::lists::handle_group),
    },
    Moved {
        key: "GET /skills",
        path: "/skills",
        route: || axum::routing::get(crate::lists::skills),
    },
    Moved {
        key: "GET /skills/{slug}",
        path: "/skills/{slug}",
        route: || axum::routing::get(crate::lists::skill),
    },
    Moved {
        key: "GET /settings/agent-defaults",
        path: "/settings/agent-defaults",
        route: || axum::routing::get(crate::lists::agent_defaults),
    },
    Moved {
        key: "GET /settings/mention-policy",
        path: "/settings/mention-policy",
        route: || axum::routing::get(crate::lists::mention_policy),
    },
];

/// `HARKROOM_FRONT_TS_ROUTES` 를 읽은 결과.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TsOverrides {
    pub all: bool,
    pub keys: HashSet<String>,
}

impl TsOverrides {
    pub fn parse(raw: Option<&str>) -> Self {
        let mut o = Self::default();
        for k in raw.unwrap_or("").split(',').map(str::trim) {
            match k {
                "" => {}
                "*" => o.all = true,
                k => {
                    // `get  /x` 처럼 써도 같은 줄로 읽는다 — 메서드는 대문자, 사이 공백은 하나로.
                    let mut it = k.split_whitespace();
                    if let (Some(m), Some(p), None) = (it.next(), it.next(), it.next()) {
                        o.keys.insert(format!("{} {p}", m.to_ascii_uppercase()));
                    } else {
                        o.keys.insert(k.to_string());
                    }
                }
            }
        }
        o
    }

    fn sends_to_ts(&self, key: &str) -> bool {
        self.all || self.keys.contains(key)
    }

    /// 표에 없는 key — 오타면 되돌림이 조용히 안 먹으므로 기동 때 알린다.
    pub fn unknown<'a>(&'a self, table: &[Moved]) -> Vec<&'a str> {
        let mut v: Vec<&str> = self
            .keys
            .iter()
            .filter(|k| !table.iter().any(|m| m.key == k.as_str()))
            .map(String::as_str)
            .collect();
        v.sort_unstable();
        v
    }
}

/// 실제로 Rust 가 답할 줄의 key — 기동 기록·시험용.
pub fn active<'a>(table: &'a [Moved], ts: &TsOverrides) -> Vec<&'a str> {
    table
        .iter()
        .filter(|m| !ts.sends_to_ts(m.key))
        .map(|m| m.key)
        .collect()
}

pub fn router(state: AppState, table: &[Moved], ts: &TsOverrides) -> Router {
    // 경로별로 메서드를 모은다. BTreeMap 이라 마운트 순서가 늘 같다.
    let mut by_path: BTreeMap<&str, MethodRouter<AppState>> = BTreeMap::new();
    for m in table.iter().filter(|m| !ts.sends_to_ts(m.key)) {
        let r = (m.route)();
        let merged = match by_path.remove(m.path) {
            Some(prev) => prev.merge(r),
            None => r,
        };
        by_path.insert(m.path, merged);
    }
    let mut app: Router<AppState> =
        Router::new().route("/front/healthz", axum::routing::get(proxy::front_health));
    for (path, mr) in by_path {
        let mr = mr
            .route_layer(axum::middleware::from_fn_with_state(
                state.pool.clone(),
                crate::auth::layer,
            ))
            .fallback(proxy::forward);
        app = app.route(path, mr);
    }
    app.fallback(proxy::forward).with_state(state)
}
