//! S5.4 CH3b — 자동 멘션 걸기·풀기와 채널 문서 저장 3줄. TS `routes/channelRoutes.ts` 의
//! `PUT·DELETE /channels/:id/auto-mentions/:agentId`·`PUT /channels/:id/doc` 와
//! `services/channelAutoMentions.ts`·`services/channels.ts`(`updateChannelDoc`·`addChannelMember`) 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다).
//!   - 자동 멘션: 본문 읽기(fastify) → 인증(401) → `requireCap('channel.auto_mention', 채널)`(403) → 경로(400) → 본문(400) → 쓰기.
//!   - 문서: 본문 읽기 → 인증(401) → 경로(400) → 본문(400) → `channelPostGate`(403) → 없는 채널(404) → 쓰기(409 stale).
//! - 이벤트가 없다(TS 도 내지 않는다). 감사는 셋 다 남기고 본문은 남기지 않는다(handle·mode, 문서는 길이만).
//! - 문장은 TS 정본을 골든(`set_channel_auto_mention`·`channel_auto_mention_row`·`auto_mention_account`·
//!   `unset_channel_auto_mention`·`auto_mention_handle`·`channel_kind_visibility`·`add_channel_member`·`update_channel_doc`)으로 받는다.
//! - 권한은 [`AUTO_MENTION_DOC_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::channels::{exists, frag, is_uuid, rows_sql};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::perm::{Target, TargetKind, require_cap};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use crate::writes_settings::{body_then, ip_of};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 이 줄들이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 쓴 행을 바로 읽어 답하므로 SELECT 도 쓰기 풀에서 본다.
pub const AUTO_MENTION_DOC_PRIVILEGES: &[(&str, &str)] = &[
    ("channel_auto_mention", "SELECT"),
    ("channel_auto_mention", "INSERT"),
    ("channel_auto_mention", "UPDATE"),
    ("channel_auto_mention", "DELETE"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "INSERT"),
    ("channel_doc", "SELECT"),
    ("channel_doc", "INSERT"),
    ("channel_doc", "UPDATE"),
    ("audit_log", "INSERT"),
];

/// shared `CHANNEL_AUTO_MENTION_MODES`.
const MODES: &[&str] = &["always", "available"];
/// 문서 본문 상한 — zod `z.string().max(64 * 1024)`(UTF-16 길이).
const MAX_DOC: usize = 64 * 1024;
/// JS `Date` 가 나타낼 수 있는 가장 큰 밀리초(8.64e15). 넘으면 TS 는 `Invalid Date` 를 pg 로 보내 500 이 된다.
const JS_DATE_MAX_MS: f64 = 8.64e15;

#[derive(Clone)]
pub struct AutoMentionDocState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: TrustProxy,
}

struct Sql {
    row: String,
    doc: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        row: rows_sql(frag("channel_auto_mention_row"), &["createdAt"]),
        doc: rows_sql(frag("channel_doc"), &["updatedAt"]),
    })
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

/// 한 행짜리 `rows_sql` 결과(`[{…}]`)에서 그 행의 JSON 글자를 꺼낸다 — 칸 순서를 지키려고 다시 직렬화하지 않는다.
fn only_row(rows: &str) -> Option<&str> {
    let inner = rows.strip_prefix('[')?.strip_suffix(']')?;
    (!inner.is_empty()).then_some(inner)
}

async fn audit(
    st: &AutoMentionDocState,
    parts: &axum::http::request::Parts,
    me: &crate::auth::Account,
    action: &str,
    channel: &str,
    detail: Value,
) {
    let ip = ip_of(parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(channel),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
}

/// 본문 → 인증 → `channel.auto_mention`(경로의 채널) — TS `requireCap('channel.auto_mention', { kind: 'channel', param: 'id' })`.
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn gate_cap(
    st: &AutoMentionDocState,
    req: Request,
    channel: &str,
) -> Result<(Body, crate::auth::Account, axum::http::request::Parts), Response> {
    let (body, RequireAccount(_, auth), parts) = body_then::<RequireAccount>(req).await?;
    let me = require_cap(
        &st.read,
        &auth,
        "channel.auto_mention",
        Some(Target {
            kind: TargetKind::Channel,
            id: channel,
        }),
    )
    .await?;
    Ok((body, me, parts))
}

/// zod `z.object({ mode: z.enum(MODES).default('always') }).parse(req.body ?? {})` — 남는 키는 버린다.
fn parse_mode(body: &Body) -> Option<&'static str> {
    let m = match body {
        Body::None | Body::Json(Value::Null) => return Some("always"),
        Body::Json(Value::Object(m)) => m,
        _ => return None,
    };
    match m.get("mode") {
        None => Some("always"),
        Some(Value::String(s)) => MODES.iter().find(|x| **x == s.as_str()).copied(),
        Some(_) => None,
    }
}

