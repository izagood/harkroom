//! S5.4 — 아바타 읽기 두 줄. TS `routes/avatarRoutes.ts` 의 GET 둘과 `services/avatars.ts`
//! (`findAvatarTarget`·`findAvatarSourceTarget`)를 옮긴다.
//!
//! - `GET /accounts/{id}/avatar`: 걸린 아바타 바이트. 헤더는 TS 그대로(`nosniff`, `content-disposition: attachment`,
//!   `content-length`(행의 `size_bytes`), `content-type`(행 값 그대로 — 설정 때 매직 바이트로 덮어쓴 값)).
//!   **`raster=1` + SVG 는 TS 에 넘긴다**: TS 는 sharp(libvips)로 PNG 를 굳히는데, 같은 바이트를 Rust 에서 낼 수 없다.
//!   `raster` 가 `1` 하나가 아닌 꼴(다른 값·여럿·인코딩된 키)도 TS 에 넘긴다 — zod 400 을 TS 가 그대로 낸다.
//! - `GET /accounts/{id}/avatar/source`: 사진 맞추기 원본 + `x-harkroom-avatar-source` 헤더. 자기 자신이 아니면
//!   `checkOwnerOrAdmin` 판정 후 대상이 에이전트일 때만(사람 계정 원본은 admin 도 403).
//! - 파일이 없으면(행은 있고 파일 없음) TS 는 `AttachmentMissingError` 를 그대로 던진다 → 500.
//! - PUT 둘(`/accounts/me/avatar`·`/accounts/agents/{id}/avatar`)은 `avatar_write.rs` 가 옮긴다(래스터 그림은 TS 로).
use super::attachment_download::stream_file;
use super::attachment_store::{LocalStorage, StoreError};
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::proxy::Upstream;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, RawQuery, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 읽기 역할이 이 두 줄에 필요한 권한(`checkOwnerOrAdmin` 의 `agent_config` 포함).
pub const AVATAR_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.avatar_attachment_id", "SELECT"),
    ("account.avatar_source_attachment_id", "SELECT"),
    ("account.avatar_crop", "SELECT"),
    ("attachment.id", "SELECT"),
    ("attachment.storage_key", "SELECT"),
    ("attachment.content_type", "SELECT"),
    ("attachment.size_bytes", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
];

const TARGET_SQL: &str = "select a.id::text, a.storage_key, a.content_type, a.size_bytes::int \
     from account acc join attachment a on a.id = acc.avatar_attachment_id where acc.id = $1::uuid";

const SOURCE_SQL: &str = "select a.id::text, a.storage_key, a.content_type, a.size_bytes::int, \
     acc.avatar_crop::text from account acc join attachment a on a.id = acc.avatar_source_attachment_id \
     where acc.id = $1::uuid";

pub const AVATAR_SOURCE_HEADER: &str = "x-harkroom-avatar-source";

#[derive(Clone)]
pub struct AvatarReadState {
    pub read: PgPool,
    pub storage: LocalStorage,
    pub up: Upstream,
}

/// `raster` 쿼리 판정. `Some(true)`: `raster=1` 하나, `Some(false)`: 없음, `None`: 그 밖의 꼴(→ TS).
pub fn raster_of(q: Option<&str>) -> Option<bool> {
    let Some(q) = q else { return Some(false) };
    let mut seen = 0;
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k.contains('%') || k.contains('+') {
            return None;
        }
        if k == "raster" {
            seen += 1;
            if v != "1" {
                return None;
            }
        }
    }
    match seen {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// JSON 객체 하나를 키 순서 그대로 읽는다(serde_json `Map` 은 키를 정렬한다 — JS `JSON.stringify` 는 순서를 지킨다).
struct Ordered(Vec<(String, Value)>);

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut m: A,
            ) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// TS `JSON.stringify({ attachmentId, crop })`. `crop` 은 jsonb 의 글 꼴(키 순서는 jsonb 가 정한 순서 —
