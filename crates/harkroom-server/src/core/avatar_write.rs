//! S5.4 — 아바타 걸기 두 줄. TS `routes/avatarRoutes.ts` 의 `PUT /accounts/me/avatar`·`PUT /accounts/agents/:id/avatar`
//! 와 `services/avatars.ts`(`detectAvatarType`·`findAvatarSource`·`findAvatarOriginal`·`setAccountAvatar`·
//! `currentAvatarIds`·`releaseAvatarFiles`)를 옮긴다.
//!
//! - 순서(TS 그대로): 본문 파싱(fastify, 인증보다 먼저) → 인증(`requireAccount` / `requireOwnerOrAdmin('id')` → 경로 uuid
//!   400 → 지우지 않은 에이전트인가 404) → zod 본문 400 → 지금 사진 id 둘 읽기 → `null` 이면 지우기 →
//!   업로드 찾기 404 `not_found` → 판정 400 → 원본 찾기 404 `source_not_found` → 원본 판정 400 → 걸기 + `avatar.changed`
//!   (outbox) → 옛 사진 정리(행 + 파일, 실패는 삼킨다).
//! - **래스터 그림(PNG·JPEG·GIF·WebP·AVIF)은 TS 에 넘긴다.** TS 는 sharp(libvips) `metadata()` 로 가로·세로·장 수를 재서
//!   상한(`AVATAR_PIXEL_LIMITS`)과 견주고, libvips 가 헤더를 못 읽으면 `not_an_image` 로 거절한다. 그 판정(움직이는
//!   GIF·WebP 의 장 수, AVIF 헤더, 깨진 파일의 갈래)을 새 크레이트 없이 같게 낼 수 없다. 넘기기 전까지는 읽기만 했으므로
//!   TS 가 처음부터 다시 해도 결과가 같다. Rust 는 지우기(`null`)·404 둘·SVG 걸기·SVG 거절(`svg_too_large`·`not_an_image`)
//!   을 낸다.
//! - TS 는 `emitEvent` 를 커밋 뒤에 따로 내지만 여기서는 걸기와 같은 트랜잭션의 outbox 줄이다(다른 쓰기 코어와 같다).
use super::attachment_store::LocalStorage;
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use crate::write::{BODY_LIMIT, Body};
use axum::body::{Bytes, to_bytes};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Request, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::Response;
use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};

/// 쓰기 풀이 쓰는 권한. 정리 DELETE 의 하위 질의가 읽는 칸까지 적는다.
pub const AVATAR_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("account.avatar_attachment_id", "UPDATE"),
    ("account.avatar_source_attachment_id", "UPDATE"),
    ("account.avatar_crop", "UPDATE"),
    ("account.id", "SELECT"),
    ("account.avatar_attachment_id", "SELECT"),
    ("account.avatar_source_attachment_id", "SELECT"),
    ("attachment.content_type", "UPDATE"),
    ("attachment", "DELETE"),
    ("attachment.id", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("attachment.storage_key", "SELECT"),
    ("workspace_profile.icon_attachment_id", "SELECT"),
    ("artifact_version.attachment_id", "SELECT"),
    ("artifact_version.cover_attachment_id", "SELECT"),
    ("event_outbox", "INSERT"),
];
pub const AVATAR_WRITE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

#[derive(Clone)]
pub struct AvatarWriteState {
    pub read: PgPool,
    pub write: PgPool,
    pub storage: LocalStorage,
    pub up: Upstream,
}

// ── 판정(services/avatars.ts) ─────────────────────────────────────────

pub const IMAGE_HEAD_BYTES: usize = 12;
pub const SVG_MAX_BYTES: i64 = 256 * 1024;
const SVG_PROBE_BYTES: usize = 4096;

