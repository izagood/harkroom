//! S5.3 C1c-1 — 글 올리기 `POST /channels/{id}/messages` 의 **뼈대**: 사람이 앱(세션)으로 쓴 최상위 글 중 부수효과가 없는 것만
//! Rust 가 올린다. TS `routes/messageRoutes.ts` 의 같은 줄과 `services/messages.ts::postMessage` 의 그 갈래를 옮긴다.
//!
//! - **맡는 글**(나머지는 읽어 둔 본문 바이트 그대로 TS 로 넘긴다 — [`to_ts`]): 작성자가 사람이고 세션으로 섰다 · `threadRootId`·
//!   `agentModels` 키가 없다 · DM 이 아니다 · 본문에 URL 후보가 없다(링크 미리보기는 TS 가 외부로 가져온다) · 글 승인 넓은 체
//!   (`CHAT_APPROVAL_GUARD_WORDS`, 메시지 링크 포함)에 안 걸린다. 그러면 TS 쪽 부수효과 중 스레드 답글 알림·깨움 선점·위임 닫기·
//!   DM 알림·글 승인·카드 닫기·링크 미리보기·모델 지정은 저절로 꺼진다.
//! - **부름**(C1c-2a): 멘션 해석([`super::mention_calls::resolve`])을 TS 처럼 트랜잭션 안 seq 락 **앞**에서 하고, 부름 meta 와
//!   고친 본문으로 넣은 뒤 [`super::mention_fanout::fan_out_calls`] 로 inbox·푸시 줄을 넣는다. 새 머리의 위임은
//!   [`super::mandate_stamp::stamp_root`]. 받은 사람마다 `inbox.updated`, 응답 헤더에 받은 사람 수·id(TS 와 같은 순서).
//! - 순서(TS 와 같다): 본문 읽기(413·400·415) → 인증(401, `route_layer`) → 경로·본문 검사(400) → 쓰기 게이트(403 `forbidden`·
//!   `channel_archived`) → **쓰기 트랜잭션 하나**: seq 락(TS `lockChannelForSeq`) → 재시도 키 재생(200, 헤더 없음) → insert →
//!   첨부 잇기(실패면 되돌리고 400 `bad_attachment`) → 다시 읽기 → 재시도 키 기록 → 부름 넣기 → 위임 → `message.created`·
//!   `inbox.updated` 를 outbox 에 → 커밋 → (새 위임이면) `mandate.created` 감사 → 201.
//! - **어느 단계든 `Err` 면 트랜잭션을 버리고 500** — 글도 첨부도 남지 않는다.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`post_*`·`attach_*`·`channel_post_gate`·`url_candidate_source`·
//!   `chat_approval_guard_words`). 쓰기 권한은 [`MESSAGE_POST_PRIVILEGES`] — 하나라도 없으면 `main.rs` 가 이 줄을 붙이지 않는다.
use super::audience::audience_for;
use super::mandate_stamp;
use super::mention_calls::{self, Input};
use super::mention_fanout::{self, Post};
use super::msg_edit::{
    MAX_MESSAGE_BODY_CHARS, NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER, NOTIFIED_HEADER_MAX_IDS,
};
use super::msg_read::{is_uuid, message_by_id};
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err};
use crate::proxy::Upstream;
use crate::write::BODY_LIMIT;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

/// 이 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 첨부는 잇는 칸만(칸 권한 — `for update` 도 이것으로 된다).
pub const MESSAGE_POST_PRIVILEGES: &[(&str, &str)] = &[
    ("message", "INSERT"),
    ("idempotency_key", "INSERT"),
    ("attachment.message_id", "UPDATE"),
    ("attachment.attached_at", "UPDATE"),
    ("event_outbox", "INSERT"),
    // C1c-2a 부름 — inbox·푸시 줄·숨긴 채널 되살리기(`mention_fanout`), 새 머리 위임(`mandate_stamp`)과 그 감사.
    ("inbox", "INSERT"),
    ("push_job", "INSERT"),
    ("channel_pref.hidden_at", "UPDATE"),
    ("mandate", "INSERT"),
    ("mandate.last_activity_at", "UPDATE"),
    ("message.mandate_id", "UPDATE"),
    ("audit_log", "INSERT"),
];
pub const MESSAGE_POST_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// zod `attachmentIds.max(10)`.
const MAX_ATTACHMENTS: usize = 10;

#[derive(Clone)]
pub struct PostState {
    pub read: PgPool,
    pub write: PgPool,
    pub up: Upstream,
}

