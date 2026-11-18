//! S5.4 — `POST /agent/api-results`(TS `apiCallRoutes.ts` → `reportApiCall`). 오퍼레이터의 `api` 래퍼가 외부 API 호출을 마친 뒤
//! 보고한다 — 임대 스레드에 시스템 줄 하나와 감사 `api.call.done` 을 남긴다. 201 `{ messageId }`.
//!
//! - 순서는 TS 그대로: 오퍼레이터 아님 403 → zod 400 → 임대 아님 403 `lease_invalid` → 연결 없음 404 `no_connector` → 판정 기록이
//!   없음 409 `not_checked` → 글 실패 409 `post_failed`. 거절 문구는 `api result not recorded: <code>`.
//! - 본문은 고정 문구와 서버가 아는 값뿐 — 래퍼가 준 `error` 는 meta 에만 싣는다. 줄은 부르지 않는다(`noMentions`).
//! - fail-closed: 글 경로와 [`API_RESULTS_PRIVILEGES`] 가 다 있을 때만 붙는다(`main.rs`). `automation.*` 은 읽지 않는다.
use super::audience::audience_for;
use super::grant_reads::through_operator;
use super::merge_approval_peek::{db_now, sha256_hex, str_len_ok};
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, post_in_tx, to_ts};
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::{AuditEntry, record_audit};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use std::net::SocketAddr;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 칸 권한(글 경로 칸은 `msg_post::MESSAGE_POST_PRIVILEGES` 로 따로 본다).
pub const API_RESULTS_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease.id", "SELECT"),
    ("secret_turn_lease.token_hash", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.operator_id", "SELECT"),
    ("secret_turn_lease.channel_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("api_connector.id", "SELECT"),
    ("api_connector.name", "SELECT"),
    ("audit_log.action", "SELECT"),
    ("audit_log.target", "SELECT"),
    ("audit_log.detail", "SELECT"),
    ("audit_log", "INSERT"),
    ("account_grant.id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.parent_grant_id", "SELECT"),
    ("account_grant.granted_by", "SELECT"),
    ("account.id", "SELECT"),
    ("account.handle", "SELECT"),
];

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str =
    "leaseId, token, connector, method, path, status, durationMs and bytes are required";
/// TS `SYSTEM_I18N_MAX_ARG_LENGTH`.
const I18N_MAX_ARG: usize = 200;

/// TS `readLease` 중 이 라우트가 쓰는 칸만.
const LEASE_SQL: &str = "select l.id::text, l.agent_id::text, l.operator_id::text, l.channel_id::text, \
       l.thread_root_id::text, l.expires_at <= $3::timestamptz, l.ended_at is not null \
     from secret_turn_lease l where l.id = $1::uuid and l.token_hash = $2::text";

const CONNECTOR_SQL: &str = "select id::text from api_connector where name = $1";

const TRAIL_SQL: &str = "select count(*) filter (where action = 'api.call.checked')::int, \
            count(*) filter (where action = 'api.call.done')::int \
       from audit_log \
      where action in ('api.call.checked', 'api.call.done') and target = $1 and detail->>'leaseId' = $2 \
        and detail->>'method' = $3 and detail->>'path' = $4";

const ROOT_SQL: &str = "with recursive up as ( \
       select id, parent_grant_id, granted_by from account_grant where account_id = $1::uuid and capability = 'api.call' and scope = $2 \
       union all \
       select p.id, p.parent_grant_id, p.granted_by from account_grant p join up on p.id = up.parent_grant_id) \
     select a.id::text, a.handle from up join account a on a.id = up.granted_by where up.parent_grant_id is null limit 1";

const NAME_SQL: &str = "select name from api_connector where id = $1::uuid";

/// zod 를 통과한 본문.
#[derive(Debug, Clone, PartialEq)]
pub struct ResultBody {
    pub lease_id: String,
    pub token: String,
    pub connector: String,
    pub method: &'static str,
    pub path: String,
    pub status: i64,
    pub duration_ms: i64,
    pub bytes: i64,
    pub error: Option<String>,
}

/// zod `.number().int()` — JSON 숫자이고 정수(`5.0` 도 정수다)이며 범위 안.
fn int_in(v: &Value, min: i64, max: i64) -> Option<i64> {
    let f = v.as_f64()?;
    if !f.is_finite() || f.fract() != 0.0 || f < min as f64 || f > max as f64 {
        return None;
    }
    Some(f as i64)
}

/// `^[a-z0-9][a-z0-9_-]{0,63}$`.
fn connector_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// zod `{ leaseId, token, connector, method, path, status, durationMs, bytes, error? }` — 모르는 키는 버린다.
pub fn parse_body(body: Option<&Value>) -> Option<ResultBody> {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => v.as_object()?,
    };
    let lease_id = o.get("leaseId")?.as_str()?;
    if !is_uuid(lease_id) {
        return None;
    }
    let token = str_len_ok(o.get("token")?, 1, 200)?;
    let connector = o.get("connector")?.as_str()?;
    if !connector_ok(connector) {
        return None;
    }
    let method = match o.get("method")?.as_str()? {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        _ => return None,
    };
    let path = str_len_ok(o.get("path")?, 1, 2000)?;
    let status = int_in(o.get("status")?, 0, 999)?;
    let duration_ms = int_in(o.get("durationMs")?, 0, 3_600_000)?;
    let bytes = int_in(o.get("bytes")?, 0, i64::MAX)?;
    let error = match o.get("error") {
        None | Some(Value::Null) => None,
        Some(v) => Some(str_len_ok(v, 0, 1000)?.to_owned()),
    };
    Some(ResultBody {
        lease_id: lease_id.to_owned(),
        token: token.to_owned(),
        connector: connector.to_owned(),
        method,
        path: path.to_owned(),
        status,
        duration_ms,
        bytes,
        error,
    })
}

