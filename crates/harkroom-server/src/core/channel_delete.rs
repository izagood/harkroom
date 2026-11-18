//! S5.4 결정 3 — 채널 지우기(`DELETE /channels/{id}`). TS `routes/channelRoutes.ts` 의 그 줄과 `services/channels.ts`
//! `deleteChannel` 을 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → `requireCap('channel.manage')`(403) → 경로(400) → 목록 수신자를 **지우기 전에**
//!   구한다 → 한 트랜잭션(채널 행 `for update` → 없음 404·DM 409·보관 안 됨 409 → 첨부 키를 **행 삭제 전에** 읽기 → 메시지 수
//!   → inbox·idempotency_key·saved_message·message_pin·channel_read·channel_member·channel_pref·channel_doc·scheduled_message
//!   ·agent_wake·message·channel 차례로 지우기) → 커밋 → **커밋 뒤** 파일 지우기(실패는 삼키고 되돌리지 않는다,
//!   TS `Promise.allSettled`) → `channel.deleted` → 감사(이름·개수만) → 204.
//! - 파일은 [`super::attachment_store::LocalStorage`] 로 지운다. 저장소가 없으면(`ATTACHMENT_ROOT` 미설정) `main.rs` 가 이 줄을
//!   붙이지 않는다 — 옮기면 파일이 고아로 남는다.
//! - 권한은 [`DELETE_PRIVILEGES`] — 없으면 이 줄은 TS 에 남는다(fail-closed).
use super::attachment_store::LocalStorage;
use super::audience::channel_list_audience;
use super::channels::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::perm::{Target, TargetKind, require_cap};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, emit_event, record_audit};
use crate::writes_settings::{body_then, ip_of};
use axum::body::Body as HttpBody;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use sqlx::{PgPool, Row, ValueRef};
use std::sync::Arc;

/// 이 줄이 쓰는 권한(표·칸, 권한) — homelab GRANT 와 같아야 한다. `delete … where X` 는 X 칸의 SELECT 를 요구하고,
/// `select … for update` 는 그 표의 UPDATE 칸이 하나라도 있어야 하므로 `channel.archived_at` UPDATE 를 함께 요구한다
/// (고치기 줄의 권한에 이미 있다). attachment·message_reaction 은 FK cascade 로 지워지므로(소유자 권한) DELETE 가 필요 없다.
pub const DELETE_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel.archived_at", "UPDATE"),
    ("channel", "DELETE"),
    ("attachment.storage_key", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("message.id", "SELECT"),
    ("message.channel_id", "SELECT"),
    ("message", "DELETE"),
    ("inbox.message_id", "SELECT"),
    ("inbox", "DELETE"),
    ("idempotency_key.channel_id", "SELECT"),
    ("idempotency_key", "DELETE"),
    ("saved_message.message_id", "SELECT"),
    ("saved_message", "DELETE"),
    ("message_pin.channel_id", "SELECT"),
    ("message_pin", "DELETE"),
    ("channel_read.channel_id", "SELECT"),
    ("channel_read", "DELETE"),
    ("channel_member", "SELECT"),
    ("channel_member", "DELETE"),
    ("channel_pref.channel_id", "SELECT"),
    ("channel_pref", "DELETE"),
    ("channel_doc.channel_id", "SELECT"),
    ("channel_doc", "DELETE"),
    ("scheduled_message.channel_id", "SELECT"),
    ("scheduled_message", "DELETE"),
    ("agent_wake.channel_id", "SELECT"),
    ("agent_wake", "DELETE"),
    ("account", "SELECT"),
    ("audit_log", "INSERT"),
];

/// TS `deleteChannel` 의 문장 — 글자 그대로, 차례 그대로.
const LOCK_CHANNEL: &str =
    "select id, name, kind, archived_at from channel where id = $1 for update";
const STORAGE_KEYS: &str = "select a.storage_key from attachment a
       join message m on m.id = a.message_id
       where m.channel_id = $1";
