//! S5.4 CH3a — 핀 고정·해제와 예약 글 만들기·취소 4줄. TS `routes/channelRoutes.ts` 의
//! `POST /channels/:id/pins`·`DELETE /channels/:id/pins/:messageId`·`POST /channels/:id/scheduled`·`DELETE /scheduled/:id`
//! 와 `services/pins.ts`·`services/scheduledMessages.ts` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기(fastify) → 인증(401) → 경로(400) → 본문(400) → 게이트(403) → 쓰기.
//! - 이벤트가 없다(TS 도 내지 않는다). 감사는 고정·해제만(`message.pinned`·`message.unpinned`, 본문은 남기지 않음).
//! - 문장은 TS 정본을 골든(`pin_insert`·`unpin_find`·`unpin_delete`·`schedule_insert`·`cancel_scheduled`)으로 받는다.
//! - 권한은 [`PINS_SCHED_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use super::channels::{frag, is_uuid, pins_sql, rows_sql, visible};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use crate::writes_settings::ip_of;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 이 줄들이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 쓴 행을 바로 읽어 답하므로 SELECT 도 쓰기 풀에서 본다.
pub const PINS_SCHED_PRIVILEGES: &[(&str, &str)] = &[
    ("message_pin", "SELECT"),
    ("message_pin", "INSERT"),
    ("message_pin", "DELETE"),
    ("message", "SELECT"),
    ("scheduled_message", "SELECT"),
    ("scheduled_message", "INSERT"),
    ("scheduled_message", "UPDATE"),
    ("audit_log", "INSERT"),
];

/// TS `SCHEDULE_MAX_DAYS`.
const SCHEDULE_MAX_DAYS: i64 = 30;
/// shared `MAX_MESSAGE_BODY_CHARS` — 즉시 발송과 같은 상한(UTF-16 길이, zod `max`).
const MAX_BODY: usize = crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;

#[derive(Clone)]
pub struct PinsSchedState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: TrustProxy,
}

struct Sql {
    schedule_insert: String,
    datetime: regex::Regex,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| Sql {
        // `insert … returning` 은 FROM 안에 못 둔다 — CTE 로 감싸 목록(`GET …/scheduled`)과 같은 칸·시각 꼴로 낸다.
        schedule_insert: {
            let rows = rows_sql("select * from ins", &["sendAt", "createdAt", "canceledAt"]);
            let tail = rows.strip_prefix("with ").expect("rows_sql starts with `with`");
            format!(
                "with ins as ({}), {tail}",
                frag("schedule_insert")
            )
        },
        // zod 3.25 `z.string().datetime()`(오프셋 없음, 정밀도 자유) 정규식 그대로.
        datetime: regex::Regex::new(concat!(
            r"^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|",
            r"\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))",
            r"T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z)$"
        ))
        .expect("datetime regex"),
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

/// 문장이 낸 JSON 을 못 읽음 — 일어나지 않아야 한다(TS 라면 500).
fn fail() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

fn forbidden(message: &str) -> Response {
    json_err(StatusCode::FORBIDDEN, "forbidden", message)
}

fn archived() -> Response {
    json_err(
        StatusCode::FORBIDDEN,
        "channel_archived",
        "archived channels are read-only",
    )
}

/// TS `channelPostGate` — `None` 은 없는 채널('ok', 뒤 단계가 404·FK 500), `(멤버인가, 보관인가)`.
async fn post_gate(pool: &PgPool, channel: &str, me: &str) -> sqlx::Result<Option<(bool, bool)>> {
    sqlx::query_as(crate::core::msg_post::gate_sql())
        .bind(channel)
        .bind(me)
        .fetch_optional(pool)
        .await
}

fn obj(body: &Body) -> Option<&serde_json::Map<String, Value>> {
    match body {
        Body::Json(Value::Object(m)) => Some(m),
        _ => None,
    }
}

async fn audit(
    st: &PinsSchedState,
    parts: &axum::http::request::Parts,
    me: &crate::auth::Account,
    action: &str,
    channel: &str,
    message: &str,
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
            detail: json!({ "messageId": message }),
        },
    )
    .await;
}