/// 매직 바이트 판정(`sniffImageType`).
pub fn sniff_image_type(h: &[u8]) -> Option<&'static str> {
    if h.len() < IMAGE_HEAD_BYTES {
        return None;
    }
    if h[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some("image/png");
    }
    if h[0] == 0xff && h[1] == 0xd8 && h[2] == 0xff {
        return Some("image/jpeg");
    }
    if &h[..6] == b"GIF87a" || &h[..6] == b"GIF89a" {
        return Some("image/gif");
    }
    if &h[..4] == b"RIFF" && &h[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if &h[4..8] == b"ftyp" && (&h[8..12] == b"avif" || &h[8..12] == b"avis") {
        return Some("image/avif");
    }
    None
}

/// JS `\s`·`trimStart` 의 공백(Rust `char::is_whitespace` 와 달리 U+FEFF 는 넣고 U+0085 는 뺀다).
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

const JS_WS_CLASS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// `/^<svg[\s/>]/i` — ASCII 만 접는다(JS 비-u `/i` 는 `ſ`·`K` 를 접지 않는다).
fn svg_root(rest: &str) -> bool {
    let b = rest.as_bytes();
    b.len() >= 4
        && b[..4].eq_ignore_ascii_case(b"<svg")
        && rest[4..]
            .chars()
            .next()
            .is_some_and(|c| c == '/' || c == '>' || js_ws(c))
}

/// `startsLikeSvg`.
pub fn starts_like_svg(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let mut rest: &str = text.strip_prefix('\u{feff}').unwrap_or(&text);
    rest = rest.trim_start_matches(js_ws);
    loop {
        if rest.starts_with("<?") {
            let Some(end) = rest.find("?>") else {
                return false;
            };
            rest = rest[end + 2..].trim_start_matches(js_ws);
        } else if rest.starts_with("<!--") {
            let Some(end) = rest.find("-->") else {
                return false;
            };
            rest = rest[end + 3..].trim_start_matches(js_ws);
        } else if rest.len() > 9
            && rest.as_bytes()[..9].eq_ignore_ascii_case(b"<!doctype")
            && rest[9..].chars().next().is_some_and(js_ws)
        {
            let Some(end) = rest.find('>') else {
                return false;
            };
            if rest[..end].contains('[') {
                return false;
            }
            rest = rest[end + 1..].trim_start_matches(js_ws);
        } else {
            break;
        }
    }
    svg_root(rest)
}

/// `SVG_UNSAFE = /<\s*(script|foreignObject)\b|\son[a-z]{2,}\s*=|javascript:/i`. 글을 ASCII 소문자로 접은 뒤 견준다.
static SVG_UNSAFE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"<{ws}*(?:script|foreignobject)(?-u:\b)|{ws}on[a-z]{{2,}}{ws}*=|javascript:",
        ws = JS_WS_CLASS
    ))
    .expect("svg unsafe regex")
});

/// `looksLikeSvg`.
pub fn looks_like_svg(bytes: &[u8]) -> bool {
    starts_like_svg(bytes)
        && !SVG_UNSAFE.is_match(&String::from_utf8_lossy(bytes).to_ascii_lowercase())
}

