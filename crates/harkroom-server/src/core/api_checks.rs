//! S5.4 — `POST /agent/api-checks`(TS `apiCallRoutes.ts` → `apiCalls.ts::checkApiCall`) — **부분 이식**.
//!
//! Rust 는 판정 전의 두 갈래만 답한다: 오퍼레이터를 거치지 않은 요청(403 `forbidden`)과 zod 모양이 틀린 본문(400 `bad_request`).
//! 모양이 맞는 요청은 전부 TS 로 넘긴다 — 임대·연결·`apiGrantFor`(사슬·limits·경로)·쓰기 사람 원인·비밀 열기(`secret_access_log`)·
//! 막힘 카드(`recordBlocked`)·감사·409 `secret_key_mismatch` 는 아직 TS 몫이다.
//! 쓰기 풀에 [`API_CHECKS_DENY_PRIVILEGES`] 가 다 있으면 임대 거절(403 `lease_invalid` — 막힘 카드가 없는 갈래)과 그
//! `api.call.denied` 감사는 Rust 가 답한다. [`API_CHECKS_ALLOW_PRIVILEGES`] 까지 있으면 임대가 통과한 본체 중
//! `authKind = none` 연결의 허락(`api.call.checked`)과 막힘 카드가 없는 거절(`bad_path`·`chain_broken`)도 Rust 가 답한다.
//! 글 올리기 코어(`api-results` 와 같은 `PostState`)까지 있으면 카드가 서는 거절(`not_granted`·`no_connector`·`expired`·
//! `suspended`·`method_not_allowed`·`path_not_allowed`·`cause_not_human`)도 Rust 가 답하고 그 턴의 스레드에 **새** 막힘 카드를
//! 세운다(`api_blocked_card`). [`API_CHECKS_BUMP_PRIVILEGES`] 까지 있으면 같은 날 같은 스레드에 이미 선 카드를 고쳐 쓰는
//! 갈래(`meta.blocked` 의 `count`·`lastAt`·`lastCode`·`lastRequest` + `message.updated`)도 Rust 가 한다.
//! 경로는 `%`·질의·ASCII 밖 글자까지 TS `safePath`·`wirePath`·`pathCovered` 를 따라 Rust 가 본다(바탕이 http(s) 가
//! 아닌 연결만 TS 몫). 비밀을 여는 연결(`authKind` 가 `none`·`token_exchange` 가 아닌 것)은 [`API_CHECKS_SECRET_PRIVILEGES`] 와
//! DB 확인값에 맞는 v2 키가 있을 때 **허락 갈래만** Rust 가 연다 — `secret_access_log` granted 줄, `api.call.checked` 감사,
//! 응답 `valueBase64`(오퍼레이터 자신에게만, `no-store`). 비밀 거절(`no_secret`·`secret_expired`·`owner_inactive`·`no_value`·
//! `unreadable`)·409 `secret_key_mismatch`·토큰 교환은 아무것도 쓰기 전에 TS 로 넘긴다.
use super::api_results::connector_ok;
use super::grant_reads::through_operator;
use super::merge_approval_peek::str_len_ok;
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::json_err;
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use std::net::SocketAddr;
use std::sync::Arc;

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, connector, method and path are required";

/// zod `{ leaseId, token, connector, method, path, caps? }` 모양만 본다(남는 키는 zod 처럼 무시).
pub fn shape_ok(body: Option<&Value>) -> bool {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        let lease = o.get("leaseId")?.as_str()?;
        if !is_uuid(lease) {
            return None;
        }
        str_len_ok(o.get("token")?, 1, 200)?;
        if !connector_ok(o.get("connector")?.as_str()?) {
            return None;
        }
        if !matches!(
            o.get("method")?.as_str()?,
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            return None;
        }
        str_len_ok(o.get("path")?, 1, 2000)?;
        match o.get("caps") {
            None => {}
            Some(v) => {
                let a = v.as_array()?;
                if a.len() > 10 {
                    return None;
                }
                for c in a {
                    str_len_ok(c, 0, 40)?;
                }
            }
        }
        Some(())
    })();
    ok.is_some()
}

/// 임대 거절을 Rust 가 답할 때 쓰기 풀에 있어야 하는 권한 — 임대 정본 문장(`grant_read_lease`)이 읽는 표,
/// `connectorIdByName`, `api.call.denied` 감사 쓰기.
pub const API_CHECKS_DENY_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("api_connector.id", "SELECT"),
    ("api_connector.name", "SELECT"),
    ("audit_log", "INSERT"),
];

