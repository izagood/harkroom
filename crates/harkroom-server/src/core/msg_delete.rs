//! S5.3 C3a-2 — 메시지 지우기와 「채널에도 보이기」 켜고 끄기. TS `routes/messageRoutes.ts` 의
//! `DELETE /channels/:id/messages/:messageId` · `DELETE`·`PUT /channels/:id/messages/:messageId/also-in-channel` 와
//! `services/messages.ts`(`deleteMessage`·`recallFromChannel`·`promoteToChannel`)를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 경로 검사(400) → 게이트(지우기·거두기는 볼 수 있는가 403, 올리기는 `channelPostGate`
//!   403 `forbidden`/`channel_archived`) → 메시지 찾기(404) → 권한(403) → 쓰기 → 이벤트.
//! - 지운 자리가 남았는지는 판정 규칙을 다시 쓰지 않고 목록에 묻는다([`read_list_row`], TS `readListRow` 문장 그대로) — 답글이 남은
//!   머리는 자리표시자로 남아 `message.updated`, 아니면 `message.deleted`. 마지막 답글을 지워 머리까지 사라지면 그 머리도 `message.deleted`.
//! - 이벤트는 TS 와 같은 이름·모양·받는 사람(`audience_for`)으로 outbox 에 넣는다. 감사는 `message.deleted`(본문 없이, `{ channelId }`).
//! - 쓰기는 쓰기 풀만 쓴다. 그 역할의 권한은 [`MESSAGE_DELETE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::audience::audience_for;
use super::msg_list::read_list_row;
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 이 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 글은 `deleted_at`·`also_in_channel` 두 칸만 고친다(칸 권한).
pub const MESSAGE_DELETE_PRIVILEGES: &[(&str, &str)] = &[
    ("message.deleted_at", "UPDATE"),
    ("message.also_in_channel", "UPDATE"),
    ("audit_log", "INSERT"),
    ("event_outbox", "INSERT"),
];
pub const MESSAGE_DELETE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

#[derive(Clone)]
pub struct DeleteState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

fn post_gate_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        v["channel_post_gate"]
            .as_str()
            .expect("golden fragment channel_post_gate")
            .to_string()
    })
}

fn bad_params() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "params: invalid",
    )
}

fn not_member() -> Response {
    json_err(
        StatusCode::FORBIDDEN,
        "forbidden",
        "not a member of this dm channel",
    )
}

fn no_message() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such message")
}

fn ok_json(body: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// 지우지 않은 메시지의 (작성자, 스레드 머리) — 채널이 다르거나 없으면 None.
async fn find(
    write: &PgPool,
    channel: &str,
    message: &str,
) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
    sqlx::query_as(
        "select author_id::text, thread_root_id::text from message \
         where id = $1::uuid and channel_id = $2::uuid and deleted_at is null",
    )
    .bind(message)
    .bind(channel)
    .fetch_optional(write)
    .await
}

/// 「채널에도 보이기」 칸을 바꾸고, 고친 행(TS `COLS` 모양)을 같은 트랜잭션에서 다시 읽어 `message.updated` 를 outbox 에 넣은 뒤
/// 커밋한다 — 이벤트 넣기가 실패하면 칸도 되돌아가 「바뀌었는데 다른 화면은 모른다」가 생기지 않는다. `edited_at` 은 건드리지 않는다.
async fn set_also(st: &DeleteState, channel: &str, message: &str, on: bool) -> Response {
    // 받는 사람은 채널에 묶인 것이라 쓰기 전에 읽어도 같다(읽기 풀).
    let audience = match audience_for(&st.read, channel).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let r: Result<Option<String>, sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query("update message set also_in_channel = $2 where id = $1::uuid")
            .bind(message)
            .bind(on)
            .execute(&mut *tx)
            .await?;
        let Some(row) = message_by_id(&mut *tx, message).await? else {
            return Ok(None);
        };
        let value: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
        let ev = json!({ "type": "message.updated", "message": value, "audience": audience });
        crate::write::emit_event(&mut tx, &ev).await?;
        tx.commit().await?;
        Ok(Some(row))
    }
    .await;
    match r {
        Ok(Some(row)) => ok_json(row),
        Ok(None) => no_message(),
        Err(e) => internal(e),
    }
}

/// `DELETE /channels/{id}/messages/{messageId}/also-in-channel` — 작성자 또는 admin. 이미 꺼져 있어도 같은 결과(멱등).
pub async fn recall(
    State(st): State<Arc<DeleteState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, message)): Path<(String, String)>,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad_params();
    }
    match channel_visible(&st.read, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => return not_member(),
        Err(e) => return internal(e),
    }
    let (author, _) = match find(&st.write, &id, &message).await {
        Ok(Some(f)) => f,
        Ok(None) => return no_message(),
        Err(e) => return internal(e),
    };
    if author != me.id && !me.is_admin {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only the author or an admin can recall",
        );
    }
    set_also(&st, &id, &message, false).await
}

