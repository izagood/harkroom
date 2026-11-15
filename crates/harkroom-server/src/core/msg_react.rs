//! S5.3 C3a-1 — 리액션 쓰기. TS `routes/messageRoutes.ts` 의 `PUT`·`DELETE /channels/:id/messages/:messageId/reactions/:emoji` 와
//! `services/reactions.ts`(`isEmoji`·`addReaction`·`stampWakeChecked`·`removeReaction`) 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 경로 검사(400) → 이모지 판정(PUT 만, 400) → 채널을 볼 수 있는지(403) → 쓰기.
//! - 이벤트는 TS 와 같은 이름·모양·받는 사람(`audience_for`)으로 outbox 에 넣는다(`write::emit_event`). TS 는 `EVENT_BUS=pg` 로
//!   받아 자기 구독자(WS·`threadStatus` 의 상태 이모지 재판정)에게 옮기고, Rust 허브는 outbox 리스너로 받는다.
//! - 쓰기는 쓰기 풀만 쓴다. 그 역할의 권한은 [`MESSAGE_REACTION_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::audience::audience_for;
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// TS `MAX_REACTIONS_PER_ACTOR`.
pub const MAX_REACTIONS_PER_ACTOR: i64 = 20;
/// TS `WAKE_CHECKED_EMOJI`(`@harkroom/shared`).
pub const WAKE_CHECKED_EMOJI: &str = "\u{2705}";

/// 리액션 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다.
pub const MESSAGE_REACTION_PRIVILEGES: &[(&str, &str)] = &[
    ("message_reaction", "INSERT"),
    ("message_reaction", "UPDATE"),
    ("message_reaction", "DELETE"),
    // 글은 `meta`(✅ 대기 줄 확인 시각)만 고친다 — 칸 권한 `update (meta) on message` 로 충분하다.
    ("message.meta", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const MESSAGE_REACTION_SEQUENCE_PRIVILEGES: &[(&str, &str)] =
    &[("event_outbox_id_seq", "USAGE")];

#[derive(Clone)]
pub struct ReactState {
    pub read: PgPool,
    pub write: PgPool,
}

/// TS `isEmoji` — 길이는 UTF-16 단위(JS `length`)로 센다.
pub fn is_emoji(v: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"^\p{Extended_Pictographic}(\x{200D}\p{Extended_Pictographic}|[\x{FE0F}\x{1F3FB}-\x{1F3FF}\x{E0020}-\x{E007F}])*$",
        )
        .expect("emoji regex")
    });
    let n = v.encode_utf16().count();
    n > 0 && n <= 32 && re.is_match(v)
}

/// zod `reactionParams` — uuid 둘, 이모지 1..=32(UTF-16).
fn params_ok(id: &str, message: &str, emoji: &str) -> bool {
    let n = emoji.encode_utf16().count();
    is_uuid(id) && is_uuid(message) && (1..=32).contains(&n)
}

fn bad_params() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "params: invalid",
    )
}

fn forbidden() -> Response {
    json_err(
        StatusCode::FORBIDDEN,
        "forbidden",
        "not a member of this dm channel",
    )
}

async fn emit(write: &PgPool, event: &Value) -> Result<(), sqlx::Error> {
    let mut conn = write.acquire().await?;
    crate::write::emit_event(&mut conn, event).await.map(|_| ())
}

