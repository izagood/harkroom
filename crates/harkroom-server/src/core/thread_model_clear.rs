//! S5.4 TM2 — 스레드 × 에이전트 모델 지정 풀기 한 줄. TS `routes/threadAgentModelRoutes.ts` 의
//! `DELETE /channels/:id/threads/:rootId/agent-models/:agentId` 와 `announceChange`(풀기 갈래)·`emitChanged` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 경로 세 id(400 `invalid_request`) → 사람만(403 `human_only`) → `channelPostGate`
//!   (403 `forbidden`·403 `channel_archived`, 없는 채널은 통과) → `isChannelRoot`(404 `not_a_root`) → 지우기(없으면 404 `not_found`)
//!   → 시스템 줄(스레드 안, 아무도 부르지 않는다 — `kind: 'system'`·`noMentions`) → `thread.agent_model.changed` → 감사 → 204.
//! - 권한은 [`THREAD_MODEL_CLEAR_PRIVILEGES`] 와 글 올리기 권한 — 둘 다 있어야 `main.rs` 가 붙인다(없으면 TS 에 남는다).
//! - `PUT …/agent-models/:agentId` 는 `thread_model_set.rs` 가 맡는다(오퍼레이터 코어가 Rust 일 때만 — 아니면 TS).
use super::audience::audience_for;
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, gate_sql, post_in_tx};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, emit_event, record_audit};
use crate::writes_settings::ip_of;
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// 이 줄이 글 올리기 권한([`super::msg_post::MESSAGE_POST_PRIVILEGES`]) 위에 쓰는 권한 — homelab GRANT 와 같아야 한다.
/// 지우기는 표 권한(`DELETE`)뿐이고, `where` 가 읽는 칸은 칸 권한으로 본다.
pub const THREAD_MODEL_CLEAR_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("account.handle", "SELECT"),
    ("thread_agent_model", "DELETE"),
    ("thread_agent_model.thread_root_id", "SELECT"),
    ("thread_agent_model.agent_id", "SELECT"),
    ("audit_log", "INSERT"),
    ("event_outbox", "INSERT"),
];

#[derive(Clone)]
pub struct ClearState {
    /// 시스템 줄을 올리는 글 경로의 상태 — 판정·쓰기는 그 쓰기 풀(`post.write`)에서 한다.
    pub post: PostState,
    pub trust: TrustProxy,
}

/// TS `isChannelRoot`.
const ROOT_SQL: &str = "select 1 from message where id = $1::uuid and channel_id = $2::uuid \
     and thread_root_id is null and deleted_at is null";
/// TS `clearThreadAgentModel`(사람 풀기 — `onlyAgentRows` 없음).
const CLEAR_SQL: &str =
    "delete from thread_agent_model where thread_root_id = $1::uuid and agent_id = $2::uuid";
/// TS `announceChange` 의 이름 읽기.
const HANDLE_SQL: &str = "select handle from account where id = $1::uuid";

const BODY_LIMIT: usize = 1024 * 1024;

/// TS `SYSTEM_ACCOUNT_PLACEHOLDER`.
const PLACEHOLDER: &str = "{account}";

/// TS `announceChange(…, row = null, byKind = 'human')` 의 본문과 meta.
fn cleared_line(actor: &str, agent: &str, handle: &str) -> (String, Map<String, Value>) {
    let body = format!(
        "{PLACEHOLDER}님이 이 스레드에서 {handle} 의 모델 지정을 풀었습니다. 다음 턴부터 기본값으로 돕니다."
    );
    let mut meta = Map::new();
    meta.insert("accountId".into(), Value::String(actor.to_owned()));
    meta.insert(
        "threadAgentModel".into(),
        json!({ "agentId": agent, "model": null, "effort": null, "byKind": "human" }),
    );
    meta.insert(
        "i18n".into(),
        json!({ "key": "system.threadModel.cleared", "args": { "accountId": actor, "agentId": agent } }),
    );
    (body, meta)
}

