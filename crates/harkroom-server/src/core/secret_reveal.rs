//! S5.4 — 소유자 보기 `POST /secrets/:id/reveal`. TS `routes/secretRoutes.ts`(114)·`services/stepUp.ts`
//! (`currentStepUp`·`extendStepUp`)·`services/secretAccess.ts`(`RevealLimiter`·`OncePerWindow`)를 옮긴다.
//!
//! - 순서는 TS 와 같다: 본문 읽기 → `requireAccount`(401) → 에이전트 403 `forbidden` → 세션이 아니면 403 `session_required`
//!   → 키링 없음 409(`secret_store_disabled`·`secret_key_mismatch`) → 경로 id(400 `invalid_request`) → **소유자 본인만**
//!   (admin 도 남의 것은 404 `not_found`) → 본문 `{action: view|copy|download, client?: string≤500}` 아니면 400 `bad_request`
//!   → 잠금 여부로 고른 상한(잠김 20/10분, 풀림 600/10분, 키 = 계정 id) — 막히면 창마다 한 번 access log `denied rate_limited`
//!   후 429(`retry-after` 헤더·본문 `retryAfterSec`) → 잠겼으면 403 `step_up_required`(log) → 지금 판 없음 409 `no_value`(log)
//!   → 못 열면 409 `unreadable`(log) → 창 연장 실패 403 `step_up_required`(log) → log `granted` → 감사 `secret.revealed`
//!   `{name, version, action}` → 200 `no-store` `{steppedUpUntil, name, kind, filename, version, value|valueBase64}`.
//! - **두 상한·「창마다 한 줄」은 프로세스 로컬이다**(TS 도 인메모리 `RevealLimiter`·`OncePerWindow`). 이 상한들은 이 줄만 쓰므로
//!   (`/agent/secrets/reveal` 의 리미터는 따로다) 이 줄을 Rust 가 받으면 TS 쪽 카운터는 쓰이지 않는다 — 나뉘어 세는 일이 없다.
//! - `/agent/secrets/reveal` 은 TS 에 남는다(턴 임대 판정과 에이전트 리미터를 같이 옮겨야 한다).
//! - **값은 답 본문에만** 싣는다. access log·감사·오류에는 값도 해시도 없다.
//! - 칸 권한은 [`privileges`] — 쓰기 풀에 하나라도 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다. homelab GRANT:
//!   ```sql
//!   grant select (id, name, kind, filename, owner_account_id) on secret to <write_role>;
//!   grant select (secret_id, version, sealed, revoked_at) on secret_version to <write_role>;
//!   grant select (token_hash, expires_at, stepped_up_at, stepped_up_until), update (stepped_up_until) on session to <write_role>;
//!   grant insert (secret_id, secret_name, version, actor_account_id, action, client, ip, result, reason) on secret_access_log to <write_role>;
//!   grant usage on sequence secret_access_log_id_seq to <write_role>;
//!   grant insert (action, actor_id, actor_handle, target, ip, detail) on audit_log to <write_role>;
//!   -- 기동 키 확인(`secrets::verify`): select (kid, kcv), insert (kid, kcv) on secret_key_check (+ 위 secret·secret_version select)
//!   ```
use crate::auth::{RequireAccount, Via};
use crate::core::account_login_ids::OncePerWindow;
use crate::directory::{internal, json_err};
use crate::secrets::keyring::{SecretAad, SecretKeyring};
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, kind_of, load_verified_from_env};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// TS `STEP_UP_IDLE_MS`·`STEP_UP_MAX_MS`.
const STEP_UP_IDLE_MS: i64 = 15 * 60_000;
const STEP_UP_MAX_MS: i64 = 60 * 60_000;

