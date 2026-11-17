//! S5.4 CH2 — 채널 읽음 상태 쓰기 2줄. TS `routes/channelRoutes.ts` 의 `PUT /channels/:id/read`·`PUT /channels/:id/unread`
//! 와 `services/readPositions.ts` 의 `markChannelRead`·`markChannelUnread` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기(fastify) → 인증(401) → 경로(400) → 본문(400) → 가시성(403) → 쓰기 → 204.
//! - 본문은 zod `z.coerce.number().int()` — JS `Number(x)` 강제 변환을 그대로 따른다(`null`→0, `"5"`→5, `true`→1).
//!   `/unread` 는 `nullable` 이 바깥이라 `null` 은 null 그대로(표시 지우기)다. 키 부재는 400.
//! - 이벤트가 없다(TS 도 내지 않는다 — 읽음은 내 상태다). 쓰기는 쓰기 풀의 문장 하나. 권한은
//!   [`CHANNEL_READ_WRITE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//! - `GET /channels/{id}/read`·`GET /reads` 는 읽기 코어(`channels.rs`) 것. `PATCH /channels/:id/pref` 는 CH3c `channel_pref_write.rs` 것.
use super::channels::{is_uuid, visible};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::Body;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽음 쓰기가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 칸 권한으로 좁힌다(읽기는 역할의 SELECT).
pub const CHANNEL_READ_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("channel_read.account_id", "INSERT"),
    ("channel_read.channel_id", "INSERT"),
    ("channel_read.last_read_seq", "INSERT"),
    ("channel_read.unread_from_seq", "INSERT"),
    ("channel_read.last_read_seq", "UPDATE"),
    ("channel_read.unread_from_seq", "UPDATE"),
    ("channel_read.updated_at", "UPDATE"),
];

#[derive(Clone)]
pub struct ReadWriteState {
    pub read: PgPool,
    pub write: PgPool,
}

/// TS `markChannelRead` 문장 그대로 — 단조 전진, 채널 끝 상한, 끝까지 읽었을 때만 미읽음 표시 지우기.
const MARK_READ: &str = "insert into channel_read (account_id, channel_id, last_read_seq) \
     values ($1::uuid, $2::uuid, least($3::bigint, coalesce((select max(seq) from message where channel_id = $2::uuid), 0))) \
     on conflict (account_id, channel_id) do update \
       set last_read_seq = greatest(channel_read.last_read_seq, excluded.last_read_seq), \
           unread_from_seq = case \
             when $3::bigint >= coalesce((select max(seq) from message where channel_id = $2::uuid), 0) \
               then null \
             else channel_read.unread_from_seq \
           end, \
           updated_at = now()";
/// TS `markChannelUnread` 문장 그대로 — 사람이 누른 것이 최신 의도라 그대로 덮는다.
const MARK_UNREAD: &str = "insert into channel_read (account_id, channel_id, unread_from_seq) \
     values ($1::uuid, $2::uuid, $3::bigint) \
     on conflict (account_id, channel_id) do update \
       set unread_from_seq = excluded.unread_from_seq, \
           updated_at = now()";

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태만 본다(`msg_read.rs` 와 같은 약속).
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

