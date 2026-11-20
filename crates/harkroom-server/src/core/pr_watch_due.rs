//! S5.4 — `GET /agent/pr-watches/due`(TS `mergeRoutes.ts` → `dueWatches`). 오퍼레이터를 거친 에이전트가 구독한, 폴링할 때가 된 열린
//! 감시 `{ watches: [{ id, repo, number, head, until }] }`.
//!
//! - 위임 v2 스위치(`HARKROOM_DELEGATION_V2`)가 꺼져 있으면 빈 목록. TS 처럼 부를 때마다 읽는다. 값이 **없는** 채로 뜬 서버는
//!   이 라우트를 붙이지 않는다(`main.rs`) — 앞단에 변수가 빠져 두 서버가 다르게 구는 일을 막는다(`msg_post::delegation_v2`).
//! - 고르기 전에 만료된 감시를 닫는다(TS `expireWatches`). 그래서 **쓰기 풀**이 필요하다 — [`PR_WATCH_DUE_PRIVILEGES`] 가 다 있어야
//!   켠다(fail-closed). 새 운영 GRANT: `grant update (state, ended_at) on pr_watch`.
//! - TS 의 `now`(JS `new Date()`)는 DB `now()` 로 본다. 403 에는 `cache-control` 이 없고 200 에만 `no-store`.
use super::grant_reads::through_operator;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 권한.
pub const PR_WATCH_DUE_PRIVILEGES: &[(&str, &str)] = &[
    ("pr_watch", "SELECT"),
    ("pr_watch.state", "UPDATE"),
    ("pr_watch.ended_at", "UPDATE"),
    ("pr_watch_subscriber", "SELECT"),
];

/// TS `PR_WATCH_POLL_SEC`.
const PR_WATCH_POLL_SEC: i32 = 60;

const EXPIRE_SQL: &str = "update pr_watch set state = 'expired', ended_at = now() where state = 'open' and expires_at <= now()";

const DUE_SQL: &str = "select w.id::text, w.repo, w.number, w.head, w.until from pr_watch w \
     where w.state = 'open' and (w.last_polled_at is null or w.last_polled_at <= now() - make_interval(secs => $2)) \
       and exists (select 1 from pr_watch_subscriber s where s.watch_id = w.id and s.account_id = $1::uuid) \
     order by w.last_polled_at nulls first limit 20";

type Row = (String, String, i32, String, String);

/// TS `DueWatch` 키 순서 그대로.
fn view((id, repo, number, head, until): &Row) -> String {
    format!(
        "{{\"id\":{},\"repo\":{},\"number\":{number},\"head\":{},\"until\":{}}}",
        Value::from(id.as_str()),
        Value::from(repo.as_str()),
        Value::from(head.as_str()),
        Value::from(until.as_str())
    )
}

fn v2_on() -> bool {
    crate::core::msg_post::delegation_v2(crate::env_once::get(&crate::env_once::DELEGATION_V2))
        .unwrap_or(false)
}

pub async fn due(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
) -> Response {
    if !through_operator(&me, &auth) {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only an agent through its operator can do this",
        );
    }
    let rows: Vec<Row> = if v2_on() {
        let run = async {
            sqlx::query(EXPIRE_SQL).execute(&*pool).await?;
            sqlx::query_as(DUE_SQL)
                .bind(&me.id)
                .bind(PR_WATCH_POLL_SEC - 5)
                .fetch_all(&*pool)
                .await
        };
        match run.await {
            Ok(r) => r,
            Err(e) => return internal(e),
        }
    } else {
        Vec::new()
    };
    let items: Vec<String> = rows.iter().map(view).collect();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        format!("{{\"watches\":[{}]}}", items.join(",")),
    )
        .into_response()
}

pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/agent/pr-watches/due", due)
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
        router: t.router.with_state(Arc::new(write)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_keys_in_ts_order() {
        let r: Row = ("i".into(), "o/r".into(), 7, "abc".into(), "merged".into());
        assert_eq!(
            view(&r),
            r#"{"id":"i","repo":"o/r","number":7,"head":"abc","until":"merged"}"#
        );
    }
}