/// `POST /channels/{id}/pins` — 글을 쓸 수 있는 사람 누구나. 이미 고정돼 있으면 그 핀을 그대로 201.
pub async fn pin(
    State(st): State<Arc<PinsSchedState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) {
        return bad("params");
    }
    let Some(message) = obj(&body)
        .and_then(|m| m.get("messageId"))
        .and_then(Value::as_str)
        .filter(|s| is_uuid(s))
        .map(str::to_string)
    else {
        return bad("body");
    };
    match post_gate(&st.read, &id, &me.id).await {
        Ok(Some((false, _))) => return forbidden("not a member of this dm channel"),
        Ok(Some((true, true))) => return archived(),
        Ok(_) => {}
        Err(e) => return internal(e),
    }
    if let Err(e) = sqlx::query(frag("pin_insert"))
        .bind(&message)
        .bind(&id)
        .bind(&me.id)
        .execute(&st.write)
        .await
    {
        return internal(e);
    }
    let pins: String = match sqlx::query_scalar(pins_sql())
        .bind(&id)
        .bind(Some(&message))
        .fetch_one(&st.write)
        .await
    {
        Ok(p) => p,
        Err(e) => return internal(e),
    };
    // 문장은 배열을 낸다 — 첫 줄이 이 핀이다(없으면 이 채널의 살아 있는 글이 아니다).
    let first = match serde_json::from_str::<Value>(&pins) {
        Ok(Value::Array(mut a)) if !a.is_empty() => a.swap_remove(0),
        Ok(_) => {
            return json_err(
                StatusCode::NOT_FOUND,
                "not_found",
                "no such message in this channel",
            );
        }
        Err(_) => return fail(),
    };
    audit(&st, &parts, &me, "message.pinned", &id, &message).await;
    let mut r = json_ok(first.to_string());
    *r.status_mut() = StatusCode::CREATED;
    r
}

/// `DELETE /channels/{id}/pins/{messageId}` — 고정한 사람 또는 admin 만. 보관된 채널에서도 치울 수 있다(게이트는 가시성).
pub async fn unpin(
    State(st): State<Arc<PinsSchedState>>,
    Path((id, message)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad("params");
    }
    match visible(&st.read, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => return forbidden("not a member of this dm channel"),
        Err(e) => return internal(e),
    }
    let pinned_by: Option<String> = match sqlx::query_scalar(frag("unpin_find"))
        .bind(&message)
        .bind(&id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(p) => p,
        Err(e) => return internal(e),
    };
    let Some(pinned_by) = pinned_by else {
        return json_err(
            StatusCode::NOT_FOUND,
            "not_found",
            "that message is not pinned here",
        );
    };
    if pinned_by != me.id && !me.is_admin {
        return forbidden("only the person who pinned it, or an admin, can unpin");
    }
    if let Err(e) = sqlx::query(frag("unpin_delete"))
        .bind(&message)
        .execute(&st.write)
        .await
    {
        return internal(e);
    }
    audit(&st, &parts, &me, "message.unpinned", &id, &message).await;
    StatusCode::NO_CONTENT.into_response()
}

/// 예약 본문 — zod `{ body: string 1..=8000, sendAt: datetime, threadRootId?: uuid }`. 남는 키는 버린다.
#[derive(Debug, PartialEq)]
struct ScheduleBody {
    body: String,
    send_at: String,
    thread_root: Option<String>,
}

fn parse_schedule(body: &Body) -> Option<ScheduleBody> {
    let m = obj(body)?;
    let text = m.get("body")?.as_str()?;
    let n = text.encode_utf16().count();
    if n == 0 || n > MAX_BODY {
        return None;
    }
    let send_at = m.get("sendAt")?.as_str()?;
    if !sql().datetime.is_match(send_at) {
        return None;
    }
    let thread_root = match m.get("threadRootId") {
        None => None,
        Some(Value::String(s)) if is_uuid(s) => Some(s.clone()),
        Some(_) => return None,
    };
    Some(ScheduleBody {
        body: text.to_string(),
        send_at: send_at.to_string(),
        thread_root,
    })
}

/// JS `new Date(s).toISOString()` 의 밀리초 자르기 — 소수 넷째 자리부터 버린다(JS 는 반올림하지 않는다).
/// 정규식을 지난 글자만 받는다(`…T..:..(:..(.d+)?)?Z`).
fn js_millis(s: &str) -> String {
    let core = s.strip_suffix('Z').unwrap_or(s);
    match core.split_once('.') {
        Some((head, frac)) => format!("{head}.{}Z", &frac[..frac.len().min(3)]),
        None => format!("{core}Z"),
    }
}