/// 임대가 유효한 본체(허락·카드 없는 거절)를 Rust 가 답할 때 더 있어야 하는 권한 — 연결 행, `apiGrantFor` 의 잎·사슬 쿼리,
/// 쓰기 원인 칸, `api.call.checked` 감사(`audit_log` INSERT 는 거절 쪽에 있다).
pub const API_CHECKS_ALLOW_PRIVILEGES: &[(&str, &str)] = &[
    ("api_connector.owner_account_id", "SELECT"),
    ("api_connector.base_url", "SELECT"),
    ("api_connector.auth_kind", "SELECT"),
    ("api_connector.auth_header", "SELECT"),
    ("api_connector.secret_id", "SELECT"),
    ("api_connector.methods", "SELECT"),
    ("account_grant.id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.parent_grant_id", "SELECT"),
    ("account_grant.granted_by", "SELECT"),
    ("account_grant.expires_at", "SELECT"),
    ("account_grant.suspended_at", "SELECT"),
    ("account_grant.limits", "SELECT"),
    ("account_grant.delegate_depth", "SELECT"),
    ("account_grant.write_needs_human_cause", "SELECT"),
];

/// 같은 날 같은 스레드에 이미 선 막힘 카드를 고쳐 쓸 때(TS `recordBlocked` 의 갱신 갈래) 더 있어야 하는 권한 —
/// `meta` 갱신. 다시 읽기(`getMessageById`)·`message.updated` outbox 는 글 올리기 코어 권한에 든다.
pub const API_CHECKS_BUMP_PRIVILEGES: &[(&str, &str)] = &[("message.meta", "UPDATE")];

/// 비밀을 여는 연결(`authKind` 가 `none`·`token_exchange` 가 아닌 것)의 허락을 Rust 가 답할 때 더 있어야 하는 권한 —
/// 비밀 행·소유자 상태(`account` SELECT 는 거절 쪽에 있다), 현재 값, `secret_access_log` 쓰기.
pub const API_CHECKS_SECRET_PRIVILEGES: &[(&str, &str)] = &[
    ("secret.id", "SELECT"),
    ("secret.name", "SELECT"),
    ("secret.kind", "SELECT"),
    ("secret.expires_at", "SELECT"),
    ("secret.owner_account_id", "SELECT"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("secret_version.revoked_at", "SELECT"),
    ("secret_access_log", "INSERT"),
];

/// 비밀 열쇠(v2 보관소). 키가 DB 확인값과 맞을 때만 선다 — 없거나 어긋나면(TS 의 `no_secret`·409 `secret_key_mismatch`) TS 몫.
pub struct SecretOpener(crate::secrets::keyring::SecretKeyring);

impl std::fmt::Debug for SecretOpener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretOpener(<redacted>)")
    }
}

/// 기동 한 번 — `secret_reveal::load_state` 와 같은 길(env 키 + DB 확인값). 오류 글귀엔 파일 이름·kid 만 있다.
pub async fn load_secret_opener(pool: &sqlx::PgPool) -> Result<Option<SecretOpener>, String> {
    Ok(crate::secrets::verify::load_verified_from_env(pool)
        .await?
        .filter(|v| !v.mismatch)
        .and_then(|v| v.keyring)
        .map(SecretOpener))
}

pub struct ChecksState {
    pub up: Upstream,
    /// 임대 거절 경로 — 쓰기 풀에 [`API_CHECKS_DENY_PRIVILEGES`] 가 다 있을 때만.
    pub deny: Option<sqlx::PgPool>,
    /// 임대가 유효한 본체 — 거기에 [`API_CHECKS_ALLOW_PRIVILEGES`] 까지 다 있을 때만.
    pub allow: bool,
    /// 막힘 카드가 서는 거절 — `allow` 에 더해 글 올리기 코어(시스템 줄)가 있을 때만. 없으면 그 거절은 TS 몫.
    pub card: Option<super::msg_post::PostState>,
    /// 이미 선 카드의 갱신 — `card` 에 더해 [`API_CHECKS_BUMP_PRIVILEGES`] 가 있을 때만. 없으면 그 갈래는 TS 몫.
    pub bump: bool,
    /// 비밀을 여는 연결의 허락 — `allow` 에 더해 [`API_CHECKS_SECRET_PRIVILEGES`] 와 맞는 키가 있을 때만.
    pub secret: Option<SecretOpener>,
}

/// JS 정규식 `\s`(ECMAScript WhiteSpace + LineTerminator).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn has_ci(s: &str, pat: &str) -> bool {
    s.to_ascii_lowercase().contains(pat)
}