/// JS `s.slice(0, n)` — UTF-16 단위로 자른다.
pub fn js_slice(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// TS `(r.path.split('?')[0] ?? '').slice(0, 300)`.
pub fn trail_path(path: &str) -> String {
    js_slice(path.split('?').next().unwrap_or(""), 300)
}

/// TS 본문과 `meta.i18n` — 같은 갈래(토큰 실패·닿음·닿지 않음 × 권한 준 사람 유무).
pub fn result_line(
    name: &str,
    method: &str,
    path: &str,
    status: i64,
    error: Option<&str>,
    root: Option<(&str, &str)>,
) -> (String, Value) {
    let token_failed = status == 0 && error == Some("token_exchange_failed");
    let shown = path.replace('@', "＠");
    let word = if status > 0 {
        status.to_string()
    } else if token_failed {
        "토큰을 받지 못함".to_owned()
    } else {
        "닿지 않음".to_owned()
    };
    let mut body = format!("🔌 {name} {method} {shown} · {word}");
    if let Some((_, handle)) = root {
        body.push_str(&format!(" · 권한: {handle}"));
    }
    body.push_str(" (래퍼 보고)");
    let clip = |s: &str| Value::String(js_slice(s, I18N_MAX_ARG));
    let mut args = Map::new();
    args.insert("connector".into(), clip(name));
    args.insert("method".into(), clip(method));
    args.insert("path".into(), clip(&shown));
    let base = if token_failed {
        "system.apiCall.tokenFailed"
    } else if status > 0 {
        args.insert("status".into(), json!(status));
        "system.apiCall.done"
    } else {
        "system.apiCall.unreachable"
    };
    let key = match root {
        Some((id, _)) => {
            args.insert("granterId".into(), clip(id));
            format!("{base}Granted")
        }
        None => base.to_owned(),
    };
    (body, json!({ "key": key, "args": args }))
}

/// 라우트 상태 — 시스템 줄은 글 경로를 탄다.
pub struct ApiResultsState {
    pub post: PostState,
}

enum Done {
    Refused(StatusCode, &'static str),
    ToTs,
    Posted(String),
}

async fn report(st: &PostState, agent: &str, operator: &str, b: &ResultBody) -> sqlx::Result<Done> {
    let w = &st.write;
    let now = db_now(w).await?;
    type Lease = (String, String, Option<String>, String, String, bool, bool);
    let lease: Option<Lease> = sqlx::query_as(LEASE_SQL)
        .bind(&b.lease_id)
        .bind(sha256_hex(&b.token))
        .bind(&now)
        .fetch_optional(w)
        .await?;
    let (lease_id, channel, root_msg) = match lease {
        Some((id, a, o, c, t, expired, ended))
            if a == agent && o.as_deref() == Some(operator) && !expired && !ended =>
        {
            (id, c, t)
        }
        _ => return Ok(Done::Refused(StatusCode::FORBIDDEN, "lease_invalid")),
    };
    let connector_id: Option<String> = sqlx::query_scalar(CONNECTOR_SQL)
        .bind(&b.connector)
        .fetch_optional(w)
        .await?;
    let Some(connector_id) = connector_id else {
        return Ok(Done::Refused(StatusCode::NOT_FOUND, "no_connector"));
    };
    let scope = format!("connector:{connector_id}");
    let path = trail_path(&b.path);
    let (checked, reported): (i32, i32) = sqlx::query_as(TRAIL_SQL)
        .bind(&scope)
        .bind(&lease_id)
        .bind(b.method)
        .bind(&path)
        .fetch_one(w)
        .await?;
    if checked <= reported {
        return Ok(Done::Refused(StatusCode::CONFLICT, "not_checked"));
    }
    let root: Option<(String, String)> = sqlx::query_as(ROOT_SQL)
        .bind(agent)
        .bind(&scope)
        .fetch_optional(w)
        .await?;
    let name: Option<String> = sqlx::query_scalar(NAME_SQL)
        .bind(&connector_id)
        .fetch_optional(w)
        .await?;
    let name = name.unwrap_or_else(|| b.connector.clone());
    let (body, i18n) = result_line(
        &name,
        b.method,
        &path,
        b.status,
        b.error.as_deref(),
        root.as_ref().map(|(i, h)| (i.as_str(), h.as_str())),
    );
    let mut meta = Map::new();
    meta.insert(
        "apiCall".into(),
        json!({
            "connectorId": connector_id, "method": b.method, "path": path, "status": b.status,
            "durationMs": b.duration_ms, "bytes": b.bytes, "error": b.error,
        }),
    );
    meta.insert("i18n".into(), i18n);
    let audience = audience_for(w, &channel).await?.to_json();
    let is_dm = channel_is_dm(w, &channel).await?;
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: Some(root_msg),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        no_mentions: true,
        ..Origin::default()
    };
    let row = match post_in_tx(
        st, &channel, agent, true, &input, None, &audience, is_dm, &origin,
    )
    .await?
    {
        Outcome::Posted { row, .. } => row,
        Outcome::ToTs => return Ok(Done::ToTs),
        _ => return Ok(Done::Refused(StatusCode::CONFLICT, "post_failed")),
    };
    let message: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    record_audit(
        w,
        AuditEntry {
            action: "api.call.done",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&scope),
            ip: None,
            detail: json!({
                "method": b.method, "path": path, "status": b.status, "durationMs": b.duration_ms,
                "bytes": b.bytes, "operatorId": operator, "leaseId": lease_id, "messageId": message_id,
            }),
        },
    )
    .await;
    Ok(Done::Posted(message_id))
}

