//! S5.4 MS1 — 저장한 글(나중에 볼 메시지, #219). TS `routes/messageRoutes.ts` 의 `GET /saved`·`GET /saved/summary`·
//! `PUT`·`PATCH`·`DELETE /saved/:messageId` 와 `services/savedMessages.ts` 를 옮긴다.
//!
//! - 모든 문장이 `account_id = 요청자` 로 **자기 행만** 다룬다 — 그 필터가 이 줄의 유일한 접근 통제다(TS 와 같다). admin 예외 없음.
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 경로·질의·본문 검사(400) → 담기는 메시지 찾기(지운 것·없는 것 404) → 볼 수 있는가(403)
//!   → 쓰기 → `saved.changed` 이벤트(본인 소켓만, outbox) → 답. 고치기·빼기는 내 행이 없으면 404 `saved message not found`.
//! - 항목의 `message` 는 지운 글이거나 지금 볼 수 없는 채널의 글이면 명시적 `null`(#219 결정 3, #1030) — 본문은
//!   [`message_by_id`](TS `getMessageById` 와 같은 칸) 로 싣는다. 시각 둘(`createdAt`·`doneAt`)은 `toISOString()` 꼴.
//! - 쓰기는 쓰기 풀만 쓴다. 그 역할의 권한은 [`SAVED_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 다섯 줄 모두 TS 에 남는다.
use super::msg_read::{is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::write::{Body, read_body};
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 쓰기 풀이 가져야 할 권한(표, 권한) — homelab GRANT 와 같아야 한다.
pub const SAVED_PRIVILEGES: &[(&str, &str)] = &[
    ("saved_message", "SELECT"),
    ("saved_message", "INSERT"),
    ("saved_message", "UPDATE"),
    ("saved_message", "DELETE"),
    ("event_outbox", "INSERT"),
];
pub const SAVED_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];
/// 읽기 풀이 가져야 할 권한 — 목록·요약·담기 판정.
pub const SAVED_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("saved_message", "SELECT"),
    ("message", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
];

#[derive(Clone)]
pub struct SavedState {
    pub read: PgPool,
    pub write: PgPool,
}

fn visible_frag() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        v["channel_visible_c_p1uuid"]
            .as_str()
            .expect("golden fragment channel_visible_c_p1uuid")
            .to_string()
    })
}

/// TS `saveMessage` 의 가시성 판정 — 술어는 TS 골든(`channelVisibleSql('c', '$1::uuid')`).
fn visible_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select {} as visible from channel c where c.id = $2::uuid",
            visible_frag()
        )
    })
}

/// TS `selectSavedMessages` 의 행(본문 빼고). 순서 = `sm.created_at desc`.
fn list_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select sm.message_id::text, m.channel_id::text, sm.state, {}, {}, (m.deleted_at is not null), \
               exists (select 1 from channel c where c.id = m.channel_id and {}) \
             from saved_message sm join message m on m.id = sm.message_id \
             where sm.account_id = $1::uuid and sm.state = $2 and ($3::uuid is null or sm.message_id = $3::uuid) \
             order by sm.created_at desc",
            crate::iso!("sm.created_at"),
            crate::iso!("sm.done_at"),
            visible_frag(),
        )
    })
}

type Row = (String, String, String, String, Option<String>, bool, bool);

async fn select_saved(
    read: &PgPool,
    me: &str,
    state: &str,
    message: Option<&str>,
) -> sqlx::Result<Vec<Value>> {
    let rows: Vec<Row> = sqlx::query_as(list_sql())
        .bind(me)
        .bind(state)
        .bind(message)
        .fetch_all(read)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, channel, st, created, done, deleted, visible) in rows {
        let body = if deleted || !visible {
            Value::Null
        } else {
            match message_by_id(read, &id).await? {
                Some(s) => serde_json::from_str(&s).map_err(|e| sqlx::Error::Decode(e.into()))?,
                None => Value::Null,
            }
        };
        out.push(json!({
            "messageId": id,
            "channelId": channel,
            "state": st,
            "createdAt": created,
            "doneAt": done,
            "deleted": deleted,
            "message": body,
        }));
    }
    Ok(out)
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`msg_read.rs` 와 같은 약속).
    json_err(StatusCode::BAD_REQUEST, "invalid_request", what)
}

fn saved_not_found() -> Response {
    json_err(
        StatusCode::NOT_FOUND,
        "not_found",
        "saved message not found",
    )
}

fn emit_tx_event(me: &str, message: &str, state: Option<&str>) -> Value {
    json!({ "type": "saved.changed", "messageId": message, "state": state, "accountId": me })
}

/// zod `{ state: enum(['open','done']).optional() }` — 같은 키가 둘이면 TS 는 배열을 받아 거절한다.
fn parse_state(raw: Option<&str>) -> Result<&'static str, &'static str> {
    let mut out: Option<&'static str> = None;
    for (k, v) in crate::directory::form_pairs(raw.unwrap_or("")) {
        if k != "state" {
            continue;
        }
        if out.is_some() {
            return Err("duplicate query key");
        }
        out = Some(match v.as_str() {
            "open" => "open",
            "done" => "done",
            _ => return Err("query: invalid state"),
        });
    }
    Ok(out.unwrap_or("open"))
}

/// `GET /saved?state=open|done`(기본 open).
pub async fn list(
    State(st): State<Arc<SavedState>>,
    RequireAccount(me, _): RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    let state = match parse_state(raw.as_deref()) {
        Ok(s) => s,
        Err(m) => return bad(m),
    };
    match select_saved(&st.read, &me.id, state, None).await {
        Ok(v) => json_ok(json!({ "entries": v }).to_string()),
        Err(e) => internal(e),
    }
}