/// `POST /channels/{id}/scheduled` — 사람만, 글을 쓸 수 있을 때만, 지금보다 뒤이고 30일 안일 때만. 201 `{ scheduled }`.
pub async fn schedule(
    State(st): State<Arc<PinsSchedState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) {
        return bad("params");
    }
    let Some(input) = parse_schedule(&body) else {
        return bad("body");
    };
    if me.kind == "agent" {
        return json_err(
            StatusCode::FORBIDDEN,
            "agents_cannot_schedule",
            "agents cannot schedule messages",
        );
    }
    match post_gate(&st.read, &id, &me.id).await {
        Ok(Some((false, _))) => return forbidden("not a member of this channel"),
        Ok(Some((true, true))) => return archived(),
        Ok(_) => {}
        Err(e) => return internal(e),
    }
    if let Some(root) = &input.thread_root {
        match sqlx::query_scalar::<_, i32>(frag("post_thread_root_of"))
            .bind(root)
            .bind(&id)
            .fetch_optional(&st.read)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "bad_thread",
                    "threadRootId must be a top-level message in this channel",
                );
            }
            Err(e) => return internal(e),
        }
    }
    let send_at = js_millis(&input.send_at);
    // 0000년은 JS 에선 과거 날짜지만 pg timestamptz 는 받지 않는다 — 그 자리에서 과거로 거절한다(TS 와 같은 400).
    let year_zero = send_at.starts_with("0000-");
    let (past, far): (bool, bool) = if year_zero {
        (true, false)
    } else {
        match sqlx::query_as(
            "select $1::timestamptz <= now(), $1::timestamptz > now() + make_interval(hours => $2::int)",
        )
        .bind(&send_at)
        .bind((SCHEDULE_MAX_DAYS * 24) as i32)
        .fetch_one(&st.read)
        .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
    if past {
        return json_err(
            StatusCode::BAD_REQUEST,
            "send_at_in_past",
            "send_at must be in the future",
        );
    }
    if far {
        return json_err(
            StatusCode::BAD_REQUEST,
            "send_at_too_far",
            &format!("send_at cannot be more than {SCHEDULE_MAX_DAYS} days in the future"),
        );
    }
    let rows: String = match sqlx::query_scalar(sql().schedule_insert.as_str())
        .bind(&id)
        .bind(&me.id)
        .bind(input.thread_root.as_deref())
        .bind(&input.body)
        .bind(&send_at)
        .fetch_one(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let row = match serde_json::from_str::<Value>(&rows) {
        Ok(Value::Array(mut a)) if !a.is_empty() => a.swap_remove(0),
        _ => return fail(),
    };
    let mut r = json_ok(json!({ "scheduled": row }).to_string());
    *r.status_mut() = StatusCode::CREATED;
    r
}

/// `DELETE /scheduled/{id}` — 내가 건, 아직 나가지·실패하지·취소되지 않은 예약만. 행은 남기고 `canceled_at` 을 찍는다.
pub async fn cancel(
    State(st): State<Arc<PinsSchedState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) {
        return bad("params");
    }
    match sqlx::query(frag("cancel_scheduled"))
        .bind(&id)
        .bind(&me.id)
        .execute(&st.write)
        .await
    {
        Ok(r) if r.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => json_err(
            StatusCode::NOT_FOUND,
            "not_found",
            "scheduled message not found or already sent/canceled",
        ),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `channel_read_write.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// `/channels/{id}/pins`·`/channels/{id}/scheduled` 의 `GET` 은 읽기 코어(`channels.rs`)가 이미 붙였다.
pub fn routes(
    st: PinsSchedState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PinsSchedState>>::new()
        .post("/channels/{id}/pins", pin)
        .delete("/channels/{id}/pins/{messageId}", unpin)
        .post("/channels/{id}/scheduled", schedule)
        .delete("/scheduled/{id}", cancel)
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

    fn sched(v: Value) -> Option<ScheduleBody> {
        parse_schedule(&Body::Json(v))
    }

    #[test]
    fn schedule_body_like_zod() {
        let ok =
            sched(json!({ "body": "hi", "sendAt": "2026-11-18T00:00:00Z", "extra": 1 })).unwrap();
        assert_eq!(ok.thread_root, None);
        assert!(sched(json!({ "body": "hi", "sendAt": "2026-11-18T00:00Z" })).is_some());
        assert!(sched(json!({ "body": "hi", "sendAt": "2028-02-29T00:00:00.123456Z" })).is_some());
        assert!(sched(json!({ "body": "", "sendAt": "2026-11-18T00:00:00Z" })).is_none());
        assert!(
            sched(json!({ "body": "x".repeat(8001), "sendAt": "2026-11-18T00:00:00Z" })).is_none()
        );
        assert!(
            sched(json!({ "body": "x".repeat(8000), "sendAt": "2026-11-18T00:00:00Z" })).is_some()
        );
        assert!(sched(json!({ "body": "hi", "sendAt": "2026-02-30T00:00:00Z" })).is_none());
        assert!(sched(json!({ "body": "hi", "sendAt": "2027-02-29T00:00:00Z" })).is_none());
        assert!(sched(json!({ "body": "hi", "sendAt": "2026-11-18T24:00:00Z" })).is_none());
        assert!(sched(json!({ "body": "hi", "sendAt": "2026-11-18T00:00:00+09:00" })).is_none());
        assert!(sched(json!({ "body": "hi", "sendAt": "2026-11-18T23:59:60Z" })).is_none());
        assert!(
            sched(json!({ "body": "hi", "sendAt": "2026-11-18T00:00:00Z", "threadRootId": null }))
                .is_none()
        );
        assert!(
            sched(json!({ "body": "hi", "sendAt": "2026-11-18T00:00:00Z", "threadRootId": "x" }))
                .is_none()
        );
        assert!(parse_schedule(&Body::None).is_none());
    }

    #[test]
    fn millis_truncate_like_js() {
        assert_eq!(
            js_millis("2026-11-18T00:00:00.123456Z"),
            "2026-11-18T00:00:00.123Z"
        );
        assert_eq!(
            js_millis("2026-11-18T00:00:00.9Z"),
            "2026-11-18T00:00:00.9Z"
        );
        assert_eq!(js_millis("2026-11-18T00:00Z"), "2026-11-18T00:00Z");
    }
}