struct Sql {
    gate: String,
    channel_kind: String,
    lock: String,
    lock_class: i32,
    dup: String,
    insert: String,
    idem_insert: String,
    attach_update: String,
    url: regex::Regex,
    guard_words: Vec<String>,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            gate: frag("channel_post_gate"),
            channel_kind: format!("select k.kind from ({}) k", frag("post_channel_kind")),
            lock: frag("post_seq_lock"),
            lock_class: frag("post_seq_lock_class").parse().expect("seq lock class"),
            dup: format!(
                "select d.message_id::text from ({}) d",
                frag("post_idempotency_find")
            ),
            insert: format!(
                "with ins as ({}) select ins.id::text from ins",
                frag("post_insert")
            ),
            idem_insert: frag("post_idempotency_insert"),
            attach_update: frag("attach_update"),
            url: regex::Regex::new(&frag("url_candidate_source")).expect("url candidate regex"),
            guard_words: serde_json::from_str(&frag("chat_approval_guard_words"))
                .expect("chat_approval_guard_words"),
        }
    })
}

/// `attach_find` 는 `for update` 라 서브쿼리로 감싸지 않고 `with` 로 받는다(잠금은 그 안에서 걸린다) — 칸은 text 로 읽는다.
fn attach_find_raw() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        format!(
            "with f as ({}) select f.id::text, f.uploader_id::text, f.message_id::text from f",
            v["attach_find"]
                .as_str()
                .expect("golden fragment attach_find")
        )
    })
}

/// JS `String.prototype.trim` 이 걷는 글자(WhiteSpace + LineTerminator). Rust `char::is_whitespace` 와 다르다(U+0085 를 걷고 U+FEFF 를 남긴다).
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// zod 가 받는 본문.
#[derive(Debug, PartialEq, Eq)]
struct PostBody {
    body: String,
    attachment_ids: Vec<String>,
}

/// 읽은 JSON 이 TS 몫인가 — 키만 보고 정한다(값이 틀렸으면 TS 가 400 을 준다).
fn ts_keys(v: &Value) -> bool {
    let Value::Object(o) = v else { return false };
    o.contains_key("threadRootId") || o.contains_key("agentModels")
}

/// zod 스키마 + refine. `threadRootId`·`agentModels` 는 [`ts_keys`] 가 먼저 TS 로 보낸다.
fn parse_post(v: &Value) -> Option<PostBody> {
    let Value::Object(o) = v else { return None };
    let Some(Value::String(body)) = o.get("body") else {
        return None;
    };
    if body.encode_utf16().count() > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let attachment_ids: Vec<String> = match o.get("attachmentIds") {
        None => vec![],
        Some(Value::Array(a)) if a.len() <= MAX_ATTACHMENTS => {
            let mut ids = vec![];
            for x in a {
                match x {
                    Value::String(s) if is_uuid(s) => ids.push(s.clone()),
                    _ => return None,
                }
            }
            ids
        }
        _ => return None,
    };
    match o.get("alsoInChannel") {
        None | Some(Value::Bool(_)) => {}
        _ => return None,
    }
    if body.trim_matches(js_ws).is_empty() && attachment_ids.is_empty() {
        return None;
    }
    Some(PostBody {
        body: body.clone(),
        attachment_ids,
    })
}

/// 본문만 보고 TS 몫인가 — URL 후보(링크 미리보기)나 글 승인 넓은 체.
fn ts_body(body: &str) -> bool {
    let s = sql();
    if s.url.is_match(body) {
        return true;
    }
    let low = body.to_lowercase();
    s.guard_words.iter().any(|w| low.contains(w.as_str()))
}

fn bad() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid")
}

async fn to_ts(
    up: Upstream,
    peer: SocketAddr,
    parts: axum::http::request::Parts,
    bytes: axum::body::Bytes,
) -> Response {
    crate::proxy::forward(
        State(up),
        ConnectInfo(peer),
        Request::from_parts(parts, Body::from(bytes)),
    )
    .await
}

enum Outcome {
    Replayed(String),
    BadAttachment,
    Posted {
        row: String,
        notified: Vec<String>,
        mandate: Option<mandate_stamp::Created>,
    },
}

