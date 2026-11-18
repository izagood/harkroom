//! S5.4 AT7 — 들어오는 hook 두 개(`POST /hooks/github/:id`, `POST /hooks/generic/:id`). TS `routes/automationRoutes.ts` 의
//! hooks 범위와 `services/automationIngress.ts` 의 `loadIngressTarget`·검증을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: (1) 경로 id 가 uuid 가 아니거나 수신이 꺼졌거나 없는 id → 404 `not_found`,
//!   (github 은 트리거가 github 이 아니어도 404), (2) 서명·키가 틀리면 401(`bad_signature`·`bad_key`),
//!   (3) github `ping` → 200 `{status:'pong'}`, (4) 본문이 JSON 이 아니면 400 `bad_json`.
//! - 서명은 **원문 바이트**로 검증한다(본문을 다시 직렬화하지 않는다). 비교는 상수 시간
//!   (`automation_ingress_verify::safe_equal`). 본문 상한은 전역 `bodyLimit` 과 같은 1MiB.
//! - github 의 `matchGithub` 거절 중 변수 없이 확정되는 것(`repo`·`event`·`not_a_branch`·push `branch`)은 여기서
//!   `200 {status:'ignored', reason}` 으로 답한다([`github_ignored`]) — 트리거는 이미 읽던 `automation.trigger` 에서(새 GRANT 없음).
//! - **TS 로 넘기는 것**: 검증을 통과한 뒤의 나머지 필터(`matchGithub` 의 맞음·paths·`genericVars`)와 회차 만들기(`enqueueRun` —
//!   디바운스 모으기·시간당 상한 일시정지)는 아직 TS 다. 원문 바이트를 그대로 넘기므로 TS 가 같은 판정을 다시 한다.
//!   예외: generic 은 쓰기 풀이 있으면 `genericVars`·`enqueueRun`(디바운스 없음·시간당 상한 일시정지·429)을 여기서 한다 —
//!   디바운스가 걸렸거나 50 칸 넘는 본문·JS 와 문자열화가 다른 숫자는 TS 로 넘긴다.
//!   `application/json` 이 아닌 content-type 도 fastify 파서 동작(415·문자열 본문)을 그대로 두려고 TS 로 넘긴다.
//! - 비밀(토큰 해시·봉인된 서명 키·열린 키)은 기록하지 않는다. [`IngressTarget`] 의 Debug 는 가린다.
use crate::core::automation_ingress_verify::{verify_bearer, verify_github_signature};
use crate::directory::{internal, json_err};
use crate::proxy::Upstream;
use crate::secrets::secret_box::SecretBox;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;

/// 읽기 풀이 이 줄에서 쓰는 칸. **새 GRANT**: `automation.ingress_token_hash`·`automation.ingress_secret_enc` 의 SELECT
/// (보안 검토 요청으로 따로 적는다 — 두 칸은 이 모듈의 [`TARGET_SQL`] 에서만 읽는다).
pub const PRIVILEGES: &[(&str, &str)] = &[
    ("automation.id", "SELECT"),
    ("automation.trigger", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.ingress_enabled_at", "SELECT"),
    ("automation.ingress_token_hash", "SELECT"),
    ("automation.ingress_secret_enc", "SELECT"),
];

/// TS `loadIngressTarget` — 수신이 **켜진** 자동화만.
pub(crate) const TARGET_SQL: &str = "select trigger->>'kind', ingress_token_hash, ingress_secret_enc, trigger::text \
     from automation where id = $1::uuid and deleted_at is null and ingress_enabled_at is not null";

const BODY_LIMIT: usize = 1024 * 1024;

struct IngressTarget {
    kind: Option<String>,
    token_hash: Option<String>,
    secret_enc: Option<String>,
    trigger: Option<String>,
}

impl fmt::Debug for IngressTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IngressTarget")
            .field("kind", &self.kind)
            .field(
                "token_hash",
                &self.token_hash.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "secret_enc",
                &self.secret_enc.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

pub struct HooksState {
    read: PgPool,
    up: Upstream,
    write: Option<PgPool>,
    secret_box: Option<SecretBox>,
}

impl fmt::Debug for HooksState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HooksState(<redacted>)")
    }
}