/// `PUT /channels/{id}/auto-mentions/{agentId}` — 건다(멱등, 모드만 바꿀 수도 있다).
pub async fn set(
    State(st): State<Arc<AutoMentionDocState>>,
    Path((id, agent)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (body, me, parts) = match gate_cap(&st, req, &id).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_uuid(&id) || !is_uuid(&agent) {
        return bad("params");
    }
    let Some(mode) = parse_mode(&body) else {
        return bad("body");
    };
    // 없는 채널은 FK 위반 500 대신 404(TS 와 같다).
    let ch: Option<(String, String)> = match sqlx::query_as(frag("channel_kind_visibility"))
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let Some((kind, visibility)) = ch else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel");
    };
    let inserted = match sqlx::query(frag("set_channel_auto_mention"))
        .bind(&id)
        .bind(&agent)
        .bind(&me.id)
        .bind(mode)
        .execute(&st.write)
        .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => return internal(e),
    };
    let row = match sqlx::query_scalar::<_, String>(sql().row.as_str())
        .bind(&id)
        .bind(&agent)
        .fetch_one(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let row = only_row(&row).map(str::to_string);
    let row_mode = |r: &str| {
        serde_json::from_str::<Value>(r)
            .ok()
            .and_then(|v| v.get("mode").and_then(Value::as_str).map(str::to_string))
    };
    // 0 행: 이미 같은 모드로 걸려 있으면 그 행(멱등), 아니면 대상 계정을 읽어 거절 까닭을 고른다(TS 와 같은 차례).
    if inserted == 0 && row.as_deref().and_then(row_mode).as_deref() != Some(mode) {
        let acc: Option<(String, bool, String)> = match sqlx::query_as(frag("auto_mention_account"))
            .bind(&agent)
            .fetch_optional(&st.write)
            .await
        {
            Ok(a) => a,
            Err(e) => return internal(e),
        };
        return match acc {
            None => json_err(StatusCode::NOT_FOUND, "not_found", "no such account"),
            Some((k, _, _)) if k != "agent" => json_err(
                StatusCode::BAD_REQUEST,
                "not_an_agent",
                "only agents can be auto-mentioned",
            ),
            Some((_, true, _)) => json_err(
                StatusCode::BAD_REQUEST,
                "agent_disabled",
                "a disabled agent cannot be auto-mentioned",
            ),
            Some(_) => json_err(
                StatusCode::BAD_REQUEST,
                "invoke_scope_restricted",
                "호출 범위가 community 가 아닌 에이전트는 자동 멘션 대상이 될 수 없다",
            ),
        };
    }
    let Some(row) = row else {
        // 넣었는데 행이 없다 — 일어나지 않아야 한다(TS 라면 `rows[0]!` 가 undefined 로 200 null).
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        );
    };
    // 볼 수 없는 채널의 에이전트는 부를 수 없다 — public standard 가 아니면 멤버로 넣는다(TS 와 같은 조건).
    if !(kind == "standard" && visibility == "public")
        && let Err(e) = sqlx::query(frag("add_channel_member"))
            .bind(&id)
            .bind(&agent)
            .execute(&st.write)
            .await
    {
        return internal(e);
    }
    let v: Value = serde_json::from_str(&row).unwrap_or(Value::Null);
    audit(
        &st,
        &parts,
        &me,
        "channel.auto_mention.set",
        &id,
        json!({ "handle": v.get("handle"), "mode": v.get("mode") }),
    )
    .await;
    json_ok(row)
}

