//! S5.4 — 아바타 읽기 두 줄. TS `routes/avatarRoutes.ts` 의 GET 둘과 `services/avatars.ts`
//! (`findAvatarTarget`·`findAvatarSourceTarget`)를 옮긴다.
//!
//! - `GET /accounts/{id}/avatar`: 걸린 아바타 바이트. 헤더는 TS 그대로(`nosniff`, `content-disposition: attachment`,
//!   `content-length`(행의 `size_bytes`), `content-type`(행 값 그대로 — 설정 때 매직 바이트로 덮어쓴 값)).
//!   **`raster=1` + SVG 는 여기서 512×512 PNG 로 굳힌다**(TS `rasterizeSvgAvatar` — sharp/librsvg 대신 resvg). 거절 검사
//!   (`svgRasterRefusal`)·`cover` 맞추기·한 번에 하나·3초 상한·64장 캐시(실패도 담는다)는 TS 그대로다. 바이트는 TS 와
//!   다르다(librsvg 대 resvg, 그리고 TS 는 원래 크기로 그린 뒤 늘리지만 여기서는 512 로 바로 그린다). 글꼴은 넣지 않아
//!   `<text>` 는 그려지지 않고, 내장 래스터(`data:image/...`)도 그리지 않는다.
//!   `raster` 가 `1` 하나가 아닌 꼴(다른 값·여럿)은 zod 처럼 400.
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
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
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

/// `raster` 쿼리 판정. `Some(true)`: `raster=1` 하나, `Some(false)`: 없음, `None`: 그 밖의 꼴(zod 400).
/// 키·값은 node `querystring` 처럼 푼다(`+` 는 공백, `%xx`).
pub fn raster_of(q: Option<&str>) -> Option<bool> {
    let Some(q) = q else { return Some(false) };
    let mut seen = 0;
    for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
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
    RequireAccount(_me, _): RequireAccount,
    Path(id): Path<String>,
    RawQuery(q): RawQuery,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        return invalid_id();
    }
    let Some(raster) = raster_of(q.as_deref()) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "querystring: invalid raster",
        );
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
    if raster
        && content_type == "image/svg+xml"
        && let Some(png) = raster_cached(&st.storage, &att_id, &key, size).await
    {
        let len = png.len();
        let mut r = Response::new(Body::from(png));
        let h = r.headers_mut();
        h.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        h.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
        return r;
    }
    // 굳히지 못했다 — 원래 바이트(SVG)를 낸다(TS 그대로).
    serve(&st.storage, &att_id, &key, &content_type, size, None).await
}

// ── SVG → PNG(`rasterizeSvgAvatar`) ───────────────────────────────

/// `SVG_RASTER_PX`.
pub const SVG_RASTER_PX: u32 = 512;
/// `SVG_RASTER_TIMEOUT_SECONDS`.
const SVG_RASTER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const RASTER_CACHE_MAX: usize = 64;

/// 굳힌 PNG 캐시(첨부 id → PNG, 실패는 `None`). 오래된 것부터 뺀다(Map 삽입 순서 = LRU, TS 그대로).
static RASTER_CACHE: std::sync::Mutex<Vec<(String, Option<bytes::Bytes>)>> =
    std::sync::Mutex::new(Vec::new());
/// 한 번에 하나(세마포어 1). 잡은 뒤 캐시를 다시 보므로 같은 첨부를 동시에 청해도 굳히기는 한 번이다(single-flight).
static RASTER_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn cache_get(id: &str) -> Option<Option<bytes::Bytes>> {
    let mut c = RASTER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let i = c.iter().position(|(k, _)| k == id)?;
    let hit = c.remove(i);
    let v = hit.1.clone();
    c.push(hit);
    Some(v)
}

fn cache_put(id: &str, v: Option<bytes::Bytes>) {
    let mut c = RASTER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    c.retain(|(k, _)| k != id);
    c.push((id.to_string(), v));
    if c.len() > RASTER_CACHE_MAX {
        c.remove(0);
    }
}

async fn raster_cached(
    storage: &LocalStorage,
    att_id: &str,
    key: &str,
    size: i32,
) -> Option<bytes::Bytes> {
    if let Some(hit) = cache_get(att_id) {
        return hit;
    }
    let _gate = RASTER_GATE.lock().await;
    if let Some(hit) = cache_get(att_id) {
        return hit;
    }
    // SVG 는 걸 때 256KiB 상한을 지났다 — 통째로 올려도 된다. 못 읽으면(파일 없음) TS 는 던진다 → 500 은 아래
    // `serve` 가 같은 이유로 낸다. 캐시에는 담지 않는다.
    let svg = read_all(storage, key, size.max(1) as usize).await?;
    let run = tokio::task::spawn_blocking(move || rasterize_svg_avatar(&svg));
    let png = match tokio::time::timeout(SVG_RASTER_TIMEOUT, run).await {
        Ok(Ok(v)) => v.map(bytes::Bytes::from),
        _ => None,
    };
    cache_put(att_id, png.clone());
    png
}

async fn read_all(storage: &LocalStorage, key: &str, want: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = storage.read(key).await.ok()?;
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(want.min(1 << 20));
        file.take(want as u64).read_to_end(&mut out).ok()?;
        Some(out)
    })
    .await
    .ok()?
}