impl HooksState {
    /// 서명 키 상자는 TS 처럼 `HARKROOM_SECRET_KEY` 에서 한 번 읽는다(없으면 github 서명은 늘 실패 → 401).
    pub fn new(read: PgPool, up: Upstream, write: Option<PgPool>) -> Self {
        Self {
            read,
            up,
            write,
            secret_box: SecretBox::from_env(),
        }
    }
}

fn hook_not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "not found")
}

/// TS `verifyGithubSignature` 전체 — 상자·암호문·헤더가 다 있고, 열린 키로 만든 HMAC 이 같을 때만.
fn github_ok(
    secret_box: Option<&SecretBox>,
    secret_enc: Option<&str>,
    raw: &[u8],
    sig: Option<&str>,
) -> bool {
    let (Some(b), Some(enc), Some(h)) = (secret_box, secret_enc, sig) else {
        return false;
    };
    if !h.starts_with("sha256=") {
        return false;
    }
    let Some(key) = b.open(enc) else {
        return false;
    };
    verify_github_signature(key.as_bytes(), raw, Some(h))
}

/// TS hooks 범위의 `parse` — 빈 본문은 `{}`, 깨진 JSON 은 None.
fn parse(raw: &[u8]) -> Option<Value> {
    if raw.is_empty() {
        return Some(Value::Object(Default::default()));
    }
    serde_json::from_slice(raw).ok()
}

/// content-type 이 있는데 `application/json` 이 아니면 fastify 의 다른 파서가 탄다 — 그대로 TS 에 맡긴다.
fn non_json_content(h: &HeaderMap) -> bool {
    h.get(header::CONTENT_TYPE).is_some_and(|v| {
        let s = v.to_str().unwrap_or("");
        let essence = s.split(';').next().unwrap_or("").trim();
        !essence.eq_ignore_ascii_case("application/json")
    })
}

fn header_str<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

async fn load(read: &PgPool, id: &str) -> Result<Option<IngressTarget>, sqlx::Error> {
    type Row = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(TARGET_SQL)
        .bind(id)
        .fetch_optional(read)
        .await?;
    Ok(
        row.map(|(kind, token_hash, secret_enc, trigger)| IngressTarget {
            kind,
            token_hash,
            secret_enc,
            trigger,
        }),
    )
}

/// TS `matchGithub` 의 거절 갈래 중 **변수 없이** 확정되는 것(`repo`·`event`·`not_a_branch`·push 의 `branch`).
/// `Some(reason)` 이면 TS 와 같은 `200 {status:'ignored', reason}` 을 답한다. `None` 이면 맞을 수 있거나(변수·회차는 아직 TS)
/// JS 강제 변환이 다를 수 있는 꼴(문자열 아닌 값·ASCII 아닌 저장소 이름·TS 가 던질 본문) — TS 로 넘긴다.
pub(crate) fn github_ignored(
    trigger: &Value,
    event: &str,
    payload: &Value,
) -> Option<&'static str> {
    // JS `String(x ?? '')` — 문자열이거나 없음/null 일 때만 같은 값을 안다.
    fn js_str(v: Option<&Value>) -> Option<&str> {
        match v {
            None | Some(Value::Null) => Some(""),
            Some(Value::String(s)) => Some(s.as_str()),
            Some(_) => None,
        }
    }
    let t_repo = trigger.get("repo")?.as_str()?;
    let t_event = trigger.get("event")?.as_str()?;
    let repo = js_str(payload.get("repository").and_then(|r| r.get("full_name")))?;
    if !repo.is_ascii() || !t_repo.is_ascii() {
        return None;
    }
    if !repo.eq_ignore_ascii_case(t_repo) {
        return Some("repo");
    }
    let action = payload.get("action");
    let is = |v: Option<&Value>, s: &str| v.and_then(Value::as_str) == Some(s);
    match t_event {
        "push" => {
            if event != "push" {
                return Some("event");
            }
            let r = js_str(payload.get("ref"))?;
            let Some(branch) = r.strip_prefix("refs/heads/") else {
                return Some("not_a_branch");
            };
            // `pushChanges` 는 commits 안의 null 에서 던진다(TS 500) — 그런 본문은 TS 로.
            if let Some(Value::Array(cs)) = payload.get("commits")
                && cs.iter().any(Value::is_null)
            {
                return None;
            }
            match trigger.get("branch") {
                None | Some(Value::Null) => None,
                Some(Value::String(b)) if b.is_empty() => None,
                Some(Value::String(b)) if b != branch => Some("branch"),
                _ => None,
            }
        }
        "pull_request.merged" => {
            let merged = payload
                .get("pull_request")
                .and_then(|p| p.get("merged"))
                .and_then(Value::as_bool)
                == Some(true);
            if event != "pull_request" || !is(action, "closed") || !merged {
                return Some("event");
            }
            None
        }
        "release.published" => {
            if event != "release" || !is(action, "published") {
                return Some("event");
            }
            None
        }
        _ => {
            if event != "workflow_run" || !is(action, "completed") {
                return Some("event");
            }
            None
        }
    }
}

