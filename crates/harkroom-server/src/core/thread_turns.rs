//! R1 — 스레드에서 지금 도는 턴(살아 있음 신호)을 밖으로 내보낸다. 턴 단위다.
//!
//! 정본은 릴레이 세션 사본 `agent_session_live`([`super::relay_live`])다. 여기서는 그것을 두 길로 내보내기만 한다:
//! - **신호** `thread.turns.changed { channelId, rootId, audience }` — 그 스레드의 턴이 생기거나 사라졌다. 값은 싣지 않는다
//!   (`thread.reportWakes.changed` 와 같은 꼴). 받는 쪽은 아래 읽는 길로 다시 읽는다.
//! - **읽기** `GET /threads/{rootId}/turns` → `{ turns: [{ agentAccountId, startedAt }] }`. 살아 있는 허브의 행만 본다
//!   (`relay_hub.seen_at` 이 TTL 안 — 위임 기한 루프와 같은 조건).
//!
//! 규율:
//! - 싣는 칸은 에이전트 id 와 시작 시각뿐이다. 세션 id·기기·하네스·계정 순번은 내보내지 않는다.
//! - 판정에는 쓰지 않는다(스레드 상태·위임 기한은 그대로다). 보이기 위한 신호일 뿐이다.
//! - 서버가 비정상으로 죽어 허브 줄이 TTL 로 사라질 때는 신호가 없다 — 읽는 길이 정본이다.
use super::agent_wakes_read::{plain_err, report_head_sql};
use super::audience::audience_on;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_ok};
use axum::extract::State;
use axum::response::Response;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀에 있어야 하는 권한(가시성 술어가 읽는 표 포함). 없으면 `main.rs` 가 이 길만 띄우지 않는다.
pub const THREAD_TURNS_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_session_live", "SELECT"),
    ("relay_hub", "SELECT"),
    ("message", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
];

/// 신호를 쓰는 풀(오퍼레이터 쓰기 풀)에 있어야 하는 권한. 없으면 신호만 끈다 — 세션 사본·릴레이는 그대로 돈다.
pub const THREAD_TURNS_SIGNAL_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("event_outbox", "INSERT"),
];
pub const THREAD_TURNS_SIGNAL_SEQUENCE_PRIVILEGES: &[(&str, &str)] =
    &[("event_outbox_id_seq", "USAGE")];

/// 신호를 받을 자리 — (채널, 스레드 뿌리). 뿌리가 없는 세션(채널 최상위)은 신호를 내지 않는다.
pub type Spot = (String, String);

/// 겹치는 자리를 하나로 줄인다(들어온 순서 유지).
pub fn distinct(spots: Vec<Spot>) -> Vec<Spot> {
    let mut out: Vec<Spot> = Vec::with_capacity(spots.len());
    for s in spots {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// 자리마다 신호 한 줄을 outbox 에 넣는다. 한 트랜잭션이다 — 실패하면 아무것도 나가지 않는다.
pub async fn signal(pool: &PgPool, spots: &[Spot]) -> sqlx::Result<()> {
    if spots.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for (channel, root) in spots {
        let audience = audience_on(&mut tx, channel).await?.to_json();
        crate::write::emit_event(
            &mut tx,
            &json!({ "type": "thread.turns.changed", "channelId": channel, "rootId": root, "audience": audience }),
        )
        .await?;
    }
    tx.commit().await
}

/// 그 스레드에서 살아 있는 턴 목록($1 뿌리, $2 채널, $3 허브 TTL 초). 시작 시각 순, 모르는 시각은 뒤로.
const TURNS_SQL: &str = "select coalesce(json_agg(json_build_object('agentAccountId', x.agent_account_id, \
     'startedAt', case when x.started_at is null then null \
       else to_char(x.started_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') end) \
     order by x.started_at nulls last, x.session_id), '[]')::text \
     from (select l.agent_account_id, l.started_at, l.session_id from agent_session_live l \
       join relay_hub h on h.hub_epoch = l.hub_epoch \
      where l.thread_root_id = $1::uuid and l.channel_id = $2::uuid \
        and h.seen_at > now() - make_interval(secs => $3) limit 50) x";

/// `GET /threads/{rootId}/turns` — `report-wakes` 와 같은 판정: id 꼴이 아니면 404 → 머리 없음 404 → 안 보임 403 → `{turns}`.
pub async fn thread_turns(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _auth): RequireAccount,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Response {
    use axum::http::StatusCode;
    if !crate::core::msg_read::is_uuid(&root) {
        return plain_err(StatusCode::NOT_FOUND, "not_found");
    }
    let head: Option<(String, bool)> = match sqlx::query_as(report_head_sql())
        .bind(&root)
        .bind(&me.id)
        .fetch_optional(&*pool)
        .await
    {
        Ok(h) => h,
        Err(e) => return internal(e),
    };
    let Some((channel, visible)) = head else {
        return plain_err(StatusCode::NOT_FOUND, "not_found");
    };
    if !visible {
        return plain_err(StatusCode::FORBIDDEN, "forbidden");
    }
    match sqlx::query_scalar::<_, String>(TURNS_SQL)
        .bind(&root)
        .bind(&channel)
        .bind(super::relay_live::RELAY_HUB_TTL_SEC as f64)
        .fetch_one(&*pool)
        .await
    {
        Ok(t) => json_ok(format!("{{\"turns\":{t}}}")),
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
        .get("/threads/{rootId}/turns", thread_turns)
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
    fn distinct_keeps_first_of_each_spot() {
        let s = |c: &str, r: &str| (c.to_owned(), r.to_owned());
        assert_eq!(
            distinct(vec![s("c", "a"), s("c", "b"), s("c", "a"), s("d", "a")]),
            vec![s("c", "a"), s("c", "b"), s("d", "a")]
        );
    }

    /// 내보내는 칸은 에이전트 id 와 시작 시각뿐이다 — 세션 id 는 정렬에만 쓴다.
    #[test]
    fn turns_sql_exports_only_allowlisted_fields() {
        let built = TURNS_SQL
            .split("json_build_object(")
            .nth(1)
            .and_then(|s| s.split("order by").next())
            .unwrap();
        let keys: Vec<&str> = built
            .split('\'')
            .skip(1)
            .step_by(2)
            .filter(|k| k.chars().all(|c| c.is_ascii_alphabetic()) && !k.is_empty())
            .collect();
        assert_eq!(keys, ["agentAccountId", "startedAt", "UTC"]);
        assert!(
            TURNS_SQL.contains("h.seen_at > now()"),
            "죽은 허브의 행은 읽지 않는다"
        );
    }
}
