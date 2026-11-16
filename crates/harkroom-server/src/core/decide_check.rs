//! S5.3 C3b-3d — `GET /agents/{id}/decide-check`: 이 사람이 이 채널에서 이 에이전트의 권한·머지 카드를 정할 수 있나(버튼을 그릴지).
//! TS `permissionRequestRoutes.ts` 와 같은 응답 네 칸(`viewerCanDecide`·`asOwner`·`decideScope`·`ownerAccountId`)을 낸다.
//!
//! - **읽기만 한다.** 판정은 3a 코어의 같은 판정 SQL(골든 `decider_*`)을 **잠그지 않고** 돌린다([`may_decide_for_unlocked`]) —
//!   버튼을 그릴지 보는 값이고, 실제 결정 때 결정 길이 tx 안에서 잠그고 다시 판정한다. 읽기 풀만 쓰므로 새 GRANT 가 없다.
//! - S1(security): 없는 채널이면 누구에게도 false·null 이다(범위·소유자 id 를 주지 않는다).
//! - n6(security): 정할 수 없고 그 채널을 볼 수도 없으면 범위·소유자를 숨긴다.
//! - 버튼은 사람 세션만 누른다 — PAT·에이전트는 판정이 통과해도 `viewerCanDecide`·`asOwner` 가 false 다.
//! - 200 응답은 `cache-control: no-store`(TS 와 같이 400 에는 붙이지 않는다).
use super::decide_core::{DecideScope, Verdict, channel_visible_conn, may_decide_for_unlocked};
use super::decide_routes::human_session;
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{form_pairs, internal, json_err};
use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

const BAD_REQUEST: &str = "agent id and channelId must be uuids";

/// TS `z.object({ id: uuid, channelId: uuid }).safeParse({ ...params, ...query })` — 쿼리의 `id` 가 경로를 덮는 것까지 같다.
/// 같은 키가 둘이면(fastify 가 배열로 읽음) 400, 모르는 키는 버린다(strict 아님).
pub fn parse(path_id: &str, raw: Option<&str>) -> Option<(String, String)> {
    let mut id: Option<String> = None;
    let mut channel: Option<String> = None;
    let mut id_seen = 0;
    let mut ch_seen = 0;
    for (k, v) in form_pairs(raw.unwrap_or("")) {
        match k.as_str() {
            "id" => {
                id_seen += 1;
                id = Some(v);
            }
            "channelId" => {
                ch_seen += 1;
                channel = Some(v);
            }
            _ => {}
        }
    }
    if id_seen > 1 || ch_seen > 1 {
        return None;
    }
    let id = id.unwrap_or_else(|| path_id.to_owned());
    let channel = channel?;
    (is_uuid(&id) && is_uuid(&channel)).then_some((id, channel))
}

/// TS `DecideScope` 문자열.
pub fn scope_str(s: &DecideScope) -> &str {
    match s {
        DecideScope::Owner => "owner",
        DecideScope::List => "list",
        DecideScope::Channel => "channel",
        DecideScope::Community => "community",
        DecideScope::SwitchOff => "switchOff",
        DecideScope::Other(o) => o.as_str(),
    }
}

/// 응답 네 칸. `hidden` 이면 범위·소유자를 null 로(n6).
pub fn body(v: &Verdict, session: bool, hidden: bool) -> Value {
    let ok = v.ok.is_some();
    json!({
        "viewerCanDecide": session && ok,
        "asOwner": session && v.ok == Some(true),
        "decideScope": if hidden { None } else { v.scope.as_ref().map(scope_str) },
        "ownerAccountId": if hidden { None } else { v.owner.as_deref() },
    })
}

/// S1 — 없는 채널의 답.
pub fn absent() -> Value {
    json!({ "viewerCanDecide": false, "asOwner": false, "decideScope": null, "ownerAccountId": null })
}

fn ok_no_store(v: &Value) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        v.to_string(),
    )
        .into_response()
}

async fn check(
    pool: &PgPool,
    agent: &str,
    actor: &str,
    channel: &str,
    session: bool,
) -> sqlx::Result<Value> {
    let mut conn = pool.acquire().await?;
    let exists = sqlx::query("select 1 from channel where id = $1::uuid")
        .bind(channel)
        .fetch_optional(&mut *conn)
        .await?
        .is_some();
    if !exists {
        return Ok(absent());
    }
    let v = may_decide_for_unlocked(&mut conn, agent, actor, Some(channel)).await?;
    let hidden = v.ok.is_none() && !channel_visible_conn(&mut conn, channel, actor).await?;
    Ok(body(&v, session, hidden))
}

/// `GET /agents/{id}/decide-check?channelId=`.
pub async fn decide_check(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let Some((agent, channel)) = parse(&id, raw.as_deref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_REQUEST);
    };
    let session = human_session(&me, &auth);
    match check(&pool, &agent, &me.id, &channel, session).await {
        Ok(v) => ok_no_store(&v),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — 읽기 풀만 쓴다(`msg_read.rs` 와 같은 길: 인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/agents/{id}/decide-check", decide_check)
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

    const A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const C: &str = "1f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn parse_like_zod() {
        assert_eq!(
            parse(A, Some(&format!("channelId={C}"))),
            Some((A.into(), C.into()))
        );
        assert_eq!(parse(A, None), None, "channelId 없음");
        assert_eq!(parse(A, Some("channelId=x")), None);
        assert_eq!(parse("x", Some(&format!("channelId={C}"))), None);
        assert_eq!(
            parse(A, Some(&format!("channelId={C}&channelId={C}"))),
            None,
            "같은 키 둘"
        );
        assert_eq!(
            parse(A, Some(&format!("channelId={C}&extra=1"))),
            Some((A.into(), C.into())),
            "모르는 키는 버림"
        );
        // 쿼리 `id` 가 경로를 덮는다(TS `{ ...params, ...query }`).
        assert_eq!(
            parse("x", Some(&format!("id={A}&channelId={C}"))),
            Some((A.into(), C.into()))
        );
    }

    #[test]
    fn body_hides_and_needs_session() {
        let v = Verdict {
            ok: Some(true),
            owner: Some(A.into()),
            scope: Some(DecideScope::SwitchOff),
        };
        assert_eq!(
            body(&v, true, false),
            json!({"viewerCanDecide":true,"asOwner":true,"decideScope":"switchOff","ownerAccountId":A})
        );
        assert_eq!(
            body(&v, false, false),
            json!({"viewerCanDecide":false,"asOwner":false,"decideScope":"switchOff","ownerAccountId":A})
        );
        let no = Verdict {
            ok: None,
            owner: Some(A.into()),
            scope: Some(DecideScope::Channel),
        };
        assert_eq!(body(&no, true, true), absent());
        assert_eq!(body(&no, true, false)["decideScope"], "channel");
    }
}