/// 쓰기 풀 권한 — `automation_run_now` 의 회차·일시정지 칸과 같다(새 GRANT 없음).
pub fn write_privileges() -> Vec<(&'static str, &'static str)> {
    use crate::core::automation_run_now as rn;
    rn::AUTOMATION_RUN_NOW_PRIVILEGES
        .iter()
        .chain(rn::AUTOMATION_RUN_NOW_PAUSE_PRIVILEGES)
        .copied()
        .collect()
}

/// TS `neutralize` — 줄바꿈 접기, `@` 뒤 폭 없는 공백, UTF-16 단위로 `max` 넘으면 `max-1` 단위 + `…`.
pub(crate) fn neutralize(v: &str, max: usize) -> String {
    let mut s = String::with_capacity(v.len());
    let mut nl = false;
    for c in v.chars() {
        if c == '\r' || c == '\n' {
            if !nl {
                s.push(' ');
            }
            nl = true;
            continue;
        }
        nl = false;
        s.push(c);
    }
    let s = s.replace('@', "@\u{200b}").replace("<@", "<\u{200b}@");
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() > max {
        format!("{}…", String::from_utf16_lossy(&units[..max - 1]))
    } else {
        s
    }
}

/// JS `String(v)` 근사 — 원시값만(TS `genericVars` 가 원시값만 받는다).
fn js_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        // 정수는 JS 와 같다. 소수·지수 표기는 JS 와 다를 수 있다 — 부른 쪽이 TS 로 넘긴다.
        Value::Number(n) if n.as_i64().is_some_and(|i| i.unsigned_abs() <= (1u64 << 53)) => {
            Some(n.to_string())
        }
        _ => None,
    }
}

