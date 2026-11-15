//! S5.3 C3a-3c — 글 고치기 `PATCH /channels/{id}/messages/{messageId}`. TS `routes/messageRoutes.ts` 의 같은 줄과
//! `services/messages.ts::editMessage` 를 옮긴다.
//!
//! - 순서(TS 와 같다): 본문 읽기(fastify 는 preHandler 앞에서 읽는다 — 415·400) → 인증(401) → 경로·본문 검사(400) →
//!   채널을 볼 수 있는가(403) → **쓰기 트랜잭션 하나**: 행 잠그고 찾기(404) → 작성자·`user` 글만(403) → 누구를 부르나
//!   ([`super::mention_calls::resolve`]) → 부름 meta 갈아 끼우기 → 고치기 → (부를 때만) 호출함 쓰기([`super::mention_fanout`])·
//!   `via_edit` 찍기 → 이벤트(`message.updated`·새로 받은 사람마다 `inbox.updated`)를 outbox 에 → 커밋.
//! - **판정·쓰기·이벤트 어느 것이든 `Err` 면 트랜잭션을 버리고 500** — 글도 inbox 도 바뀌지 않는다(TS 가 던져 롤백하는 것과 같다).
//!   `Err` 를 「부를 수 있음」으로 읽는 자리가 없다.
//! - 부르지 않는 수정: 에이전트 글이거나 만든 지 24시간(`MENTION_EDIT_WINDOW_MS`)이 지나면 부르지 않고, 새 멘션을 넣었으면
//!   그 까닭을 `x-harkroom-mention-edit-skipped` 로 알린다. 그때 meta 는 지칭 표시(`mentionRefs`)만 새 본문 기준이다.
//! - 문장은 TS 상수를 골든으로 받는다(`edit_*`). 쓰기 권한은 [`MESSAGE_EDIT_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않는다.
use super::audience::audience_for;
use super::mention_calls::{self, Input, Resolved};
use super::mention_fanout::{self, Post};
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

/// shared `MAX_MESSAGE_BODY_CHARS`(JS 길이 = UTF-16 단위).
pub const MAX_MESSAGE_BODY_CHARS: usize = 8000;
/// shared `MENTION_EDIT_WINDOW_MS` — 24시간.
pub const MENTION_EDIT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// shared 헤더 이름들.
pub const NOTIFIED_HEADER: &str = "x-harkroom-notified";
pub const NOTIFIED_COUNT_HEADER: &str = "x-harkroom-notified-count";
pub const NOTIFIED_HEADER_MAX_IDS: usize = 100;
pub const MENTION_EDIT_SKIPPED_HEADER: &str = "x-harkroom-mention-edit-skipped";

/// 이 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 글은 고치는 칸만(칸 권한).
pub const MESSAGE_EDIT_PRIVILEGES: &[(&str, &str)] = &[
    ("message.body", "UPDATE"),
    ("message.meta", "UPDATE"),
    ("message.edited_at", "UPDATE"),
    ("inbox", "INSERT"),
    ("inbox.via_edit", "UPDATE"),
    ("push_job", "INSERT"),
    ("channel_pref.hidden_at", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const MESSAGE_EDIT_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// 부름 meta 칸 — 고칠 때 새 판정으로 통째로 갈아 끼우는 것(TS 의 구조 분해 목록과 같다).
const CALL_META_KEYS: &[&str] = &[
    "mentionRefs",
    "mentionDenied",
    "mentionChainCapped",
    "mentionChainLimit",
    "mentionPrincipalShadow",
    "invokedAsPrincipal",
    "mentionDeniedPrincipal",
    "mentionChainReason",
];

#[derive(Clone)]
pub struct EditState {
    pub read: PgPool,
    pub write: PgPool,
}

struct Sql {
    find: String,
    update: String,
    already: String,
    via_edit: String,
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
            find: format!(
                "select f.author_id::text, f.kind, f.body, f.meta::text, f.depth::int8, \
                   (extract(epoch from f.created_at) * 1000)::int8, f.author_is_agent from ({}) f",
                frag("edit_find")
            ),
            update: frag("edit_update"),
            already: format!(
                "select a.account_id::text from ({}) a",
                frag("edit_inbox_already")
            ),
            via_edit: frag("edit_via_edit"),
        }
    })
}

/// TS `mentionTokens` — 본문의 `<@…>` 토큰들, 그리고 `@channel` 이 부름이면 `channel`.
fn mention_tokens(body: &str) -> HashSet<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"<@([^>\s]+)>").expect("token regex"));
    let mut out: HashSet<String> = re.captures_iter(body).map(|c| c[1].to_string()).collect();
    if super::mention_parse::mentioned_handles(body)
        .iter()
        .any(|h| h == mention_calls::CHANNEL_MENTION_HANDLE)
    {
        out.insert(mention_calls::CHANNEL_MENTION_HANDLE.to_string());
    }
    out
}

