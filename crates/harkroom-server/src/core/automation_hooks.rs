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
//! - github 이 맞으면(쓰기 풀이 있고 디바운스가 없을 때) 회차도 여기서 만든다(`github:<delivery>`, 상한은 200 `rate_limited`).
//!   paths/change 글롭 필터도 여기서(`globToRegExp` 이식) — ASCII 아닌 경로·글롭, JS 강제 변환이 다를 수 있는 값은 TS 로.
//! - **TS 로 넘기는 것**: 위에서 장담하지 못한 꼴과 회차 만들기(`enqueueRun` —
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

/// TS `matchGithub` 의 거절 갈래만 — [`match_github`] 의 `Err`.
#[cfg(test)]
pub(crate) fn github_ignored(
    trigger: &Value,
    event: &str,
    payload: &Value,
) -> Option<&'static str> {
    match_github(trigger, event, payload)?.err()
}

/// TS `matchGithub`. `Some(Ok(vars))` 맞음, `Some(Err(reason))` 거절(`200 ignored`), `None` 은 JS 와 같은 답을 장담할 수 없는
/// 꼴(문자열·정수 아닌 값·ASCII 아닌 저장소 이름·TS 가 던질 본문·paths/change 글롭 필터) — TS 로 넘긴다.
pub(crate) fn match_github(
    trigger: &Value,
    event: &str,
    payload: &Value,
) -> Option<Result<serde_json::Map<String, Value>, &'static str>> {
    // JS `String(x ?? '')`.
    fn jv(v: Option<&Value>) -> Option<String> {
        match v {
            None | Some(Value::Null) => Some(String::new()),
            Some(v) => js_string(v),
        }
    }
    fn n(v: Option<&Value>, max: usize) -> Option<Value> {
        Some(Value::String(neutralize(&jv(v)?, max)))
    }
    let t_repo = trigger.get("repo")?.as_str()?;
    let t_event = trigger.get("event")?.as_str()?;
    let repo = jv(payload.get("repository").and_then(|r| r.get("full_name")))?;
    if !repo.is_ascii() || !t_repo.is_ascii() {
        return None;
    }
    if !repo.eq_ignore_ascii_case(t_repo) {
        return Some(Err("repo"));
    }
    let mut vars = serde_json::Map::new();
    vars.insert("repo".into(), Value::String(neutralize(&repo, 300)));
    vars.insert("event".into(), Value::String(neutralize(t_event, 300)));
    let action = payload.get("action");
    let is = |v: Option<&Value>, s: &str| v.and_then(Value::as_str) == Some(s);
    let mut branch: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    let mut changes: Vec<(String, &'static str)> = Vec::new();
    match t_event {
        "push" => {
            if event != "push" {
                return Some(Err("event"));
            }
            let r = jv(payload.get("ref"))?;
            let Some(b) = r.strip_prefix("refs/heads/") else {
                return Some(Err("not_a_branch"));
            };
            branch = Some(b.to_owned());
            if let Some(Value::Array(cs)) = payload.get("commits") {
                for c in cs {
                    if c.is_null() {
                        return None; // TS 가 던진다(500).
                    }
                    for k in ["added", "modified", "removed"] {
                        if let Some(Value::Array(ps)) = c.get(k) {
                            for p in ps {
                                files.push(p.as_str()?.to_owned());
                                changes.push((p.as_str()?.to_owned(), k));
                            }
                        }
                    }
                }
            }
            vars.insert("sha".into(), n(payload.get("after"), 40)?);
            let pusher = payload.get("pusher").and_then(|p| p.get("name"));
            let author = match pusher {
                None | Some(Value::Null) => payload.get("sender").and_then(|p| p.get("login")),
                some => some,
            };
            vars.insert("author".into(), n(author, 300)?);
            vars.insert("compare".into(), n(payload.get("compare"), 500)?);
            vars.insert(
                "commit.message".into(),
                n(
                    payload.get("head_commit").and_then(|c| c.get("message")),
                    300,
                )?,
            );
        }
        "pull_request.merged" => {
            let pr = payload.get("pull_request");
            let merged = pr.and_then(|p| p.get("merged")).and_then(Value::as_bool) == Some(true);
            if event != "pull_request" || !is(action, "closed") || !merged {
                return Some(Err("event"));
            }
            let pr = pr?;
            branch = Some(jv(pr.get("base").and_then(|b| b.get("ref")))?);
            vars.insert("pr.number".into(), n(pr.get("number"), 20)?);
            vars.insert("pr.title".into(), n(pr.get("title"), 300)?);
            vars.insert("pr.url".into(), n(pr.get("html_url"), 500)?);
            vars.insert("sha".into(), n(pr.get("merge_commit_sha"), 40)?);
            vars.insert(
                "author".into(),
                n(pr.get("user").and_then(|u| u.get("login")), 300)?,
            );
        }
        "release.published" => {
            if event != "release" || !is(action, "published") {
                return Some(Err("event"));
            }
            let rel = payload.get("release");
            let g = |k: &str| rel.and_then(|r| r.get(k));
            vars.insert("release.tag".into(), n(g("tag_name"), 300)?);
            vars.insert("release.url".into(), n(g("html_url"), 500)?);
            vars.insert(
                "author".into(),
                n(g("author").and_then(|a| a.get("login")), 300)?,
            );
        }
        _ => {
            if event != "workflow_run" || !is(action, "completed") {
                return Some(Err("event"));
            }
            let run = payload.get("workflow_run");
            let g = |k: &str| run.and_then(|r| r.get(k));
            branch = Some(jv(g("head_branch"))?);
            vars.insert("workflow.name".into(), n(g("name"), 300)?);
            vars.insert("workflow.conclusion".into(), n(g("conclusion"), 300)?);
            vars.insert("workflow.url".into(), n(g("html_url"), 500)?);
            vars.insert("sha".into(), n(g("head_sha"), 40)?);
        }
    }
    match trigger.get("branch") {
        None | Some(Value::Null) => {}
        Some(Value::String(b)) if b.is_empty() => {}
        Some(Value::String(b)) => {
            if branch.as_deref() != Some(b.as_str()) {
                return Some(Err("branch"));
            }
        }
        _ => return None,
    }
    if let Some(b) = &branch {
        vars.insert("branch".into(), Value::String(neutralize(b, 300)));
    }
    let has_paths = match trigger.get("paths") {
        None | Some(Value::Null) => false,
        Some(Value::Array(a)) => !a.is_empty(),
        _ => return None,
    };
    let has_change = match trigger.get("change") {
        None | Some(Value::Null) => false,
        Some(Value::String(c)) => !c.is_empty() && c != "any",
        _ => return None,
    };
    if has_paths || has_change {
        if t_event != "push" {
            return Some(Err("paths_need_push"));
        }
        // JS 정규식(UTF-16 단위·`.` 의 줄 끝)과 어긋날 수 있는 경로는 TS 로.
        if files.iter().any(|p| !p.is_ascii() || p.contains('\r')) {
            return None;
        }
        let globs: Vec<&str> = match trigger.get("paths") {
            Some(Value::Array(a)) if !a.is_empty() => {
                a.iter().map(Value::as_str).collect::<Option<Vec<_>>>()?
            }
            _ => vec!["**"],
        };
        let res = globs
            .iter()
            .map(|g| glob_regex(g))
            .collect::<Option<Vec<_>>>()?;
        let change = match trigger.get("change") {
            Some(Value::String(c)) if !c.is_empty() && c != "any" => Some(c.as_str()),
            _ => None,
        };
        let hit: Vec<&(String, &str)> = changes
            .iter()
            .filter(|(p, k)| res.iter().any(|r| r.is_match(p)) && change.is_none_or(|c| c == *k))
            .collect();
        if hit.is_empty() {
            return Some(Err("paths"));
        }
        let join = |it: &mut dyn Iterator<Item = &str>| {
            let mut seen = std::collections::HashSet::new();
            it.filter(|p| seen.insert(*p))
                .take(50)
                .map(|p| neutralize(p, 300))
                .collect::<Vec<_>>()
                .join("\n")
        };
        vars.insert(
            "files".into(),
            Value::String(join(&mut hit.iter().map(|(p, _)| p.as_str()))),
        );
        for k in ["added", "modified", "removed"] {
            let v = join(&mut hit.iter().filter(|(_, c)| *c == k).map(|(p, _)| p.as_str()));
            vars.insert(format!("files.{k}"), Value::String(v));
        }
        return Some(Ok(vars));
    }
    if !files.is_empty() {
        let mut seen = std::collections::HashSet::new();
        let uniq: Vec<String> = files
            .iter()
            .filter(|p| seen.insert(p.as_str()))
            .take(50)
            .map(|p| neutralize(p, 300))
            .collect();
        vars.insert("files".into(), Value::String(uniq.join("\n")));
    }
    Some(Ok(vars))
}

