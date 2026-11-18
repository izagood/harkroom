//! S5.4 — `GET /agent-wakes`(TS `agentRelayRoutes.ts`). 아직 오지 않은 깨움 목록 `{ wakes: [...] }`.
//!
//! - admin 은 전체, `?scope=visible`(admin 아님)은 채널 가시성(TS 골든 `channelVisibleSql`)으로, 그 외는 소유한 에이전트 것만.
//!   소유한 에이전트가 없으면 질의 없이 빈 목록.
//! - wake 메시지가 지워졌으면 `reason` 만 null(줄은 남긴다).
//! - **읽기만 한다.** 새 GRANT 없음 — 필요한 SELECT 는 [`AGENT_WAKES_READ_PRIVILEGES`], 없으면 `main.rs` 가 TS 에 남긴다.
use super::channels::{frag, rows_sql};
use super::relay_routes::{owned_agent_ids, wants_visible};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_ok};
use axum::extract::{RawQuery, State};
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

/// 읽기 풀에 있어야 하는 권한(가시성 술어가 읽는 표 포함).
pub const AGENT_WAKES_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_wake", "SELECT"),
    ("message", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("agent_config", "SELECT"),
];

const BASE: &str = "select w.id, w.account_id, w.channel_id, w.message_id, w.wake_at, \
     coalesce(m.thread_root_id, m.id) as thread_root_id, \
     case when m.deleted_at is null then m.body else null end as reason \
     from agent_wake w join message m on m.id = w.message_id join channel c on c.id = w.channel_id \
     where w.fired_at is null and w.canceled_at is null";

enum Scope {
    All,
    Owned,
    Visible,
}

fn sql(s: Scope) -> &'static str {
    static ALL: OnceLock<String> = OnceLock::new();
    static OWNED: OnceLock<String> = OnceLock::new();
    static VIS: OnceLock<String> = OnceLock::new();
    let build = |extra: String| {
        rows_sql(
            &format!("{BASE}{extra} order by w.wake_at limit 200"),
            &["wake_at"],
        )
    };
    match s {
        Scope::All => ALL.get_or_init(|| build(String::new())),
        Scope::Owned => OWNED.get_or_init(|| build(" and w.account_id = any($1::uuid[])".into())),
        Scope::Visible => {
            VIS.get_or_init(|| build(format!(" and {}", frag("channel_visible_c_p1uuid"))))
        }
    }
}

/// 행 → TS `AgentWakeView`(키 순서 그대로). serde_json 은 키를 정렬하므로 손으로 잇는다.
fn view(r: &Value) -> String {
    format!(
        "{{\"id\":{},\"agentAccountId\":{},\"channelId\":{},\"threadRootId\":{},\"messageId\":{},\"wakeAt\":{},\"reason\":{}}}",
        r["id"],
        r["account_id"],
        r["channel_id"],
        r["thread_root_id"],
        r["message_id"],
        r["wake_at"],
        r["reason"]
    )
}

pub async fn agent_wakes(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _auth): RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    let visible_only = wants_visible(raw.as_deref()) && !me.is_admin;
    let run = async {
        let text: String = if me.is_admin {
            sqlx::query_scalar(sql(Scope::All))
                .fetch_one(&*pool)
                .await?
        } else if visible_only {
            sqlx::query_scalar(sql(Scope::Visible))
                .bind(&me.id)
                .fetch_one(&*pool)
                .await?
        } else {
            let ids = owned_agent_ids(&pool, &me.id).await?;
            if ids.is_empty() {
                return Ok(None);
            }
            sqlx::query_scalar(sql(Scope::Owned))
                .bind(ids)
                .fetch_one(&*pool)
                .await?
        };
        Ok::<_, sqlx::Error>(Some(text))
    };
    let text = match run.await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let rows: Vec<Value> = text
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let wakes: Vec<String> = rows.iter().map(view).collect();
    json_ok(format!("{{\"wakes\":[{}]}}", wakes.join(",")))
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/agent-wakes", agent_wakes)
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
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn view_keys_in_ts_order() {
        let v = view(&json!({
            "id": "i", "account_id": "a", "channel_id": "c", "thread_root_id": "t",
            "message_id": "m", "wake_at": "2026-01-01T00:00:00.000Z", "reason": null
        }));
        assert_eq!(
            v,
            r#"{"id":"i","agentAccountId":"a","channelId":"c","threadRootId":"t","messageId":"m","wakeAt":"2026-01-01T00:00:00.000Z","reason":null}"#
        );
    }
}
