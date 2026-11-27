//! S5.3 C6a-1 — 인박스 읽음 표시 `POST /inbox/read`. TS `routes/messageRoutes.ts` 의 그 라우트와 `services/messages.ts::markInboxRead` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문(fastify — 익명도 400/415) → 인증(401) → zod `{ ids: number.int()[] (1개 이상) }`(400 `invalid_request`)
//!   → 쓰기 → 204(본문 없음).
//! - 고치는 행은 언제나 부른 계정의 것이다(`account_id = 나`) — 남의 id 를 넣어도 바뀌지 않는다. 이미 읽은 줄은 시각을 덮지 않는다.
//! - TS 는 이벤트를 내지 않는다(같게 둔다).
//! - JS 숫자 규칙: `1.0` 은 정수다. 부호 있는 64비트 밖의 정수는 TS 에서 Postgres 가 거절해 500 이다 — 같게 500.
//! - 쓰기 역할 권한은 [`INBOX_READ_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 이 줄이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. `read_at` 한 칸만 고친다(칸 권한).
pub const INBOX_READ_PRIVILEGES: &[(&str, &str)] = &[("inbox.read_at", "UPDATE")];

#[derive(Clone)]
pub struct InboxReadState {
    pub write: PgPool,
}

/// zod 거절 하나 — 그 밖의 오류와 구분한다(문구는 TS 의 zod 오류 JSON 과 다르다, 대조는 상태·코드만).
#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Ids(Vec<i64>),
    /// zod 가 거절한다 → 400.
    Invalid,
    /// zod 는 받지만 Postgres 가 bigint 로 못 받는 값(TS 500).
    OutOfRange,
}

/// `z.object({ ids: z.array(z.number().int()).min(1) })` — 모르는 키는 버린다(zod strip).
pub fn parse_ids(body: &Body) -> Parsed {
    let Body::Json(Value::Object(o)) = body else {
        return Parsed::Invalid;
    };
    let Some(Value::Array(a)) = o.get("ids") else {
        return Parsed::Invalid;
    };
    if a.is_empty() {
        return Parsed::Invalid;
    }
    let mut out = Vec::with_capacity(a.len());
    let mut wide = false;
    for v in a {
        // JSON 숫자는 JS 에서 double 이다 — `Number.isInteger` 와 같게 본다.
        let Some(n) = v.as_f64() else {
            return Parsed::Invalid;
        };
        if !n.is_finite() || n.fract() != 0.0 {
            return Parsed::Invalid;
        }
        if let Some(i) = v.as_i64() {
            out.push(i);
        } else if (-9.223_372_036_854_776e18..9.223_372_036_854_776e18).contains(&n) {
            out.push(n as i64);
        } else {
            wide = true;
        }
    }
    if wide {
        Parsed::OutOfRange
    } else {
        Parsed::Ids(out)
    }
}

/// `POST /inbox/read` — 내 인박스 줄을 읽음으로. 바뀐 수와 무관하게 204.
pub async fn post_read(State(st): State<Arc<InboxReadState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let ids = match parse_ids(&body) {
        Parsed::Ids(ids) => ids,
        Parsed::Invalid => {
            return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid");
        }
        Parsed::OutOfRange => {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            );
        }
    };
    match crate::core::wake_write::mark_read(&st.write, &me.id, &ids).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `msg_delete.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: InboxReadState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<InboxReadState>>::new()
        .post("/inbox/read", post_read)
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

    fn p(v: Value) -> Parsed {
        parse_ids(&Body::Json(v))
    }

    #[test]
    fn zod_shape() {
        assert_eq!(p(json!({ "ids": [1, 2] })), Parsed::Ids(vec![1, 2]));
        assert_eq!(p(json!({ "ids": [1.0], "x": 1 })), Parsed::Ids(vec![1]));
        assert_eq!(p(json!({ "ids": [-3] })), Parsed::Ids(vec![-3]));
        assert_eq!(p(json!({ "ids": [] })), Parsed::Invalid);
        assert_eq!(p(json!({ "ids": [1.5] })), Parsed::Invalid);
        assert_eq!(p(json!({ "ids": ["1"] })), Parsed::Invalid);
        assert_eq!(p(json!({ "ids": [null] })), Parsed::Invalid);
        assert_eq!(p(json!({ "ids": 1 })), Parsed::Invalid);
        assert_eq!(p(json!({})), Parsed::Invalid);
        assert_eq!(p(json!([1])), Parsed::Invalid);
        assert_eq!(parse_ids(&Body::None), Parsed::Invalid);
        assert_eq!(parse_ids(&Body::Text("x".into())), Parsed::Invalid);
        assert_eq!(p(json!({ "ids": [1e20] })), Parsed::OutOfRange);
        // 정수가 아닌 것이 범위 밖보다 먼저 거절된다(zod 가 먼저 돈다).
        assert_eq!(p(json!({ "ids": [1e20, 0.5] })), Parsed::Invalid);
    }

    #[test]
    fn privilege_is_one_column() {
        assert_eq!(INBOX_READ_PRIVILEGES, &[("inbox.read_at", "UPDATE")]);
    }
}