/// `PUT /channels/{id}/messages/{messageId}/also-in-channel` — 작성자만, 스레드 답만, 보관된 채널은 거절. 이미 켜져 있어도 같은 결과.
pub async fn promote(
    State(st): State<Arc<DeleteState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, message)): Path<(String, String)>,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad_params();
    }
    // TS `channelPostGate` — 없는 채널은 'ok'(뒤 단계가 404).
    let gate: Option<(bool, bool)> = match sqlx::query_as(post_gate_sql())
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(&st.read)
        .await
    {
        Ok(g) => g,
        Err(e) => return internal(e),
    };
    match gate {
        Some((false, _)) => return not_member(),
        Some((true, true)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "channel_archived",
                "archived channels are read-only",
            );
        }
        _ => {}
    }
    let (author, root) = match find(&st.write, &id, &message).await {
        Ok(Some(f)) => f,
        Ok(None) => return no_message(),
        Err(e) => return internal(e),
    };
    if author != me.id {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only the author can post their message to the channel",
        );
    }
    if root.is_none() {
        return json_err(
            StatusCode::BAD_REQUEST,
            "not_thread_reply",
            "only a thread reply can be posted to the channel",
        );
    }
    set_also(&st, &id, &message, true).await
}

/// `DELETE /channels/{id}/messages/{messageId}` — 작성자 또는 admin. 자리표시자가 남으면 200 + 그 행, 아니면 204.
pub async fn delete(
    State(st): State<Arc<DeleteState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, message)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad_params();
    }
    match channel_visible(&st.read, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => return not_member(),
        Err(e) => return internal(e),
    }
    let (author, root) = match find(&st.write, &id, &message).await {
        Ok(Some(f)) => f,
        Ok(None) => return no_message(),
        Err(e) => return internal(e),
    };
    if author != me.id && !me.is_admin {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only the author or an admin can delete",
        );
    }
    let audience = match audience_for(&st.read, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    // 지우기·자리표시자 판정·이벤트를 한 트랜잭션으로 — 이벤트 넣기가 실패하면 지우기도 되돌아간다(다른 화면에 지운 본문이 남지 않게).
    let r: Result<Option<String>, sqlx::Error> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query("update message set deleted_at = now() where id = $1::uuid")
            .bind(&message)
            .execute(&mut *tx)
            .await?;
        // 지운 것이 머리면 그 자리가 남았나, 답글이면 마지막 답글이어서 머리까지 사라졌나 — 둘 다 목록에 묻는다.
        let (tombstone, root_gone) = match &root {
            None => (read_list_row(&mut tx, &id, &message).await?, None),
            Some(r) => match read_list_row(&mut tx, &id, r).await? {
                Some(_) => (None, None),
                None => (None, Some(r.clone())),
            },
        };
        let first = match &tombstone {
            Some(t) => {
                let v: Value =
                    serde_json::from_str(t).map_err(|e| sqlx::Error::Decode(e.into()))?;
                json!({ "type": "message.updated", "message": v, "audience": audience })
            }
            None => json!({
                "type": "message.deleted", "channelId": id, "messageId": message, "audience": audience,
            }),
        };
        crate::write::emit_event(&mut tx, &first).await?;
        if let Some(gone) = &root_gone {
            let ev = json!({
                "type": "message.deleted", "channelId": id, "messageId": gone, "audience": audience,
            });
            crate::write::emit_event(&mut tx, &ev).await?;
        }
        tx.commit().await?;
        Ok(tombstone)
    }
    .await;
    let tombstone = match r {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    // 본문은 남기지 않는다 — 감사에 복사하면 삭제가 삭제가 아니다.
    let (parts, _) = req.into_parts();
    let ip = crate::trust_proxy::request_ip(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "message.deleted",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&message),
            ip: ip.as_deref(),
            detail: json!({ "channelId": id }),
        },
    )
    .await;
    match tombstone {
        Some(t) => ok_json(t),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

/// 코어 라우터에 합칠 줄 — `msg_react.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: DeleteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let also = "/channels/{id}/messages/{messageId}/also-in-channel";
    let t = Table::<Arc<DeleteState>>::new()
        .delete("/channels/{id}/messages/{messageId}", delete)
        .delete(also, recall)
        .put(also, promote)
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
    fn golden_post_gate_loads() {
        let s = post_gate_sql();
        assert!(s.contains("cm_vis.account_id = $2::uuid"));
        assert!(s.contains("archived_at is not null"));
        assert!(s.contains("c.id = $1::uuid"));
    }

    #[test]
    fn privileges_are_column_scoped_on_message() {
        assert!(
            MESSAGE_DELETE_PRIVILEGES
                .iter()
                .all(|(t, _)| *t != "message"),
            "글은 칸 권한만"
        );
    }
}
