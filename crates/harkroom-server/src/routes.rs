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
    /// 쓰기 풀(P3) — env `DATABASE_WRITE_URL` 이 있을 때만. 없으면 [`MOVED_WRITE`] 줄을 마운트하지 않는다(그 요청은 TS 로 간다).
    pub write: Option<PgPool>,
    /// 감사 `ip` 를 고르는 규칙(env `TRUST_PROXY`, `trust_proxy.rs`). 기본은 안 믿음(소켓 주소).
    pub trust: std::sync::Arc<crate::trust_proxy::TrustProxy>,
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
#[derive(Clone, Copy)]
pub struct Moved {
    pub key: &'static str,
    pub path: &'static str,
    /// 이 메서드 하나만 담은 `MethodRouter`(예: `|| axum::routing::get(handler)`).
    pub route: fn() -> MethodRouter<AppState>,
}

/// Rust 가 답하는 줄. 묶음마다 더한다 — P1 읽기① 디렉터리(`directory.rs`) · P2 읽기② 목록(`lists.rs`) · P2b 인박스 「오늘」(`inbox_today.rs`).
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
    // P2b 인박스 「오늘」(`inbox_today.rs`) — ETag/304.
    Moved {
        key: "GET /inbox/today/open",
        path: "/inbox/today/open",
        route: || axum::routing::get(crate::inbox_today::open),
    },
    Moved {
        key: "GET /inbox/today/done",
        path: "/inbox/today/done",
        route: || axum::routing::get(crate::inbox_today::done),
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
    // P4c 신고·차단 읽기(`writes_moderation.rs`).
    Moved {
        key: "GET /admin/reports",
        path: "/admin/reports",
        route: || axum::routing::get(crate::writes_moderation::list_reports),
    },
    Moved {
        key: "GET /accounts/me/blocks",
        path: "/accounts/me/blocks",
        route: || axum::routing::get(crate::writes_moderation::list_blocks),
    },
    // P4c-2 작업 항목 읽기(`writes_misc.rs`).
    Moved {
        key: "GET /work-items",
        path: "/work-items",
        route: || axum::routing::get(crate::writes_misc::list_items),
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

/// 쓰는 줄(P3~). 쓰기 풀이 있을 때만 마운트한다 — 읽기 전용 역할로 뜬 앞단에서 쓰기를 시도하지 않게.
pub const MOVED_WRITE: &[Moved] = &[
    Moved {
        key: "PUT /inbox/today/seen",
        path: "/inbox/today/seen",
        route: || axum::routing::put(crate::inbox_today::put_seen),
    },
    // P4a 가벼운 쓰기①(`writes_settings.rs`).
    Moved {
        key: "PUT /settings/agent-defaults",
        path: "/settings/agent-defaults",
        route: || axum::routing::put(crate::writes_settings::put_agent_defaults),
    },
    Moved {
        key: "PUT /settings/mention-policy",
        path: "/settings/mention-policy",
        route: || axum::routing::put(crate::writes_settings::put_mention_policy),
    },
    Moved {
        key: "POST /skills/usage",
        path: "/skills/usage",
        route: || axum::routing::post(crate::writes_settings::post_usage),
    },
    Moved {
        key: "POST /skills/{slug}/approve",
        path: "/skills/{slug}/approve",
        route: || axum::routing::post(crate::writes_settings::approve_skill),
    },
    Moved {
        key: "DELETE /skills/{slug}",
        path: "/skills/{slug}",
        route: || axum::routing::delete(crate::writes_settings::disable_skill),
    },
    // P4b 팀·집합(`writes_teams.rs`·`writes_groups.rs`). 채널에 팀 넣기는 S5.3.
    Moved {
        key: "POST /teams",
        path: "/teams",
        route: || axum::routing::post(crate::writes_teams::create_team),
    },
    Moved {
        key: "PATCH /teams/{id}",
        path: "/teams/{id}",
        route: || axum::routing::patch(crate::writes_teams::rename_team),
    },
    Moved {
        key: "DELETE /teams/{id}",
        path: "/teams/{id}",
        route: || axum::routing::delete(crate::writes_teams::delete_team),
    },
    Moved {
        key: "PUT /teams/{id}/scope",
        path: "/teams/{id}/scope",
        route: || axum::routing::put(crate::writes_teams::set_scope),
    },
    Moved {
        key: "PUT /teams/{id}/lead",
        path: "/teams/{id}/lead",
        route: || axum::routing::put(crate::writes_teams::set_lead),
    },
    Moved {
        key: "PUT /teams/{id}/invokers/{accountId}",
        path: "/teams/{id}/invokers/{accountId}",
        route: || axum::routing::put(crate::writes_teams::put_invoker),
    },
    Moved {
        key: "DELETE /teams/{id}/invokers/{accountId}",
        path: "/teams/{id}/invokers/{accountId}",
        route: || axum::routing::delete(crate::writes_teams::delete_invoker),
    },
    Moved {
        key: "PUT /teams/{id}/members/{accountId}",
        path: "/teams/{id}/members/{accountId}",
        route: || axum::routing::put(crate::writes_teams::put_member),
    },
    Moved {
        key: "DELETE /teams/{id}/members/{accountId}",
        path: "/teams/{id}/members/{accountId}",
        route: || axum::routing::delete(crate::writes_teams::delete_member),
    },
    Moved {
        key: "POST /handle-groups",
        path: "/handle-groups",
        route: || axum::routing::post(crate::writes_groups::create_group),
    },
    Moved {
        key: "PATCH /handle-groups/{id}",
        path: "/handle-groups/{id}",
        route: || axum::routing::patch(crate::writes_groups::rename_group),
    },
    Moved {
        key: "DELETE /handle-groups/{id}",
        path: "/handle-groups/{id}",
        route: || axum::routing::delete(crate::writes_groups::delete_group),
    },
    Moved {
        key: "POST /handle-groups/{id}/members",
        path: "/handle-groups/{id}/members",
        route: || axum::routing::post(crate::writes_groups::add_members),
    },
    Moved {
        key: "DELETE /handle-groups/{id}/members",
        path: "/handle-groups/{id}/members",
        route: || axum::routing::delete(crate::writes_groups::remove_members),
    },
    // P4c 신고·차단(`writes_moderation.rs`). 신고 올리기(POST /messages/{id}/report)는 프로세스 메모리 상한 때문에 TS 에 남는다.
    Moved {
        key: "POST /admin/reports/{id}/resolve",
        path: "/admin/reports/{id}/resolve",
        route: || axum::routing::post(crate::writes_moderation::resolve_report),
    },
    Moved {
        key: "PUT /accounts/me/blocks/{id}",
        path: "/accounts/me/blocks/{id}",
        route: || axum::routing::put(crate::writes_moderation::put_block),
    },
    Moved {
        key: "DELETE /accounts/me/blocks/{id}",
        path: "/accounts/me/blocks/{id}",
        route: || axum::routing::delete(crate::writes_moderation::delete_block),
    },
    // P4c-2 작업 항목·스레드 임대·푸시 기기(`writes_misc.rs`). PUT /work-items 는 위임장 끝내기 때문에 TS 에 남는다.
    Moved {
        key: "DELETE /work-items/{id}",
        path: "/work-items/{id}",
        route: || axum::routing::delete(crate::writes_misc::delete_item),
    },
    Moved {
        key: "POST /agent/thread-claims",
        path: "/agent/thread-claims",
        route: || axum::routing::post(crate::writes_misc::claim),
    },
    Moved {
        key: "POST /agent/thread-claims/release",
        path: "/agent/thread-claims/release",
        route: || axum::routing::post(crate::writes_misc::release),
    },
    Moved {
        key: "PUT /push/devices",
        path: "/push/devices",
        route: || axum::routing::put(crate::writes_misc::put_device),
    },
    Moved {
        key: "DELETE /push/devices/current",
        path: "/push/devices/current",
        route: || axum::routing::delete(crate::writes_misc::delete_device),
    },
];

/// 이번 기동에 실제로 마운트할 쓰는 줄.
pub fn writes_for(state: &AppState) -> &'static [Moved] {
    if state.write.is_some() {
        MOVED_WRITE
    } else {
        &[]
    }
}

pub fn router(state: AppState, table: &[Moved], ts: &TsOverrides) -> Router {
    // 경로별로 메서드를 모은다. BTreeMap 이라 마운트 순서가 늘 같다.
    let mut by_path: BTreeMap<&str, MethodRouter<AppState>> = BTreeMap::new();
    let writes = writes_for(&state);
    for m in table
        .iter()
        .chain(writes)
        .filter(|m| !ts.sends_to_ts(m.key))
    {
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
                crate::auth::AuthPools {
                    read: state.pool.clone(),
                    write: state.write.clone(),
                },
                crate::auth::layer,
            ))
            .fallback(proxy::forward);
        app = app.route(path, mr);
    }
    app.fallback(proxy::forward).with_state(state)
}