/// node-pg 가 그 순서로 객체를 만든다).
pub fn source_meta(attachment_id: &str, crop: Option<&str>) -> String {
    let crop = match crop {
        None => "null".to_string(),
        Some(t) => match serde_json::from_str::<Ordered>(t) {
            Ok(Ordered(kv)) => {
                let parts: Vec<String> = kv
                    .iter()
                    .map(|(k, v)| format!("{}:{}", Value::String(k.clone()), v))
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
            // 객체가 아니면(손으로 넣은 값) serde 가 다시 쓴 글 꼴.
            Err(_) => serde_json::from_str::<Value>(t)
                .map(|v| v.to_string())
                .unwrap_or_else(|_| "null".into()),
        },
    };
    format!(
        "{{\"attachmentId\":{},\"crop\":{crop}}}",
        Value::String(attachment_id.to_string())
    )
}

fn invalid_id() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "params: invalid uuid",
    )
}

fn internal_plain() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

/// 파일을 열어 TS 와 같은 헤더로 내준다. `extra` 는 원본 줄의 메타 헤더.
async fn serve(
    storage: &LocalStorage,
    att_id: &str,
    key: &str,
    content_type: &str,
    size_bytes: i32,
    extra: Option<String>,
) -> Response {
    let file = match storage.read(key).await {
        Ok(f) => f,
        Err(StoreError::Missing { path, .. }) => {
            eprintln!(
                "avatar {att_id} row exists but file is missing at {}",
                path.display()
            );
            return internal_plain();
        }
        Err(e) => {
            eprintln!("avatar {att_id}: storage read failed ({e})");
            return internal_plain();
        }
    };
    let Ok(ct) = HeaderValue::from_str(content_type) else {
        return internal_plain();
    };
    let mut r = Response::new(stream_file(file));
    let h = r.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size_bytes));
    if let Some(meta) = extra {
        let Ok(v) = HeaderValue::from_str(&meta) else {
            return internal_plain();
        };
        h.insert(AVATAR_SOURCE_HEADER, v);
    }
    h.insert(header::CONTENT_TYPE, ct);
    r
}

type TargetRow = (String, String, String, i32);

pub async fn avatar(
    State(st): State<Arc<AvatarReadState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RequireAccount(_me, _): RequireAccount,
    Path(id): Path<String>,
    RawQuery(q): RawQuery,
    req: Request,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        return invalid_id();
    }
    let Some(raster) = raster_of(q.as_deref()) else {
        return to_ts(st.up.clone(), peer, req).await;
    };
    let row: Option<TargetRow> = match sqlx::query_as(TARGET_SQL)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((att_id, key, content_type, size)) = row else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no avatar");
    };
    if raster && content_type == "image/svg+xml" {
        // sharp 로 굳힌 PNG 는 TS 만 낸다.
        return to_ts(st.up.clone(), peer, req).await;
    }
    serve(&st.storage, &att_id, &key, &content_type, size, None).await
}

async fn to_ts(up: Upstream, peer: SocketAddr, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    crate::proxy::forward(
        State(up),
        ConnectInfo(peer),
        Request::from_parts(parts, Body::new(body)),
    )
    .await
}

type SourceRow = (String, String, String, i32, Option<String>);

pub async fn avatar_source(
    State(st): State<Arc<AvatarReadState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        return invalid_id();
    }
    if id != me.id {
        match check_owner_or_admin(&st.read, &me, &id).await {
            Ok(Verdict::Refused(s, code, msg)) => return json_err(s, code, msg),
            Ok(_) => {}
            Err(e) => return internal(e),
        }
        let agent: Option<i32> = match sqlx::query_scalar(
            "select 1 from account where id = $1::uuid and kind = 'agent'",
        )
        .bind(&id)
        .fetch_optional(&st.read)
        .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        if agent.is_none() {
            return json_err(StatusCode::FORBIDDEN, "forbidden", "not yours");
        }
    }
    let row: Option<SourceRow> = match sqlx::query_as(SOURCE_SQL)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((att_id, key, content_type, size, crop)) = row else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no avatar source");
    };
    let meta = source_meta(&att_id, crop.as_deref());
    serve(&st.storage, &att_id, &key, &content_type, size, Some(meta)).await
}

