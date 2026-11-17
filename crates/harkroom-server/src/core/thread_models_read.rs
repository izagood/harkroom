//! S5.4 TM1 — 스레드 × 에이전트 모델 지정 읽기 한 줄. TS `routes/threadAgentModelRoutes.ts` 의
//! `GET /channels/:id/threads/:rootId/agent-models` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 경로 두 id(400 `invalid_request`) → `assertChannelVisible`(403 `forbidden`)
//!   → `isChannelRoot`(404 `not_a_root`) → `listThreadAgentModels`. 사람·에이전트 누구나 읽는다(TS 도 막지 않는다).
//! - **루트를 이 채널에 묶는다**(TS 의 security 검토 ①). 볼 수 있는 채널 A 의 경로에 비공개 채널 B 의 rootId 를 넣어도
//!   B 스레드의 지정은 나오지 않는다. 답글 id·지운 글도 루트가 아니다.
//! - 답 칸은 TS `COLS` + `normalize` 그대로다 — `setAt` 은 `toISOString()` 꼴(밀리초·Z), 순서는 `set_at`.
//! - 읽기 풀만 쓴다. 읽기 역할에 [`THREAD_MODELS_READ_PRIVILEGES`] 의 SELECT 가 다 있을 때만 `main.rs` 가 붙인다 — 없으면 TS 에 남는다.
//! - `PUT`·`DELETE …/agent-models/:agentId` 는 TS 에 남긴다: 시스템 줄을 쓰고(`announceChange` → `postMessage`)
//!   `thread.agent_model.changed` 이벤트·감사 줄을 내며, 정하기는 오퍼레이터 허브의 하네스 목록(`checkOffered`)을 본다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 역할이 이 줄에 필요한 SELECT. 채널 가시성(`channel`·`channel_member`)과 루트 판정(`message`), 지정(`thread_agent_model`)과
/// 지금 하네스(`agent_config`).
pub const THREAD_MODELS_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("thread_agent_model", "SELECT"),
    ("agent_config", "SELECT"),
];

/// TS `isChannelRoot` — 이 채널의 살아 있는 **최상위** 글인가.
const ROOT_SQL: &str = "select 1 from message where id = $1::uuid and channel_id = $2::uuid \
     and thread_root_id is null and deleted_at is null";

/// TS `listThreadAgentModels` — `COLS`·`FROM`·`order by t.set_at`, 그리고 `normalize`(setAt → `toISOString()` 꼴).
/// 칸 순서는 TS 행 + 스프레드 순서 그대로.
const LIST_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(",
    "'threadRootId', t.thread_root_id, 'agentId', t.agent_id, 'harness', t.harness, ",
    "'model', t.model, 'effort', t.effort, 'setBy', t.set_by, 'setByKind', t.set_by_kind, ",
    "'setAt', to_char(t.set_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), ",
    "'currentHarness', coalesce(c.harness, 'claude-code'), ",
    "'stale', (t.harness is distinct from coalesce(c.harness, 'claude-code'))",
    ") order by t.set_at), '[]')::text ",
    "from thread_agent_model t left join agent_config c on c.account_id = t.agent_id ",
    "where t.thread_root_id = $1::uuid"
);

/// `GET /channels/{id}/threads/{rootId}/agent-models`.
pub async fn list_thread_agent_models(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, root_id)): Path<(String, String)>,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) || !crate::lists::is_zod_uuid(&root_id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    match super::channels::visible(read.as_ref(), &me.id, &id).await {
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
    match sqlx::query_scalar::<_, i32>(ROOT_SQL)
        .bind(&root_id)
        .bind(&id)
        .fetch_optional(read.as_ref())
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            return json_err(
                StatusCode::NOT_FOUND,
                "not_a_root",
                "그 채널의 최상위 글이 아니다",
            );
        }
        Err(e) => return internal(e),
    }
    match sqlx::query_scalar::<_, String>(LIST_SQL)
        .bind(&root_id)
        .fetch_one(read.as_ref())
        .await
    {
        Ok(rows) => json_ok(format!("{{\"agentModels\":{rows}}}")),
        Err(e) => internal(e),
    }
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get(
            "/channels/{id}/threads/{rootId}/agent-models",
            list_thread_agent_models,
        )
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

    #[test]
    fn list_normalizes_set_at_like_to_iso_string() {
        // TS `normalize` — `new Date(setAt).toISOString()`: UTC, 밀리초 세 자리, 끝 Z.
        assert!(
            LIST_SQL.contains(
                "to_char(t.set_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
            )
        );
        assert!(LIST_SQL.contains("order by t.set_at)"));
        assert!(LIST_SQL.contains("'[]'"), "빈 스레드는 빈 배열");
    }

    #[test]
    fn list_is_scoped_to_one_root_and_mirrors_ts_cols() {
        assert!(LIST_SQL.ends_with("where t.thread_root_id = $1::uuid"));
        for k in [
            "'threadRootId'",
            "'agentId'",
            "'harness'",
            "'model'",
            "'effort'",
            "'setBy'",
            "'setByKind'",
            "'setAt'",
            "'currentHarness'",
            "'stale'",
        ] {
            assert!(LIST_SQL.contains(k), "{k}");
        }
        assert!(
            LIST_SQL.contains("(t.harness is distinct from coalesce(c.harness, 'claude-code'))")
        );
    }

    #[test]
    fn root_check_binds_channel_and_excludes_replies_and_deleted() {
        assert!(ROOT_SQL.contains("channel_id = $2::uuid"));
        assert!(ROOT_SQL.contains("thread_root_id is null"));
        assert!(ROOT_SQL.contains("deleted_at is null"));
    }

    #[test]
    fn privileges_cover_every_table_read() {
        for t in ["thread_agent_model", "agent_config"] {
            assert!(LIST_SQL.contains(t));
        }
        assert!(ROOT_SQL.contains("from message"));
        let tables: Vec<_> = THREAD_MODELS_READ_PRIVILEGES
            .iter()
            .map(|(t, _)| *t)
            .collect();
        for t in [
            "channel",
            "channel_member",
            "message",
            "thread_agent_model",
            "agent_config",
        ] {
            assert!(tables.contains(&t), "{t}");
        }
        assert!(
            THREAD_MODELS_READ_PRIVILEGES
                .iter()
                .all(|(_, p)| *p == "SELECT")
        );
    }

    #[test]
    fn param_check_matches_zod_uuid() {
        assert!(crate::lists::is_zod_uuid(
            "00000000-0000-4000-8000-000000000999"
        ));
        assert!(!crate::lists::is_zod_uuid("nope"));
        assert!(!crate::lists::is_zod_uuid(
            "00000000-0000-4000-8000-00000000099"
        ));
    }
}
