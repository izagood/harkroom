//! S5.4 MI3 — 설정 REST 의 남은 읽기 한 줄. TS `routes/settingsRoutes.ts` 의 `GET /settings/projection` 을 옮긴다.
//!
//! - `GET`·`PUT /settings/agent-defaults` 는 이미 앞단에 있다(`/settings/mention-policy` 는 O2 에서 없앴다)(S5.2 `lists.rs`·`writes_settings.rs`).
//!   둘 다 서비스에 캐시가 없다 — TS 는 쓰임마다 DB 를 읽는다(`mentionPolicy.ts` 「캐시하지 않는다」, `createAgentAccount` 는
//!   `getAgentDefaults` 를 그때 읽는다).
//! - `GET /settings/projection` 은 TS 와 같이 매번 `projection_config` 를 읽는다(TS `getProjectionConfig` 도 캐시 없음).
//!   판정은 shared `resolveProjectionUrl` 그대로: 앱 값(표준형이 되면)이 이기고, 아니면 env `AVCS_BASE_URL`, 아니면 null.
//!   `envUrl` 은 TS `config.avcsBaseUrl`(`env.AVCS_BASE_URL ?? null`, 다듬지 않음)과 같이 원문이다.
//! - `PUT /settings/projection` — 쓰기 풀에 [`SETTINGS_PROJECTION_WRITE_PRIVILEGES`] 가 있을 때만. Rust 투영 루프는 사이클마다
//!   `projection_config` 를 다시 읽으므로 TS 의 `reconfigure` 에 해당하는 일이 없다(저장이 곧 재설정이다).
//! - 권한은 [`SETTINGS_REST_PRIVILEGES`](읽기 풀) — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAdmin;
use crate::directory::{internal, json_err, json_ok};
use crate::write::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀이 쓰는 권한(표, 권한).
pub const SETTINGS_REST_PRIVILEGES: &[(&str, &str)] = &[("projection_config", "SELECT")];

/// `PUT /settings/projection` 이 쓰기 풀에 바라는 권한.
pub const SETTINGS_PROJECTION_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("projection_config", "SELECT"),
    ("projection_config.avcs_base_url", "UPDATE"),
    ("audit_log", "INSERT"),
];

#[derive(Clone)]
pub struct SettingsRestState {
    pub read: PgPool,
    /// 쓰기 풀 — 있으면 `PUT` 도 단다.
    pub write: Option<PgPool>,
    pub trust: Arc<crate::trust_proxy::TrustProxy>,
    /// `AVCS_BASE_URL` 원문(없으면 None). TS `config.avcsBaseUrl` 과 같은 값이어야 한다 — 두 프로세스에 같은 env 를 준다.
    pub env_base_url: Option<String>,
}

/// shared `canonicalAvcsBaseUrl` — WHATWG URL 로 읽어 `protocol//host + pathname(끝 / 제거)`. 앞뒤 공백·C0 는 파서가 떼어 낸다.
pub fn canonical_avcs_base_url(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let host = u.host_str()?;
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!(
        "{}://{host}{port}{}",
        u.scheme(),
        u.path().trim_end_matches('/')
    ))
}

/// shared `resolveProjectionUrl` — (url, source). 빈 문자열은 값이 아니다.
pub fn resolve_projection_url(
    env_url: Option<&str>,
    app_url: Option<&str>,
) -> (Option<String>, Option<&'static str>) {
    if let Some(a) = app_url
        .filter(|s| !s.is_empty())
        .and_then(canonical_avcs_base_url)
    {
        return (Some(a), Some("app"));
    }
    if let Some(e) = env_url
        .filter(|s| !s.is_empty())
        .and_then(canonical_avcs_base_url)
    {
        return (Some(e), Some("env"));
    }
    (None, None)
}

/// `GET /settings/projection` — admin. TS `view()` 와 같은 네 칸.
pub async fn get_projection(State(st): State<Arc<SettingsRestState>>, _: RequireAdmin) -> Response {
    let app: Option<Option<String>> =
        match sqlx::query_scalar("select avcs_base_url from projection_config where id = true")
            .fetch_optional(&st.read)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
    let app = app.flatten();
    let (url, source) = resolve_projection_url(st.env_base_url.as_deref(), app.as_deref());
    json_ok(
        json!({ "url": url, "source": source, "appUrl": app, "envUrl": st.env_base_url })
            .to_string(),
    )
}

