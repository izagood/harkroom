//! `/operators*` REST 8개(C2a, TS `routes/operatorRoutes.ts`). 소켓과 같은 프로세스에 둬야 하는 까닭: 폐기(DELETE·claim
//! `replaces`)는 허브의 소켓을 4401 로 끊고, 목록·self·능력은 허브가 든 「지금 붙어 있나·박동」을 싣는다.
//!
//! 순서는 TS 와 같다: fastify 본문 읽기 → preHandler(인증·권한) → zod. 거절 상태·코드는 같고 문구(zod 의 issue 목록)는 다르다.
//! 이벤트는 이 프로세스의 허브로 낸다(TS `emitEvent` 와 같은 꼴) — core=rust 에서 `/ws` 를 답하는 쪽이 여기다.
use super::operator::OperatorCore;
use crate::auth::{Account, Auth, RequireAccount, RequireOperator};
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::perm::{Target, TargetKind, can, require_cap};
use crate::write::{AuditEntry, Body, read_body, record_audit};
use crate::writes_settings::{ip_of, js_len};
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const REGISTER_CODE_TTL: Duration = Duration::from_secs(5 * 60);
/// TS `UPGRADE_HISTORY_MAX`.
const UPGRADE_HISTORY_MAX: i64 = 20;
/// shared `OPERATOR_LABEL_MAX`.
pub const OPERATOR_LABEL_MAX: usize = 64;

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}
macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

/// TS `OP_COLS` 를 JSON 한 줄로(칸 순서도 같다).
macro_rules! op_json {
    ($p:literal) => {
        concat!(
            "json_build_object('id', ",
            $p,
            "id, 'ownerAccountId', ",
            $p,
            "owner_account_id, 'name', ",
            $p,
            "name, 'createdAt', ",
            crate::iso!("created_at"),
            ", 'lastSeenAt', ",
            crate::iso!("last_seen_at"),
            ", 'revokedAt', ",
            crate::iso!("revoked_at"),
            ", 'version', ",
            $p,
            "version, 'label', ",
            $p,
            "label, 'machineId', ",
            $p,
            "machine_id)::text"
        )
    };
}

fn rand_b64url(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("os random");
    crate::inbox_today::b64url(&b)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct CodeEntry {
    owner: String,
    code_id: String,
    expires: Instant,
}

/// TS `createRegisterCodes` — 1회용, TTL. `codeId` 는 코드와 따로 뽑는다(이벤트로 퍼져도 코드를 되짚을 수 없다).
pub struct RegisterCodes {
    ttl: Duration,
    live: Mutex<HashMap<String, CodeEntry>>,
}

impl RegisterCodes {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            live: Mutex::new(HashMap::new()),
        }
    }
    pub fn issue(&self, owner: &str) -> (String, String) {
        let code = format!("hkreg_{}", rand_b64url(16));
        let code_id = rand_b64url(9);
        let now = Instant::now();
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        // TS 는 지난 코드를 쓰일 때까지 들고 있다 — 여기선 낼 때 만료분을 걷는다(같은 답, 메모리만 다르다).
        live.retain(|_, e| e.expires > now);
        live.insert(
            code.clone(),
            CodeEntry {
                owner: owner.to_owned(),
                code_id: code_id.clone(),
                expires: now + self.ttl,
            },
        );
        (code, code_id)
    }
    /// 있든 없든 지운다 — 두 번째 시도는 언제나 실패다. `(owner, codeId)`.
    pub fn consume(&self, code: &str) -> Option<(String, String)> {
        let e = self
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(code)?;
        (e.expires >= Instant::now()).then_some((e.owner, e.code_id))
    }
}