/// 판정 결과. `Raster` 는 TS(sharp) 에 넘긴다.
#[derive(Debug, PartialEq)]
pub enum Detected {
    Svg,
    Raster,
    Refused(&'static str, String),
}

fn not_an_image() -> Detected {
    Detected::Refused(
        "not_an_image",
        "avatar must be a png, jpeg, gif, webp, avif, or svg image".into(),
    )
}

/// `detectAvatarType` 에서 래스터 상한 판정을 뺀 것 — 바이트(앞 `want`)와 행의 크기로 정한다.
pub fn detect(bytes: &[u8], size_bytes: i64) -> Detected {
    if sniff_image_type(bytes).is_some() {
        return Detected::Raster;
    }
    if size_bytes > SVG_MAX_BYTES {
        return if starts_like_svg(bytes) {
            Detected::Refused(
                "svg_too_large",
                format!("svg avatar must be at most {SVG_MAX_BYTES} bytes"),
            )
        } else {
            not_an_image()
        };
    }
    if looks_like_svg(bytes) {
        Detected::Svg
    } else {
        not_an_image()
    }
}

/// `readHead` — 앞 `want` 바이트. 파일이 없으면 TS 는 던진다(500).
async fn read_head(storage: &LocalStorage, key: &str, want: usize) -> Result<Vec<u8>, String> {
    let file = storage.read(key).await.map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(want.min(1 << 20));
        file.take(want as u64)
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn detect_upload(st: &AvatarWriteState, key: &str, size: i64) -> Result<Detected, String> {
    let want = if size > SVG_MAX_BYTES {
        SVG_PROBE_BYTES
    } else {
        (size.max(0) as usize).max(IMAGE_HEAD_BYTES)
    };
    let bytes = read_head(&st.storage, key, want).await?;
    Ok(detect(&bytes, size))
}

// ── 본문(zod) ──────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub struct SourceBody {
    pub attachment_id: String,
    pub crop: (f64, f64, f64),
}

#[derive(Debug, PartialEq)]
pub struct AvatarBody {
    pub attachment_id: Option<String>,
    pub source: Option<SourceBody>,
}

fn ratio(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    (n.is_finite() && (0.0..=1.0).contains(&n)).then_some(n)
}

fn uuid_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if crate::lists::is_zod_uuid(s) => Some(s.clone()),
        _ => None,
    }
}

/// zod `avatarBody` — `attachmentId` 는 키 필수(uuid 또는 null), `source` 는 없음·null·{attachmentId, crop}.
pub fn parse_body(body: &Body) -> Option<AvatarBody> {
    let Body::Json(Value::Object(o)) = body else {
        return None;
    };
    let attachment_id = match o.get("attachmentId")? {
        Value::Null => None,
        v => Some(uuid_of(Some(v))?),
    };
    let source = match o.get("source") {
        None | Some(Value::Null) => None,
        Some(Value::Object(s)) => {
            let id = uuid_of(s.get("attachmentId"))?;
            let Some(Value::Object(c)) = s.get("crop") else {
                return None;
            };
            let x = ratio(c.get("x"))?;
            let y = ratio(c.get("y"))?;
            let size = ratio(c.get("size")).filter(|s| *s > 0.0)?;
            Some(SourceBody {
                attachment_id: id,
                crop: (x, y, size),
            })
        }
        Some(_) => return None,
    };
    Some(AvatarBody {
        attachment_id,
        source,
    })
}

// ── 질의 ──────────────────────────────────────────────────────────

type Upload = (String, String, i32);

const FIND_SOURCE: &str = "select id::text, storage_key, size_bytes::int from attachment \
     where id = $1::uuid and uploader_id = $2::uuid and message_id is null";
const FIND_ORIGINAL_ATTACHED: &str = "select att.id::text, att.storage_key, att.size_bytes::int \
     from account a join attachment att \
       on att.id = $1::uuid and att.id in (a.avatar_attachment_id, a.avatar_source_attachment_id) \
     where a.id = $2::uuid";
const CURRENT_IDS: &str = "select avatar_attachment_id::text, avatar_source_attachment_id::text \
     from account where id = $1::uuid";
const CLEAR: &str = "update account set avatar_attachment_id = null, avatar_source_attachment_id = null, \
     avatar_crop = null where id = $1::uuid";
const SET_TYPE: &str = "update attachment set content_type = $2 where id = $1::uuid";
const SET_ACCOUNT: &str = "update account set avatar_attachment_id = $2::uuid, \
     avatar_source_attachment_id = $3::uuid, avatar_crop = $4::jsonb where id = $1::uuid";
const RELEASE: &str = "delete from attachment a \
     where a.id = any($1::uuid[]) \
       and a.message_id is null \
       and not exists (select 1 from account c \
                        where c.avatar_attachment_id = a.id or c.avatar_source_attachment_id = a.id) \
       and not exists (select 1 from workspace_profile w where w.icon_attachment_id = a.id) \
       and not exists (select 1 from artifact_version v \
                        where v.attachment_id = a.id or v.cover_attachment_id = a.id) \
     returning a.storage_key";