/// TS 의 meta 갈아 끼우기. 부를 때는 새 판정 그대로, 아니면 옛 부름 표시를 남기고 지칭만 새 본문 기준.
fn merge_meta(
    old: Option<Map<String, Value>>,
    calls: &Map<String, Value>,
    invoke: bool,
) -> Map<String, Value> {
    let old = old.unwrap_or_default();
    let mut rest = Map::new();
    for (k, v) in &old {
        if !CALL_META_KEYS.contains(&k.as_str()) {
            rest.insert(k.clone(), v.clone());
        }
    }
    if invoke {
        for (k, v) in calls {
            rest.insert(k.clone(), v.clone());
        }
        return rest;
    }
    for k in [
        "mentionDenied",
        "mentionPrincipalShadow",
        "invokedAsPrincipal",
        "mentionDeniedPrincipal",
    ] {
        if let Some(v) = old.get(k) {
            rest.insert(k.into(), v.clone());
        }
    }
    if let Some(capped) = old.get("mentionChainCapped") {
        rest.insert("mentionChainCapped".into(), capped.clone());
        // TS 는 `mentionChainLimit: _limit` 을 그대로 싣는다 — 없던 칸이면 undefined 라 JSON 에서 빠진다.
        if let Some(l) = old.get("mentionChainLimit") {
            rest.insert("mentionChainLimit".into(), l.clone());
        }
        if let Some(r) = old.get("mentionChainReason") {
            rest.insert("mentionChainReason".into(), r.clone());
        }
    }
    if let Some(refs) = calls.get("mentionRefs") {
        rest.insert("mentionRefs".into(), refs.clone());
    }
    rest
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

fn parse_body(body: &Body) -> Option<String> {
    let Body::Json(Value::Object(o)) = body else {
        return None;
    };
    let Some(Value::String(s)) = o.get("body") else {
        return None;
    };
    let n = s.encode_utf16().count();
    (1..=MAX_MESSAGE_BODY_CHARS).contains(&n).then(|| s.clone())
}

enum Outcome {
    NotFound,
    Forbidden,
    Done {
        row: String,
        fresh: Vec<String>,
        skipped: Option<&'static str>,
    },
}

#[allow(clippy::too_many_arguments)]
async fn edit_in_tx(
    st: &EditState,
    channel: &str,
    message: &str,
    actor: &str,
    body: &str,
    audience: &Value,
    now_ms: i64,
    principal_invoke_enabled: bool,
) -> Result<Outcome, sqlx::Error> {
    let s = sql();
    let mut tx = st.write.begin().await?;
    type Found = (String, String, String, Option<String>, i64, i64, bool);
    let found: Option<Found> = sqlx::query_as(s.find.as_str())
        .bind(message)
        .bind(channel)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((author, kind, old_body, old_meta, depth, created_ms, author_is_agent)) = found else {
        return Ok(Outcome::NotFound);
    };
    if author != actor || kind != "user" {
        return Ok(Outcome::Forbidden);
    }
    let calls: Resolved = mention_calls::resolve(
        &mut tx,
        &Input {
            body,
            channel_id: channel,
            author_id: actor,
            author_is_agent,
            mention_depth: depth,
            chain_bound: false,
            chain_started_at_ms: None,
            reply_grant_thread_id: None,
            principal: None,
            now_ms,
            principal_invoke_enabled,
        },
    )
    .await?;
    let before = mention_tokens(&old_body);
    let added = mention_tokens(&calls.normalized_body)
        .iter()
        .any(|t| !before.contains(t));
    let skip: Option<&'static str> = if author_is_agent {
        Some("agent_author")
    } else if now_ms - created_ms > MENTION_EDIT_WINDOW_MS {
        Some("too_old")
    } else {
        None
    };
    let invoke = skip.is_none();
    let old_meta: Option<Map<String, Value>> = old_meta
        .and_then(|m| serde_json::from_str::<Value>(&m).ok())
        .and_then(|v| match v {
            Value::Object(o) => Some(o),
            _ => None,
        });
    let meta = merge_meta(old_meta, &calls.call_meta, invoke);
    sqlx::query(s.update.as_str())
        .bind(message)
        .bind(&calls.normalized_body)
        .bind(Value::Object(meta).to_string())
        .execute(&mut *tx)
        .await?;
    let mut fresh: Vec<String> = vec![];
    if invoke {
        let already: Vec<String> = sqlx::query_scalar(s.already.as_str())
            .bind(message)
            .fetch_all(&mut *tx)
            .await?;
        let mut notified: HashSet<String> = already.iter().cloned().collect();
        mention_fanout::fan_out_calls(
            &mut tx,
            &Post {
                channel_id: channel,
                author_id: actor,
                message_id: message,
            },
            &calls,
            &mut notified,
        )
        .await?;
        // 새로 넣은 사람 — 넣은 순서(inbox id 순)로. TS 의 `[...notified]` 순서와 같다.
        let order: Vec<String> = sqlx::query_scalar(
            "select account_id::text from inbox where message_id = $1::uuid order by id",
        )
        .bind(message)
        .fetch_all(&mut *tx)
        .await?;
        let already: HashSet<String> = already.into_iter().collect();
        for id in order {
            if notified.contains(&id) && !already.contains(&id) && !fresh.contains(&id) {
                fresh.push(id);
            }
        }
        if !fresh.is_empty() {
            sqlx::query(s.via_edit.as_str())
                .bind(message)
                .bind(&fresh)
                .execute(&mut *tx)
                .await?;
        }
    }
    let Some(row) = message_by_id(&mut *tx, message).await? else {
        return Ok(Outcome::NotFound);
    };
    let row_value: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
    crate::write::emit_event(
        &mut tx,
        &json!({ "type": "message.updated", "message": row_value, "audience": audience }),
    )
    .await?;
    for id in &fresh {
        crate::write::emit_event(
            &mut tx,
            &json!({ "type": "inbox.updated", "accountId": id }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Outcome::Done {
        row,
        fresh,
        skipped: if !invoke && added { skip } else { None },
    })
}

/// `PATCH /channels/{id}/messages/{messageId}`.
pub async fn patch(
    State(st): State<Arc<EditState>>,
    Path((id, message)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), _parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad("params");
    }
    let Some(text) = parse_body(&body) else {
        return bad("body");
    };
    match channel_visible(&st.read, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this dm channel",
            );
        }
        Err(e) => return internal(e),
    }
    let audience = match audience_for(&st.read, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let enabled = mention_calls::principal_invoke_enabled(
        std::env::var("HARKROOM_PRINCIPAL_INVOKE").ok().as_deref(),
    );
    match edit_in_tx(
        &st, &id, &message, &me.id, &text, &audience, now_ms, enabled,
    )
    .await
    {
        Err(e) => internal(e),
        Ok(Outcome::NotFound) => json_err(StatusCode::NOT_FOUND, "not_found", "no such message"),
        Ok(Outcome::Forbidden) => json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only the author can edit a user message",
        ),
        Ok(Outcome::Done {
            row,
            fresh,
            skipped,
        }) => {
            let mut res = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                row,
            )
                .into_response();
            let h = res.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&fresh.len().to_string()) {
                h.insert(NOTIFIED_COUNT_HEADER, v);
            }
            if !fresh.is_empty() {
                let ids: Vec<&str> = fresh
                    .iter()
                    .take(NOTIFIED_HEADER_MAX_IDS)
                    .map(String::as_str)
                    .collect();
                if let Ok(v) = HeaderValue::from_str(&ids.join(",")) {
                    h.insert(NOTIFIED_HEADER, v);
                }
            }
            if let Some(s) = skipped {
                h.insert(MENTION_EDIT_SKIPPED_HEADER, HeaderValue::from_static(s));
            }
            res
        }
    }
}