/// TS `decodeSlashes` — 질의 앞의 `%2f`(대소문자 무시)를 `/` 로.
pub fn decode_slashes(path: &str) -> String {
    let (p, q) = match path.find('?') {
        Some(i) => (&path[..i], &path[i..]),
        None => (path, ""),
    };
    let b = p.as_bytes();
    let mut out = String::with_capacity(path.len());
    let mut i = 0;
    while i < p.len() {
        if b[i] == b'%'
            && p.get(i..i + 3)
                .is_some_and(|t| t.eq_ignore_ascii_case("%2f"))
        {
            out.push('/');
            i += 3;
        } else {
            let c = p[i..].chars().next().unwrap_or_default();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out.push_str(q);
    out
}

/// TS `safePath` 그대로(`%`·ASCII 밖 글자 포함).
pub fn safe_path(path: &str) -> bool {
    if !path.starts_with('/') || path.starts_with("//") {
        return false;
    }
    if path.chars().any(|c| c == '\\' || c == '#' || js_space(c)) {
        return false;
    }
    let p = path.split('?').next().unwrap_or("");
    if has_ci(p, "%2e") || has_ci(p, "%5c") || has_ci(p, "%25") || p.contains(';') {
        return false;
    }
    let dot = |s: &str| s == ".." || s == ".";
    if p.split('/').any(dot) {
        return false;
    }
    if !has_ci(p, "%2f") {
        return true;
    }
    let decoded = decode_slashes(p);
    let segs: Vec<&str> = decoded.split('/').skip(1).collect();
    let last = segs.len().saturating_sub(1);
    !segs
        .iter()
        .enumerate()
        .any(|(i, s)| dot(s) || (s.is_empty() && !(i == last && p.ends_with('/'))))
}

/// TS `pathCovered` 그대로.
pub fn path_covered(path: &str, prefix: &str) -> bool {
    if has_ci(path.split('?').next().unwrap_or(""), "%2f")
        && !path_covered(&decode_slashes(path), prefix)
    {
        return false;
    }
    let p = path.split('?').next().unwrap_or("");
    if prefix.ends_with('/') {
        return p.starts_with(prefix);
    }
    p == prefix || p.starts_with(&format!("{prefix}/"))
}

fn pct_push(out: &mut String, c: char, encode: impl Fn(u8) -> bool) {
    let mut buf = [0u8; 4];
    for &b in c.encode_utf8(&mut buf).as_bytes() {
        if !(0x20..=0x7e).contains(&b) || encode(b) {
            out.push_str(&format!("%{b:02X}"));
        } else {
            out.push(b as char);
        }
    }
}

/// TS `wirePath(baseUrl, path)` 중 `safePath` 를 지난 경로(`/` 하나로 시작, `\`·`#`·`\s`·점 마디 없음)와 http(s) 바탕.
/// WHATWG URL 의 path·special-query percent-encode set 으로 인코딩하고 빈 질의(`?` 만)는 지운다. 바탕이 http(s)
/// 가 아니면 `None`(TS 에 맡긴다).
pub fn wire_path(base_url: &str, path: &str) -> Option<String> {
    let lb = base_url.trim_start().to_ascii_lowercase();
    if !(lb.starts_with("https://") || lb.starts_with("http://")) {
        return None;
    }
    let (p, q) = match path.find('?') {
        Some(i) => (&path[..i], Some(&path[i + 1..])),
        None => (path, None),
    };
    let mut out = String::with_capacity(path.len());
    for c in p.chars() {
        pct_push(&mut out, c, |b| {
            matches!(
                b,
                b' ' | b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}'
            )
        });
    }
    if let Some(q) = q.filter(|q| !q.is_empty()) {
        out.push('?');
        for c in q.chars() {
            pct_push(&mut out, c, |b| {
                matches!(b, b' ' | b'"' | b'#' | b'<' | b'>' | b'\'')
            });
        }
    }
    Some(out)
}

/// TS `leaseOk`.
pub fn lease_ok(lease: Option<&super::lease_read::LeaseRow>, agent: &str, operator: &str) -> bool {
    lease.is_some_and(|l| {
        l.agent_id == agent && l.operator_id.as_deref() == Some(operator) && !l.expired && !l.ended
    })
}

/// TS `(path.split('?')[0] ?? '').slice(0, 300)` — JS 는 UTF-16 단위로 자른다. 자른 자리가 서로게이트 쌍을
/// 가르면 `None`(TS 에 맡긴다).
pub fn audit_path(path: &str) -> Option<String> {
    let head = path.split('?').next().unwrap_or_default();
    let u: Vec<u16> = head.encode_utf16().collect();
    if u.len() <= 300 {
        return Some(head.to_owned());
    }
    String::from_utf16(&u[..300]).ok()
}

/// TS `deny(code)` 의 `api.call.denied` 감사 `detail` — `leaseId` 는 임대가 통과했을 때만.
pub fn denied_detail(
    code: &str,
    method: &str,
    path: &str,
    operator: &str,
    lease: Option<&str>,
) -> Value {
    json!({ "code": code, "method": method, "path": path, "operatorId": operator, "leaseId": lease })
}

/// TS `api.call.checked` 감사 `detail`.
pub fn checked_detail(
    method: &str,
    path: &str,
    operator: &str,
    lease: &str,
    grant: &str,
    root: &str,
    by_human: bool,
) -> Value {
    json!({ "method": method, "path": path, "operatorId": operator, "leaseId": lease, "grantId": grant, "rootGrantedBy": root, "causeByHuman": by_human })
}

/// TS 라우트의 거절 상태 — Rust 가 답하는 코드만.
pub fn deny_status(code: &str) -> StatusCode {
    match code {
        "bad_path" => StatusCode::BAD_REQUEST,
        "no_connector" => StatusCode::NOT_FOUND,
        "operator_update_required" => StatusCode::CONFLICT,
        _ => StatusCode::FORBIDDEN,
    }
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    r
}

async fn deny(
    pool: &sqlx::PgPool,
    agent: &str,
    target: &str,
    detail: Value,
    code: &str,
) -> Response {
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "api.call.denied",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(target),
            ip: None,
            detail,
        },
    )
    .await;
    no_store(json_err(
        deny_status(code),
        code,
        &format!("api call not allowed: {code}"),
    ))
}