/// TS `globToRegExp` — `**` 는 `/` 를 넘고(뒤 `/` 하나 먹음), `*` 는 한 칸 안, `?` 는 한 글자. ASCII 아닌 글롭은 TS 로.
fn glob_regex(glob: &str) -> Option<regex::Regex> {
    if !glob.is_ascii() {
        return None;
    }
    let b: Vec<char> = glob.chars().collect();
    let mut re = String::from("^");
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == '*' {
            if b.get(i + 1) == Some(&'*') {
                re.push_str(".*");
                i += 1;
                if b.get(i + 1) == Some(&'/') {
                    i += 1;
                }
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else if ".+^${}()|[]\\".contains(c) {
            re.push('\\');
            re.push(c);
        } else {
            // JS 는 그 밖의 글자를 그대로 둔다(`-`·`&` 등도 괄호 밖에선 글자다).
            re.push_str(&regex::escape(&c.to_string()));
        }
        i += 1;
    }
    re.push('$');
    regex::Regex::new(&re).ok()
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
    // serde_json 은 키 순서를 바꿀 수 있다(`slice(0, 50)` 이 달라진다) — 50 칸 넘는 본문은 TS 로.
    if payload.as_object().is_some_and(|o| o.len() > 50) {
        return Ok(None);
    }
    let Some(vars) = generic_vars(payload) else {
        return Ok(None);
    };
    let idem = idem.map(|k| {
        let u: Vec<u16> = k.encode_utf16().take(200).collect();
        String::from_utf16_lossy(&u)
    });
    enqueue_vars(w, id, kind, "generic", idem, vars).await
}

/// TS `enqueueRun`(디바운스 없는 갈래). `suffix` 가 없으면 `prefix:` + 새 uuid. 디바운스가 걸렸으면 `None`(TS 로).
async fn enqueue_vars(
    w: &PgPool,
    id: &str,
    kind: &str,
    prefix: &str,
    suffix: Option<String>,
    vars: serde_json::Map<String, Value>,
) -> Result<Option<Response>, sqlx::Error> {
    use crate::core::mcp::automation_run as ar;
    use crate::loops::automation as la;
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
    let event_key = match suffix {
        Some(k) => format!("{prefix}:{k}"),
        None => {
            sqlx::query_scalar("select $1 || ':' || gen_random_uuid()::text")
                .bind(prefix)
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
        // TS: generic 은 429, github 은 200.
        let code = if prefix == "github" {
            StatusCode::OK
        } else {
            StatusCode::TOO_MANY_REQUESTS
        };
        return Ok(Some(status(code, "rate_limited")));
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
            match trigger
                .as_ref()
                .zip(event)
                .and_then(|(t, e)| match_github(t, e, &payload))
            {
                Some(Err(reason)) => {
                    return (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                        format!(r#"{{"status":"ignored","reason":"{reason}"}}"#),
                    )
                        .into_response();
                }
                Some(Ok(vars)) => {
                    // 배달 id 가 utf-8 이 아니면 TS(latin1) 와 키가 달라진다 — TS 로.
                    let delivery = match parts.headers.get("x-github-delivery") {
                        None => Some(None),
                        Some(v) => v
                            .to_str()
                            .ok()
                            .map(|s| Some(s.to_owned()).filter(|s| !s.is_empty())),
                    };
                    if let (Some(w), Some(delivery)) = (&st.write, delivery) {
                        match enqueue_vars(w, &id, "github", "github", delivery, vars).await {
                            Ok(Some(r)) => return r,
                            Ok(None) => {}
                            Err(e) => return internal(e),
                        }
                    }
                }
                None => {}
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
        let num = json!({ "repository": { "full_name": 7.5 } });
        assert_eq!(
            github_ignored(&push, "push", &num),
            None,
            "JS float coercion"
        );
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
    fn match_github_vars() {
        use serde_json::json;
        let t = json!({ "kind": "github", "repo": "acme/app", "event": "push" });
        let p = json!({
            "repository": { "full_name": "acme/app" }, "ref": "refs/heads/main", "after": "abc",
            "pusher": null, "sender": { "login": "@bob" }, "compare": "u",
            "commits": [{ "added": ["a.rs"], "modified": ["b.rs", "a.rs"] }, 3],
        });
        let v = match_github(&t, "push", &p).unwrap().unwrap();
        assert_eq!(v["branch"], "main");
        assert_eq!(v["author"], "@\u{200b}bob");
        assert_eq!(v["files"], "a.rs\nb.rs");
        assert_eq!(v["commit.message"], "");
        let globbed = json!({ "repo": "acme/app", "event": "push", "paths": ["src/**"] });
        assert_eq!(github_ignored(&globbed, "push", &p), Some("paths"));
        let g2 =
            json!({ "repo": "acme/app", "event": "push", "paths": ["*.rs"], "change": "modified" });
        let v = match_github(&g2, "push", &p).unwrap().unwrap();
        assert_eq!(v["files"], "b.rs\na.rs");
        assert_eq!(v["files.modified"], "b.rs\na.rs");
        assert_eq!(v["files.added"], "");
        assert!(glob_regex("**/x.ts").unwrap().is_match("x.ts"));
        assert!(glob_regex("a/**/b?.c").unwrap().is_match("a/q/r/b1.c"));
        assert!(!glob_regex("a/*.c").unwrap().is_match("a/q/b.c"));
        let rel = json!({ "repo": "acme/app", "event": "release.published", "branch": "main" });
        let rp = json!({ "repository": { "full_name": "acme/app" }, "action": "published" });
        assert_eq!(github_ignored(&rel, "release", &rp), Some("branch"));
        let relp = json!({ "repo": "acme/app", "event": "release.published", "change": "added" });
        assert_eq!(
            github_ignored(&relp, "release", &rp),
            Some("paths_need_push")
        );
        let pr = json!({ "repo": "acme/app", "event": "pull_request.merged" });
        let pp = json!({ "repository": { "full_name": "acme/app" }, "action": "closed",
            "pull_request": { "merged": true, "number": 12, "base": { "ref": "main" } } });
        let v = match_github(&pr, "pull_request", &pp).unwrap().unwrap();
        assert_eq!(v["pr.number"], "12");
        assert_eq!(v["branch"], "main");
    }

    #[test]
    fn secret_columns_listed() {
        assert!(PRIVILEGES.contains(&("automation.ingress_token_hash", "SELECT")));
        assert!(PRIVILEGES.contains(&("automation.ingress_secret_enc", "SELECT")));
    }
}