async fn find_source(read: &PgPool, id: &str, uploader: &str) -> sqlx::Result<Option<Upload>> {
    sqlx::query_as(FIND_SOURCE)
        .bind(id)
        .bind(uploader)
        .fetch_optional(read)
        .await
}

/// `releaseAvatarFiles` — 실패는 삼킨다(기록만).
async fn release(st: &AvatarWriteState, previous: Vec<Option<String>>) {
    let mut ids: Vec<String> = Vec::new();
    for id in previous.into_iter().flatten() {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return;
    }
    let keys: Vec<String> = match sqlx::query_scalar(RELEASE)
        .bind(&ids)
        .fetch_all(&st.write)
        .await
    {
        Ok(k) => k,
        Err(e) => {
            eprintln!("avatar attachment cleanup failed ({e})");
            return;
        }
    };
    for key in keys {
        if let Err(e) = st.storage.remove(&key).await {
            eprintln!("avatar file removal failed ({e})");
        }
    }
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

fn internal_msg(what: &str) -> Response {
    eprintln!("avatar write: {what}");
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

async fn to_ts(up: Upstream, peer: SocketAddr, parts: Parts, bytes: Bytes) -> Response {
    super::msg_post::to_ts(up, peer, parts, bytes).await
}

enum Step {
    Done(Response),
    ToTs,
}

/// `applyAvatar` — 대상 계정과 업로더(요청자)만 다르다.
async fn apply(st: &AvatarWriteState, target: &str, uploader: &str, body: &Body) -> Step {
    let Some(body) = parse_body(body) else {
        return Step::Done(bad("body"));
    };
    let previous: Option<(Option<String>, Option<String>)> = match sqlx::query_as(CURRENT_IDS)
        .bind(target)
        .fetch_optional(&st.read)
        .await
    {
        Ok(v) => v,
        Err(e) => return Step::Done(internal(e)),
    };
    let previous: Vec<Option<String>> = previous.map(|(a, s)| vec![a, s]).unwrap_or_default();

    let Some(att_id) = body.attachment_id else {
        let res: sqlx::Result<()> = async {
            let mut tx = st.write.begin().await?;
            sqlx::query(CLEAR).bind(target).execute(&mut *tx).await?;
            crate::write::emit_event(
                &mut tx,
                &json!({ "type": "avatar.changed", "accountId": target, "avatarAttachmentId": null }),
            )
            .await?;
            tx.commit().await
        }
        .await;
        if let Err(e) = res {
            return Step::Done(internal(e));
        }
        release(st, previous).await;
        return Step::Done(json_ok(json!({ "avatarAttachmentId": null }).to_string()));
    };

    let found = match find_source(&st.read, &att_id, uploader).await {
        Ok(v) => v,
        Err(e) => return Step::Done(internal(e)),
    };
    let Some((found_id, found_key, found_size)) = found else {
        return Step::Done(json_err(
            StatusCode::NOT_FOUND,
            "not_found",
            "no unattached upload of yours with that id",
        ));
    };
    match detect_upload(st, &found_key, i64::from(found_size)).await {
        Ok(Detected::Svg) => {}
        Ok(Detected::Raster) => return Step::ToTs,
        Ok(Detected::Refused(code, msg)) => {
            return Step::Done(json_err(StatusCode::BAD_REQUEST, code, &msg));
        }
        Err(e) => return Step::Done(internal_msg(&e)),
    }

    let mut source: Option<(String, Value)> = None;
    if let Some(src) = body.source {
        let own = match find_source(&st.read, &src.attachment_id, uploader).await {
            Ok(v) => v,
            Err(e) => return Step::Done(internal(e)),
        };
        let original = match own {
            Some(o) => Some(o),
            None => match sqlx::query_as::<_, Upload>(FIND_ORIGINAL_ATTACHED)
                .bind(&src.attachment_id)
                .bind(target)
                .fetch_optional(&st.read)
                .await
            {
                Ok(v) => v,
                Err(e) => return Step::Done(internal(e)),
            },
        };
        let Some((orig_id, orig_key, orig_size)) = original else {
            return Step::Done(json_err(
                StatusCode::NOT_FOUND,
                "source_not_found",
                "no usable original with that id",
            ));
        };
        match detect_upload(st, &orig_key, i64::from(orig_size)).await {
            Ok(Detected::Svg) => {}
            Ok(Detected::Raster) => return Step::ToTs,
            Ok(Detected::Refused(code, msg)) => {
                return Step::Done(json_err(StatusCode::BAD_REQUEST, code, &msg));
            }
            Err(e) => return Step::Done(internal_msg(&e)),
        }
        let (x, y, size) = src.crop;
        source = Some((orig_id, json!({ "x": x, "y": y, "size": size })));
    }

    let res: sqlx::Result<()> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query(SET_TYPE)
            .bind(&found_id)
            .bind("image/svg+xml")
            .execute(&mut *tx)
            .await?;
        if let Some((orig_id, _)) = &source {
            sqlx::query(SET_TYPE)
                .bind(orig_id)
                .bind("image/svg+xml")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(SET_ACCOUNT)
            .bind(target)
            .bind(&found_id)
            .bind(source.as_ref().map(|(id, _)| id.clone()))
            .bind(source.as_ref().map(|(_, c)| c.to_string()))
            .execute(&mut *tx)
            .await?;
        crate::write::emit_event(
            &mut tx,
            &json!({ "type": "avatar.changed", "accountId": target, "avatarAttachmentId": found_id }),
        )
        .await?;
        tx.commit().await
    }
    .await;
    if let Err(e) = res {
        return Step::Done(internal(e));
    }
    release(st, previous).await;
    Step::Done(json_ok(
        json!({ "avatarAttachmentId": found_id }).to_string(),
    ))
}

/// 본문을 먼저 읽는다(fastify 는 preHandler 보다 본문 파싱이 먼저) — 넘길 때 같은 바이트를 다시 보낸다.
#[allow(clippy::result_large_err)]
async fn read(req: Request) -> Result<(Parts, Bytes, Body, Account), Response> {
    let (mut parts, body) = req.into_parts();
    let bytes = to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        )
    })?;
    let parsed = crate::write::fastify_body(&parts.headers, &bytes)?;
    let RequireAccount(me, _) = RequireAccount::from_request_parts(&mut parts, &()).await?;
    Ok((parts, bytes, parsed, me))
}

