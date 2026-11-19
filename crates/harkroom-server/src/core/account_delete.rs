//! P4-5 — 사람이 자기 계정을 지운다. TS `routes/accountDeletionRoutes.ts` 의 `DELETE /accounts/me` 와
//! `services/accountDeletion.ts` 의 `deleteHumanAccount` 를 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAccount`(401) → 사람·세션이 아니면 403 `forbidden` → 본문 `{password: string 1..1024}`
//!   아니면 400 `invalid_request` → 시도 상한 `accountDelete:{id}`([`ACCOUNT_DELETE`]) 를 **검증 앞**에서 센다(429)
//!   → 비밀번호 확인(해시가 없거나 틀리면 401 `invalid_credentials`) → 한 트랜잭션(관리자 잠금·마지막 관리자 409 →
//!   내 행 잠금 → 주인인 에이전트가 있으면 409 `owns_agents` → 묘비 이름·이름·사진·로그인 id·비밀번호 지우기 → 푸시 기기·
//!   세션 지우기 → PAT 거두기 → 내 오퍼레이터의 배정 지우기·오퍼레이터 폐기 → 예약 글 취소 → 자동화 지우기 →
//!   API 연결·비밀 지우기) → 상한 비우기 → 폐기한 오퍼레이터 소켓 4401 로 끊기 + `operator.changed` → 사진 파일 정리
//!   → 감사 `account.deleted`(handle 없이) → 204.
//! - **오퍼레이터 소켓**: TS 는 같은 프로세스의 허브를 불러 끊는다. 오퍼레이터 코어가 Rust 로 온 뒤로는 TS 허브가 비어
//!   있어서 이 줄을 `operator_guard` 가 503 으로 막아 왔다. 이 줄은 오퍼레이터 코어와 **같은 허브**를 받아 직접 끊는다 —
//!   그래서 `main.rs` 는 오퍼레이터 코어 블록 안에서만 붙인다. `operator.changed` 는 outbox 로 내서 다른 프로세스도 본다.
//! - 시도 상한 카운터는 프로세스 로컬이다(TS 와 따로 센다). 이 줄을 Rust 가 받는 동안 TS 의 `accountDelete:*` 키는 쓰이지 않는다.
//! - 쓰기 권한은 [`ACCOUNT_DELETE_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄 대신 안전판(503)을 붙인다.
use super::attachment_store::LocalStorage;
use super::operator_hub::OperatorHub;
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err};
use crate::rate_limit::{self, RateLimiter, Rule};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, emit_event, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// TS `ACCOUNT_DELETE_RULE` — 15분에 10번.
pub const ACCOUNT_DELETE: Rule = Rule {
    window_ms: 15 * 60_000,
    max: 10,
};

/// TS `DELETED_DISPLAY_NAME`.
pub const DELETED_DISPLAY_NAME: &str = "Deleted user";