const COUNT_MESSAGES: &str = "select count(*)::int as cnt from message where channel_id = $1";
const DELETES: &[&str] = &[
    "delete from inbox where message_id in (select id from message where channel_id = $1)",
    "delete from idempotency_key where channel_id = $1",
    "delete from saved_message
       where message_id in (select id from message where channel_id = $1)",
    "delete from message_pin where channel_id = $1",
    "delete from channel_read where channel_id = $1",
    "delete from channel_member where channel_id = $1",
    "delete from channel_pref where channel_id = $1",
    "delete from channel_doc where channel_id = $1",
    "delete from scheduled_message where channel_id = $1",
    "delete from agent_wake where channel_id = $1",
    "delete from message where channel_id = $1",
    "delete from channel where id = $1",
];

#[derive(Clone)]
pub struct DeleteState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: TrustProxy,
    pub storage: LocalStorage,
}

enum Outcome {
    Deleted {
        name: String,
        message_count: i32,
        attachment_count: usize,
        storage_keys: Vec<String>,
    },
    NotFound,
    IsDm,
    NotArchived,
}

/// TS `deleteChannel` 의 트랜잭션 부분. 판정 갈래는 rollback(트랜잭션을 버리면 sqlx 가 되돌린다).
async fn delete_tx(pool: &PgPool, id: &str) -> Result<Outcome, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query(LOCK_CHANNEL)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(Outcome::NotFound);
    };
    let name: Option<String> = row.try_get("name")?;
    let kind: String = row.try_get("kind")?;
    // 값은 쓰지 않는다 — null 인지(보관됐는지)만 본다.
    let archived = !row.try_get_raw("archived_at")?.is_null();
    if kind != "standard" {
        tx.rollback().await?;
        return Ok(Outcome::IsDm);
    }
    if !archived {
        tx.rollback().await?;
        return Ok(Outcome::NotArchived);
    }
    let storage_keys: Vec<String> = sqlx::query_scalar(STORAGE_KEYS)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    let message_count: i32 = sqlx::query_scalar(COUNT_MESSAGES)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let attachment_count = storage_keys.len();
    for &q in DELETES {
        sqlx::query(q).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Outcome::Deleted {
        name: name.unwrap_or_default(),
        message_count,
        attachment_count,
        storage_keys,
    })
}

pub async fn delete(
    State(st): State<Arc<DeleteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(_, auth), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let me = match require_cap(
        &st.read,
        &auth,
        "channel.manage",
        Some(Target {
            kind: TargetKind::Channel,
            id: &id,
        }),
    )
    .await
    {
        Ok(m) => m,
        Err(r) => return r,
    };
    if !is_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    // 삭제 전 수신자 — 삭제 후에는 채널 행이 없어 'all' 로 넓어진다.
    let audience = match channel_list_audience(&st.write, &id).await {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    let outcome = match delete_tx(&st.write, &id).await {
        Ok(o) => o,
        Err(e) => return internal(e),
    };
    // 커밋 뒤에 파일을 지운다. 실패는 삼키지만 되돌리지 않는다(TS `Promise.allSettled` — 하나가 실패해도 나머지를 모두 시도한다).
    if let Outcome::Deleted { storage_keys, .. } = &outcome {
        for k in storage_keys {
            if let Err(e) = st.storage.remove(k).await {
                eprintln!("channel delete: attachment remove failed ({e})");
            }
        }
    }
    let (name, message_count, attachment_count) = match outcome {
        Outcome::NotFound => {
            return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel");
        }
        Outcome::IsDm => {
            return json_err(
                StatusCode::CONFLICT,
                "cannot_delete_dm",
                "DMs cannot be deleted",
            );
        }
        Outcome::NotArchived => {
            return json_err(
                StatusCode::CONFLICT,
                "not_archived",
                "only archived channels can be deleted",
            );
        }
        Outcome::Deleted {
            name,
            message_count,
            attachment_count,
            ..
        } => (name, message_count, attachment_count),
    };
    let event =
        json!({ "type": "channel.deleted", "channelId": id, "audience": audience.to_json() });
    match st.write.acquire().await {
        Ok(mut conn) => {
            if let Err(e) = emit_event(&mut conn, &event).await {
                return internal(e);
            }
        }
        Err(e) => return internal(e),
    }
    let ip = ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "channel.deleted",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "name": name, "messageCount": message_count, "attachmentCount": attachment_count }),
        },
    )
    .await;
    let mut r = Response::new(HttpBody::empty());
    *r.status_mut() = StatusCode::NO_CONTENT;
    r
}

pub fn routes(
    st: DeleteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<DeleteState>>::new()
        .delete("/channels/{id}", delete)
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