/// `GET /saved/summary` — `{ openCount, messageIds }`. `messageIds` 는 open·done 을 둘 다 담는다.
pub async fn summary(
    State(st): State<Arc<SavedState>>,
    RequireAccount(me, _): RequireAccount,
) -> Response {
    let rows: Result<Vec<(String, String)>, _> = sqlx::query_as(
        "select message_id::text, state from saved_message where account_id = $1::uuid",
    )
    .bind(&me.id)
    .fetch_all(&st.read)
    .await;
    match rows {
        Ok(rows) => {
            let open = rows.iter().filter(|(_, s)| s == "open").count();
            let ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
            json_ok(json!({ "openCount": open, "messageIds": ids }).to_string())
        }
        Err(e) => internal(e),
    }
}

/// `PUT /saved/{messageId}` — 담기. 이미 있으면 open 으로 되돌린다(행은 하나).
pub async fn save(
    State(st): State<Arc<SavedState>>,
    RequireAccount(me, _): RequireAccount,
    Path(message): Path<String>,
) -> Response {
    if !is_uuid(&message) {
        return bad("params: invalid");
    }
    let found: Result<Option<String>, _> = sqlx::query_scalar(
        "select channel_id::text from message where id = $1::uuid and deleted_at is null",
    )
    .bind(&message)
    .fetch_optional(&st.read)
    .await;
    let channel = match found {
        Ok(Some(c)) => c,
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "message not found"),
        Err(e) => return internal(e),
    };
    let visible: Result<Option<bool>, _> = sqlx::query_scalar(visible_sql())
        .bind(&me.id)
        .bind(&channel)
        .fetch_optional(&st.read)
        .await;
    match visible {
        Ok(Some(true)) => {}
        Ok(_) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this channel",
            );
        }
        Err(e) => return internal(e),
    }
    let r: sqlx::Result<()> = async {
        let mut tx = st.write.begin().await?;
        sqlx::query(
            "insert into saved_message (account_id, message_id, state) values ($1::uuid, $2::uuid, 'open') \
             on conflict (account_id, message_id) do update set state = 'open', done_at = null",
        )
        .bind(&me.id)
        .bind(&message)
        .execute(&mut *tx)
        .await?;
        crate::write::emit_event(&mut tx, &emit_tx_event(&me.id, &message, Some("open"))).await?;
        tx.commit().await
    }
    .await;
    if let Err(e) = r {
        return internal(e);
    }
    match select_saved(&st.read, &me.id, "open", Some(&message)).await {
        Ok(mut v) if !v.is_empty() => json_ok(v.swap_remove(0).to_string()),
        Ok(_) => json_err(StatusCode::NOT_FOUND, "not_found", "message not found"),
        Err(e) => internal(e),
    }
}

/// `PATCH /saved/{messageId}` — `{ state: 'open'|'done' }`. `done_at` 은 DB 시계.
pub async fn patch(
    State(st): State<Arc<SavedState>>,
    RequireAccount(me, _): RequireAccount,
    Path(message): Path<String>,
    req: Request,
) -> Response {
    if !is_uuid(&message) {
        return bad("params: invalid");
    }
    let (parts, body) = req.into_parts();
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let state = match &body {
        Body::Json(Value::Object(o)) => match o.get("state").and_then(Value::as_str) {
            Some(s @ ("open" | "done")) => s.to_string(),
            _ => return bad("body: invalid state"),
        },
        _ => return bad("body: invalid"),
    };
    let r: sqlx::Result<bool> = async {
        let mut tx = st.write.begin().await?;
        let n = sqlx::query(
            "update saved_message set state = $3, done_at = case when $3 = 'done' then now() else null end \
             where account_id = $1::uuid and message_id = $2::uuid",
        )
        .bind(&me.id)
        .bind(&message)
        .bind(&state)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        crate::write::emit_event(&mut tx, &emit_tx_event(&me.id, &message, Some(&state))).await?;
        tx.commit().await?;
        Ok(true)
    }
    .await;
    match r {
        Ok(true) => {}
        Ok(false) => return saved_not_found(),
        Err(e) => return internal(e),
    }
    match select_saved(&st.read, &me.id, &state, Some(&message)).await {
        Ok(mut v) if !v.is_empty() => json_ok(v.swap_remove(0).to_string()),
        Ok(_) => saved_not_found(),
        Err(e) => internal(e),
    }
}

/// `DELETE /saved/{messageId}` — 빼기. 204 본문 없음.
pub async fn unsave(
    State(st): State<Arc<SavedState>>,
    RequireAccount(me, _): RequireAccount,
    Path(message): Path<String>,
) -> Response {
    if !is_uuid(&message) {
        return bad("params: invalid");
    }
    let r: sqlx::Result<bool> = async {
        let mut tx = st.write.begin().await?;
        let n = sqlx::query(
            "delete from saved_message where account_id = $1::uuid and message_id = $2::uuid",
        )
        .bind(&me.id)
        .bind(&message)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        crate::write::emit_event(&mut tx, &emit_tx_event(&me.id, &message, None)).await?;
        tx.commit().await?;
        Ok(true)
    }
    .await;
    match r {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => saved_not_found(),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄(`route_table.rs`). 인증 층은 메서드 안(`route_layer`), CORS 는 바깥(`layer`).
pub fn routes(
    st: SavedState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let one = "/saved/{messageId}";
    let t = Table::<Arc<SavedState>>::new()
        .get("/saved", list)
        .get("/saved/summary", summary)
        .put(one, save)
        .patch(one, patch)
        .delete(one, unsave)
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