const CARD_EXISTING_SQL: &str = "select id::text from message \
      where meta->'blocked'->>'key' = $1 and channel_id = $2::uuid and coalesce(thread_root_id, id) = $3::uuid and deleted_at is null \
      order by created_at limit 1";
/// TS `recordBlocked` 의 갱신 — `count`·`lastAt`·`lastCode`·`lastRequest` 만 올린다.
const CARD_BUMP_SQL: &str = "update message set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta, \
           '{blocked,count}', to_jsonb(coalesce((meta->'blocked'->>'count')::int, 1) + 1)), \
           '{blocked,lastAt}', to_jsonb($2::text)), \
           '{blocked,lastCode}', to_jsonb($3::text)), \
           '{blocked,lastRequest}', to_jsonb($4::text)) \
        where id = $1::uuid returning id::text";
const CARD_AGENT_SQL: &str = "select a.handle, c.owner_account_id::text from account a \
     left join agent_config c on c.account_id = a.id where a.id = $1::uuid";

/// 카드가 서는 거절(TS `deny` + `recordBlocked`). `Ok(None)` 은 TS 몫 — 카드 경로를 못 따라가거나(`%`·ASCII 밖),
/// 이미 선 카드를 고쳐 써야 하는데 갱신 권한이 없거나(`bump`), 글 코어가 TS 로 넘겼을 때. 아무것도 쓰기 전에 고른다.
/// 새 카드를 먼저 올리고 감사를 남긴다(TS 는 감사 → 카드; 카드 실패는 판정을 바꾸지 않는다). 이미 선 카드는 한 tx 에서
/// `meta.blocked` 를 올리고 `message.updated` 를 outbox 에 넣은 뒤 감사를 남긴다.
#[allow(clippy::too_many_arguments)]
async fn deny_card(
    st: &super::msg_post::PostState,
    bump: bool,
    agent: &str,
    lease: &super::lease_read::LeaseRow,
    connector_id: Option<&str>,
    connector_name: &str,
    method: &str,
    path: &str,
    target: &str,
    detail: Value,
    code: &str,
) -> sqlx::Result<Option<Response>> {
    use super::api_blocked_card as bc;
    use super::msg_post::{Origin, Outcome, PostBody, channel_is_dm, post_in_tx};
    let w = &st.write;
    let Some(cpath) = bc::card_path(path) else {
        return Ok(None);
    };
    let (Some(channel), Some(root)) =
        (lease.channel_id.as_deref(), lease.thread_root_id.as_deref())
    else {
        return Ok(None);
    };
    let now = super::merge_approval_peek::db_now(w).await?;
    let key = bc::card_key(agent, connector_id, root, &now);
    let existing: Option<String> = sqlx::query_scalar(CARD_EXISTING_SQL)
        .bind(&key)
        .bind(channel)
        .bind(root)
        .fetch_optional(w)
        .await?;
    if let Some(id) = existing {
        if !bump {
            return Ok(None);
        }
        let request = bc::card_request(method, cpath.as_deref());
        let mut tx = w.begin().await?;
        let hit: Option<String> = sqlx::query_scalar(CARD_BUMP_SQL)
            .bind(&id)
            .bind(&now)
            .bind(code)
            .bind(&request)
            .fetch_optional(&mut *tx)
            .await?;
        if hit.is_some() {
            super::ask_sync::announce_updated(&mut tx, &id).await?;
        }
        tx.commit().await?;
        return Ok(Some(deny(w, agent, target, detail, code).await));
    }
    let who: Option<(String, Option<String>)> = sqlx::query_as(CARD_AGENT_SQL)
        .bind(agent)
        .fetch_optional(w)
        .await?;
    let handle = who.as_ref().map_or("agent", |w| w.0.as_str());
    let owner = who.as_ref().and_then(|w| w.1.as_deref());
    let request = bc::card_request(method, cpath.as_deref());
    let name = bc::card_connector_name(connector_id, connector_name);
    let blocked = bc::card_meta(&bc::NewMeta {
        key: &key,
        agent,
        owner,
        code,
        now: &now,
        connector_id,
        connector_name: name.as_deref(),
        method,
        path: cpath.as_deref(),
    });
    let mut meta = Map::new();
    meta.insert("blocked".into(), blocked);
    meta.insert(
        "i18n".into(),
        bc::card_i18n(agent, name.as_deref(), &request, code),
    );
    let audience = super::audience::audience_for(w, channel).await?.to_json();
    let is_dm = channel_is_dm(w, channel).await?;
    let input = PostBody {
        body: bc::card_body(handle, name.as_deref(), &request, code),
        attachment_ids: Vec::new(),
        thread_root: Some(root.to_owned()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        server_notice: true,
        no_mentions: true,
        ..Origin::default()
    };
    if let Outcome::ToTs = post_in_tx(
        st, channel, agent, true, &input, None, &audience, is_dm, &origin,
    )
    .await?
    {
        return Ok(None);
    }
    Ok(Some(deny(w, agent, target, detail, code).await))
}

type ConnRow = (
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Vec<String>,
);
const CONN_SQL: &str = "select id::text, owner_account_id::text, name, base_url, auth_kind, auth_header, \
     secret_id::text, methods from api_connector where name = $1";
const LEAF_SQL: &str = "select id::text, limits::text, write_needs_human_cause from account_grant \
     where account_id = $1::uuid and capability = 'api.call' and scope = $2";

/// 임대가 유효한 본체. `Ok(None)` 은 TS 몫 — 막힘 카드가 서는 거절(`not_granted`·`no_connector`·`expired`·…),
/// 비밀을 여는 연결(`authKind != none`), http(s) 가 아닌 바탕.
#[allow(clippy::too_many_arguments)]
async fn checks_body(
    pool: &sqlx::PgPool,
    agent: &str,
    operator: &str,
    lease: &super::lease_read::LeaseRow,
    o: &Value,
    path300: &str,
    card: Option<&super::msg_post::PostState>,
    bump: bool,
    secret: Option<&SecretOpener>,
    now: &str,
) -> sqlx::Result<Option<Response>> {
    use super::mcp::grant_delegate as gd;
    let g = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default();
    let (method, path) = (g("method"), g("path"));
    let Some(c): Option<ConnRow> = sqlx::query_as(CONN_SQL)
        .bind(g("connector"))
        .fetch_optional(pool)
        .await?
    else {
        let Some(st) = card else { return Ok(None) };
        let target = format!("connector-name:{}", g("connector"));
        let d = denied_detail("no_connector", method, path300, operator, Some(&lease.id));
        return deny_card(
            st,
            bump,
            agent,
            lease,
            None,
            g("connector"),
            method,
            path,
            &target,
            d,
            "no_connector",
        )
        .await
        .or(Ok(None));
    };
    let target = format!("connector:{}", c.0);
    let (target_ref, cid) = (target.as_str(), c.0.as_str());
    let carded = |code: &'static str| async move {
        let Some(st) = card else { return Ok(None) };
        let d = denied_detail(code, method, path300, operator, Some(&lease.id));
        deny_card(
            st,
            bump,
            agent,
            lease,
            Some(cid),
            g("connector"),
            method,
            path,
            target_ref,
            d,
            code,
        )
        .await
        .or(Ok(None)) // 카드 쓰기 오류는 tx 가 되돌린다 — 아무것도 남기기 전이니 TS 에 맡긴다(TS 는 카드 오류를 삼킨다).
    };
    let denied = |code: &'static str| {
        (
            code,
            denied_detail(code, method, path300, operator, Some(&lease.id)),
        )
    };
    if !safe_path(path) {
        let (code, d) = denied("bad_path");
        return Ok(Some(deny(pool, agent, &target, d, code).await));
    }
    // 실제로 보낼 경로(TS `wirePath`). http(s) 가 아닌 바탕은 TS 가 짓는다.
    let Some(wire) = wire_path(&c.3, path) else {
        return Ok(None);
    };
    if !safe_path(&wire) {
        let (code, d) = denied("bad_path");
        return Ok(Some(deny(pool, agent, &target, d, code).await));
    }
    let Some((leaf_id, leaf_limits, write_human)): Option<(String, Option<String>, bool)> =
        sqlx::query_as(LEAF_SQL)
            .bind(agent)
            .bind(&target)
            .fetch_optional(pool)
            .await?
    else {
        return carded("not_granted").await;
    };
    let root = match gd::chain_root(pool, c.1.as_ref(), &target, &leaf_id).await {
        None => return Ok(None),
        Some(Ok(r)) => r,
        Some(Err("chain_broken")) => {
            let (code, d) = denied("chain_broken");
            return Ok(Some(deny(pool, agent, &target, d, code).await));
        }
        Some(Err("expired")) => return carded("expired").await,
        Some(Err("suspended")) => return carded("suspended").await,
        Some(Err(_)) => return Ok(None),
    };
    let Some(limits) = gd::limits_of(leaf_limits.as_deref()) else {
        return Ok(None);
    };
    let Some(limits) = limits else {
        let (code, d) = denied("chain_broken");
        return Ok(Some(deny(pool, agent, &target, d, code).await));
    };
    if !limits.methods.iter().any(|m| m == method) || !c.7.iter().any(|m| m == method) {
        return carded("method_not_allowed").await;
    }
    if !path_covered(path, &limits.path_prefix) || !path_covered(&wire, &limits.path_prefix) {
        return carded("path_not_allowed").await;
    }
    // 토큰 교환(`caps`·`tokenUrl`)은 TS 몫. 비밀을 여는 연결은 맞는 키와 권한이 있을 때만 — 없으면 TS 가
    // `no_secret`·409 `secret_key_mismatch` 로 답한다. 여기까지는 아무것도 쓰지 않았다.
    if c.4 == "token_exchange" || (c.4 != "none" && secret.is_none()) {
        return Ok(None);
    }
    let by_human = lease.cause_by_human();
    if method != "GET" && write_human && !by_human {
        return carded("cause_not_human").await;
    }
    let value = match (c.4.as_str(), secret) {
        ("none", _) => None,
        (_, Some(sec)) => {
            let Some(sid) = c.6.as_deref() else {
                return Ok(None); // `no_secret` 거절은 TS 몫.
            };
            match open_secret(
                pool, sec, sid, &c.2, agent, operator, lease, method, path, now,
            )
            .await?
            {
                Some(v) => Some(v),
                None => return Ok(None),
            }
        }
        (_, None) => return Ok(None),
    };
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "api.call.checked",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&target),
            ip: None,
            detail: checked_detail(
                method, path300, operator, &lease.id, &leaf_id, &root, by_human,
            ),
        },
    )
    .await;
    let body = json!({
        "allowed": true, "connector": c.2, "baseUrl": c.3, "authKind": c.4, "authHeader": c.5,
        "valueBase64": value.as_ref().map(|v| v.as_str()), "causeByHuman": by_human, "path": wire,
    });
    drop(value);
    let text = zeroize::Zeroizing::new(body.to_string());
    drop(body);
    Ok(Some(no_store(crate::directory::json_ok(
        text.as_str().to_owned(),
    ))))
}