/// `DELETE /channels/{id}/auto-mentions/{agentId}` — 푼다. 없던 것을 풀면 404.
pub async fn unset(
    State(st): State<Arc<AutoMentionDocState>>,
    Path((id, agent)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, me, parts) = match gate_cap(&st, req, &id).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_uuid(&id) || !is_uuid(&agent) {
        return bad("params");
    }
    // handle 은 지우기 전에 읽는다 — 지운 뒤에는 조인할 행이 없다.
    let handle: Option<String> = match sqlx::query_scalar(frag("auto_mention_handle"))
        .bind(&id)
        .bind(&agent)
        .fetch_optional(&st.write)
        .await
    {
        Ok(h) => h,
        Err(e) => return internal(e),
    };
    match sqlx::query(frag("unset_channel_auto_mention"))
        .bind(&id)
        .bind(&agent)
        .execute(&st.write)
        .await
    {
        Ok(r) if r.rows_affected() > 0 => {}
        Ok(_) => {
            return json_err(
                StatusCode::NOT_FOUND,
                "not_found",
                "that agent is not auto-mentioned here",
            );
        }
        Err(e) => return internal(e),
    }
    audit(
        &st,
        &parts,
        &me,
        "channel.auto_mention.unset",
        &id,
        json!({ "handle": handle }),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// 문서 저장 본문 — zod `{ body: string ≤ 65536, expectedUpdatedAt?: int ≥ 0 | null }`. 남는 키는 버린다.
#[derive(Debug, PartialEq)]
struct DocBody {
    body: String,
    /// `None` 은 「아직 문서가 없다고 믿는다」(부재·null). `Some(ms)`.
    expected: Option<f64>,
}

fn parse_doc(body: &Body) -> Option<DocBody> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let text = m.get("body")?.as_str()?;
    if text.encode_utf16().count() > MAX_DOC {
        return None;
    }
    let expected = match m.get("expectedUpdatedAt") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => {
            let f = n.as_f64()?;
            // zod `int()` = `Number.isInteger`, `min(0)`. JSON 수는 언제나 유한하다.
            if f.fract() != 0.0 || f < 0.0 {
                return None;
            }
            Some(f)
        }
        Some(_) => return None,
    };
    Some(DocBody {
        body: text.to_string(),
        expected,
    })
}

/// 지금 문서(없으면 빈 문서) — TS `getChannelDoc`.
async fn current_doc(pool: &PgPool, id: &str) -> Result<String, sqlx::Error> {
    let rows: String = sqlx::query_scalar(sql().doc.as_str())
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(match only_row(&rows) {
        Some(r) => r.to_string(),
        None => format!(
            r#"{{"channelId":{},"body":"","updatedBy":null,"updatedAt":null}}"#,
            Value::String(id.to_string())
        ),
    })
}

/// `PUT /channels/{id}/doc` — 그 채널에 글을 쓸 수 있는 사람(보관된 채널은 403). 낙관적 동시성은 문장 안에서 판정한다.
pub async fn put_doc(
    State(st): State<Arc<AutoMentionDocState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_uuid(&id) {
        return bad("params");
    }
    let Some(input) = parse_doc(&body) else {
        return bad("body");
    };
    let gate: Option<(bool, bool)> = match sqlx::query_as(crate::core::msg_post::gate_sql())
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(g) => g,
        Err(e) => return internal(e),
    };
    match gate {
        Some((false, _)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this channel",
            );
        }
        Some((true, true)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "channel_archived",
                "archived channels are read-only",
            );
        }
        _ => {}
    }
    match exists(&st.write, &id).await {
        Ok(true) => {}
        Ok(false) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel"),
        Err(e) => return internal(e),
    }
    let expected = match input.expected {
        None => None,
        // `new Date(ms)` 가 Invalid Date 가 되는 값 — TS 는 pg 형 오류로 500.
        Some(f) if f > JS_DATE_MAX_MS => {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            );
        }
        Some(f) => Some(crate::core::operator_hub::iso_from_ms(f as i64)),
    };
    let written = match sqlx::query(frag("update_channel_doc"))
        .bind(&id)
        .bind(&input.body)
        .bind(&me.id)
        .bind(expected)
        .execute(&st.write)
        .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => return internal(e),
    };
    let doc = match current_doc(&st.write, &id).await {
        Ok(d) => d,
        Err(e) => return internal(e),
    };
    if written == 0 {
        // 칸 차례는 TS 와 같게 error → doc.
        let mut r = json_ok(format!(
            r#"{{"error":{{"code":"doc_stale","message":"the document changed since you read it"}},"doc":{doc}}}"#
        ));
        *r.status_mut() = StatusCode::CONFLICT;
        return r;
    }
    audit(
        &st,
        &parts,
        &me,
        "channel.doc.updated",
        &id,
        json!({ "bodyLength": input.body.encode_utf16().count() }),
    )
    .await;
    json_ok(doc)
}