/// 코어 라우터에 합칠 줄 — `msg_delete.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: EditState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<EditState>>::new()
        .patch("/channels/{id}/messages/{messageId}", patch)
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
    fn tokens_like_ts() {
        let t = mention_tokens("hi <@a> and <@team:b> @channel");
        assert!(t.contains("a") && t.contains("team:b") && t.contains("channel"));
        assert!(!mention_tokens("`@channel`").contains("channel"));
    }

    #[test]
    fn meta_merge_like_ts() {
        let old: Map<String, Value> = serde_json::from_value(json!({
            "kind": "x", "mentionDenied": ["a"], "mentionRefs": ["old"], "mentionChainCapped": ["b"], "mentionChainLimit": 3
        }))
        .unwrap();
        let calls: Map<String, Value> =
            serde_json::from_value(json!({ "mentionRefs": ["new"], "mentionDenied": ["z"] }))
                .unwrap();
        let on = merge_meta(Some(old.clone()), &calls, true);
        assert_eq!(
            Value::Object(on),
            json!({ "kind": "x", "mentionRefs": ["new"], "mentionDenied": ["z"] })
        );
        let off = merge_meta(Some(old), &calls, false);
        assert_eq!(
            Value::Object(off),
            json!({ "kind": "x", "mentionDenied": ["a"], "mentionChainCapped": ["b"], "mentionChainLimit": 3, "mentionRefs": ["new"] })
        );
    }

    #[test]
    fn body_rules_like_zod() {
        assert!(parse_body(&Body::Json(json!({ "body": "x" }))).is_some());
        assert!(parse_body(&Body::Json(json!({ "body": "" }))).is_none());
        assert!(parse_body(&Body::Json(json!({ "body": "a".repeat(8001) }))).is_none());
        assert!(parse_body(&Body::Json(json!({ "body": 1 }))).is_none());
    }
}