/// `DELETE /channels/{id}/threads/{rootId}/agent-models/{agentId}`.
pub async fn clear(
    State(st): State<Arc<ClearState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, root, agent)): Path<(String, String, String)>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(_) = to_bytes(body, BODY_LIMIT).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
    };
    let uuid = crate::lists::is_zod_uuid;
    if !uuid(&id) || !uuid(&root) || !uuid(&agent) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    if me.kind != "human" {
        return json_err(
            StatusCode::FORBIDDEN,
            "human_only",
            "모델 지정은 사람만 바꾼다",
        );
    }
    let w = &st.post.write;
    let gate: Option<(bool, bool)> = match sqlx::query_as(gate_sql())
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(w)
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
    match sqlx::query_scalar::<_, i32>(ROOT_SQL)
        .bind(&root)
        .bind(&id)
        .fetch_optional(w)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            return json_err(
                StatusCode::NOT_FOUND,
                "not_a_root",
                "그 채널의 최상위 글이 아니다",
            );
        }
        Err(e) => return internal(e),
    }
    match sqlx::query(CLEAR_SQL)
        .bind(&root)
        .bind(&agent)
        .execute(w)
        .await
    {
        Ok(r) if r.rows_affected() > 0 => {}
        Ok(_) => {
            return json_err(
                StatusCode::NOT_FOUND,
                "not_found",
                "no model is set for that agent in this thread",
            );
        }
        Err(e) => return internal(e),
    }
    if let Err(e) = announce(&st.post, &id, &root, &me.id, &agent).await {
        return internal(e);
    }
    // TS `emitChanged`.
    let audience = match audience_for(w, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let ev = json!({ "type": "thread.agent_model.changed", "channelId": id, "threadRootId": root,
        "agentId": agent, "row": null, "audience": audience });
    let emitted = match w.acquire().await {
        Ok(mut c) => emit_event(&mut c, &ev).await.map(|_| ()),
        Err(e) => Err(e),
    };
    if let Err(e) = emitted {
        return internal(e);
    }
    let ip = ip_of(&parts, &st.trust);
    record_audit(
        w,
        AuditEntry {
            action: "thread.agent_model.clear",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&root),
            ip: ip.as_deref(),
            detail: json!({ "agentId": agent }),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// TS `announceChange(row = null)` — 스레드 안 시스템 줄, 아무도 부르지 않는다. `message.created` 는 글 경로가 같은 tx 의 outbox 로 낸다.
pub(crate) async fn announce(
    st: &PostState,
    channel: &str,
    root: &str,
    actor: &str,
    agent: &str,
) -> sqlx::Result<()> {
    let handle: Option<String> = sqlx::query_scalar(HANDLE_SQL)
        .bind(agent)
        .fetch_optional(&st.write)
        .await?;
    let (body, meta) = cleared_line(actor, agent, handle.as_deref().unwrap_or(""));
    let audience = audience_for(&st.write, channel).await?.to_json();
    let is_dm = channel_is_dm(&st.write, channel).await?;
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: Some(root.to_owned()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        no_mentions: true,
        ..Origin::default()
    };
    // 사람만 온다(`human_only` 를 지났다).
    match post_in_tx(
        st, channel, actor, false, &input, None, &audience, is_dm, &origin,
    )
    .await?
    {
        Outcome::Posted { .. } => {}
        // TS 는 `posted.failure` 면 알리지 않고 지나간다 — 지정은 이미 풀렸다. 흔적만 남긴다(`ToTs` 는 위 미리 보기와 사이에 위임이
        // 생긴 경합뿐이다).
        Outcome::ToTs => eprintln!("[threadModelClear] system line not posted: to_ts"),
        Outcome::BadThread => eprintln!("[threadModelClear] system line not posted: bad_thread"),
        Outcome::BadAttachment | Outcome::ChainLimit | Outcome::Replayed(_) => {
            eprintln!("[threadModelClear] system line not posted")
        }
    }
    Ok(())
}

/// 코어 라우터에 합칠 줄 — 인증은 `route_layer`, CORS 는 `layer`. 같은 경로의 `GET …/agent-models` 는 읽기 코어
/// (`thread_models_read.rs`)가, `PUT` 은 `thread_model_set.rs`(또는 TS)가 맡는다.
pub fn routes(
    st: ClearState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ClearState>>::new()
        .delete(
            "/channels/{id}/threads/{rootId}/agent-models/{agentId}",
            clear,
        )
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

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const G: &str = "00000000-0000-4000-8000-00000000000b";

    #[test]
    fn cleared_line_like_ts() {
        let (body, meta) = cleared_line(A, G, "scout");
        assert_eq!(
            body,
            "{account}님이 이 스레드에서 scout 의 모델 지정을 풀었습니다. 다음 턴부터 기본값으로 돕니다."
        );
        assert_eq!(meta["accountId"], A);
        assert_eq!(
            meta["threadAgentModel"],
            json!({ "agentId": G, "model": null, "effort": null, "byKind": "human" })
        );
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.threadModel.cleared", "args": { "accountId": A, "agentId": G } })
        );
        // 이름이 없으면 TS `?? ''` 와 같이 빈 글자.
        assert!(cleared_line(A, G, "").0.contains("에서  의 모델"));
    }

    #[test]
    fn privileges_column_level_for_reads() {
        assert!(THREAD_MODEL_CLEAR_PRIVILEGES.contains(&("thread_agent_model", "DELETE")));
        assert!(
            !THREAD_MODEL_CLEAR_PRIVILEGES
                .iter()
                .any(|(t, p)| *t == "thread_agent_model" && *p == "SELECT")
        );
    }
}