/// 코어 라우터에 합칠 줄 — `channel_pins_sched.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// 같은 경로의 `GET`(`/channels/{id}/auto-mentions`·`/channels/{id}/doc`)은 읽기 코어(`channels.rs`)가 이미 붙였다.
pub fn routes(
    st: AutoMentionDocState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AutoMentionDocState>>::new()
        .put("/channels/{id}/auto-mentions/{agentId}", set)
        .delete("/channels/{id}/auto-mentions/{agentId}", unset)
        .put("/channels/{id}/doc", put_doc)
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
    fn mode_like_zod() {
        assert_eq!(parse_mode(&Body::None), Some("always"));
        assert_eq!(parse_mode(&Body::Json(Value::Null)), Some("always"));
        assert_eq!(parse_mode(&Body::Json(json!({}))), Some("always"));
        assert_eq!(
            parse_mode(&Body::Json(json!({ "mode": "available", "x": 1 }))),
            Some("available")
        );
        assert_eq!(parse_mode(&Body::Json(json!({ "mode": null }))), None);
        assert_eq!(parse_mode(&Body::Json(json!({ "mode": "never" }))), None);
        assert_eq!(parse_mode(&Body::Json(json!([]))), None);
        assert_eq!(parse_mode(&Body::Text("x".into())), None);
    }

    #[test]
    fn doc_body_like_zod() {
        let d = |v: Value| parse_doc(&Body::Json(v));
        assert_eq!(d(json!({ "body": "" })).unwrap().expected, None);
        assert_eq!(
            d(json!({ "body": "a", "expectedUpdatedAt": null }))
                .unwrap()
                .expected,
            None
        );
        assert_eq!(
            d(json!({ "body": "a", "expectedUpdatedAt": 1_700_000_000_123_i64 }))
                .unwrap()
                .expected,
            Some(1_700_000_000_123.0)
        );
        assert!(d(json!({ "body": "a", "expectedUpdatedAt": 1.0 })).is_some());
        assert!(d(json!({ "body": "a", "expectedUpdatedAt": 1.5 })).is_none());
        assert!(d(json!({ "body": "a", "expectedUpdatedAt": -1 })).is_none());
        assert!(d(json!({ "body": "a", "expectedUpdatedAt": "1" })).is_none());
        assert!(d(json!({ "body": 1 })).is_none());
        assert!(d(json!({})).is_none());
        assert!(d(json!({ "body": "x".repeat(MAX_DOC) })).is_some());
        assert!(d(json!({ "body": "x".repeat(MAX_DOC + 1) })).is_none());
        // UTF-16 길이 — 아스트랄 글자는 둘로 센다.
        assert!(d(json!({ "body": "😀".repeat(MAX_DOC / 2) })).is_some());
        assert!(d(json!({ "body": format!("{}x", "😀".repeat(MAX_DOC / 2)) })).is_none());
        assert!(parse_doc(&Body::None).is_none());
        assert!(parse_doc(&Body::Json(Value::Null)).is_none());
    }

    #[test]
    fn only_row_keeps_text() {
        assert_eq!(only_row("[]"), None);
        assert_eq!(only_row(r#"[{"b":1,"a":2}]"#), Some(r#"{"b":1,"a":2}"#));
    }
}