/// `POST /agent/api-results`.
pub async fn results_route(
    State(st): State<Arc<ApiResultsState>>,
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
    let Some(b) = parse_body(parsed.as_ref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    };
    let operator = auth
        .operator
        .as_ref()
        .map(|o| o.id.as_str())
        .unwrap_or_default();
    match report(&st.post, &me.id, operator, &b).await {
        Err(e) => internal(e),
        Ok(Done::ToTs) => to_ts(st.post.up.clone(), peer, parts, bytes).await,
        Ok(Done::Refused(s, code)) => {
            json_err(s, code, &format!("api result not recorded: {code}"))
        }
        Ok(Done::Posted(id)) => (
            StatusCode::CREATED,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )],
            json!({ "messageId": id }).to_string(),
        )
            .into_response(),
    }
}

/// 코어 라우터에 합칠 줄.
pub fn routes(
    st: ApiResultsState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ApiResultsState>>::new()
        .post("/agent/api-results", results_route)
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

    const L: &str = "00000000-0000-4000-8000-000000000001";
    const G: &str = "00000000-0000-4000-8000-00000000000g";

    fn ok() -> Value {
        json!({ "leaseId": L, "token": "t", "connector": "gh", "method": "GET", "path": "/x?q=1",
                "status": 200, "durationMs": 5, "bytes": 0, "x": 1 })
    }

    #[test]
    fn body_like_zod() {
        let b = parse_body(Some(&ok())).unwrap();
        assert_eq!((b.method, b.status, b.error.clone()), ("GET", 200, None));
        let mut e = ok();
        e["error"] = json!("boom");
        assert_eq!(parse_body(Some(&e)).unwrap().error.as_deref(), Some("boom"));
        for (k, v) in [
            ("method", json!("HEAD")),
            ("connector", json!("Bad")),
            ("status", json!(1000)),
            ("status", json!(1.5)),
            ("durationMs", json!(3_600_001)),
            ("bytes", json!(-1)),
            ("path", json!("")),
            ("error", json!(3)),
        ] {
            let mut bad = ok();
            bad[k] = v;
            assert!(parse_body(Some(&bad)).is_none(), "{k}");
        }
        assert!(parse_body(None).is_none());
    }

    #[test]
    fn trail_path_drops_query_and_clips() {
        assert_eq!(trail_path("/a/b?c=1"), "/a/b");
        assert_eq!(trail_path(&"x".repeat(400)).len(), 300);
    }

    #[test]
    fn line_branches_like_ts() {
        let (body, i) = result_line("gh", "GET", "/u/@me", 200, None, None);
        assert_eq!(body, "🔌 gh GET /u/＠me · 200 (래퍼 보고)");
        assert_eq!(
            i,
            json!({ "key": "system.apiCall.done", "args": { "connector": "gh", "method": "GET", "path": "/u/＠me", "status": 200 } })
        );
        let (body, i) = result_line(
            "gh",
            "POST",
            "/p",
            0,
            Some("token_exchange_failed"),
            Some((G, "owner")),
        );
        assert_eq!(
            body,
            "🔌 gh POST /p · 토큰을 받지 못함 · 권한: owner (래퍼 보고)"
        );
        assert_eq!(i["key"], "system.apiCall.tokenFailedGranted");
        assert_eq!(i["args"]["granterId"], G);
        let (body, i) = result_line("gh", "GET", "/p", 0, Some("other"), None);
        assert_eq!(body, "🔌 gh GET /p · 닿지 않음 (래퍼 보고)");
        assert_eq!(i["key"], "system.apiCall.unreachable");
    }
}