fn bad_request(msg: &str) -> Response {
    json_err(StatusCode::BAD_REQUEST, "bad_request", msg)
}
fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "그런 오퍼레이터가 없다")
}
fn json_text(body: String) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// TS `view(row, viewer)` — 행 JSON 끝에 `online`·`status` 를 붙인다. MCP 칸은 주인에게만(viewer 가 없으면 그대로).
fn view(core: &OperatorCore, row: &str, viewer: Option<&str>) -> String {
    let parsed: Value = serde_json::from_str(row).unwrap_or(Value::Null);
    let id = parsed.get("id").and_then(Value::as_str).unwrap_or("");
    let owner = parsed
        .get("ownerAccountId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut status = core.hub.status(id).unwrap_or(Value::Null);
    if let (Some(v), Value::Object(m)) = (viewer, &mut status)
        && v != owner
    {
        m.remove("mcp");
    }
    let head = row.strip_suffix('}').unwrap_or(row);
    format!(
        r#"{head},"online":{},"status":{status}}}"#,
        core.hub.is_online(id)
    )
}

/// 본문을 읽고(fastify) 인증을 꺼낸다 — 본문 오류가 인증 오류보다 먼저다.
#[allow(clippy::result_large_err)]
async fn body_auth(req: Request) -> Result<(Body, Auth, axum::http::request::Parts), Response> {
    let (parts, body) = req.into_parts();
    let body = read_body(&parts.headers, body).await?;
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    Ok((body, auth, parts))
}

fn op_target(id: &str) -> Target<'_> {
    Target {
        kind: TargetKind::Operator,
        id,
    }
}

/// `POST /operators/register-codes` — `operator.register`.
pub async fn register_code(State(core): State<Arc<OperatorCore>>, req: Request) -> Response {
    let (_, auth, _) = tri!(body_auth(req).await);
    let me: Account = tri!(require_cap(&core.pool, &auth, "operator.register", None).await);
    let (code, code_id) = core.codes.issue(&me.id);
    let expires = super::operator_hub::iso_from_ms(now_ms() + REGISTER_CODE_TTL.as_millis() as i64);
    json_text(json!({ "code": code, "codeId": code_id, "expiresAt": expires }).to_string())
}

/// zod `claimBody` — `{ code: startsWith('hkreg_'), name: 1..64, replaces?: uuid }`. 본문 없음은 `{}`.
pub fn parse_claim(body: &Body) -> Result<(String, String, Option<String>), &'static str> {
    let empty = serde_json::Map::new();
    let o = match body {
        Body::None => &empty,
        Body::Json(Value::Object(o)) => o,
        _ => return Err("Expected object"),
    };
    let code = match o.get("code") {
        Some(Value::String(c)) if c.starts_with("hkreg_") => c.clone(),
        _ => return Err("code"),
    };
    let name = match o.get("name") {
        Some(Value::String(n)) if (1..=64).contains(&js_len(n)) => n.clone(),
        _ => return Err("name"),
    };
    let replaces = match o.get("replaces") {
        None => None,
        Some(Value::String(r)) if is_zod_uuid(r) => Some(r.clone()),
        Some(_) => return Err("replaces"),
    };
    Ok((code, name, replaces))
}