/// `svgRasterRefusal` — 굳히기 전에 거절할 SVG(밖 참조·겹친 SVG data·`@import`·스타일 안 백슬래시).
pub fn svg_raster_refusal(text: &str) -> Option<&'static str> {
    use regex::Regex;
    use std::sync::LazyLock;
    static REF: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)(?:\bhref|\bsrc)\s*=\s*["']\s*|url\(\s*["']?\s*"#).expect("ref")
    });
    static DATA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bdata:").expect("data"));
    static DATA_OK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^image/(?:png|jpeg|gif|webp)[;,]").expect("data ok"));
    static STYLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?is)<style\b[^>]*>(.*?)</style\s*>|\bstyle\s*=\s*("[^"]*"|'[^']*')"#)
            .expect("style")
    });
    let lower = text.to_ascii_lowercase();
    // `(?!#|data:)[^"'\s]`(href·src) / `(?!#|data:)[^)"'\s]`(url) — 겹친 공백은 정규식이 이미 다 먹었다.
    for m in REF.find_iter(text) {
        let rest = &lower[m.end()..];
        let Some(c) = rest.chars().next() else {
            continue;
        };
        let is_url = m.as_str().starts_with(['u', 'U']);
        let stop = c == '"' || c == '\'' || js_space(c) || (is_url && c == ')');
        if !stop && !rest.starts_with('#') && !rest.starts_with("data:") {
            return Some("external_ref");
        }
    }
    for m in DATA.find_iter(text) {
        if !DATA_OK.is_match(&text[m.end()..]) {
            return Some("data_not_raster");
        }
    }
    if lower.contains("@import") {
        return Some("css_import");
    }
    for c in STYLE.captures_iter(text) {
        let body = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
        if body.contains('\\') {
            return Some("css_escape");
        }
    }
    None
}

fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `rasterizeSvgAvatar` — 512×512 PNG, `cover`(가운데 기준). 거절·실패는 `None`(부르는 쪽이 SVG 를 그대로 낸다).
pub fn rasterize_svg_avatar(svg: &[u8]) -> Option<Vec<u8>> {
    use resvg::tiny_skia::{Pixmap, Transform};
    if svg_raster_refusal(&String::from_utf8_lossy(svg)).is_some() {
        return None;
    }
    // resources_dir 없음 — 바깥 파일을 읽을 바탕 주소가 없다(TS 의 두 번째 겹과 같다).
    let tree = resvg::usvg::Tree::from_data(svg, &resvg::usvg::Options::default()).ok()?;
    let (w, h) = (tree.size().width(), tree.size().height());
    let px = SVG_RASTER_PX as f32;
    // sharp `limitInputPixels`(512² × 16) — 원래 크기가 그 위면 TS 도 굳히지 못한다.
    if !(w > 0.0 && h > 0.0) || f64::from(w) * f64::from(h) > f64::from(px * px * 16.0) {
        return None;
    }
    let scale = (px / w).max(px / h);
    let (tx, ty) = ((px - w * scale) / 2.0, (px - h * scale) / 2.0);
    let mut pixmap = Pixmap::new(SVG_RASTER_PX, SVG_RASTER_PX)?;
    resvg::render(
        &tree,
        Transform::from_row(scale, 0.0, 0.0, scale, tx, ty),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().ok()
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
        // node querystring 처럼 키를 푼다 — zod 는 푼 키 `raster` 를 본다.
        assert_eq!(raster_of(Some("r%61ster=1")), Some(true));
        assert_eq!(raster_of(Some("raster=%31")), Some(true));
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

    #[test]
    fn svg_raster_refusal_follows_ts() {
        assert_eq!(svg_raster_refusal("<svg><circle r='1'/></svg>"), None);
        assert_eq!(svg_raster_refusal("<svg><use href='#a'/></svg>"), None);
        assert_eq!(
            svg_raster_refusal("<svg><image href=\"file:///etc/passwd\"/></svg>"),
            Some("external_ref")
        );
        assert_eq!(
            svg_raster_refusal("<svg><rect fill='url( http://x/a)'/></svg>"),
            Some("external_ref")
        );
        assert_eq!(
            svg_raster_refusal("<svg><rect fill='url(#g)'/></svg>"),
            None
        );
        assert_eq!(
            svg_raster_refusal("<svg><image href='data:image/png;base64,AA'/></svg>"),
            None
        );
        assert_eq!(
            svg_raster_refusal("<svg><image href='data:image/svg+xml;base64,AA'/></svg>"),
            Some("data_not_raster")
        );
        assert_eq!(
            svg_raster_refusal("<svg><style>@import 'x';</style></svg>"),
            Some("css_import")
        );
        assert_eq!(
            svg_raster_refusal("<svg><style>a{fill:\\75 rl(x)}</style></svg>"),
            Some("css_escape")
        );
    }

    #[test]
    fn svg_rasterizes_to_512_png_cover() {
        // 가로로 긴 그림 — cover 로 가운데를 512×512 로 채운다.
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#f00"/></svg>"##;
        let png = rasterize_svg_avatar(svg).expect("png");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .expect("decode")
            .to_rgba8();
        assert_eq!(img.dimensions(), (SVG_RASTER_PX, SVG_RASTER_PX));
        // 모서리까지 칠해졌다(투명 띠 없음).
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(511, 511).0, [255, 0, 0, 255]);
        // 거절·깨진 SVG 는 None.
        assert!(rasterize_svg_avatar(b"<svg><image href='http://x/a.png'/></svg>").is_none());
        assert!(rasterize_svg_avatar(b"<svg").is_none());
    }
}