/// TS `PROJECTION_URL.nullable()` — trim·1..=512(UTF-16)·http(s)·쿼리/프래그먼트/사용자 이름 없음. `None` 은 zod 거절.
pub fn parse_projection_body(body: &Body) -> Option<Option<String>> {
    let Body::Json(serde_json::Value::Object(o)) = body else {
        return None;
    };
    match o.get("url") {
        Some(serde_json::Value::Null) => Some(None),
        Some(serde_json::Value::String(raw)) => {
            let v = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            let n = v.encode_utf16().count();
            if n == 0 || n > 512 {
                return None;
            }
            let u = url::Url::parse(v).ok()?;
            if u.scheme() != "http" && u.scheme() != "https" {
                return None;
            }
            if u.query().is_some_and(|q| !q.is_empty())
                || u.fragment().is_some_and(|f| !f.is_empty())
                || !u.username().is_empty()
            {
                return None;
            }
            Some(Some(
                canonical_avcs_base_url(v).unwrap_or_else(|| v.to_owned()),
            ))
        }
        _ => None,
    }
}

async fn view(
    pool: &PgPool,
    env: Option<&str>,
) -> Result<(Option<String>, Option<String>, Option<&'static str>), sqlx::Error> {
    let app: Option<Option<String>> =
        sqlx::query_scalar("select avcs_base_url from projection_config where id = true")
            .fetch_optional(pool)
            .await?;
    let app = app.flatten();
    let (url, source) = resolve_projection_url(env, app.as_deref());
    Ok((app, url, source))
}

/// `PUT /settings/projection` — admin. 저장 → 판정 결과를 돌려주고 `projection.url.updated` 감사를 남긴다.
pub async fn put_projection(State(st): State<Arc<SettingsRestState>>, req: Request) -> Response {
    let (body, RequireAdmin(me), parts) =
        match crate::writes_settings::body_then::<RequireAdmin>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let Some(stored) = parse_projection_body(&body) else {
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "url");
    };
    let Some(pool) = st.write.as_ref() else {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    let env = st.env_base_url.as_deref();
    let before = match view(pool, env).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if let Err(e) = sqlx::query("update projection_config set avcs_base_url = $1 where id = true")
        .bind(&stored)
        .execute(pool)
        .await
    {
        return internal(e);
    }
    let after = match view(pool, env).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let ip = crate::trust_proxy::request_ip(&parts, &st.trust);
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "projection.url.updated",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({
                "before": { "appUrl": before.0, "source": before.2 },
                "after": { "appUrl": after.0, "source": after.2 },
            }),
        },
    )
    .await;
    json_ok(
        json!({ "url": after.1, "source": after.2, "appUrl": after.0, "envUrl": st.env_base_url })
            .to_string(),
    )
}

pub fn routes(
    st: SettingsRestState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SettingsRestState>>::new().get("/settings/projection", get_projection);
    let t = if st.write.is_some() {
        t.put("/settings/projection", put_projection)
    } else {
        t
    };
    let t = t
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_body_follows_zod() {
        let p = |v: serde_json::Value| parse_projection_body(&Body::Json(v));
        assert_eq!(p(json!({ "url": null })), Some(None));
        assert_eq!(
            p(json!({ "url": " http://A.example:80/x/ " })),
            Some(Some("http://a.example/x".into()))
        );
        assert_eq!(p(json!({})), None);
        assert_eq!(p(json!({ "url": "" })), None);
        assert_eq!(p(json!({ "url": "ftp://a" })), None);
        assert_eq!(p(json!({ "url": "http://a/?q=1" })), None);
        assert_eq!(p(json!({ "url": "http://u@a/" })), None);
        assert_eq!(parse_projection_body(&Body::None), None);
    }

    #[test]
    fn canonical_follows_shared() {
        let c = canonical_avcs_base_url;
        assert_eq!(
            c("http://A.example:3000/").as_deref(),
            Some("http://a.example:3000")
        );
        assert_eq!(
            c("https://a.example:443/x//").as_deref(),
            Some("https://a.example/x")
        );
        assert_eq!(
            c("http://a.example:80").as_deref(),
            Some("http://a.example")
        );
        assert_eq!(
            c("  http://a.example/  ").as_deref(),
            Some("http://a.example")
        );
        assert_eq!(
            c("http://a.example/p?q=1#h").as_deref(),
            Some("http://a.example/p")
        );
        assert_eq!(c("ftp://a.example"), None);
        assert_eq!(c("nope"), None);
    }

    #[test]
    fn app_wins_then_env() {
        assert_eq!(
            resolve_projection_url(Some("http://e/"), Some("http://a/")),
            (Some("http://a".into()), Some("app"))
        );
        assert_eq!(
            resolve_projection_url(Some("http://e/"), None),
            (Some("http://e".into()), Some("env"))
        );
        assert_eq!(
            resolve_projection_url(Some("http://e/"), Some("")),
            (Some("http://e".into()), Some("env"))
        );
        assert_eq!(resolve_projection_url(Some(""), None), (None, None));
        assert_eq!(resolve_projection_url(Some("bad"), None), (None, None));
    }
}
