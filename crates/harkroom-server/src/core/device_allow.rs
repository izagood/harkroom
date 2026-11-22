//! 에이전트×기기 허용 표(H1) — 표 `agent_operator_allow`(migration 180). 「이 에이전트를 이 오퍼레이터에서 돌려도 된다」 한 쌍이 한 줄.
//!
//! - **기록만 한다.** 배정·러너 등록 판정은 여전히 `agent_assignment` 만 읽는다. 이 표는 배정을 따라 맞춰지는 사본이다.
//! - 맞추는 길은 [`sync`] 하나다 — 배정을 쓰는 곳(배정·해제·오퍼레이터 교체·에이전트/계정 지우기)이 **커밋 뒤에** 부른다. 요청 밖
//!   (`tokio::spawn`)에서 돌고 실패는 로그 한 줄로 삼킨다: 이 표가 없거나 권한이 빠져도 배정 자체는 그대로 된다.
//!   `sync` 는 「배정에 없는 줄을 지우고, 배정에 있는 줄을 넣는다」를 다시 해도 같은 결과로 하므로, 놓친 한 번은 다음 부름이나 기동 때 맞춰진다.
//! - 켜는 곳은 `main.rs` 한 군데([`enable`]) — 쓰기 풀에 [`DEVICE_ALLOW_PRIVILEGES`] 가 다 있을 때만. 오퍼레이터 코어 권한 묶음
//!   (`write::OPERATOR_PRIVILEGES`)에 넣지 않는다: 거기 넣으면 GRANT 가 늦을 때 오퍼레이터 표면 전체가 꺼진다.
//! - 개인 자격증명 에이전트는 소유자 자신의 기기만 유효하다 — 읽을 때 줄마다 판정한다([`LIST_SQL`] 의 `effective`).
use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

/// 이 기능이 쓰는 권한 — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 켜지 않는다(나머지는 그대로 돈다).
pub const DEVICE_ALLOW_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_operator_allow", "SELECT"),
    ("agent_operator_allow", "INSERT"),
    ("agent_operator_allow", "DELETE"),
];

static POOL: OnceLock<PgPool> = OnceLock::new();

/// 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 켜졌을 때의 풀. 안 켜졌으면 `None`.
pub fn pool() -> Option<&'static PgPool> {
    POOL.get()
}

/// 배정에 없는 줄을 지운다. `$1` 이 null 이면 표 전체, 아니면 그 에이전트의 줄만.
pub const PRUNE_SQL: &str = "delete from agent_operator_allow w \
     where ($1::uuid is null or w.agent_id = $1::uuid) \
       and not exists (select 1 from agent_assignment a where a.agent_id = w.agent_id and a.operator_id = w.operator_id)";
/// 배정에 있는 줄을 넣는다(있으면 그대로). 범위는 [`PRUNE_SQL`] 과 같다.
pub const FILL_SQL: &str = "insert into agent_operator_allow (agent_id, operator_id, added_by, added_at) \
     select a.agent_id, a.operator_id, a.assigned_by, a.assigned_at from agent_assignment a \
      where ($1::uuid is null or a.agent_id = $1::uuid) \
     on conflict do nothing";

/// 허용 표를 배정에 맞춘다 — `agent` 가 `None` 이면 전부. 두 문장은 한 트랜잭션이다.
pub async fn sync_with(pool: &PgPool, agent: Option<&str>) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(PRUNE_SQL).bind(agent).execute(&mut *tx).await?;
    sqlx::query(FILL_SQL).bind(agent).execute(&mut *tx).await?;
    tx.commit().await
}

/// best-effort 맞추기 — 기다리지 않는다. 켜지지 않았거나 런타임 밖이면 아무것도 안 한다. 배정을 쓴 트랜잭션이 **커밋된 뒤에** 부른다.
pub fn sync(agent: Option<&str>) {
    let Some(pool) = POOL.get() else { return };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let agent = agent.map(str::to_owned);
    rt.spawn(async move {
        if let Err(err) = sync_with(pool, agent.as_deref()).await {
            eprintln!(
                "front: device allow sync failed: {}",
                err.as_database_error().map_or("io", |_| "db")
            );
        }
    });
}

/// 한 에이전트의 허용 줄. `effective` 는 지금 그 줄이 유효한지 — 오퍼레이터가 회수되지 않았고, 개인 자격증명 에이전트면 그 기기의
/// 소유자가 에이전트 소유자와 같아야 한다.
pub const LIST_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(\
       'agentId', w.agent_id, 'operatorId', w.operator_id, 'addedBy', w.added_by, 'addedAt', ",
    crate::iso!("w.added_at"),
    ", 'effective', (o.revoked_at is null and (coalesce(c.credential_scope, 'none') <> 'personal' \
                     or c.owner_account_id = o.owner_account_id))\
     ) order by w.added_at, w.operator_id), '[]'::json)::text \
     from agent_operator_allow w \
     join operator o on o.id = w.operator_id \
     left join agent_config c on c.account_id = w.agent_id \
     where w.agent_id = $1::uuid"
);

pub async fn list(pool: &PgPool, agent_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let text: String = sqlx::query_scalar(LIST_SQL)
        .bind(agent_id)
        .fetch_one(pool)
        .await?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

/// `GET /accounts/agents/{id}/allowed-operators` — 관리자만(`RequireAdmin`). 기능이 안 켜졌으면(권한 없음) 옮기지 않은 줄처럼 404.
pub async fn list_route(
    _admin: crate::auth::RequireAdmin,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    let Some(pool) = pool() else {
        return crate::directory::json_err(StatusCode::NOT_FOUND, "not_found", "not found");
    };
    if !crate::lists::is_zod_uuid(&agent_id) {
        return crate::directory::json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "id: invalid",
        );
    }
    match list(pool, &agent_id).await {
        Ok(rows) => crate::directory::json_ok(serde_json::json!({ "allowed": rows }).to_string()),
        Err(e) => crate::directory::internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privileges_stay_out_of_the_operator_core_gate() {
        // 이 표의 GRANT 가 늦어도 오퍼레이터 코어는 떠야 한다.
        for (t, _) in crate::write::OPERATOR_PRIVILEGES {
            assert_ne!(*t, "agent_operator_allow");
        }
        assert!(
            DEVICE_ALLOW_PRIVILEGES
                .iter()
                .all(|(t, _)| *t == "agent_operator_allow")
        );
        assert!(DEVICE_ALLOW_PRIVILEGES.iter().all(|(_, p)| *p != "UPDATE"));
    }

    #[test]
    fn sync_without_enable_is_a_no_op() {
        // 켜지 않은 프로세스(권한 없음)에서는 아무 일도 하지 않는다 — 패닉도 없다.
        sync(None);
        sync(Some("00000000-0000-4000-8000-000000000001"));
    }
}