fn valid_key(k: &str) -> bool {
    (1..=64).contains(&k.chars().count())
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// TS `genericVars`. 소수 숫자 값이 있으면 None(JS 숫자 문자열화와 맞출 수 없어 TS 로 넘긴다).
pub(crate) fn generic_vars(body: &Value) -> Option<serde_json::Map<String, Value>> {
    let mut vars = serde_json::Map::new();
    if let Value::Object(o) = body {
        for (k, v) in o.iter().take(50) {
            if !valid_key(k) {
                continue;
            }
            match v {
                Value::String(_) | Value::Bool(_) | Value::Number(_) => {
                    let s = js_string(v)?;
                    vars.insert(format!("payload.{k}"), Value::String(neutralize(&s, 1000)));
                }
                _ => {}
            }
        }
    }
    Some(vars)
}

/// TS `enqueueRun`(webhook 갈래). None 이면 TS 로 넘긴다(디바운스 모으기 · JS 와 맞출 수 없는 값).
async fn enqueue_generic(
    w: &PgPool,
    id: &str,
    kind: &str,
    idem: Option<&str>,
    payload: &Value,
) -> Result<Option<Response>, sqlx::Error> {
    use crate::core::mcp::automation_run as ar;
    use crate::loops::automation as la;
    // serde_json 은 키 순서를 바꿀 수 있다(`slice(0, 50)` 이 달라진다) — 50 칸 넘는 본문은 TS 로.
    if payload.as_object().is_some_and(|o| o.len() > 50) {
        return Ok(None);
    }
    let Some(vars) = generic_vars(payload) else {
        return Ok(None);
    };
    let row: Option<(bool, Option<i32>)> = sqlx::query_as(ar::ENQUEUE_ROW_SQL)
        .bind(id)
        .fetch_optional(w)
        .await?;
    let status = |code: StatusCode, s: &str| -> Response {
        (
            code,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            format!("{{\"status\":\"{s}\"}}"),
        )
            .into_response()
    };
    let Some((enabled, debounce)) = row else {
        return Ok(Some(status(StatusCode::OK, "inactive")));
    };
    if !enabled {
        return Ok(Some(status(StatusCode::OK, "inactive")));
    }
    if debounce.is_some_and(|d| d != 0) {
        return Ok(None); // 디바운스 모으기는 아직 TS.
    }
    let event_key = match idem {
        Some(k) => {
            let u: Vec<u16> = k.encode_utf16().take(200).collect();
            format!("generic:{}", String::from_utf16_lossy(&u))
        }
        None => {
            sqlx::query_scalar("select 'generic:' || gen_random_uuid()::text")
                .fetch_one(w)
                .await?
        }
    };
    let recent: i32 = sqlx::query_scalar(ar::RECENT_SQL)
        .bind(id)
        .fetch_one(w)
        .await?;
    if recent >= ar::RATE_LIMIT_PER_HOUR {
        let mut tx = w.begin().await?;
        sqlx::query(la::RATE_LIMIT_SQL)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        la::end_automation_mandates_tx(&mut tx, id, "automation_off").await?;
        tx.commit().await?;
        return Ok(Some(status(StatusCode::TOO_MANY_REQUESTS, "rate_limited")));
    }
    let summary = la::event_summary(&vars, &event_key);
    let body =
        serde_json::json!({ "vars": vars, "events": [{ "key": event_key, "summary": summary }] });
    let ins: Option<String> = sqlx::query_scalar(la::INSERT_SCHEDULE_RUN_SQL)
        .bind(id)
        .bind(&event_key)
        .bind(kind)
        .bind(body.to_string())
        .fetch_optional(w)
        .await?;
    Ok(Some(match ins {
        Some(_) => status(StatusCode::ACCEPTED, "queued"),
        None => status(StatusCode::OK, "duplicate"),
    }))
}

#[derive(Clone, Copy)]
enum Hook {
    Github,
    Generic,
}

async fn handle(
    st: Arc<HooksState>,
    peer: SocketAddr,
    id: String,
    req: Request,
    hook: Hook,
) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let to_ts = |parts, bytes| {
        crate::proxy::forward(
            State(st.up.clone()),
            ConnectInfo(peer),
            Request::from_parts(parts, Body::from(bytes)),
        )
    };
    if non_json_content(&parts.headers) {
        return to_ts(parts, bytes).await;
    }
    if !crate::lists::is_zod_uuid(&id) {
        return hook_not_found();
    }
    let target = match load(&st.read, &id).await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let Some(target) = target else {
        return hook_not_found();
    };
    match hook {
        Hook::Github => {
            if target.kind.as_deref() != Some("github") {
                return hook_not_found();
            }
            let sig = header_str(&parts.headers, "x-hub-signature-256");
            if !github_ok(
                st.secret_box.as_ref(),
                target.secret_enc.as_deref(),
                &bytes,
                sig,
            ) {
                return json_err(
                    StatusCode::UNAUTHORIZED,
                    "bad_signature",
                    "signature does not match",
                );
            }
            if header_str(&parts.headers, "x-github-event") == Some("ping") {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                    r#"{"status":"pong"}"#,
                )
                    .into_response();
            }
            let Some(payload @ (Value::Object(_) | Value::Array(_))) = parse(&bytes) else {
                return json_err(StatusCode::BAD_REQUEST, "bad_json", "body is not JSON");
            };
            // 헤더가 utf-8 이 아니면 TS(latin1) 와 글자가 다를 수 있다 — 판정하지 않는다.
            let event = match parts.headers.get("x-github-event") {
                None => Some(""),
                Some(v) => v.to_str().ok(),
            };
            let trigger = target
                .trigger
                .as_deref()
                .and_then(|t| serde_json::from_str::<Value>(t).ok());
            if let Some(reason) = trigger
                .as_ref()
                .zip(event)
                .and_then(|(t, e)| github_ignored(t, e, &payload))
            {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                    format!(r#"{{"status":"ignored","reason":"{reason}"}}"#),
                )
                    .into_response();
            }
        }
        Hook::Generic => {
            let auth = header_str(&parts.headers, "authorization");
            if !verify_bearer(target.token_hash.as_deref(), auth) {
                return json_err(StatusCode::UNAUTHORIZED, "bad_key", "key does not match");
            }
            let Some(payload) = parse(&bytes) else {
                return json_err(StatusCode::BAD_REQUEST, "bad_json", "body is not JSON");
            };
            if let Some(w) = &st.write {
                let kind = if target.kind.as_deref() == Some("github") {
                    "github"
                } else {
                    "webhook"
                };
                let idem = header_str(&parts.headers, "idempotency-key").filter(|s| !s.is_empty());
                match enqueue_generic(w, &id, kind, idem, &payload).await {
                    Ok(Some(r)) => return r,
                    Ok(None) => {}
                    Err(e) => return internal(e),
                }
            }
        }
    }
    // 필터·회차는 아직 TS(모듈 머리말).
    to_ts(parts, bytes).await
}