/// `PUT /accounts/me/avatar`.
pub async fn put_me(
    State(st): State<Arc<AvatarWriteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, bytes, body, me) = match read(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    match apply(&st, &me.id, &me.id, &body).await {
        Step::Done(r) => r,
        Step::ToTs => to_ts(st.up.clone(), peer, parts, bytes).await,
    }
}

/// `PUT /accounts/agents/{id}/avatar`.
pub async fn put_agent(
    State(st): State<Arc<AvatarWriteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, bytes, body, me) = match read(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    match check_owner_or_admin(&st.read, &me, &id).await {
        Ok(Verdict::Owner | Verdict::Admin) => {}
        Ok(Verdict::Refused(s, c, m)) => return json_err(s, c, m),
        Err(e) => return internal(e),
    }
    if !crate::lists::is_zod_uuid(&id) {
        return bad("params");
    }
    let agent: Option<i32> = match sqlx::query_scalar(
        "select 1 from account where id = $1::uuid and kind = 'agent' and deleted_at is null",
    )
    .bind(&id)
    .fetch_optional(&st.read)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if agent.is_none() {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
    }
    match apply(&st, &id, &me.id, &body).await {
        Step::Done(r) => r,
        Step::ToTs => to_ts(st.up.clone(), peer, parts, bytes).await,
    }
}