const SECRET_SQL: &str = "select s.id::text, s.name, s.kind, s.expires_at <= $2::timestamptz, \
     (o.deleted_at is not null or o.disabled_at is not null) \
     from secret s join account o on o.id = s.owner_account_id where s.id = $1::uuid";
const VERSION_SQL: &str = "select version, sealed from secret_version \
     where secret_id = $1::uuid and revoked_at is null and sealed is not null order by version desc limit 1";
const ACCESS_LOG_SQL: &str = "insert into secret_access_log (secret_id, secret_name, version, agent_id, operator_id, \
     turn_id, channel_id, thread_root_id, result, reason, at) \
     values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, 'granted', $9, $10::timestamptz)";

/// TS `(path.split('?')[0] ?? '').slice(0, 200)` — UTF-16 단위. 서로게이트 쌍 가운데서 잘리면 None(TS 몫).
pub fn access_path(path: &str) -> Option<String> {
    let head = path.split('?').next().unwrap_or_default();
    let u: Vec<u16> = head.encode_utf16().collect();
    if u.len() <= 200 {
        return Some(head.to_owned());
    }
    String::from_utf16(&u[..200]).ok()
}

/// TS `checkApiCall` 의 비밀 열기 — 허락 갈래만. 만료·소유자 비활성·값 없음·열 수 없음(`secret_access_log` 거절 줄 +
/// 거절 감사)은 아무것도 쓰기 전에 `None` 으로 TS 에 맡긴다. 값은 base64 로만 돌려주고, 로그·오류·감사에는 싣지 않는다.
#[allow(clippy::too_many_arguments)]
async fn open_secret(
    pool: &sqlx::PgPool,
    sec: &SecretOpener,
    secret_id: &str,
    connector_name: &str,
    agent: &str,
    operator: &str,
    lease: &super::lease_read::LeaseRow,
    method: &str,
    path: &str,
    now: &str,
) -> sqlx::Result<Option<zeroize::Zeroizing<String>>> {
    use crate::secrets::keyring::{SecretAad, SecretKind};
    use base64::Engine as _;
    let Some(reason_path) = access_path(path) else {
        return Ok(None);
    };
    let row: Option<(String, String, String, Option<bool>, bool)> = sqlx::query_as(SECRET_SQL)
        .bind(secret_id)
        .bind(now)
        .fetch_optional(pool)
        .await?;
    let Some((sid, name, kind, expired, owner_inactive)) = row else {
        return Ok(None);
    };
    if expired == Some(true) || owner_inactive {
        return Ok(None);
    }
    let kind = match kind.as_str() {
        "text" => SecretKind::Text,
        "file" => SecretKind::File,
        _ => return Ok(None),
    };
    let Some((version, sealed)): Option<(i32, String)> = sqlx::query_as(VERSION_SQL)
        .bind(&sid)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    let sealed = zeroize::Zeroizing::new(sealed);
    let aad = SecretAad {
        secret_id: &sid,
        version: i64::from(version),
        kind,
    };
    let Some(value) = sec.0.open(&sealed, &aad) else {
        return Ok(None);
    };
    drop(sealed);
    sqlx::query(ACCESS_LOG_SQL)
        .bind(&sid)
        .bind(&name)
        .bind(version)
        .bind(agent)
        .bind(operator)
        .bind(&lease.id)
        .bind(lease.channel_id.as_deref())
        .bind(lease.thread_root_id.as_deref())
        .bind(format!("api:{connector_name} {method} {reason_path}"))
        .bind(now)
        .execute(pool)
        .await?;
    Ok(Some(zeroize::Zeroizing::new(
        base64::engine::general_purpose::STANDARD.encode(value.as_bytes()),
    )))
}

