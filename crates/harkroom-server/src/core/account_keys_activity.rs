//! S5.4 AC4 — `PUT /accounts/{id}/keys`·`POST /agent/activity` 를 옮긴다(TS `routes/accountRoutes.ts`).
//!
//! - keys: `requireAccount`(401) → 경로(400) → 본인·admin 아니면 403 → 본문(400) → upsert. 다른 계정의
//!   `key_id` 면 0줄이라 409 `key_conflict`. 성공은 204. 대상 계정이 없으면 FK 위반으로 500(TS 와 같다).
//! - activity: `requireAccount`(401) → 에이전트가 아니면 400 `invalid_account` → `agent_config.last_turn_at` 을
//!   서버 `now()` 로 찍고 `{lastTurnAt}`. 감사는 남기지 않는다(TS 주석과 같다 — 매 턴 일어나는 일).
//! - 권한은 [`KEYS_ACTIVITY_PRIVILEGES`] — 없으면 `main.rs` 가 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::lists::is_zod_uuid;
use crate::write::Body;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 칸 권한.
pub const KEYS_ACTIVITY_PRIVILEGES: &[(&str, &str)] = &[
    ("account_key.key_id", "INSERT"),
    ("account_key.account_id", "INSERT"),
    ("account_key.public_key_pem", "INSERT"),
    ("account_key.public_key_pem", "UPDATE"),
    ("agent_config.account_id", "INSERT"),
    ("agent_config.last_turn_at", "INSERT"),
    ("agent_config.last_turn_at", "UPDATE"),
    ("agent_config.updated_at", "UPDATE"),
];

#[derive(Clone)]
pub struct KeysActivityState {
    pub write: PgPool,
}

/// zod `{ keyId: string().min(1).max(128), publicKeyPem: string().includes('BEGIN PUBLIC KEY') }`.
/// zod 길이는 UTF-16 단위다.
pub fn parse_key(body: &Body) -> Option<(String, String)> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let Some(Value::String(k)) = m.get("keyId") else {
        return None;
    };
    let Some(Value::String(p)) = m.get("publicKeyPem") else {
        return None;
    };
    let n = k.encode_utf16().count();
    ((1..=128).contains(&n) && p.contains("BEGIN PUBLIC KEY")).then(|| (k.clone(), p.clone()))
}

fn bad(what: &str) -> Response {
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}

const UPSERT_KEY: &str =
    "insert into account_key (key_id, account_id, public_key_pem) values ($1, $2::uuid, $3)
 on conflict (key_id) do update set public_key_pem = excluded.public_key_pem
 where account_key.account_id = excluded.account_id";

/// `PUT /accounts/{id}/keys`.
pub async fn put_keys(
    State(st): State<Arc<KeysActivityState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), _parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_zod_uuid(&id) {
        return bad("id");
    }
    if !me.is_admin && me.id != id {
        return json_err(StatusCode::FORBIDDEN, "forbidden", "not your account");
    }
    let Some((key_id, pem)) = parse_key(&body) else {
        return bad("body");
    };
    match sqlx::query(UPSERT_KEY)
        .bind(&key_id)
        .bind(&id)
        .bind(&pem)
        .execute(&st.write)
        .await
    {
        Ok(r) if r.rows_affected() == 0 => json_err(
            StatusCode::CONFLICT,
            "key_conflict",
            "key already registered to another account",
        ),
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}

const TOUCH: &str = concat!(
    "insert into agent_config (account_id, last_turn_at) values ($1::uuid, now())
 on conflict (account_id) do update set last_turn_at = now(), updated_at = now()
 returning ",
    crate::iso!("last_turn_at")
);

/// `POST /agent/activity`.
pub async fn post_activity(State(st): State<Arc<KeysActivityState>>, req: Request) -> Response {
    let (_body, RequireAccount(me, _), _parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if me.kind != "agent" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_account",
            "activity is only for agent accounts",
        );
    }
    match sqlx::query_scalar::<_, String>(TOUCH)
        .bind(&me.id)
        .fetch_one(&st.write)
        .await
    {
        Ok(at) => json_ok(json!({ "lastTurnAt": at }).to_string()),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: KeysActivityState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<KeysActivityState>>::new()
        .put("/accounts/{id}/keys", put_keys)
        .post("/agent/activity", post_activity)
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

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn key_body_follows_zod() {
        let pem = "-----BEGIN PUBLIC KEY-----x";
        assert!(parse_key(&j(json!({ "keyId": "k", "publicKeyPem": pem }))).is_some());
        assert!(parse_key(&j(json!({ "keyId": "", "publicKeyPem": pem }))).is_none());
        assert!(parse_key(&j(json!({ "keyId": "k".repeat(129), "publicKeyPem": pem }))).is_none());
        assert!(
            parse_key(&j(
                json!({ "keyId": "가".repeat(128), "publicKeyPem": pem })
            ))
            .is_some()
        );
        assert!(parse_key(&j(json!({ "keyId": "k", "publicKeyPem": "nope" }))).is_none());
        assert!(parse_key(&j(json!({ "keyId": 1, "publicKeyPem": pem }))).is_none());
        assert!(parse_key(&j(json!([]))).is_none());
    }
}
