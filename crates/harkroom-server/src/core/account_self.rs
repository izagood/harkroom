//! S5.4 AC1 — 내 상태 한 줄과 에이전트 PAT 세 줄. TS `routes/accountRoutes.ts` 의 `PUT /accounts/me/status`·
//! `GET`·`POST /accounts/:id/pats`·`DELETE /accounts/:id/pats/:label` 을 옮긴다.
//!
//! - 상태: `requireAccount`(401) → 본문(400 `invalid_request`) → 사람만(400 `invalid_account`) → 내 줄만 UPDATE →
//!   `status.changed` 이벤트(outbox). 계정 id 는 인증에서만 온다 — 남의 상태를 바꿀 길이 없다.
//! - PAT: `requireOwnerOrAdmin('id')`(TS `checkOwnerOrAdmin` = [`check_owner_or_admin`]) → 경로(400) → 에이전트인가(404,
//!   지운 에이전트도 대상) → 목록·410·폐기. **토큰·해시는 읽지도 주지도 않는다.** 발급은 닫혀 있다(410, TS 와 같다).
//! - 권한은 [`ACCOUNT_SELF_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
//! - 에이전트 관리·초대·handle·키·아바타는 TS 에 남긴다.
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 칸 권한으로 좁힌다(읽기는 역할의 SELECT).
/// 감사 줄(`audit_log` INSERT)은 이미 있는 쓰기 코어 권한이다.
pub const ACCOUNT_SELF_PRIVILEGES: &[(&str, &str)] = &[
    ("account.status", "UPDATE"),
    ("account.status_text", "UPDATE"),
    ("pat.revoked_at", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const ACCOUNT_SELF_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// `@harkroom/shared` `ACCOUNT_STATUSES`.
const STATUSES: &[&str] = &["available", "away", "dnd"];
/// zod `statusText: z.string().max(80)` — UTF-16 단위.
const STATUS_TEXT_MAX: usize = 80;
/// zod `label: z.string().min(1).max(64)` — UTF-16 단위.
const LABEL_MAX: usize = 64;

#[derive(Clone)]
pub struct AccountSelfState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
}

fn bad(what: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        &format!("{what}: invalid"),
    )
}
fn no_such_agent() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such agent")
}

/// 바꿀 상태 — `text` 가 None 이면 손대지 않음, Some(None) 이면 지우기(키 부재와 null 을 가른다).
#[derive(Debug, PartialEq)]
pub struct StatusBody {
    pub status: String,
    pub text: Option<Option<String>>,
}

/// zod `{ status: enum, statusText: string.max(80).nullable().optional() }` — 모르는 칸은 버린다(strict 아님).
pub fn parse_status(body: &Body) -> Option<StatusBody> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let status = m
        .get("status")?
        .as_str()
        .filter(|s| STATUSES.contains(s))?
        .to_string();
    let text = match m.get("statusText") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s.encode_utf16().count() <= STATUS_TEXT_MAX => {
            Some(Some(s.clone()))
        }
        Some(_) => return None,
    };
    Some(StatusBody { status, text })
}

/// 상태 UPDATE — 부재는 기존 값을 그대로 둔다(`$3::boolean` 플래그. coalesce 로 쓰면 null(지우기)이 부재와 같아진다).
const STATUS_UPDATE: &str = "update account \
       set status = $2, \
           status_text = case when $3::boolean then $4::text else status_text end \
     where id = $1::uuid \
     returning status, status_text";

pub async fn put_status(State(st): State<Arc<AccountSelfState>>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let Some(b) = parse_status(&body) else {
        return bad("body");
    };
    if me.kind != "human" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_account",
            "status is only for human accounts",
        );
    }
    match set_status(&st.write, &me, &b).await {
        Ok(v) => json_ok(v.to_string()),
        Err(e) => internal(e),
    }
}

/// UPDATE 와 이벤트를 한 트랜잭션에 — 이벤트만 빠지는 일이 없게.
async fn set_status(write: &PgPool, me: &Account, b: &StatusBody) -> sqlx::Result<Value> {
    let mut tx = write.begin().await?;
    let (status, text): (String, Option<String>) = sqlx::query_as(STATUS_UPDATE)
        .bind(&me.id)
        .bind(&b.status)
        .bind(b.text.is_some())
        .bind(b.text.clone().flatten())
        .fetch_one(&mut *tx)
        .await?;
    crate::write::emit_event(
        &mut tx,
        &json!({ "type": "status.changed", "accountId": me.id, "status": status, "statusText": text }),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({ "status": status, "statusText": text }))
}