/// `PUT /channels/{id}/messages/{messageId}/reactions/{emoji}`.
pub async fn put_reaction(
    State(st): State<Arc<ReactState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, message, emoji)): Path<(String, String, String)>,
) -> Response {
    if !params_ok(&id, &message, &emoji) {
        return bad_params();
    }
    if !is_emoji(&emoji) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "a reaction must be a single emoji",
        );
    }
    match channel_visible(&st.read, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(),
        Err(e) => return internal(e),
    }
    // TS `messageIsHere` — 삭제된 메시지에 붙으면 되살아난 것처럼 보인다.
    let here: Option<i32> = match sqlx::query_scalar(
        "select 1 from message where id = $1::uuid and channel_id = $2::uuid and deleted_at is null",
    )
    .bind(&message)
    .bind(&id)
    .fetch_optional(&st.write)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if here.is_none() {
        return json_err(
            StatusCode::NOT_FOUND,
            "not_found",
            "no such message in this channel",
        );
    }
    // 이미 눌러 둔 것은 한도에 걸리지 않는다. 상태 리액션(`source = 'status'`)은 세지 않는다.
    let mine: Vec<String> = match sqlx::query_scalar(
        "select emoji from message_reaction where message_id = $1::uuid and account_id = $2::uuid and source = 'user'",
    )
    .bind(&message)
    .bind(&me.id)
    .fetch_all(&st.write)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if !mine.contains(&emoji) && mine.len() as i64 >= MAX_REACTIONS_PER_ACTOR {
        // TS 는 이 경우만 맨 겉에도 `code` 를 싣는다.
        let body = json!({
            "code": "too_many_reactions",
            "error": {
                "code": "too_many_reactions",
                "message": format!("at most {MAX_REACTIONS_PER_ACTOR} reactions per message"),
            },
        });
        return (
            StatusCode::CONFLICT,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            body.to_string(),
        )
            .into_response();
    }
    if let Err(e) = sqlx::query(
        "insert into message_reaction (message_id, account_id, emoji) values ($1::uuid, $2::uuid, $3) \
         on conflict (message_id, account_id, emoji) do update set source = 'user' \
           where message_reaction.source = 'status'",
    )
    .bind(&message)
    .bind(&me.id)
    .bind(&emoji)
    .execute(&st.write)
    .await
    {
        return internal(e);
    }
    let audience = match audience_for(&st.read, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let added = json!({
        "type": "reaction.added", "channelId": id, "messageId": message, "emoji": emoji,
        "accountId": me.id, "audience": audience,
    });
    if let Err(e) = emit(&st.write, &added).await {
        return internal(e);
    }
    // TS `stampWakeChecked` — 줄 주인이 자기 대기 줄에 ✅ 를 달면 첫 확인 시각을 적는다.
    if emoji == WAKE_CHECKED_EMOJI {
        let stamped = match sqlx::query(
            "update message set meta = jsonb_set(meta, '{wake,checkedAt}', \
               to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) \
             where id = $1::uuid and channel_id = $2::uuid and author_id = $3::uuid and kind = 'wake' \
               and deleted_at is null and jsonb_typeof(meta->'wake') = 'object' and meta->'wake'->>'checkedAt' is null",
        )
        .bind(&message)
        .bind(&id)
        .bind(&me.id)
        .execute(&st.write)
        .await
        {
            Ok(r) => r.rows_affected() == 1,
            Err(e) => return internal(e),
        };
        if stamped {
            let row = match message_by_id(&st.write, &message).await {
                Ok(r) => r,
                Err(e) => return internal(e),
            };
            if let Some(row) = row.and_then(|r| serde_json::from_str::<Value>(&r).ok()) {
                let updated =
                    json!({ "type": "message.updated", "message": row, "audience": audience });
                if let Err(e) = emit(&st.write, &updated).await {
                    return internal(e);
                }
            }
        }
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        json!({ "emoji": emoji }).to_string(),
    )
        .into_response()
}

/// `DELETE /channels/{id}/messages/{messageId}/reactions/{emoji}` — 없는 것을 떼는 것도 204(TS 와 같다, 존재 확인을 하지 않는다).
pub async fn delete_reaction(
    State(st): State<Arc<ReactState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, message, emoji)): Path<(String, String, String)>,
) -> Response {
    if !params_ok(&id, &message, &emoji) {
        return bad_params();
    }
    match channel_visible(&st.read, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(),
        Err(e) => return internal(e),
    }
    let kept: bool = match sqlx::query_scalar(
        "with del as ( \
           delete from message_reaction where message_id = $1::uuid and account_id = $2::uuid and emoji = $3 and source = 'user' \
         ) \
         select exists (select 1 from message_reaction \
                         where message_id = $1::uuid and account_id = $2::uuid and emoji = $3 and source = 'status')",
    )
    .bind(&message)
    .bind(&me.id)
    .bind(&emoji)
    .fetch_one(&st.write)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    // 서버가 단 상태 리액션이 남았으면 이벤트를 내지 않는다 — 내면 화면이 남은 리액션을 지운다.
    if !kept {
        let audience = match audience_for(&st.read, &id).await {
            Ok(a) => a.to_json(),
            Err(e) => return internal(e),
        };
        let removed = json!({
            "type": "reaction.removed", "channelId": id, "messageId": message, "emoji": emoji,
            "accountId": me.id, "audience": audience,
        });
        if let Err(e) = emit(&st.write, &removed).await {
            return internal(e);
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// 코어 라우터에 합칠 줄 — `msg_read.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: ReactState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let path = "/channels/{id}/messages/{messageId}/reactions/{emoji}";
    let t = Table::<Arc<ReactState>>::new()
        .put(path, put_reaction)
        .delete(path, delete_reaction)
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
    fn emoji_like_ts() {
        assert!(is_emoji("\u{1F44D}")); // thumbs up
        assert!(is_emoji("\u{2705}")); // check mark
        assert!(is_emoji("\u{2764}\u{FE0F}")); // heart + VS16
        assert!(is_emoji("\u{1F44D}\u{1F3FD}")); // skin tone
        assert!(is_emoji("\u{1F468}\u{200D}\u{1F4BB}")); // ZWJ sequence
        assert!(!is_emoji(""));
        assert!(!is_emoji("a"));
        assert!(!is_emoji("\u{1F44D}a"));
        assert!(!is_emoji("hello"));
        assert!(!is_emoji("\u{200D}\u{1F44D}"));
        // 그림문자 하나 + VS16 32 개 = UTF-16 34 단위 → 32 초과.
        assert!(!is_emoji(&format!("\u{1F44D}{}", "\u{FE0F}".repeat(32))));
    }

    #[test]
    fn params_like_zod() {
        let u = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert!(params_ok(u, u, "\u{1F44D}"));
        assert!(!params_ok("x", u, "\u{1F44D}"));
        assert!(!params_ok(u, u, ""));
        assert!(!params_ok(u, u, &"a".repeat(33)));
    }
}