pub fn routes(
    st: AvatarReadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AvatarReadState>>::new()
        .get("/accounts/{id}/avatar", avatar)
        .get("/accounts/{id}/avatar/source", avatar_source)
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

/// S5.4 — `GET /workspace/icon`(TS `routes/workspaceRoutes.ts` · `findWorkspaceIcon`)이 읽기 역할에 쓰는 권한.
/// 아바타 줄과 따로 본다 — 이 칸이 없다고 아바타 읽기까지 TS 로 떨어지지 않게.
pub const WORKSPACE_ICON_PRIVILEGES: &[(&str, &str)] = &[
    ("workspace_profile.id", "SELECT"),
    ("workspace_profile.icon_attachment_id", "SELECT"),
    ("attachment.id", "SELECT"),
    ("attachment.storage_key", "SELECT"),
    ("attachment.content_type", "SELECT"),
    ("attachment.size_bytes", "SELECT"),
];

const ICON_SQL: &str = "select a.id::text, a.storage_key, a.content_type, a.size_bytes::int \
     from workspace_profile w join attachment a on a.id = w.icon_attachment_id where w.id = true";

/// `GET /workspace/icon` — 아바타와 같은 헤더에 `etag: "<attachmentId>"` 를 더한다.
pub async fn workspace_icon(
    State(st): State<Arc<AvatarReadState>>,
    RequireAccount(_me, _): RequireAccount,
) -> Response {
    let row: Option<TargetRow> = match sqlx::query_as(ICON_SQL).fetch_optional(&st.read).await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((att_id, key, content_type, size)) = row else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no workspace icon");
    };
    let mut r = serve(&st.storage, &att_id, &key, &content_type, size, None).await;
    if r.status() == StatusCode::OK
        && let Ok(v) = HeaderValue::from_str(&format!("\"{att_id}\""))
    {
        r.headers_mut().insert(header::ETAG, v);
    }
    r
}

/// `GET /workspace/icon` 한 줄 — [`WORKSPACE_ICON_PRIVILEGES`] 가 있을 때만 `main.rs` 가 붙인다.
pub fn icon_routes(
    st: AvatarReadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AvatarReadState>>::new()
        .get("/workspace/icon", workspace_icon)
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
    fn raster_query_matches_zod() {
        assert_eq!(raster_of(None), Some(false));
        assert_eq!(raster_of(Some("v=3")), Some(false));
        assert_eq!(raster_of(Some("raster=1&v=3")), Some(true));
        assert_eq!(raster_of(Some("raster=2")), None);
        assert_eq!(raster_of(Some("raster")), None);
        assert_eq!(raster_of(Some("raster=1&raster=1")), None);
        assert_eq!(raster_of(Some("r%61ster=1")), None);
    }

    #[test]
    fn source_meta_keeps_jsonb_order() {
        assert_eq!(
            source_meta(
                "00000000-0000-0000-0000-000000000001",
                Some(r#"{"x": 0.1, "y": 0.25, "size": 0.5}"#)
            ),
            r#"{"attachmentId":"00000000-0000-0000-0000-000000000001","crop":{"x":0.1,"y":0.25,"size":0.5}}"#
        );
        assert_eq!(
            source_meta("a", None),
            r#"{"attachmentId":"a","crop":null}"#
        );
        assert_eq!(
            source_meta("a", Some(r#"{"x": 0, "y": 1, "size": 1}"#)),
            r#"{"attachmentId":"a","crop":{"x":0,"y":1,"size":1}}"#
        );
    }
}