/// TS `requireOwnerOrAdmin('id')` 다음 `z.string().uuid()` 다음 `isAgentTarget`(지운 에이전트 포함).
/// Ok(()) 면 지나간다. 순서가 TS 와 같아야 거절 갈래가 같다.
async fn gate(read: &PgPool, me: &Account, id: &str) -> Result<(), Response> {
    match check_owner_or_admin(read, me, id).await {
        Ok(Verdict::Owner | Verdict::Admin) => {}
        Ok(Verdict::Refused(s, c, m)) => return Err(json_err(s, c, m)),
        Err(e) => return Err(internal(e)),
    }
    if !crate::lists::is_zod_uuid(id) {
        return Err(bad("params"));
    }
    let agent: Result<Option<i32>, _> =
        sqlx::query_scalar("select 1 from account where id = $1::uuid and kind = 'agent'")
            .bind(id)
            .fetch_optional(read)
            .await;
    match agent {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(no_such_agent()),
        Err(e) => Err(internal(e)),
    }
}

/// 시각은 JS `Date#toJSON` 꼴(밀리초·Z).
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}
/// 라벨·시각만 — token_hash 칸은 고르지 않는다.
const PATS_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'label', label, ",
    "'createdAt', ",
    iso!("created_at"),
    ", 'revokedAt', ",
    iso!("revoked_at"),
    ", 'lastUsedAt', ",
    iso!("last_used_at"),
    ") order by created_at desc), '[]')::text ",
    "from pat where account_id = $1::uuid"
);

pub async fn list_pats(
    State(st): State<Arc<AccountSelfState>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = gate(&st.read, &me, &id).await {
        return r;
    }
    match sqlx::query_scalar::<_, String>(PATS_SQL)
        .bind(&id)
        .fetch_one(&st.read)
        .await
    {
        Ok(rows) => json_ok(format!("{{\"pats\":{rows}}}")),
        Err(e) => internal(e),
    }
}

/// 발급은 닫혔다(410) — 판정 순서만 TS 와 같게 거친다.
pub async fn issue_pat(
    State(st): State<Arc<AccountSelfState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), _) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if let Err(r) = gate(&st.read, &me, &id).await {
        return r;
    }
    json_err(
        StatusCode::GONE,
        "pat_issuance_closed",
        "agents authenticate through their operator; PATs are no longer issued",
    )
}

/// 라벨 단위 폐기 — 같은 라벨이 여럿이면 전부(하나 더 끊는 쪽이 안전하다, TS 주석).
pub async fn revoke_pat(
    State(st): State<Arc<AccountSelfState>>,
    Path((id, label)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_, RequireAccount(me, _), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if let Err(r) = gate(&st.read, &me, &id).await {
        return r;
    }
    let n = label.encode_utf16().count();
    if n == 0 || n > LABEL_MAX {
        return bad("params");
    }
    let revoked = match sqlx::query(
        "update pat set revoked_at = now() \
          where account_id = $1::uuid and label = $2 and revoked_at is null",
    )
    .bind(&id)
    .bind(&label)
    .execute(&st.write)
    .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => return internal(e),
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "pat.revoked",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({ "label": label, "revoked": revoked }),
        },
    )
    .await;
    json_ok(json!({ "revoked": revoked }).to_string())
}

pub fn routes(
    st: AccountSelfState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AccountSelfState>>::new()
        .put("/accounts/me/status", put_status)
        .get("/accounts/{id}/pats", list_pats)
        .post("/accounts/{id}/pats", issue_pat)
        .delete("/accounts/{id}/pats/{label}", revoke_pat)
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
    fn status_body_keeps_absent_and_null_apart() {
        assert_eq!(
            parse_status(&j(json!({"status": "away"}))),
            Some(StatusBody {
                status: "away".into(),
                text: None
            })
        );
        assert_eq!(
            parse_status(&j(json!({"status": "dnd", "statusText": null}))),
            Some(StatusBody {
                status: "dnd".into(),
                text: Some(None)
            })
        );
        assert_eq!(
            parse_status(&j(
                json!({"status": "available", "statusText": "점심", "x": 1})
            )),
            Some(StatusBody {
                status: "available".into(),
                text: Some(Some("점심".into()))
            })
        );
    }

    #[test]
    fn status_body_rejects() {
        assert_eq!(parse_status(&Body::None), None);
        assert_eq!(parse_status(&j(json!({"status": "busy"}))), None);
        assert_eq!(parse_status(&j(json!({"statusText": "x"}))), None);
        assert_eq!(
            parse_status(&j(json!({"status": "away", "statusText": 1}))),
            None
        );
        let long = "가".repeat(81);
        assert_eq!(
            parse_status(&j(json!({"status": "away", "statusText": long}))),
            None
        );
        let ok = "가".repeat(80);
        assert!(parse_status(&j(json!({"status": "away", "statusText": ok}))).is_some());
    }
}