pub async fn github(
    State(st): State<Arc<HooksState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    handle(st, peer, id, req, Hook::Github).await
}

pub async fn generic(
    State(st): State<Arc<HooksState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    handle(st, peer, id, req, Hook::Generic).await
}

/// 로그인 없는 표면 — auth 층을 걸지 않는다(TS 도 `requireAccount` 가 없다).
pub fn routes(st: HooksState, cors: Arc<crate::cors::Cors>) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<HooksState>>::new()
        .post("/hooks/github/{id}", github)
        .post("/hooks/generic/{id}", generic)
        .map(|r| {
            r.layer(axum::middleware::from_fn_with_state(
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
    use ring::hmac;

    const KEY: &str = "hkhook_test-key";

    fn sealed() -> (SecretBox, String) {
        let b = SecretBox::new(Some("unit-test-master")).expect("box");
        let enc = b.seal(KEY);
        (b, enc)
    }

    fn sig(body: &[u8]) -> String {
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, KEY.as_bytes()), body);
        format!("sha256={}", hex::encode(tag.as_ref()))
    }

    #[test]
    fn good_signature_over_raw_bytes() {
        let (b, enc) = sealed();
        let body = br#"{"a": 1}"#;
        assert!(github_ok(Some(&b), Some(&enc), body, Some(&sig(body))));
    }

    #[test]
    fn bad_signature() {
        let (b, enc) = sealed();
        let body = br#"{"a": 1}"#;
        // 같은 JSON 을 다시 직렬화한 바이트로는 맞지 않는다.
        assert!(!github_ok(
            Some(&b),
            Some(&enc),
            body,
            Some(&sig(br#"{"a":1}"#))
        ));
        assert!(!github_ok(Some(&b), Some(&enc), body, Some("sha256=00")));
        let mut s = sig(body);
        s.replace_range(7..8, if s.as_bytes()[7] == b'a' { "b" } else { "a" });
        assert!(!github_ok(Some(&b), Some(&enc), body, Some(&s)));
        // 다른 키로 봉인한 것 · 접두사 없음
        let other = SecretBox::new(Some("other-master")).expect("box");
        assert!(!github_ok(Some(&other), Some(&enc), body, Some(&sig(body))));
        assert!(!github_ok(
            Some(&b),
            Some(&enc),
            body,
            Some(&sig(body)[7..])
        ));
    }

    #[test]
    fn missing_header_box_or_secret() {
        let (b, enc) = sealed();
        let body = b"{}";
        assert!(!github_ok(Some(&b), Some(&enc), body, None));
        assert!(!github_ok(None, Some(&enc), body, Some(&sig(body))));
        assert!(!github_ok(Some(&b), None, body, Some(&sig(body))));
    }

    #[test]
    fn neutralize_and_generic_vars() {
        assert_eq!(neutralize("a\r\n\nb @x", 300), "a b @\u{200b}x");
        assert_eq!(neutralize("abcdef", 4), "abc…");
        assert_eq!(neutralize("😀😀", 3), "😀…");
        let v = generic_vars(
            &serde_json::json!({"a": "x", "n": 3, "b": true, "o": {}, "bad key": "y"}),
        )
        .unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v["payload.n"], "3");
        assert!(generic_vars(&serde_json::json!({"f": 1.5})).is_none());
        assert!(generic_vars(&serde_json::json!({"big": 12345678901234567890u64})).is_none());
        assert!(generic_vars(&serde_json::json!([1])).unwrap().is_empty());
    }

    #[test]
    fn parse_matches_ts() {
        assert_eq!(parse(b""), Some(serde_json::json!({})));
        assert_eq!(parse(b"null"), Some(Value::Null));
        assert!(parse(b"{nope").is_none());
    }

    #[test]
    fn debug_redacts_secrets() {
        let t = IngressTarget {
            kind: Some("github".into()),
            token_hash: Some("deadbeef".into()),
            secret_enc: Some("v1.secret".into()),
            trigger: None,
        };
        let s = format!("{t:?}");
        assert!(!s.contains("deadbeef") && !s.contains("v1.secret"), "{s}");
    }

    #[test]
    fn github_ignored_matches_ts() {
        use serde_json::json;
        let push =
            json!({ "kind": "github", "repo": "Acme/App", "event": "push", "branch": "main" });
        let p = json!({ "repository": { "full_name": "acme/app" }, "ref": "refs/heads/dev", "commits": [] });
        assert_eq!(github_ignored(&push, "push", &p), Some("branch"));
        assert_eq!(github_ignored(&push, "release", &p), Some("event"));
        let other = json!({ "repository": { "full_name": "acme/other" } });
        assert_eq!(github_ignored(&push, "push", &other), Some("repo"));
        assert_eq!(github_ignored(&push, "push", &json!([])), Some("repo"));
        let tag = json!({ "repository": { "full_name": "acme/app" }, "ref": "refs/tags/v1" });
        assert_eq!(github_ignored(&push, "push", &tag), Some("not_a_branch"));
        let main = json!({ "repository": { "full_name": "acme/app" }, "ref": "refs/heads/main" });
        assert_eq!(
            github_ignored(&push, "push", &main),
            None,
            "a match goes to TS"
        );
        let nulls = json!({ "repository": { "full_name": "acme/app" }, "ref": "refs/heads/dev", "commits": [null] });
        assert_eq!(github_ignored(&push, "push", &nulls), None, "TS throws");
        let num = json!({ "repository": { "full_name": 7 } });
        assert_eq!(github_ignored(&push, "push", &num), None, "JS coercion");
        let pr = json!({ "repo": "acme/app", "event": "pull_request.merged" });
        let open = json!({ "repository": { "full_name": "acme/app" }, "action": "closed", "pull_request": { "merged": false } });
        assert_eq!(github_ignored(&pr, "pull_request", &open), Some("event"));
        let merged = json!({ "repository": { "full_name": "acme/app" }, "action": "closed", "pull_request": { "merged": true } });
        assert_eq!(github_ignored(&pr, "pull_request", &merged), None);
        let wf = json!({ "repo": "acme/app", "event": "workflow_run.completed" });
        let req = json!({ "repository": { "full_name": "acme/app" }, "action": "requested" });
        assert_eq!(github_ignored(&wf, "workflow_run", &req), Some("event"));
        let rel = json!({ "repo": "acme/app", "event": "release.published" });
        assert_eq!(github_ignored(&rel, "release", &req), Some("event"));
    }

    #[test]
    fn secret_columns_listed() {
        assert!(PRIVILEGES.contains(&("automation.ingress_token_hash", "SELECT")));
        assert!(PRIVILEGES.contains(&("automation.ingress_secret_enc", "SELECT")));
    }
}