pub fn routes(
    st: AvatarWriteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AvatarWriteState>>::new()
        .put("/accounts/me/avatar", put_me)
        .put("/accounts/agents/{id}/avatar", put_agent)
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

    const U: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn sniff_matches_ts_signatures() {
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend([0; 4]);
        assert_eq!(sniff_image_type(&png), Some("image/png"));
        assert_eq!(sniff_image_type(&png[..11]), None);
        assert_eq!(
            sniff_image_type(b"\xff\xd8\xff\xe0aaaaaaaa"),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_type(b"GIF89a______"), Some("image/gif"));
        assert_eq!(sniff_image_type(b"RIFF____WEBP"), Some("image/webp"));
        assert_eq!(sniff_image_type(b"RIFF____WAVE"), None);
        assert_eq!(sniff_image_type(b"\0\0\0\x1cftypavis"), Some("image/avif"));
        assert_eq!(sniff_image_type(b"\0\0\0\x1cftypheic"), None);
    }

    #[test]
    fn svg_root_and_prolog() {
        assert!(starts_like_svg(b"<svg xmlns='x'></svg>"));
        assert!(starts_like_svg(
            "\u{feff}  <?xml version='1.0'?><!-- c --><!DOCTYPE svg PUBLIC 'x'>\n<SVG>".as_bytes()
        ));
        assert!(!starts_like_svg(b"<!DOCTYPE svg [<!ENTITY a 'b'>]><svg>"));
        assert!(!starts_like_svg(b"<html><svg>"));
        assert!(!starts_like_svg(b"<svgx>"));
        assert!(!starts_like_svg(b"<?xml"));
        // U+0085 은 JS 공백이 아니다.
        assert!(!starts_like_svg("\u{85}<svg>".as_bytes()));
    }

    #[test]
    fn svg_unsafe_follows_ts_regex() {
        assert!(looks_like_svg(b"<svg><circle r='1'/></svg>"));
        assert!(!looks_like_svg(b"<svg>< ScRiPt>1</script></svg>"));
        assert!(!looks_like_svg(b"<svg><foreignObject/></svg>"));
        assert!(looks_like_svg(b"<svg><scripts/></svg>"));
        assert!(!looks_like_svg(b"<svg onload=x>"));
        assert!(!looks_like_svg(b"<svg><a href='JavaScript:1'/></svg>"));
        assert!(looks_like_svg(b"<svg on=x>"));
    }

    #[test]
    fn detect_branches() {
        assert_eq!(detect(b"GIF89a______", 12), Detected::Raster);
        assert_eq!(detect(b"<svg/>", 6), Detected::Svg);
        assert!(matches!(
            detect(b"<svg>", SVG_MAX_BYTES + 1),
            Detected::Refused("svg_too_large", _)
        ));
        assert!(matches!(
            detect(b"hello", SVG_MAX_BYTES + 1),
            Detected::Refused("not_an_image", _)
        ));
        assert!(matches!(
            detect(b"<html/>", 7),
            Detected::Refused("not_an_image", _)
        ));
    }

    #[test]
    fn body_follows_zod() {
        let j = |v: Value| parse_body(&Body::Json(v));
        assert_eq!(
            j(json!({ "attachmentId": null })),
            Some(AvatarBody {
                attachment_id: None,
                source: None
            })
        );
        assert!(j(json!({})).is_none());
        assert!(j(json!({ "attachmentId": "nope" })).is_none());
        assert!(j(json!({ "attachmentId": U, "source": 1 })).is_none());
        assert_eq!(
            j(json!({ "attachmentId": U, "source": { "attachmentId": U, "crop": { "x": 0, "y": 1, "size": 0.5 } } }))
                .and_then(|b| b.source)
                .map(|s| s.crop),
            Some((0.0, 1.0, 0.5))
        );
        assert!(j(json!({ "attachmentId": U, "source": { "attachmentId": U, "crop": { "x": 0, "y": 0, "size": 0 } } })).is_none());
        assert!(j(json!({ "attachmentId": U, "source": { "attachmentId": U, "crop": { "x": 1.5, "y": 0, "size": 1 } } })).is_none());
        assert!(parse_body(&Body::None).is_none());
    }
}
