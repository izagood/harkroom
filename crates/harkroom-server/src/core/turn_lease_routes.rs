//! 턴 임대 라우트(S5.3 C6b-2) — TS `routes/secretRoutes.ts` 의 `POST /agent/turn-leases`·`/{id}/end`·`/{id}/renew` 를 옮긴다.
//! 판정·쓰기는 [`super::turn_lease`] 가 하고, 여기서는 TS 와 같은 차례로 거른다: 인증(401) → 오퍼레이터를 거친 에이전트(403) →
//! 본문(400) → 판정. 감사 줄(`secret.lease.issued|reissued|conflict`)은 TS 와 같은 칸이고 토큰·해시는 싣지 않는다.
//!
//! - 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 [`super::turn_lease::TURN_LEASE_PRIVILEGES`] 가 다 있을 때만 선다(`main.rs`).
//!   아니면 세 줄 모두 TS 에 남는다.
//! - 요청별로 TS 에 넘기는 갈래는 없다 — 자동화 회차 글의 위임장(⑤b)도 [`super::turn_lease::issue`] 가 같은 tx 에서 한다.
use super::msg_read::is_uuid;
use super::turn_lease::{self as lease, Issue};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, BODY_LIMIT, record_audit};
use axum::body::{Body, to_bytes};
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

pub struct LeaseState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

/// TS `viaOperator` — 에이전트 계정이 오퍼레이터 토큰으로 선 요청만. (agent_id, operator_id).
#[allow(clippy::result_large_err)]
fn via_operator(me: &Account, auth: &crate::auth::Auth) -> Result<(String, String), Response> {
    match (&me.kind[..], &auth.operator) {
        ("agent", Some(op)) => Ok((me.id.clone(), op.id.clone())),
        _ => Err(json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only an agent through its operator can do this",
        )),
    }
}

/// fastify 처럼 본문을 읽는다(한도 413 → 형식 400/415). 본문이 없거나 JSON 이 아니면 `None`(TS `req.body ?? {}` 뒤 zod 가 400).
#[allow(clippy::result_large_err)]
async fn read_body(
    headers: &axum::http::HeaderMap,
    body: Body,
) -> Result<(axum::body::Bytes, Option<Value>), Response> {
    let bytes = to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        )
    })?;
    let parsed = crate::write::fastify_body(headers, &bytes)?;
    Ok((
        bytes,
        match parsed {
            crate::write::Body::Json(v) => Some(v),
            // 본문 없음 = `{}` — 필수 칸이 없어 아래에서 400 이다.
            crate::write::Body::None => Some(json!({})),
            crate::write::Body::Text(_) => None,
        },
    ))
}

/// zod `z.string().min(lo).max(hi)` — 길이는 JS 처럼 UTF-16 단위로 센다.
fn str_in(v: &Value, lo: usize, hi: usize) -> Option<&str> {
    let s = v.as_str()?;
    let n = s.encode_utf16().count();
    (lo..=hi).contains(&n).then_some(s)
}

/// `POST /agent/turn-leases` 본문 — (causeMessageId, claimHolder?). 틀리면 None.
fn parse_issue(v: &Value) -> Option<(String, Option<String>)> {
    let o = v.as_object()?;
    let cause = o.get("causeMessageId")?.as_str().filter(|s| is_uuid(s))?;
    let holder = match o.get("claimHolder") {
        None => None,
        Some(h) => Some(str_in(h, 1, 100)?.to_string()),
    };
    Some((cause.to_string(), holder))
}

/// `/end`·`/renew` 본문의 `token`(1..200).
fn parse_token(v: &Value) -> Option<String> {
    str_in(v.as_object()?.get("token")?, 1, 200).map(str::to_string)
}

fn bad_request(message: &str) -> Response {
    json_err(StatusCode::BAD_REQUEST, "bad_request", message)
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

fn ok_json(v: &Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        v.to_string(),
    )
        .into_response()
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such live lease")
}