#[allow(clippy::too_many_arguments)]
async fn checks_early(
    pool: &sqlx::PgPool,
    agent: &str,
    operator: &str,
    o: &Value,
    allow: bool,
    card: Option<&super::msg_post::PostState>,
    bump: bool,
    secret: Option<&SecretOpener>,
) -> sqlx::Result<Option<Response>> {
    let g = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default();
    let Some(path) = audit_path(g("path")) else {
        return Ok(None);
    };
    let now = super::merge_approval_peek::db_now(pool).await?;
    let lease = super::lease_read::read_lease(pool, g("leaseId"), g("token"), &now).await?;
    if let Some(l) = lease
        .as_ref()
        .filter(|_| lease_ok(lease.as_ref(), agent, operator))
    {
        if !allow {
            return Ok(None);
        }
        return checks_body(pool, agent, operator, l, o, &path, card, bump, secret, &now).await;
    }
    let cid: Option<String> =
        sqlx::query_scalar("select id::text from api_connector where name = $1")
            .bind(g("connector"))
            .fetch_optional(pool)
            .await?;
    let target = match cid {
        Some(c) => format!("connector:{c}"),
        None => format!("connector-name:{}", g("connector")),
    };
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "api.call.denied",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&target),
            ip: None,
            detail: denied_detail("lease_invalid", g("method"), &path, operator, None),
        },
    )
    .await;
    Ok(Some(no_store(json_err(
        StatusCode::FORBIDDEN,
        "lease_invalid",
        "api call not allowed: lease_invalid",
    ))))
}