/// TS `resolveMentionCalls` 의 사람 작성자 입력 — 깊이 0, 사슬·회신권·principal 없음(`mentionDepthFor` 첫 줄).
async fn resolve_human(
    conn: &mut sqlx::PgConnection,
    channel: &str,
    author: &str,
    body: &str,
) -> Result<mention_calls::Resolved, sqlx::Error> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    mention_calls::resolve(
        conn,
        &Input {
            body,
            channel_id: channel,
            author_id: author,
            author_is_agent: false,
            mention_depth: 0,
            chain_bound: false,
            chain_started_at_ms: None,
            reply_grant_thread_id: None,
            principal: None,
            now_ms,
            principal_invoke_enabled: mention_calls::principal_invoke_enabled(
                std::env::var("HARKROOM_PRINCIPAL_INVOKE").ok().as_deref(),
            ),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn post_in_tx(
    st: &PostState,
    channel: &str,
    author: &str,
    body: &str,
    attachment_ids: &[String],
    idempotency_key: Option<&str>,
    audience: &Value,
) -> Result<Outcome, sqlx::Error> {
    let s = sql();
    let mut tx = st.write.begin().await?;
    // TS 와 같이 멘션 해석은 seq 락 **앞**이다(그 읽기는 seq 순서와 무관하고, 락 안에서 하면 줄 선 트랜잭션이 커넥션을 쥔다).
    let calls = resolve_human(&mut tx, channel, author, body).await?;
    sqlx::query(s.lock.as_str())
        .bind(s.lock_class)
        .bind(channel)
        .execute(&mut *tx)
        .await?;
    if let Some(key) = idempotency_key {
        let dup: Option<String> = sqlx::query_scalar(s.dup.as_str())
            .bind(key)
            .bind(author)
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(id) = dup {
            let row = message_by_id(&mut *tx, &id).await?;
            tx.commit().await?;
            return Ok(match row {
                Some(r) => Outcome::Replayed(r),
                // TS 는 `existing.rows[0]`(undefined)을 그대로 보낸다 — 지울 수 없는 행이라 닿지 않는 갈래다.
                None => Outcome::Replayed("null".into()),
            });
        }
    }
    let id: String = sqlx::query_scalar(s.insert.as_str())
        .bind(channel)
        .bind(None::<String>)
        .bind(author)
        .bind(&calls.normalized_body)
        .bind("user")
        // 사람 글은 입력 meta 가 없다 — 부름 meta 만 얹는다(TS `{...calls.callMeta}`).
        .bind(Value::Object(calls.call_meta.clone()).to_string())
        .bind(false)
        .bind(0_i32)
        .bind(None::<String>)
        .bind(0_i32)
        .bind(None::<String>)
        .fetch_one(&mut *tx)
        .await?;
    if !attachment_ids.is_empty() {
        let found: Vec<(String, String, Option<String>)> = sqlx::query_as(attach_find_raw())
            .bind(attachment_ids)
            .fetch_all(&mut *tx)
            .await?;
        let ok = found.len() == attachment_ids.len()
            && found.iter().all(|(_, up, m)| up == author && m.is_none());
        if !ok {
            tx.rollback().await?;
            return Ok(Outcome::BadAttachment);
        }
        sqlx::query(s.attach_update.as_str())
            .bind(&id)
            .bind(attachment_ids)
            .execute(&mut *tx)
            .await?;
    }
    let Some(row) = message_by_id(&mut *tx, &id).await? else {
        return Err(sqlx::Error::RowNotFound);
    };
    if let Some(key) = idempotency_key {
        sqlx::query(s.idem_insert.as_str())
            .bind(key)
            .bind(&id)
            .bind(author)
            .bind(channel)
            .execute(&mut *tx)
            .await?;
    }
    let mut notified_set: HashSet<String> = HashSet::new();
    mention_fanout::fan_out_calls(
        &mut tx,
        &Post {
            channel_id: channel,
            author_id: author,
            message_id: &id,
        },
        &calls,
        &mut notified_set,
    )
    .await?;
    // 넣은 순서(inbox id 순) — TS `[...notified]`(Set 삽입 순서)와 같다. 새 글이라 inbox 행은 전부 이 요청이 넣은 것이다.
    let notified: Vec<String> = if notified_set.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar(
            "select account_id::text from inbox where message_id = $1::uuid order by id",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await?
    };
    let mandate = mandate_stamp::stamp_root(&mut tx, &id, author, channel, &notified).await?;
    // 내보내는 행은 위임 키 앞에서 읽은 것 그대로다(TS 와 같다 — 행 칸에 위임 키는 없다).
    let row_value: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
    crate::write::emit_event(
        &mut tx,
        &json!({ "type": "message.created", "message": row_value, "audience": audience }),
    )
    .await?;
    for a in &notified {
        crate::write::emit_event(&mut tx, &json!({ "type": "inbox.updated", "accountId": a }))
            .await?;
    }
    tx.commit().await?;
    Ok(Outcome::Posted {
        row,
        notified,
        mandate,
    })
}

fn json_response(status: StatusCode, row: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        row,
    )
        .into_response()
}

/// `POST /channels/{id}/messages`.
pub async fn post(
    State(st): State<Arc<PostState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    req: Request,
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
    let parsed = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(crate::write::Body::Json(v)) => Some(v),
        Ok(_) => None,
        Err(r) => return r,
    };
    // 사람·세션이 아니거나 스레드·모델 지정 키가 있으면 판정하지 않고 넘긴다(검사도 TS 가 한다).
    let human_session = me.kind == "human" && auth.via == Some(Via::Session);
    if !human_session || parsed.as_ref().is_some_and(ts_keys) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    if !is_uuid(&id) {
        return bad();
    }
    let Some(input) = parsed.as_ref().and_then(parse_post) else {
        return bad();
    };
    if ts_body(&input.body) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    // TS `channelPostGate` — 없는 채널은 'ok'(insert 가 FK 로 실패해 500, TS 와 같다).
    let gate: Option<(bool, bool)> = match sqlx::query_as(sql().gate.as_str())
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
                "not a member of this dm channel",
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
    // DM 은 받는 사람에게 `dm` 알림이 간다(C1c-3 몫).
    let kind: Option<String> = match sqlx::query_scalar(sql().channel_kind.as_str())
        .bind(&id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(k) => k,
        Err(e) => return internal(e),
    };
    if kind.as_deref() == Some("dm") {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    let audience = match audience_for(&st.read, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let key = parts
        .headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    match post_in_tx(
        &st,
        &id,
        &me.id,
        &input.body,
        &input.attachment_ids,
        key.as_deref(),
        &audience,
    )
    .await
    {
        Err(e) => internal(e),
        // 세 사유를 400 하나로 합친다 — TS 와 같이, 남의 업로드 id 가 있는지 알리는 신호가 되지 않게.
        Ok(Outcome::BadAttachment) => json_err(
            StatusCode::BAD_REQUEST,
            "bad_attachment",
            "attachments must be your own, unused uploads",
        ),
        // 재생은 새로 부른 사람을 모른다 — 헤더를 싣지 않는다(TS 와 같다).
        Ok(Outcome::Replayed(row)) => json_response(StatusCode::OK, row),
        Ok(Outcome::Posted {
            row,
            notified,
            mandate,
        }) => {
            // 새로 만든 위임의 감사 — 커밋 뒤라 되돌린 글의 위임은 남지 않는다(TS `auditMandateCreated`).
            if let Some(c) = &mandate {
                crate::write::record_audit(
                    &st.write,
                    crate::write::AuditEntry {
                        action: "mandate.created",
                        actor_id: Some(c.actor_id()),
                        actor_handle: None,
                        target: Some(&c.mandate_id),
                        ip: None,
                        detail: c.audit_detail(),
                    },
                )
                .await;
            }
            let mut res = json_response(StatusCode::CREATED, row);
            let h = res.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&notified.len().to_string()) {
                h.insert(NOTIFIED_COUNT_HEADER, v);
            }
            if !notified.is_empty() {
                let ids = notified
                    .iter()
                    .take(NOTIFIED_HEADER_MAX_IDS)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(",");
                if let Ok(v) = HeaderValue::from_str(&ids) {
                    h.insert(NOTIFIED_HEADER, v);
                }
            }
            res
        }
    }
}

/// 코어 라우터에 합칠 줄 — `msg_edit.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: PostState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PostState>>::new()
        .post("/channels/{id}/messages", post)
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
    fn golden_loads() {
        let s = sql();
        assert_eq!(s.lock_class, 0x6d73_6571);
        assert!(s.lock.contains("pg_advisory_xact_lock"));
        assert!(s.insert.contains("insert into message"));
        assert!(attach_find_raw().contains("for update"));
        assert!(s.guard_words.iter().any(|w| w == "harkroom://message/"));
    }

    #[test]
    fn ts_body_like_ts() {
        for b in [
            "see https://example.com",
            "mailto:x@example.com",
            "승인",
            "Approve this",
            "denied",
            "BYPASS",
            "harkroom://message/0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b",
        ] {
            assert!(ts_body(b), "{b}");
        }
        for b in ["안녕하세요", "오늘 3시", "1번", "a: b"] {
            assert!(!ts_body(b), "{b}");
        }
    }

    #[test]
    fn body_rules_like_zod() {
        let ok = |v: Value| parse_post(&v).is_some();
        assert!(ok(json!({ "body": "x" })));
        assert!(!ok(json!({ "body": "" })));
        assert!(!ok(json!({ "body": " \u{feff}\u{3000}\n" })));
        assert!(
            ok(json!({ "body": "\u{85}" })),
            "JS trim 은 U+0085 를 남긴다"
        );
        assert!(ok(
            json!({ "body": "", "attachmentIds": ["0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b"] })
        ));
        assert!(!ok(json!({ "body": "x", "attachmentIds": ["nope"] })));
        assert!(!ok(
            json!({ "body": "x", "attachmentIds": vec!["0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b"; 11] })
        ));
        assert!(!ok(json!({ "body": "x", "alsoInChannel": "yes" })));
        assert!(!ok(json!({ "body": "a".repeat(8001) })));
        assert!(ok(json!({ "body": "a".repeat(8000), "extra": 1 })));
        assert!(ts_keys(&json!({ "body": "x", "threadRootId": "bad" })));
        assert!(ts_keys(&json!({ "body": "x", "agentModels": [] })));
    }
}