/// `POST /agent/turn-leases`.
pub async fn issue(
    State(st): State<Arc<LeaseState>>,
    RequireAccount(me, auth): RequireAccount,
    req: Request,
) -> Response {
    let (agent_id, operator_id) = match via_operator(&me, &auth) {
        Ok(w) => w,
        Err(r) => return r,
    };
    let (parts, body) = req.into_parts();
    let (_, v) = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some((cause, holder)) = v.as_ref().and_then(parse_issue) else {
        return bad_request("body: invalid");
    };
    let issued = match lease::issue(
        &st.write,
        &agent_id,
        &operator_id,
        &cause,
        holder.as_deref(),
    )
    .await
    {
        Ok(i) => i,
        Err(e) => return internal(e),
    };
    let ip = crate::trust_proxy::request_ip(&parts, &st.trust);
    let audit = |action: &'static str, detail: Value| AuditEntry {
        action,
        actor_id: Some(&me.id),
        actor_handle: Some(&me.handle),
        target: Some(&agent_id),
        ip: ip.as_deref(),
        detail,
    };
    match issued {
        Issue::LeaseUsed => {
            // 충돌은 사건이다(H2·S1) — TS 와 같은 줄.
            record_audit(
                &st.write,
                audit(
                    "secret.lease.conflict",
                    json!({ "causeMessageId": cause, "operatorId": operator_id }),
                ),
            )
            .await;
            json_err(
                StatusCode::CONFLICT,
                "lease_used",
                "this mention has already had a lease; a lease is issued once per mention",
            )
        }
        Issue::NotInvoked => json_err(
            StatusCode::FORBIDDEN,
            "not_invoked",
            "this agent was not recently invoked by that message",
        ),
        Issue::Ok(i) => {
            // 발급 줄 — 토큰·해시 없음.
            let entry = match &i.reissue {
                Some(r) => audit(
                    "secret.lease.reissued",
                    json!({
                        "causeMessageId": cause, "operatorId": operator_id, "oldLeaseId": r.old_lease_id,
                        "newLeaseId": i.lease_id, "waitedSec": i.waited_sec,
                        "sinceLastBeatSec": r.since_last_beat_sec, "via": r.via,
                    }),
                ),
                None => audit(
                    "secret.lease.issued",
                    json!({
                        "causeMessageId": cause, "operatorId": operator_id,
                        "leaseId": i.lease_id, "waitedSec": i.waited_sec,
                    }),
                ),
            };
            record_audit(&st.write, entry).await;
            no_store(ok_json(&json!({ "lease": {
                "id": i.lease_id, "token": i.token, "channelId": i.channel_id,
                "threadRootId": i.thread_root_id, "expiresAt": i.expires_at,
            }})))
        }
    }
}

/// `/end`·`/renew` 공통 — 거르기와 (lease id, token).
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy).
async fn lease_and_token(id: &str, req: Request) -> Result<(String, String), Response> {
    let (parts, body) = req.into_parts();
    let (_, v) = read_body(&parts.headers, body).await?;
    match (is_uuid(id), v.as_ref().and_then(parse_token)) {
        (true, Some(t)) => Ok((id.to_string(), t)),
        _ => Err(bad_request("leaseId and token are required")),
    }
}

/// `POST /agent/turn-leases/{id}/end` — 끝냈으면 204, 없으면 404.
pub async fn end(
    State(st): State<Arc<LeaseState>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (agent_id, _) = match via_operator(&me, &auth) {
        Ok(w) => w,
        Err(r) => return r,
    };
    let (id, token) = match lease_and_token(&id, req).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    match lease::end(&st.write, &id, &token, &agent_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found(),
        Err(e) => internal(e),
    }
}

/// `POST /agent/turn-leases/{id}/renew` — 늘린 만료 시각. 끝났거나 만료됐으면 404(되살리지 않는다).
pub async fn renew(
    State(st): State<Arc<LeaseState>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (agent_id, operator_id) = match via_operator(&me, &auth) {
        Ok(w) => w,
        Err(r) => return r,
    };
    let (id, token) = match lease_and_token(&id, req).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    match lease::renew(&st.write, &id, &token, &agent_id, &operator_id).await {
        Ok(Some(at)) => no_store(ok_json(&json!({ "expiresAt": at }))),
        Ok(None) => no_store(not_found()),
        Err(e) => internal(e),
    }
}

pub fn routes(
    st: LeaseState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<LeaseState>>::new()
        .post("/agent/turn-leases", issue)
        .post("/agent/turn-leases/{id}/end", end)
        .post("/agent/turn-leases/{id}/renew", renew)
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

    const U: &str = "0b9e8f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn issue_body_matches_zod() {
        assert_eq!(
            parse_issue(&json!({ "causeMessageId": U })),
            Some((U.into(), None))
        );
        assert_eq!(
            parse_issue(&json!({ "causeMessageId": U, "claimHolder": "h" })),
            Some((U.into(), Some("h".into())))
        );
        assert!(parse_issue(&json!({})).is_none());
        assert!(parse_issue(&json!({ "causeMessageId": "x" })).is_none());
        assert!(parse_issue(&json!({ "causeMessageId": U, "claimHolder": "" })).is_none());
        assert!(parse_issue(&json!({ "causeMessageId": U, "claimHolder": null })).is_none());
        assert!(
            parse_issue(&json!({ "causeMessageId": U, "claimHolder": "a".repeat(101) })).is_none()
        );
        assert!(
            parse_issue(&json!({ "causeMessageId": U, "claimHolder": "a".repeat(100) })).is_some()
        );
        assert!(parse_issue(&json!([U])).is_none());
    }

    #[test]
    fn token_length_counts_utf16_like_js() {
        assert!(parse_token(&json!({ "token": "" })).is_none());
        assert!(parse_token(&json!({ "token": "t".repeat(200) })).is_some());
        assert!(parse_token(&json!({ "token": "t".repeat(201) })).is_none());
        // 이모지 하나 = UTF-16 2단위 → 100개가 200.
        assert!(parse_token(&json!({ "token": "😀".repeat(100) })).is_some());
        assert!(parse_token(&json!({ "token": "😀".repeat(101) })).is_none());
        assert!(parse_token(&json!({ "token": 1 })).is_none());
    }
}