pub async fn checks_route(
    State(st): State<Arc<ChecksState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    if !shape_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    }
    if let (Some(pool), Some(op), Some(o)) = (
        st.deny.as_ref(),
        auth.operator.as_ref().map(|o| o.id.as_str()),
        parsed.as_ref(),
    ) {
        match checks_early(
            pool,
            &me.id,
            op,
            o,
            st.allow,
            st.card.as_ref(),
            st.bump,
            st.secret.as_ref(),
        )
        .await
        {
            Ok(Some(r)) => return r,
            Ok(None) => {}
            Err(e) => return crate::directory::internal(e),
        }
    }
    super::msg_post::to_ts(st.up.clone(), peer, parts, bytes).await
}

#[allow(clippy::too_many_arguments)]
pub fn routes(
    up: Upstream,
    deny: Option<sqlx::PgPool>,
    allow: bool,
    card: Option<super::msg_post::PostState>,
    bump: bool,
    secret: Option<SecretOpener>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ChecksState>>::new()
        .post("/agent/api-checks", checks_route)
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
        router: t.router.with_state(Arc::new(ChecksState {
            up,
            deny,
            allow,
            bump: bump && allow && card.is_some(),
            card: card.filter(|_| allow),
            secret: secret.filter(|_| allow),
        })),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lease_ok_like_ts() {
        let l = crate::core::lease_read::LeaseRow {
            id: "L".into(),
            agent_id: "a".into(),
            operator_id: Some("o".into()),
            ..Default::default()
        };
        assert!(lease_ok(Some(&l), "a", "o"));
        assert!(!lease_ok(None, "a", "o"));
        assert!(!lease_ok(Some(&l), "b", "o"));
        assert!(!lease_ok(Some(&l), "a", "x"));
        let mut e = l.clone();
        e.expired = true;
        assert!(!lease_ok(Some(&e), "a", "o"));
        let mut n = l.clone();
        n.ended = true;
        assert!(!lease_ok(Some(&n), "a", "o"));
    }

    #[test]
    fn access_path_like_ts() {
        assert_eq!(access_path("/x?api_key=1").as_deref(), Some("/x"));
        assert_eq!(access_path(&"a".repeat(300)).unwrap().len(), 200);
        assert_eq!(access_path(&"가".repeat(300)).unwrap().chars().count(), 200);
        let p = format!("{}{}", "a".repeat(199), "😀");
        assert_eq!(access_path(&p), None);
    }

    #[test]
    fn audit_path_like_ts() {
        assert_eq!(audit_path("/x?api_key=1").as_deref(), Some("/x"));
        assert_eq!(audit_path("?q").as_deref(), Some(""));
        assert_eq!(audit_path(&"a".repeat(400)).unwrap().len(), 300);
        // UTF-16 단위로 센다: 한글은 1단위.
        assert_eq!(audit_path(&"가".repeat(400)).unwrap().chars().count(), 300);
        // 299 단위 뒤에 서로게이트 쌍이 걸리면 TS 에 맡긴다.
        let p = format!("{}{}", "a".repeat(299), "😀");
        assert_eq!(audit_path(&p), None);
        assert_eq!(
            denied_detail("lease_invalid", "GET", "/x", "op", None),
            json!({ "code": "lease_invalid", "method": "GET", "path": "/x", "operatorId": "op", "leaseId": null })
        );
    }

    #[test]
    fn deny_privileges_cover_lease_sql() {
        let f = crate::core::channels::frag("grant_read_lease");
        for t in [
            "secret_turn_lease",
            "message",
            "account",
            "agent_config",
            "channel",
            "channel_member",
            "agent_invoker",
        ] {
            assert!(f.contains(t), "{t}");
            assert!(API_CHECKS_DENY_PRIVILEGES.contains(&(t, "SELECT")), "{t}");
        }
    }

    #[test]
    fn allow_details_like_ts() {
        assert_eq!(
            checked_detail("GET", "/x", "op", "L", "G", "R", true),
            json!({ "method": "GET", "path": "/x", "operatorId": "op", "leaseId": "L", "grantId": "G", "rootGrantedBy": "R", "causeByHuman": true })
        );
        assert_eq!(
            denied_detail("chain_broken", "GET", "/x", "op", Some("L"))["leaseId"],
            json!("L")
        );
        assert_eq!(deny_status("bad_path"), StatusCode::BAD_REQUEST);
        assert_eq!(deny_status("chain_broken"), StatusCode::FORBIDDEN);
        for (c, _) in API_CHECKS_ALLOW_PRIVILEGES {
            let col = c.split('.').nth(1).unwrap();
            assert!(
                CONN_SQL.contains(col)
                    || LEAF_SQL.contains(col)
                    || (c.starts_with("account_grant.") && col != "id"),
                "{c}"
            );
        }
    }

    #[test]
    fn paths_like_ts() {
        assert!(safe_path("/a%2Fb"));
        assert!(!safe_path("/a%2e%2e/x"));
        assert!(!safe_path("/a%252e"));
        assert!(!safe_path("/a%2F%2Fb"));
        assert!(!safe_path("/a%2F"));
        assert!(!safe_path("/a/%2F/"));
        assert!(safe_path("/a/b%2Fc/"));
        assert!(!safe_path("/a%2F..%2Fb"));
        assert!(!safe_path("/a\u{a0}b"));
        assert!(!safe_path("/a\u{feff}"));
        assert!(safe_path("/a\u{85}"));
        assert!(safe_path("/가?q=%2e"));
        assert!(!safe_path("/x;y?z"));
        assert!(safe_path("/x?a;b"));
        assert_eq!(decode_slashes("/a%2fb%2F?x%2f"), "/a/b/?x%2f");
        assert!(path_covered("/api/x", "/api"));
        assert!(!path_covered("/api%2Fx", "/api/"));
        assert!(path_covered("/api/a%2Fb", "/api/"));
        assert!(!path_covered("/apix", "/api"));
        let b = "https://h.example/base/";
        assert_eq!(wire_path(b, "/x").as_deref(), Some("/x"));
        assert_eq!(wire_path(b, "/x?").as_deref(), Some("/x"));
        assert_eq!(
            wire_path(b, "/가?q=가'").as_deref(),
            Some("/%EA%B0%80?q=%EA%B0%80%27")
        );
        assert_eq!(
            wire_path(b, "/a{b}`<>\"").as_deref(),
            Some("/a%7Bb%7D%60%3C%3E%22")
        );
        assert_eq!(
            wire_path(b, "/a%2Fb'?x=?y").as_deref(),
            Some("/a%2Fb'?x=?y")
        );
        assert_eq!(wire_path(b, "/\u{7f}").as_deref(), Some("/%7F"));
        assert_eq!(wire_path("ftp://h/", "/x"), None);
    }

    #[test]
    fn bump_like_ts() {
        // TS `recordBlocked` 의 갱신: 네 칸만 올리고 count 가 없으면 1 에서 센다.
        for k in ["count", "lastAt", "lastCode", "lastRequest"] {
            assert!(CARD_BUMP_SQL.contains(&format!("'{{blocked,{k}}}'")), "{k}");
        }
        assert!(CARD_BUMP_SQL.contains("coalesce((meta->'blocked'->>'count')::int, 1) + 1"));
        assert!(CARD_BUMP_SQL.starts_with("update message set meta ="));
        assert_eq!(API_CHECKS_BUMP_PRIVILEGES, &[("message.meta", "UPDATE")]);
    }

    #[test]
    fn shape_like_zod() {
        let ok = json!({ "leaseId": "00000000-0000-4000-8000-000000000000", "token": "t", "connector": "lab", "method": "GET", "path": "/x", "caps": ["token_exchange"], "extra": 1 });
        assert!(shape_ok(Some(&ok)));
        assert!(!shape_ok(None));
        let mut bad = ok.clone();
        bad["method"] = json!("HEAD");
        assert!(!shape_ok(Some(&bad)));
        let mut bad = ok.clone();
        bad["caps"] = json!(["x".repeat(41)]);
        assert!(!shape_ok(Some(&bad)));
        let mut bad = ok;
        bad["connector"] = json!("Lab");
        assert!(!shape_ok(Some(&bad)));
    }
}