/// 쓰기 풀이 쓰는 칸 권한(표.칸, 권한).
pub const SECRET_REVEAL_PRIVILEGES: &[(&str, &str)] = &[
    ("secret.id", "SELECT"),
    ("secret.name", "SELECT"),
    ("secret.kind", "SELECT"),
    ("secret.filename", "SELECT"),
    ("secret.owner_account_id", "SELECT"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("secret_version.revoked_at", "SELECT"),
    ("session.token_hash", "SELECT"),
    ("session.expires_at", "SELECT"),
    ("session.stepped_up_at", "SELECT"),
    ("session.stepped_up_until", "SELECT"),
    ("session.stepped_up_until", "UPDATE"),
    ("secret_access_log.secret_id", "INSERT"),
    ("secret_access_log.secret_name", "INSERT"),
    ("secret_access_log.version", "INSERT"),
    ("secret_access_log.actor_account_id", "INSERT"),
    ("secret_access_log.action", "INSERT"),
    ("secret_access_log.client", "INSERT"),
    ("secret_access_log.ip", "INSERT"),
    ("secret_access_log.result", "INSERT"),
    ("secret_access_log.reason", "INSERT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];
/// 시퀀스 권한(`bigserial`).
pub const SECRET_REVEAL_SEQUENCES: &[(&str, &str)] = &[("secret_access_log_id_seq", "USAGE")];

/// 모든 표 권한(이 줄 + 기동 키 확인).
pub fn privileges() -> Vec<(&'static str, &'static str)> {
    SECRET_REVEAL_PRIVILEGES
        .iter()
        .chain(SECRET_KEY_CHECK_PRIVILEGES)
        .copied()
        .collect()
}

const LOAD_SQL: &str =
    "select owner_account_id::text, name, kind, filename from secret where id = $1::uuid";
const CURRENT_SQL: &str = "select version, sealed from secret_version \
     where secret_id = $1::uuid and revoked_at is null and sealed is not null order by version desc limit 1";
const CURRENT_STEP_UP_SQL: &str = "select 1 from session \
     where token_hash = $1 and expires_at > $2::timestamptz and stepped_up_until > $2::timestamptz";
const EXTEND_STEP_UP_SQL: &str = "update session \
        set stepped_up_until = least($2::timestamptz + $3 * interval '1 millisecond', \
                                     stepped_up_at + $4 * interval '1 millisecond') \
      where token_hash = $1 and stepped_up_until > $2::timestamptz and stepped_up_at is not null \
      returning to_char(stepped_up_until at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
const LOG_SQL: &str = "insert into secret_access_log \
       (secret_id, secret_name, version, actor_account_id, action, client, ip, result, reason) \
     values ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9)";

/// TS `RevealLimiter` — 키마다 창 안의 시각 목록(밀리초). 인메모리.
pub struct RevealLimiter {
    max: usize,
    window_ms: i64,
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl RevealLimiter {
    pub fn new(max: usize, window_ms: i64) -> Self {
        Self {
            max,
            window_ms,
            hits: Mutex::new(HashMap::new()),
        }
    }
    pub fn take(&self, key: &str, now_ms: i64) -> bool {
        let mut m = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let mut recent: Vec<i64> = m
            .get(key)
            .map(|v| {
                v.iter()
                    .copied()
                    .filter(|t| now_ms - t < self.window_ms)
                    .collect()
            })
            .unwrap_or_default();
        if recent.len() >= self.max {
            m.insert(key.to_owned(), recent);
            return false;
        }
        recent.push(now_ms);
        m.insert(key.to_owned(), recent);
        true
    }
    pub fn retry_after_ms(&self, key: &str, now_ms: i64) -> i64 {
        let m = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let recent: Vec<i64> = m
            .get(key)
            .map(|v| {
                v.iter()
                    .copied()
                    .filter(|t| now_ms - t < self.window_ms)
                    .collect()
            })
            .unwrap_or_default();
        if recent.len() < self.max {
            return 0;
        }
        (recent.first().copied().unwrap_or(now_ms) + self.window_ms - now_ms).max(0)
    }
}

/// TS `ownerRevealLimiter` — 잠긴 요청만, 계정마다 10분에 20회.
pub fn owner_reveal_limiter() -> RevealLimiter {
    RevealLimiter::new(20, 10 * 60_000)
}
/// TS `ownerUnlockedRevealLimiter` — 풀린 세션의 폭주 방지, 10분에 600회.
pub fn owner_unlocked_reveal_limiter() -> RevealLimiter {
    RevealLimiter::new(600, 10 * 60_000)
}

pub struct SecretRevealState {
    read: PgPool,
    write: PgPool,
    trust: Arc<TrustProxy>,
    keyring: Option<SecretKeyring>,
    mismatch: bool,
    locked: RevealLimiter,
    unlocked: RevealLimiter,
    limited_log: OncePerWindow,
}

/// 기동 한 번: 키를 읽어 확인값과 맞춘다(`secret_writes::load_state` 와 같다). 실패하면 `Err`(TS 에 남는다).
pub async fn load_state(
    read: PgPool,
    write: PgPool,
    trust: Arc<TrustProxy>,
) -> Result<SecretRevealState, String> {
    let (keyring, mismatch) = match load_verified_from_env(&write).await? {
        None => (None, false),
        Some(v) => (v.keyring, v.mismatch),
    };
    Ok(SecretRevealState {
        read,
        write,
        trust,
        keyring,
        mismatch,
        locked: owner_reveal_limiter(),
        unlocked: owner_unlocked_reveal_limiter(),
        limited_log: OncePerWindow::default(),
    })
}

/// TS `clientLabel` — 제어문자(U+0000–001F, 007F–009F)는 칸으로, bidi·zero-width(U+200B–200F, 202A–202E, 2066–2069)는 지우고,
/// JS `trim` 뒤 UTF-16 120 단위로 자른다(서로게이트 쌍 가운데서 잘리면 node-pg 가 그 반쪽을 U+FFFD 로 보낸다).
pub fn client_label(raw: Option<&str>) -> Option<String> {
    let mapped: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !matches!(*c as u32, 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069))
        .map(|c| {
            if matches!(c as u32, 0..=0x1f | 0x7f..=0x9f) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let js_ws = |c: char| c.is_whitespace() || c == '\u{feff}';
    let trimmed = mapped.trim_matches(js_ws);
    let mut out = String::new();
    let mut units = 0;
    for c in trimmed.chars() {
        let n = c.len_utf16();
        if units + n > 120 {
            if units < 120 {
                out.push('\u{fffd}');
            }
            break;
        }
        units += n;
        out.push(c);
    }
    (!out.is_empty()).then_some(out)
}

/// zod `revealBody.safeParse(req.body ?? {})` → (action, client).
fn parse_body(body: &Body) -> Option<(&'static str, Option<String>)> {
    let Body::Json(Value::Object(o)) = body else {
        return None;
    };
    let action = match o.get("action") {
        Some(Value::String(s)) => match s.as_str() {
            "view" => "view",
            "copy" => "copy",
            "download" => "download",
            _ => return None,
        },
        _ => return None,
    };
    let client = match o.get("client") {
        None => None,
        Some(Value::String(s)) if s.encode_utf16().count() <= 500 => Some(s.clone()),
        _ => return None,
    };
    Some((action, client))
}

/// 성공 본문 — TS 와 같은 칸 순서.
fn reveal_body(
    until: &str,
    name: &str,
    kind: &str,
    filename: Option<&str>,
    version: i32,
    value: &[u8],
) -> String {
    let s = |v: &str| Value::String(v.to_owned()).to_string();
    let (vk, vv) = if kind == "text" {
        ("value", s(&String::from_utf8_lossy(value)))
    } else {
        (
            "valueBase64",
            s(&base64::engine::general_purpose::STANDARD.encode(value)),
        )
    };
    format!(
        "{{\"steppedUpUntil\":{},\"name\":{},\"kind\":{},\"filename\":{},\"version\":{version},\"{vk}\":{vv}}}",
        s(until),
        s(name),
        s(kind),
        filename.map_or_else(|| "null".to_owned(), s),
    )
}

fn store_off(mismatch: bool) -> Response {
    if mismatch {
        json_err(
            StatusCode::CONFLICT,
            "secret_key_mismatch",
            "the secret store key on the server does not match the key these secrets were sealed with; the secret store is off",
        )
    } else {
        json_err(
            StatusCode::CONFLICT,
            "secret_store_disabled",
            "HARKROOM_SECRET_KEYS_DIR is not set on the server; the secret store is off",
        )
    }
}

/// `POST /secrets/:id/reveal`.
pub async fn reveal(
    State(st): State<Arc<SecretRevealState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, auth), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "agents cannot manage secrets",
        );
    }
    let cred = match (auth.via, auth.credential_hash.as_deref()) {
        (Some(Via::Session), Some(h)) => h.to_owned(),
        _ => {
            return json_err(
                StatusCode::FORBIDDEN,
                "session_required",
                "only a signed-in session can view a secret value",
            );
        }
    };
    let Some(keyring) = &st.keyring else {
        return store_off(st.mismatch);
    };
    if !crate::lists::is_zod_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    let row: Option<(String, String, String, Option<String>)> = match sqlx::query_as(LOAD_SQL)
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((_owner, name, kind, filename)) = row.filter(|r| r.0 == me.id) else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such secret");
    };
    let Some((action, client)) = parse_body(&body) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "action must be view, copy or download",
        );
    };
    let client = client_label(client.as_deref());
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let log = |result: &'static str, reason: Option<&'static str>, version: Option<i32>| {
        let (st, id, name, me_id, client, ip) = (
            st.clone(),
            id.clone(),
            name.clone(),
            me.id.clone(),
            client.clone(),
            ip.clone(),
        );
        async move {
            sqlx::query(LOG_SQL)
                .bind(id)
                .bind(name)
                .bind(version)
                .bind(me_id)
                .bind(action)
                .bind(client)
                .bind(ip)
                .bind(result)
                .bind(reason)
                .execute(&st.write)
                .await
                .map(|_| ())
        }
    };
    macro_rules! deny {
        ($status:expr, $code:literal, $msg:literal) => {{
            if let Err(e) = log("denied", Some($code), None).await {
                return internal(e);
            }
            return json_err($status, $code, $msg);
        }};
    }

    let now_ms = crate::core::msg_post::now_ms();
    let unlocked = match sqlx::query_scalar::<_, i32>(CURRENT_STEP_UP_SQL)
        .bind(&cred)
        .bind(crate::core::msg_post::iso_ms(now_ms))
        .fetch_optional(&st.write)
        .await
    {
        Ok(v) => v.is_some(),
        Err(e) => return internal(e),
    };
    let gate = if unlocked { &st.unlocked } else { &st.locked };
    if !gate.take(&me.id, now_ms) {
        let wait_ms = gate.retry_after_ms(&me.id, now_ms);
        let secs = ((wait_ms + 999) / 1000).max(1);
        if st.limited_log.first(
            &me.id,
            Instant::now(),
            Duration::from_millis(u64::try_from(wait_ms).unwrap_or(0)),
        ) && let Err(e) = log("denied", Some("rate_limited"), None).await
        {
            return internal(e);
        }
        let mut res = (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            json!({ "error": { "code": "rate_limited", "message": "too many secret views, try again later", "retryAfterSec": secs } })
                .to_string(),
        )
            .into_response();
        res.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from(secs));
        return res;
    }
    if !unlocked {
        deny!(
            StatusCode::FORBIDDEN,
            "step_up_required",
            "unlock with your password to view secret values"
        );
    }
    let cur: Option<(i32, String)> = match sqlx::query_as(CURRENT_SQL)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let Some((version, sealed)) = cur else {
        deny!(StatusCode::CONFLICT, "no_value", "this secret has no value");
    };
    let value = kind_of(&kind).and_then(|k| {
        keyring.open(
            &sealed,
            &SecretAad {
                secret_id: &id,
                version: i64::from(version),
                kind: k,
            },
        )
    });
    drop(sealed);
    let Some(value) = value else {
        deny!(
            StatusCode::CONFLICT,
            "unreadable",
            "this value cannot be opened with the key on this server"
        );
    };
    let until: Option<String> = match sqlx::query_scalar(EXTEND_STEP_UP_SQL)
        .bind(&cred)
        .bind(crate::core::msg_post::iso_ms(
            crate::core::msg_post::now_ms(),
        ))
        .bind(STEP_UP_IDLE_MS as f64)
        .bind(STEP_UP_MAX_MS as f64)
        .fetch_optional(&st.write)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let Some(until) = until else {
        deny!(
            StatusCode::FORBIDDEN,
            "step_up_required",
            "unlock with your password to view secret values"
        );
    };
    if let Err(e) = log("granted", None, Some(version)).await {
        return internal(e);
    }
    record_audit(
        &st.write,
        AuditEntry {
            action: "secret.revealed",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "name": name, "version": version, "action": action }),
        },
    )
    .await;
    let body = zeroize::Zeroizing::new(reveal_body(
        &until,
        &name,
        &kind,
        filename.as_deref(),
        version,
        value.as_bytes(),
    ));
    let mut res = (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body.as_str().to_owned(),
    )
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn routes(
    st: SecretRevealState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SecretRevealState>>::new()
        .post("/secrets/{id}/reveal", reveal)
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
    fn limiter_matches_ts() {
        let l = RevealLimiter::new(2, 1000);
        assert!(l.take("a", 0));
        assert!(l.take("a", 100));
        assert!(!l.take("a", 200));
        assert_eq!(l.retry_after_ms("a", 200), 800);
        assert!(l.take("b", 200));
        assert!(l.take("a", 1000));
        assert_eq!(l.retry_after_ms("b", 300), 0);
    }

    #[test]
    fn client_label_matches_ts() {
        assert_eq!(client_label(None), None);
        assert_eq!(client_label(Some("  \u{200b} ")), None);
        assert_eq!(
            client_label(Some("app\n1.2\u{202e}x\u{feff}")),
            Some("app 1.2x".to_owned())
        );
        let long = "a".repeat(200);
        assert_eq!(client_label(Some(&long)).unwrap().len(), 120);
        let cut = format!("{}\u{1f600}", "a".repeat(119));
        assert_eq!(
            client_label(Some(&cut)),
            Some(format!("{}\u{fffd}", "a".repeat(119)))
        );
    }

    #[test]
    fn body_parse_matches_zod() {
        let b = |v: Value| Body::Json(v);
        assert_eq!(
            parse_body(&b(json!({"action": "copy", "extra": 1}))),
            Some(("copy", None))
        );
        assert!(parse_body(&b(json!({"action": "peek"}))).is_none());
        assert!(parse_body(&b(json!({"action": "view", "client": null}))).is_none());
        assert!(parse_body(&b(json!({"action": "view", "client": "x".repeat(501)}))).is_none());
        assert!(parse_body(&b(json!([]))).is_none());
    }

    #[test]
    fn body_shape_matches_ts() {
        assert_eq!(
            reveal_body("2026-01-01T00:00:00.000Z", "k", "text", None, 3, b"hi"),
            r#"{"steppedUpUntil":"2026-01-01T00:00:00.000Z","name":"k","kind":"text","filename":null,"version":3,"value":"hi"}"#
        );
        assert_eq!(
            reveal_body("t", "f", "file", Some("id_rsa"), 1, &[0xff, 0]),
            r#"{"steppedUpUntil":"t","name":"f","kind":"file","filename":"id_rsa","version":1,"valueBase64":"/wA="}"#
        );
    }
}