/// `POST /operators/claim` — 인증 없음(코드가 인증). 새 행·옛 행 폐기·배정 이동·비밀 grant 세우기는 한 트랜잭션.
pub async fn claim(State(core): State<Arc<OperatorCore>>, req: Request) -> Response {
    let (body, _, parts) = tri!(body_auth(req).await);
    let (code, name, replaces) = tri!(parse_claim(&body).map_err(bad_request));
    let Some((owner, code_id)) = core.codes.consume(&code) else {
        return json_err(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "등록 코드가 없거나 만료됐다",
        );
    };
    let token = format!("hkop_{}", rand_b64url(32));
    let hash = crate::auth::hash_token(&token);
    let mut tx = db!(core.write.begin().await);
    let mut row: String = db!(
        sqlx::query_scalar(concat!(
            "insert into operator (owner_account_id, name, token_hash) values ($1::uuid, $2, $3) returning ",
            op_json!("")
        ))
        .bind(&owner)
        .bind(&name)
        .bind(&hash)
        .fetch_one(&mut *tx)
        .await
    );
    let new_id = serde_json::from_str::<Value>(&row)
        .ok()
        .and_then(|v| v["id"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let mut replaced: Option<(String, Vec<String>)> = None;
    if let Some(old) = &replaces {
        // 코드를 낸 사람의 것일 때만 폐기한다. 아니면 조용히 넘어간다(남의 id 를 떠보는 길이 되지 않게).
        let hit: Option<Option<String>> = db!(
            sqlx::query_scalar(
                "update operator set revoked_at = now() \
                  where id = $1::uuid and owner_account_id = $2::uuid and revoked_at is null returning label"
            )
            .bind(old)
            .bind(&owner)
            .fetch_optional(&mut *tx)
            .await
        );
        if let Some(label) = hit {
            if let Some(label) = label {
                row = db!(sqlx::query_scalar(concat!(
                    "update operator set label = $2 where id = $1::uuid returning ",
                    op_json!("")
                ))
                .bind(&new_id)
                .bind(&label)
                .fetch_one(&mut *tx)
                .await);
            }
            let moved: Vec<String> = db!(
                sqlx::query_scalar(
                    "update agent_assignment set operator_id = $2::uuid where operator_id = $1::uuid returning agent_id::text"
                )
                .bind(old)
                .bind(&new_id)
                .fetch_all(&mut *tx)
                .await
            );
            for agent in &moved {
                // TS `suspendSecretGrants(client, { agentId, exceptOperatorId }, 'assignment_changed')`.
                db!(
                    sqlx::query(
                        "update secret_grant set suspended_at = now(), suspend_reason = $2 \
                          where agent_id = $1::uuid and suspended_at is null and operator_id is not null and operator_id <> $3::uuid"
                    )
                    .bind(agent)
                    .bind("assignment_changed")
                    .bind(&new_id)
                    .execute(&mut *tx)
                    .await
                );
            }
            replaced = Some((old.clone(), moved));
        }
    }
    db!(tx.commit().await);
    let operator = view(&core, &row, None);
    // commit 뒤의 일은 응답을 막지 못한다(security #1025) — 끊기·감사·이벤트가 실패해도 토큰은 돌려준다.
    if let Some((old, _)) = &replaced {
        core.hub.disconnect(old, 4401, "operator revoked");
    }
    let ip = ip_of(&parts, &core.trust);
    let mut detail = json!({ "name": name });
    if let Some((old, _)) = &replaced {
        detail["replaces"] = json!(old);
    }
    record_audit(
        &core.write,
        AuditEntry {
            action: "operator.registered",
            actor_id: Some(&owner),
            actor_handle: None,
            target: Some(&new_id),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
    if let Some((old, moved)) = &replaced {
        record_audit(
            &core.write,
            AuditEntry {
                action: "operator.revoked",
                actor_id: Some(&owner),
                actor_handle: None,
                target: Some(old),
                ip: ip.as_deref(),
                detail: json!({ "replacedBy": new_id, "movedAssignments": moved.len() }),
            },
        )
        .await;
    }
    core.events.emit(json!({ "type": "operator.changed", "operatorId": new_id, "audience": [owner], "codeId": code_id }));
    if let Some((old, moved)) = &replaced {
        core.changed_all(old);
        for agent in moved {
            core.events.emit(
                json!({ "type": "agent_assignment.changed", "agentId": agent, "audience": "all" }),
            );
        }
    }
    let replaced_json = replaced.as_ref().map_or_else(
        || "null".to_string(),
        |(old, moved)| json!({ "operatorId": old, "movedAssignments": moved.len() }).to_string(),
    );
    json_text(format!(
        r#"{{"operator":{operator},"token":{},"replaced":{replaced_json}}}"#,
        Value::String(token)
    ))
}

/// `GET /operators` — 내 것, `operator.manage` 면 전부.
pub async fn list(
    State(core): State<Arc<OperatorCore>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    let all = db!(can(&core.pool, &me, "operator.manage", None).await);
    let rows: Vec<String> = db!(
        sqlx::query_scalar(concat!(
            "select ",
            op_json!(""),
            " from operator where revoked_at is null and ($1::bool or owner_account_id = $2::uuid) order by created_at"
        ))
        .bind(all)
        .bind(&me.id)
        .fetch_all(&core.pool)
        .await
    );
    let items: Vec<String> = rows.iter().map(|r| view(&core, r, Some(&me.id))).collect();
    json_text(format!(r#"{{"operators":[{}]}}"#, items.join(",")))
}

/// `GET /operators/self` — 오퍼레이터 토큰.
pub async fn self_view(
    State(core): State<Arc<OperatorCore>>,
    RequireOperator(op, _): RequireOperator,
) -> Response {
    let row: Option<String> = db!(sqlx::query_scalar(concat!(
        "select ",
        op_json!(""),
        " from operator where id = $1::uuid"
    ))
    .bind(&op.id)
    .fetch_optional(&core.pool)
    .await);
    match row {
        Some(r) => json_text(view(&core, &r, None)),
        None => not_found(),
    }
}

/// `GET /operators/{id}/capabilities` — 오프라인이면 404 `offline`.
pub async fn capabilities(
    State(core): State<Arc<OperatorCore>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, auth, _) = tri!(body_auth(req).await);
    tri!(require_cap(&core.pool, &auth, "operator.manage", Some(op_target(&id))).await);
    match core.hub.capabilities(&id) {
        Some(c) => json_text(c.to_string()),
        None => json_err(
            StatusCode::NOT_FOUND,
            "offline",
            "오퍼레이터가 붙어 있지 않다",
        ),
    }
}

/// `GET /operators/{id}/upgrades` — 최근 것부터 20줄.
pub async fn upgrades(
    State(core): State<Arc<OperatorCore>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, auth, _) = tri!(body_auth(req).await);
    tri!(require_cap(&core.pool, &auth, "operator.manage", Some(op_target(&id))).await);
    let body: String = db!(
        sqlx::query_scalar(concat!(
            "select json_build_object('upgrades', coalesce((select json_agg(x order by x.id desc) from (",
            "select id, stage, from_version, to_version, error, ",
            crate::iso!("at"),
            " as at from operator_upgrade where operator_id = $1::uuid order by id desc limit $2) x), '[]'::json))::text"
        ))
        .bind(&id)
        .bind(UPGRADE_HISTORY_MAX)
        .fetch_one(&core.pool)
        .await
    );
    // id 는 정렬에만 쓴다 — 칸 이름을 TS 와 맞춰 다시 적는다.
    let v: Value = serde_json::from_str(&body).unwrap_or(json!({ "upgrades": [] }));
    let rows: Vec<String> = v["upgrades"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| {
                    format!(
                        r#"{{"stage":{},"from":{},"to":{},"error":{},"at":{}}}"#,
                        r["stage"], r["from_version"], r["to_version"], r["error"], r["at"]
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    json_text(format!(r#"{{"upgrades":[{}]}}"#, rows.join(",")))
}

/// shared `normalizeOperatorLabel` — 공백 접기, 보이지 않는 글자 지우기(이모지를 이루는 ZWJ·변이 선택자·지역 깃발 태그는 남김), trim.
pub fn normalize_label(raw: Option<&str>) -> Option<String> {
    use std::sync::OnceLock;
    static RE: OnceLock<[regex::Regex; 4]> = OnceLock::new();
    let [invisible, picto, modifier, emoji] = RE.get_or_init(|| {
        [
            regex::Regex::new(r"^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\x{2800}]$").unwrap(),
            regex::Regex::new(r"^\p{Extended_Pictographic}$").unwrap(),
            regex::Regex::new(r"^\p{Emoji_Modifier}$").unwrap(),
            regex::Regex::new(r"^\p{Emoji}$").unwrap(),
        ]
    });
    let raw = raw?;
    // JS `/[\s\u0085]+/gu` — `\s` 는 WhiteSpace + FEFF(BOM). Rust `char::is_whitespace` 는 FEFF 를 빼므로 따로 넣는다.
    let mut folded = String::with_capacity(raw.len());
    let mut in_ws = false;
    for c in raw.chars() {
        if c.is_whitespace() || c == '\u{FEFF}' || c == '\u{85}' {
            if !in_ws {
                folded.push(' ');
            }
            in_ws = true;
        } else {
            folded.push(c);
            in_ws = false;
        }
    }
    let cps: Vec<char> = folded.chars().collect();
    let is = |re: &regex::Regex, c: Option<&char>| {
        c.is_some_and(|c| re.is_match(c.encode_utf8(&mut [0; 4])))
    };
    let mut flag = std::collections::HashSet::new();
    let tag = |c: char| {
        ('\u{E0030}'..='\u{E0039}').contains(&c) || ('\u{E0061}'..='\u{E007A}').contains(&c)
    };
    let mut i = 0;
    while i < cps.len() {
        if cps[i] == '\u{1F3F4}' {
            let mut j = i + 1;
            while j < cps.len() && j - i <= 7 && tag(cps[j]) {
                j += 1;
            }
            let count = j - i - 1;
            if (3..=7).contains(&count) && cps.get(j) == Some(&'\u{E007F}') {
                flag.extend(i + 1..=j);
                i = j;
            }
        }
        i += 1;
    }
    let keep_joiner = |i: usize| {
        if cps[i] != '\u{200D}' || i == 0 {
            return false;
        }
        let mut b = i - 1;
        if cps[b] == '\u{FE0F}' {
            if b == 0 {
                return false;
            }
            b -= 1;
        }
        let before = cps.get(b);
        let after = cps.get(i + 1);
        (is(picto, before) || is(modifier, before)) && is(picto, after)
    };
    let keep_selector = |i: usize| {
        (cps[i] == '\u{FE0F}' || cps[i] == '\u{FE0E}') && i > 0 && is(emoji, cps.get(i - 1))
    };
    let mut out = String::new();
    for (i, c) in cps.iter().enumerate() {
        if !is(invisible, Some(c)) || flag.contains(&i) || keep_joiner(i) || keep_selector(i) {
            out.push(*c);
        }
    }
    let out = out.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    (!out.is_empty()).then(|| out.to_string())
}

/// zod `renameBody` — `label` 은 꼭 있어야 한다(string ≤ 200 | null). 정리 뒤 ≤ 64.
pub fn parse_rename(body: &Body) -> Result<Option<String>, &'static str> {
    let empty = serde_json::Map::new();
    let o = match body {
        Body::None => &empty,
        Body::Json(Value::Object(o)) => o,
        _ => return Err("Expected object"),
    };
    let label = match o.get("label") {
        Some(Value::Null) => None,
        Some(Value::String(s)) if js_len(s) <= 200 => normalize_label(Some(s)),
        _ => return Err("label"),
    };
    if label
        .as_deref()
        .is_some_and(|l| js_len(l) > OPERATOR_LABEL_MAX)
    {
        return Err("label 은 64자까지다");
    }
    Ok(label)
}

/// `PATCH /operators/{id}` — 이름 바꾸기. 같은 값이면 감사·이벤트 없음.
pub async fn rename(
    State(core): State<Arc<OperatorCore>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, auth, parts) = tri!(body_auth(req).await);
    let me = tri!(require_cap(&core.pool, &auth, "operator.manage", Some(op_target(&id))).await);
    let label = tri!(parse_rename(&body).map_err(bad_request));
    let hit: Option<(String, Option<String>)> = db!(
        sqlx::query_as(concat!(
            "with prev as (select id as prev_id, label as before from operator where id = $1::uuid and revoked_at is null for update) \
             update operator set label = $2 from prev where operator.id = prev.prev_id returning ",
            op_json!("operator."),
            ", prev.before"
        ))
        .bind(&id)
        .bind(&label)
        .fetch_optional(&core.write)
        .await
    );
    let Some((row, before)) = hit else {
        return not_found();
    };
    if before != label {
        record_audit(
            &core.write,
            AuditEntry {
                action: "operator.renamed",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: Some(&id),
                ip: ip_of(&parts, &core.trust).as_deref(),
                detail: json!({ "from": before, "to": label }),
            },
        )
        .await;
        core.changed_all(&id);
    }
    json_text(view(&core, &row, Some(&me.id)))
}

/// `DELETE /operators/{id}` — 폐기, 붙어 있던 소켓은 4401. 204.
pub async fn revoke(
    State(core): State<Arc<OperatorCore>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, auth, parts) = tri!(body_auth(req).await);
    let me = tri!(require_cap(&core.pool, &auth, "operator.manage", Some(op_target(&id))).await);
    let hit: Option<String> = db!(
        sqlx::query_scalar(
            "update operator set revoked_at = now() where id = $1::uuid and revoked_at is null returning id::text"
        )
        .bind(&id)
        .fetch_optional(&core.write)
        .await
    );
    if hit.is_none() {
        return not_found();
    }
    record_audit(
        &core.write,
        AuditEntry {
            action: "operator.revoked",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip_of(&parts, &core.trust).as_deref(),
            detail: json!({}),
        },
    )
    .await;
    core.hub.disconnect(&id, 4401, "operator revoked");
    core.changed_all(&id);
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_normalize_matches_shared_cases() {
        assert_eq!(normalize_label(None), None);
        assert_eq!(normalize_label(Some("   ")), None);
        assert_eq!(
            normalize_label(Some(" a\n\tb  c ")).as_deref(),
            Some("a b c")
        );
        assert_eq!(normalize_label(Some("a\u{200B}b")).as_deref(), Some("ab"));
        assert_eq!(normalize_label(Some("\u{2800}x")).as_deref(), Some("x"));
        // 👩🏽‍💻 — ZWJ 는 남는다.
        let dev = "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}";
        assert_eq!(normalize_label(Some(dev)).as_deref(), Some(dev));
        // ❤️ 는 남고, 글자 뒤 FE0F 는 지운다.
        assert_eq!(
            normalize_label(Some("\u{2764}\u{FE0F}")).as_deref(),
            Some("\u{2764}\u{FE0F}")
        );
        assert_eq!(normalize_label(Some("a\u{FE0F}")).as_deref(), Some("a"));
        // 🏴󠁧󠁢󠁳󠁣󠁴󠁿 (스코틀랜드) 는 남는다.
        let sct = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
        assert_eq!(normalize_label(Some(sct)).as_deref(), Some(sct));
        assert_eq!(normalize_label(Some("x\u{E0067}")).as_deref(), Some("x"));
    }

    #[test]
    fn claim_and_rename_shapes() {
        let u = "00000000-0000-4000-8000-000000000001";
        assert!(parse_claim(&Body::None).is_err());
        assert!(parse_claim(&Body::Json(json!({ "code": "hkreg_x", "name": "m" }))).is_ok());
        assert!(parse_claim(&Body::Json(json!({ "code": "x", "name": "m" }))).is_err());
        assert!(parse_claim(&Body::Json(json!({ "code": "hkreg_x", "name": "" }))).is_err());
        assert!(
            parse_claim(&Body::Json(
                json!({ "code": "hkreg_x", "name": "m", "replaces": u })
            ))
            .is_ok()
        );
        assert!(
            parse_claim(&Body::Json(
                json!({ "code": "hkreg_x", "name": "m", "replaces": "no" })
            ))
            .is_err()
        );
        assert_eq!(
            parse_rename(&Body::Json(json!({ "label": null }))),
            Ok(None)
        );
        assert_eq!(
            parse_rename(&Body::Json(json!({ "label": "  " }))),
            Ok(None)
        );
        assert!(
            parse_rename(&Body::Json(json!({}))).is_err(),
            "label 은 꼭 있어야 한다"
        );
        assert!(parse_rename(&Body::Json(json!({ "label": "a".repeat(65) }))).is_err());
        assert!(parse_rename(&Body::Json(json!({ "label": "a".repeat(201) }))).is_err());
    }

    #[test]
    fn register_codes_are_one_shot_and_expire() {
        let c = RegisterCodes::new(Duration::from_secs(60));
        let (code, id) = c.issue("o");
        assert!(code.starts_with("hkreg_") && code.len() == 6 + 22);
        assert_eq!(id.len(), 12);
        assert_eq!(c.consume(&code), Some(("o".into(), id)));
        assert_eq!(c.consume(&code), None);
        let c = RegisterCodes::new(Duration::ZERO);
        let (code, _) = c.issue("o");
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(c.consume(&code), None);
    }
}