/// JS 문자열 → 수(`Number("…")`). 앞뒤 공백을 걷고 빈 값은 0, `0x`·`0o`·`0b`, `Infinity` 를 받는다.
fn js_str_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if t.is_empty() {
        return 0.0;
    }
    for (p, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(p) {
            if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return rest.chars().fold(0.0, |a, c| {
                a * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64
            });
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust 는 `inf`·`nan` 도 받지만 JS 는 아니다 — 수 글자만 남긴다.
    if !t.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `Number(v)` — zod `z.coerce.number()` 이 하는 일.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_str_number(s),
        // `String([x])` 꼴 — 빈 배열은 "", 한 칸은 그 칸의 글자, 여럿은 쉼표로 이어져 NaN.
        Value::Array(a) => match a.as_slice() {
            [] => 0.0,
            [Value::Null] => 0.0,
            [x @ (Value::Bool(_) | Value::Number(_) | Value::String(_))] => match x {
                Value::String(s) => js_str_number(s),
                Value::Bool(_) => f64::NAN, // Number("true") 는 NaN.
                _ => js_number(x),
            },
            [Value::Array(inner)] => js_number(&Value::Array(inner.clone())),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// zod `z.object({ seq: z.coerce.number().int().min(min) })` 의 `seq` — Ok(None) 은 (`nullable` 일 때) null.
/// Err 는 400. 정수인지·하한만 본다(zod v3 `int()` 는 `Number.isInteger`).
fn parse_seq(body: &Body, min: f64, nullable: bool) -> Result<Option<f64>, ()> {
    let Body::Json(Value::Object(m)) = body else {
        return Err(());
    };
    let Some(v) = m.get("seq") else {
        // 키 부재 → `Number(undefined)` 는 NaN → 400.
        return Err(());
    };
    if nullable && v.is_null() {
        return Ok(None);
    }
    let f = js_number(v);
    if !f.is_finite() || f.fract() != 0.0 || f < min {
        return Err(());
    }
    Ok(Some(f))
}

/// JS 수 → pg bigint. 범위를 넘으면 TS 에서도 pg 가 거절해 500 이 된다.
fn to_bigint(f: f64) -> Option<i64> {
    // -0 은 0 이다(`Number.isInteger(-0)` 참, pg 에는 "0" 으로 간다).
    (f.abs() < 9_223_372_036_854_775_808.0).then_some(f as i64)
}

fn too_big() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

enum Which {
    Read,
    Unread,
}

async fn mark(st: &ReadWriteState, id: String, req: Request, which: Which) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) {
        return bad("params");
    }
    let seq = match which {
        Which::Read => parse_seq(&body, 0.0, false),
        Which::Unread => parse_seq(&body, 1.0, true),
    };
    let Ok(seq) = seq else {
        return bad("body");
    };
    match visible(&st.read, &me.id, &id).await {
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
    let seq = match seq.map(to_bigint) {
        None => None,
        Some(Some(n)) => Some(n),
        Some(None) => return too_big(),
    };
    let sql = match which {
        Which::Read => MARK_READ,
        Which::Unread => MARK_UNREAD,
    };
    match sqlx::query(sql)
        .bind(&me.id)
        .bind(&id)
        .bind(seq)
        .execute(&st.write)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}

/// `PUT /channels/{id}/read` — 읽음 위치 전진. 204.
pub async fn read(
    State(st): State<Arc<ReadWriteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    mark(&st, id, req, Which::Read).await
}

/// `PUT /channels/{id}/unread` — 미읽음 표시(#154). `seq: null` 은 표시 지우기. 204.
pub async fn unread(
    State(st): State<Arc<ReadWriteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    mark(&st, id, req, Which::Unread).await
}

/// 코어 라우터에 합칠 줄 — `sections_write.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
/// `/channels/{id}/read` 의 `GET` 은 읽기 코어(`channels.rs`)가 이미 붙였다 — 같은 경로라 여기서 `PUT` 만 더한다.
pub fn routes(
    st: ReadWriteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ReadWriteState>>::new()
        .put("/channels/{id}/read", read)
        .put("/channels/{id}/unread", unread)
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
    use serde_json::json;

    fn seq(v: Value, min: f64, nullable: bool) -> Result<Option<f64>, ()> {
        parse_seq(&Body::Json(json!({ "seq": v })), min, nullable)
    }

    #[test]
    fn coerces_like_zod() {
        assert_eq!(seq(json!(3), 0.0, false), Ok(Some(3.0)));
        assert_eq!(seq(json!("7"), 0.0, false), Ok(Some(7.0)));
        assert_eq!(seq(json!(" 0x10 "), 0.0, false), Ok(Some(16.0)));
        assert_eq!(seq(json!(""), 0.0, false), Ok(Some(0.0)));
        assert_eq!(seq(json!(null), 0.0, false), Ok(Some(0.0)));
        assert_eq!(seq(json!(true), 0.0, false), Ok(Some(1.0)));
        assert_eq!(seq(json!([4]), 0.0, false), Ok(Some(4.0)));
        assert_eq!(seq(json!(null), 1.0, true), Ok(None));
        assert!(seq(json!(-1), 0.0, false).is_err());
        assert!(seq(json!(0), 1.0, true).is_err());
        assert!(seq(json!(1.5), 0.0, false).is_err());
        assert!(seq(json!("inf"), 0.0, false).is_err());
        assert!(seq(json!("Infinity"), 0.0, false).is_err());
        assert!(seq(json!({}), 0.0, false).is_err());
        assert!(seq(json!([1, 2]), 0.0, false).is_err());
        assert!(parse_seq(&Body::Json(json!({})), 0.0, false).is_err());
        assert!(parse_seq(&Body::None, 0.0, false).is_err());
        assert!(parse_seq(&Body::Json(json!([])), 0.0, false).is_err());
    }
}