/// 쓰기 풀에 있어야 하는 권한 — homelab GRANT 와 같아야 한다.
pub const ACCOUNT_DELETE_PRIVILEGES: &[(&str, &str)] = &[
    // 비밀번호 확인·관리자 판정·내 행 잠금(`for update` 는 UPDATE 권한도 요구한다 — 아래 UPDATE 줄이 덮는다).
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.role", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("account.password_hash", "SELECT"),
    ("account.avatar_attachment_id", "SELECT"),
    ("account.avatar_source_attachment_id", "SELECT"),
    ("account.deleted_at", "UPDATE"),
    ("account.disabled_at", "UPDATE"),
    ("account.handle", "UPDATE"),
    ("account.display_name", "UPDATE"),
    ("account.avatar_attachment_id", "UPDATE"),
    ("account.avatar_source_attachment_id", "UPDATE"),
    ("account.avatar_crop", "UPDATE"),
    ("account.login_id", "UPDATE"),
    ("account.password_hash", "UPDATE"),
    // 주인인 에이전트.
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    // 묘비 이름(`free_deleted_handle`).
    ("agent_team.name", "SELECT"),
    ("handle_group.handle", "SELECT"),
    ("push_device", "DELETE"),
    ("push_device.account_id", "SELECT"),
    ("session", "DELETE"),
    ("session.account_id", "SELECT"),
    ("pat.account_id", "SELECT"),
    ("pat.revoked_at", "SELECT"),
    ("pat.label", "SELECT"),
    ("pat.revoked_at", "UPDATE"),
    ("agent_assignment", "DELETE"),
    ("agent_assignment.operator_id", "SELECT"),
    ("operator.id", "SELECT"),
    ("operator.owner_account_id", "SELECT"),
    ("operator.revoked_at", "SELECT"),
    ("operator.revoked_at", "UPDATE"),
    ("scheduled_message.author_id", "SELECT"),
    ("scheduled_message.sent_message_id", "SELECT"),
    ("scheduled_message.failed_reason", "SELECT"),
    ("scheduled_message.canceled_at", "SELECT"),
    ("scheduled_message.canceled_at", "UPDATE"),
    ("automation.owner_id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.deleted_at", "UPDATE"),
    ("automation.enabled", "UPDATE"),
    ("automation.ingress_token_hash", "UPDATE"),
    ("automation.ingress_secret_enc", "UPDATE"),
    ("api_connector", "DELETE"),
    ("api_connector.owner_account_id", "SELECT"),
    ("secret", "DELETE"),
    ("secret.owner_account_id", "SELECT"),
    // 옛 사진 정리(`release_files`) — 에이전트 지우기와 같은 묶음.
    ("attachment", "DELETE"),
    ("attachment.id", "SELECT"),
    ("attachment.message_id", "SELECT"),
    ("attachment.storage_key", "SELECT"),
    ("workspace_profile.icon_attachment_id", "SELECT"),
    ("artifact_version.attachment_id", "SELECT"),
    ("artifact_version.cover_attachment_id", "SELECT"),
    ("event_outbox", "INSERT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

pub struct AccountDeleteState {
    pub write: PgPool,
    pub storage: LocalStorage,
    pub trust: Arc<TrustProxy>,
    pub limiter: Arc<RateLimiter>,
    /// 오퍼레이터 코어의 허브 — 폐기한 오퍼레이터의 소켓을 끊는다.
    pub op_hub: OperatorHub,
}

/// zod `z.object({ password: z.string().min(1).max(1024) }).parse(req.body)`.
fn parse_password(body: Body) -> Option<String> {
    let Body::Json(Value::Object(mut m)) = body else {
        return None;
    };
    match m.remove("password") {
        Some(Value::String(p)) if (1..=1024).contains(&crate::writes_settings::js_len(&p)) => {
            Some(p)
        }
        _ => None,
    }
}

enum Outcome {
    Deleted {
        avatar_ids: Vec<Option<String>>,
        revoked_operator_ids: Vec<String>,
    },
    OwnsAgents(Vec<(String, String)>),
    LastAdmin,
}

/// 묘비 로그인 id — `deleted-` + 난수 16바이트 hex(TS 와 같은 꼴).
fn tombstone_login_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os random");
    format!(
        "{}{}",
        super::agent_delete::DELETED_HANDLE_PREFIX,
        hex::encode(b)
    )
}

/// `deleteHumanAccount`. 계정이 없으면(이미 지웠거나 사람이 아님) TS 처럼 오류(500)다.
async fn delete_human_account(pool: &PgPool, id: &str) -> Result<Outcome, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let role: Option<String> = sqlx::query_scalar(
        "select role from account where id = $1::uuid and kind = 'human' and deleted_at is null",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(role) = role else {
        return Err(sqlx::Error::RowNotFound);
    };
    if role == "owner" || role == "admin" {
        // 관리자 행을 내 행까지 한 쿼리로, id 순서로 잠근다(두 관리자가 동시에 지울 때 교착 대신 한쪽이 409).
        let admins: Vec<String> = sqlx::query_scalar(
            "select id::text from account \
              where kind = 'human' and role in ('owner', 'admin') and deleted_at is null and disabled_at is null \
              order by id for update",
        )
        .fetch_all(&mut *tx)
        .await?;
        if !admins.iter().any(|a| a != id) {
            tx.rollback().await?;
            return Ok(Outcome::LastAdmin);
        }
    }
    let me: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select a.avatar_attachment_id::text, a.avatar_source_attachment_id::text \
           from account a \
          where a.id = $1::uuid and a.deleted_at is null \
          for update of a",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((a, s)) = me else {
        return Err(sqlx::Error::RowNotFound);
    };
    let owned: Vec<(String, String)> = sqlx::query_as(
        "select a.id::text, a.handle from agent_config c join account a on a.id = c.account_id \
          where c.owner_account_id = $1::uuid and a.kind = 'agent' and a.deleted_at is null \
          order by a.handle",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    if !owned.is_empty() {
        tx.rollback().await?;
        return Ok(Outcome::OwnsAgents(owned));
    }
    let handle = super::agent_delete::free_deleted_handle(&mut tx, id).await?;
    sqlx::query(
        "update account \
            set deleted_at = now(), disabled_at = coalesce(disabled_at, now()), \
                handle = $2, display_name = $4, avatar_attachment_id = null, avatar_source_attachment_id = null, avatar_crop = null, \
                login_id = $3, password_hash = null \
          where id = $1::uuid",
    )
    .bind(id)
    .bind(&handle)
    .bind(tombstone_login_id())
    .bind(DELETED_DISPLAY_NAME)
    .execute(&mut *tx)
    .await?;
    for sql in [
        "delete from push_device where account_id = $1::uuid",
        "delete from session where account_id = $1::uuid",
        "update pat set revoked_at = now() where account_id = $1::uuid and revoked_at is null",
        "delete from agent_assignment where operator_id in (select id from operator where owner_account_id = $1::uuid)",
    ] {
        sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    }
    let revoked_operator_ids: Vec<String> = sqlx::query_scalar(
        "update operator set revoked_at = now() where owner_account_id = $1::uuid and revoked_at is null returning id::text",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for sql in [
        // 예약 글은 발송 때 작성자를 다시 보지 않는다 — 두면 지운 사람 이름으로 나간다.
        "update scheduled_message set canceled_at = now() \
          where author_id = $1::uuid and sent_message_id is null and failed_reason is null and canceled_at is null",
        // 수신 키를 남기면 webhook 이 run 을 계속 쌓는다.
        "update automation set deleted_at = now(), enabled = false, ingress_token_hash = null, ingress_secret_enc = null \
          where owner_id = $1::uuid and deleted_at is null",
        "delete from api_connector where owner_account_id = $1::uuid",
        "delete from secret where owner_account_id = $1::uuid",
    ] {
        sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Outcome::Deleted {
        avatar_ids: vec![a, s],
        revoked_operator_ids,
    })
}

/// `DELETE /accounts/me`.
pub async fn delete_me(State(st): State<Arc<AccountDeleteState>>, req: Request) -> Response {
    let (body, RequireAccount(me, auth), parts) =
        match crate::writes_settings::body_then::<RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only a signed-in person can delete their account",
        );
    }
    let Some(password) = parse_password(body) else {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid");
    };
    let key = format!("accountDelete:{}", me.id);
    let verdict = st.limiter.hit(&key, ACCOUNT_DELETE);
    if !verdict.allowed {
        return rate_limit::too_many(verdict, false);
    }
    let stored: Option<Option<String>> =
        match sqlx::query_scalar("select password_hash from account where id = $1::uuid")
            .bind(&me.id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    let ok = match stored.flatten().filter(|h| !h.is_empty()) {
        Some(h) => crate::password::verify_async(h, password).await,
        None => false,
    };
    if !ok {
        return json_err(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "wrong password",
        );
    }
    let (avatar_ids, revoked) = match delete_human_account(&st.write, &me.id).await {
        Ok(Outcome::Deleted {
            avatar_ids,
            revoked_operator_ids,
        }) => (avatar_ids, revoked_operator_ids),
        Ok(Outcome::OwnsAgents(agents)) => {
            let agents: Vec<Value> = agents
                .into_iter()
                .map(|(id, handle)| json!({ "id": id, "handle": handle }))
                .collect();
            return conflict(json!({
                "code": "owns_agents",
                "message": "transfer or delete the agents you own first",
                "agents": agents,
            }));
        }
        Ok(Outcome::LastAdmin) => {
            return conflict(json!({
                "code": "last_admin",
                "message": "make someone else an admin first",
            }));
        }
        Err(e) => return internal(e),
    };
    st.limiter.reset(&key);
    // 폐기한 오퍼레이터의 소켓을 끊는다 — 오퍼레이터 소켓은 붙을 때만 인증한다(`DELETE /operators/{id}` 와 같다).
    if !revoked.is_empty() {
        for operator_id in &revoked {
            st.op_hub.disconnect(operator_id, 4401, "operator revoked");
        }
        match st.write.acquire().await {
            Ok(mut conn) => {
                for operator_id in &revoked {
                    let ev = json!({ "type": "operator.changed", "operatorId": operator_id, "audience": "all" });
                    if let Err(e) = emit_event(&mut conn, &ev).await {
                        eprintln!(
                            "front: operator.changed event failed: {}",
                            e.as_database_error().map_or("io", |_| "db")
                        );
                    }
                }
            }
            Err(e) => eprintln!(
                "front: operator.changed event failed: {}",
                e.as_database_error().map_or("io", |_| "db")
            ),
        }
    }
    // 사진·원본은 아무도 안 쓰면 지운다(그 사람의 에이전트가 같은 첨부를 쓰면 남는다).
    super::avatar_write::release_files(&st.write, &st.storage, avatar_ids).await;
    // 옛 handle 은 남기지 않는다 — 감사는 id 로 가리킨다.
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action: "account.deleted",
            actor_id: Some(&me.id),
            actor_handle: None,
            target: None,
            ip: ip.as_deref(),
            detail: json!({}),
        },
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

fn conflict(error: Value) -> Response {
    (
        StatusCode::CONFLICT,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        json!({ "error": error }).to_string(),
    )
        .into_response()
}

pub fn routes(
    st: AccountDeleteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AccountDeleteState>>::new()
        .delete("/accounts/me", delete_me)
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
    fn password_shape_matches_zod() {
        let ok = |v: Value| parse_password(Body::Json(v));
        assert_eq!(ok(json!({"password": "x"})).as_deref(), Some("x"));
        assert!(ok(json!({"password": ""})).is_none());
        assert!(ok(json!({"password": "a".repeat(1025)})).is_none());
        assert!(ok(json!({"password": "a".repeat(1024)})).is_some());
        assert!(ok(json!({"password": 1})).is_none());
        assert!(ok(json!({})).is_none());
        assert!(parse_password(Body::None).is_none());
    }

    #[test]
    fn tombstone_login_id_shape() {
        let s = tombstone_login_id();
        assert!(s.starts_with("deleted-"));
        assert_eq!(s.len(), "deleted-".len() + 32);
    }

    #[test]
    fn rule_matches_ts() {
        assert_eq!(ACCOUNT_DELETE.window_ms, 15 * 60_000);
        assert_eq!(ACCOUNT_DELETE.max, 10);
    }

    #[test]
    fn privileges_cover_writes() {
        for p in [
            ("operator.revoked_at", "UPDATE"),
            ("session", "DELETE"),
            ("secret", "DELETE"),
            ("api_connector", "DELETE"),
            ("account.login_id", "UPDATE"),
            ("event_outbox", "INSERT"),
        ] {
            assert!(ACCOUNT_DELETE_PRIVILEGES.contains(&p), "{p:?}");
        }
    }
}
