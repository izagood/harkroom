//! S5.4 TP4 — 스레드 계획 관리 에이전트 바꾸기 한 줄(+ `POST …/plan/start` 의 앞 거절들, [`post_start`]). TS `routes/threadPlanRoutes.ts` 의 `PUT /threads/:rootId/plan/manager` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 사람 **세션**만(403 `human_only`) → rootId 가 uuid 아님(404 `not_found`) →
//!   본문 zod `{ managerId: uuid | null }`(400 `invalid_request`) → `threadRootChannel`(404 `not_found`·`not_root`) →
//!   `channelPostGate` 가 보관(403 `channel_archived`) → `writeThreadPlan`(가시성 404 `forbidden`, 판 없음 404 `no_plan`,
//!   `invalid_manager` 400, 그 밖 409) → 200 `{ plan }`. 거절 몸통은 `{ "error": { code, …칸 } }`(TS `res.error` 그대로)다.
//! - 쓰기는 MCP 쓰기 경로([`super::mcp::plan_write::write_manager`])를 그대로 탄다 — 검증·이벤트(`thread.plan.changed`)가 같다.
//! - 관리자가 바뀌는데 자동 진행이 켜져 있으면 같은 tx 에서 끄고(TS `writeThreadPlan`), 커밋 뒤 끄기 알림
//!   (`noticePlanAutoOff(…, [나, 새 관리자, 앞 관리자], 'manager_changed')`)을 스레드에 올린다. 글 올리기·끄기 권한이 없어
//!   [`ManagerState::post`] 가 비었을 때만 되감고 TS 에 넘긴다.
//! - 권한은 MCP 계획 쓰기와 같다([`super::mcp::plan_write::PLAN_WRITE_PRIVILEGES`]) — `main.rs` 가 그것이 켜졌을 때만 붙인다.
use super::mcp::plan_write::{ManagerWrite, write_manager};
use super::msg_post::{gate_sql, to_ts};
use super::msg_read::channel_visible;
use super::thread_plan_read::{ROOT_SQL, plan_view_json};
use super::thread_plan_start::{handles_of, nothing_json, plan_routes, preview_json, start_req};
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Clone)]
pub struct ManagerState {
    /// MCP 계획 쓰기가 켜진 쓰기 풀 — 판정·쓰기·답 읽기를 다 여기서 한다.
    pub write: PgPool,
    pub up: Upstream,
    /// 자동 진행 끄기 알림을 올릴 글 경로 — 끄기 칸 권한([`super::thread_plan_auto_off::THREAD_PLAN_AUTO_OFF_PRIVILEGES`])과
    /// 글 올리기 권한이 다 있을 때만 있다. 없으면 그 갈래는 TS 에 남는다.
    pub post: Option<super::msg_post::PostState>,
}

const BODY_LIMIT: usize = 1024 * 1024;

fn code_err(status: StatusCode, code: &str) -> Response {
    err_fields(status, &format!("\"code\":{}", Value::from(code)))
}

fn err_fields(status: StatusCode, fields: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        format!("{{\"error\":{{{fields}}}}}"),
    )
        .into_response()
}

/// TS `HTTP_BY_CODE` — 없으면 409.
fn status_of(code: &str) -> StatusCode {
    match code {
        "not_found" | "not_root" | "forbidden" | "no_plan" => StatusCode::NOT_FOUND,
        "channel_archived" => StatusCode::FORBIDDEN,
        "invalid_manager" | "if_rev_required" => StatusCode::BAD_REQUEST,
        _ => StatusCode::CONFLICT,
    }
}

/// zod `{ managerId: z.string().uuid().nullable() }` — 모르는 칸은 버린다. `Some(None)` 은 비우기.
#[allow(clippy::option_option)]
fn parse_body(bytes: &[u8]) -> Option<Option<String>> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    match v.as_object()?.get("managerId")? {
        Value::Null => Some(None),
        Value::String(s) if crate::lists::is_zod_uuid(s) => Some(Some(s.clone())),
        _ => None,
    }
}

/// `PUT /threads/{rootId}/plan/manager`.
pub async fn put_manager(
    State(st): State<Arc<ManagerState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(root): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(bytes) = to_bytes(body, BODY_LIMIT).await else {
        return code_err(StatusCode::PAYLOAD_TOO_LARGE, "fst_err_ctp_body_too_large");
    };
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return code_err(StatusCode::FORBIDDEN, "human_only");
    }
    if !crate::lists::is_zod_uuid(&root) {
        return code_err(StatusCode::NOT_FOUND, "not_found");
    }
    let Some(manager) = parse_body(&bytes) else {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid");
    };
    let w = &st.write;
    let channel = match sqlx::query_as::<_, (String, bool)>(ROOT_SQL)
        .bind(&root)
        .fetch_optional(w)
        .await
    {
        Ok(Some((c, true))) => c,
        Ok(Some((_, false))) => return code_err(StatusCode::NOT_FOUND, "not_root"),
        Ok(None) => return code_err(StatusCode::NOT_FOUND, "not_found"),
        Err(e) => return internal(e),
    };
    match sqlx::query_as::<_, (bool, bool)>(gate_sql())
        .bind(&channel)
        .bind(&me.id)
        .fetch_optional(w)
        .await
    {
        Ok(Some((true, true))) => return code_err(StatusCode::FORBIDDEN, "channel_archived"),
        Ok(_) => {}
        Err(e) => return internal(e),
    }
    match channel_visible(w, &me.id, &channel).await {
        Ok(true) => {}
        Ok(false) => return code_err(StatusCode::NOT_FOUND, "forbidden"),
        Err(e) => return internal(e),
    }
    match write_manager(w, &me.id, &root, &channel, manager, st.post.is_some()).await {
        Ok(ManagerWrite::Written { auto_off: None }) => {}
        Ok(ManagerWrite::Written {
            auto_off: Some((next, prev)),
        }) => {
            if let Some(post) = &st.post {
                let authors = [Some(me.id.as_str()), next.as_deref(), prev.as_deref()];
                if let Err(e) = super::thread_plan_auto_off::notice_manager_changed(
                    post, &channel, &root, &authors,
                )
                .await
                {
                    return internal(e);
                }
            }
        }
        Ok(ManagerWrite::Refused { code, fields }) => return err_fields(status_of(code), &fields),
        Ok(ManagerWrite::Deleted) => return code_err(StatusCode::NOT_FOUND, "no_plan"),
        Ok(ManagerWrite::ToTs) => return to_ts(st.up.clone(), peer, parts, bytes).await,
        Err(e) => return internal(e),
    }
    match plan_view_json(w, &me.id, &root).await {
        Ok(body) => json_ok(body),
        Err(e) => internal(e),
    }
}

/// zod `startBody` 를 Rust 가 같은 판정으로 읽을 수 있는 꼴만 — `(dryRun, ifRev 있음)`. 애매하면 `None`(→ TS 가 판정한다).
fn parse_start(bytes: &[u8]) -> Option<(bool, bool)> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let o = v.as_object()?;
    let steps = o.get("steps")?.as_array()?;
    if steps.is_empty() || steps.len() > 40 {
        return None;
    }
    for st in steps {
        let so = st.as_object()?;
        let id = so.get("id")?.as_str()?;
        let digits = id.strip_prefix('s')?;
        if digits.is_empty()
            || digits.len() > 4
            || digits.starts_with('0')
            || !digits.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        match so.get("assigneeId") {
            None => {}
            Some(Value::String(a)) if crate::lists::is_zod_uuid(a) => {}
            Some(_) => return None,
        }
    }
    let dry = match o.get("dryRun") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    let if_rev = match o.get("ifRev") {
        None => false,
        Some(v) => {
            let n = v.as_i64()?;
            if !(1..=9_007_199_254_740_991).contains(&n) {
                return None;
            }
            true
        }
    };
    match o.get("locale") {
        None => {}
        Some(Value::String(l)) if l == "ko" || l == "en" => {}
        Some(_) => return None,
    }
    Some((dry, if_rev))
}

/// `POST /threads/{rootId}/plan/start` — TS `startPlanSteps` 의 앞 거절들(`human_only`·`not_found`·`if_rev_required`·
/// `not_root`·보기 404·`channel_archived`·`no_plan`·`plan_flagged`)만 Rust 가 답한다. 그 뒤(경로 정하기·미리보기·위임 글 올리기)와
/// zod 판정이 애매한 본문은 요청을 그대로 TS 에 넘긴다(TS 가 같은 판정을 처음부터 다시 돈다).
pub async fn post_start(
    State(st): State<Arc<ManagerState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(root): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(bytes) = to_bytes(body, BODY_LIMIT).await else {
        return code_err(StatusCode::PAYLOAD_TOO_LARGE, "fst_err_ctp_body_too_large");
    };
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return code_err(StatusCode::FORBIDDEN, "human_only");
    }
    if !crate::lists::is_zod_uuid(&root) {
        return code_err(StatusCode::NOT_FOUND, "not_found");
    }
    let Some((dry, if_rev)) = parse_start(&bytes) else {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    };
    if !dry && !if_rev {
        return code_err(StatusCode::BAD_REQUEST, "if_rev_required");
    }
    let w = &st.write;
    let channel = match sqlx::query_as::<_, (String, bool)>(ROOT_SQL)
        .bind(&root)
        .fetch_optional(w)
        .await
    {
        Ok(Some((c, true))) => c,
        Ok(Some((_, false))) => return code_err(StatusCode::NOT_FOUND, "not_root"),
        Ok(None) => return code_err(StatusCode::NOT_FOUND, "not_found"),
        Err(e) => return internal(e),
    };
    match sqlx::query_as::<_, (bool, bool)>(gate_sql())
        .bind(&channel)
        .bind(&me.id)
        .fetch_optional(w)
        .await
    {
        Ok(Some((false, _))) => return code_err(StatusCode::NOT_FOUND, "not_found"),
        Ok(Some((true, true))) => return code_err(StatusCode::FORBIDDEN, "channel_archived"),
        Ok(_) => {}
        Err(e) => return internal(e),
    }
    let (doc_text, rev) = match sqlx::query_as::<_, (Option<String>, String, i64)>(
        "select flag_reason, doc::text, rev::int8 from thread_plan where root_id = $1::uuid",
    )
    .bind(&root)
    .fetch_optional(w)
    .await
    {
        Ok(None) => return code_err(StatusCode::NOT_FOUND, "no_plan"),
        // TS `if (row.flagReason)` — 빈 글자는 걸리지 않은 것이다.
        Ok(Some((Some(f), _, _))) if !f.is_empty() => {
            return code_err(StatusCode::CONFLICT, "plan_flagged");
        }
        Ok(Some((_, d, r))) => (d, r),
        Err(e) => return internal(e),
    };
    // 미리보기와 「시작할 단계 없음」 거절은 Rust(TP5, `thread_plan_start.rs`), 실제 시작(쓰기·글)은 TS.
    let (Some(req), Ok(doc)) = (start_req(&bytes), serde_json::from_str::<Value>(&doc_text)) else {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    };
    let route = match plan_routes(w, &me.id, &channel, &doc, &req).await {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    if dry {
        return match handles_of(w, &route, &doc).await {
            Ok(h) => json_ok(preview_json(&route, &doc, rev, &h, req.en)),
            Err(e) => internal(e),
        };
    }
    if route.self_ids.is_empty() && route.posts.is_empty() {
        return (
            StatusCode::CONFLICT,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            nothing_json(&route),
        )
            .into_response();
    }
    to_ts(st.up.clone(), peer, parts, bytes).await
}

/// 코어 라우터에 합칠 줄 — 인증은 `route_layer`, CORS 는 `layer`. `POST …/plan/start` 는 앞 거절만 Rust, 나머지는 TS.
pub fn routes(
    st: ManagerState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ManagerState>>::new()
        .put("/threads/{rootId}/plan/manager", put_manager)
        .post("/threads/{rootId}/plan/start", post_start)
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

    const A: &str = "00000000-0000-4000-8000-00000000000a";

    #[test]
    fn body_like_zod() {
        assert_eq!(parse_body(br#"{"managerId":null}"#), Some(None));
        assert_eq!(
            parse_body(format!(r#"{{"managerId":"{A}","x":1}}"#).as_bytes()),
            Some(Some(A.to_owned()))
        );
        assert_eq!(parse_body(br#"{}"#), None);
        assert_eq!(parse_body(br#"{"managerId":"nope"}"#), None);
        assert_eq!(parse_body(br#"{"managerId":1}"#), None);
        assert_eq!(parse_body(b""), None);
        assert_eq!(parse_body(b"[]"), None);
    }

    #[test]
    fn status_like_ts_table() {
        assert_eq!(status_of("no_plan"), StatusCode::NOT_FOUND);
        assert_eq!(status_of("forbidden"), StatusCode::NOT_FOUND);
        assert_eq!(status_of("invalid_manager"), StatusCode::BAD_REQUEST);
        assert_eq!(status_of("channel_archived"), StatusCode::FORBIDDEN);
        assert_eq!(status_of("rev_conflict"), StatusCode::CONFLICT);
        assert_eq!(status_of("plan_too_large"), StatusCode::CONFLICT);
    }
}

#[cfg(test)]
mod start_tests {
    use super::parse_start;

    #[test]
    fn start_body_follows_zod() {
        assert_eq!(
            parse_start(br#"{"steps":[{"id":"s1"}],"ifRev":2}"#),
            Some((false, true))
        );
        assert_eq!(
            parse_start(br#"{"steps":[{"id":"s9999"}],"dryRun":true}"#),
            Some((true, false))
        );
        assert_eq!(
            parse_start(br#"{"steps":[{"id":"s1"}]}"#),
            Some((false, false))
        );
        assert!(parse_start(br#"{"steps":[]}"#).is_none());
        assert!(parse_start(br#"{"steps":[{"id":"s0"}]}"#).is_none());
        assert!(parse_start(br#"{"steps":[{"id":"s10000"}]}"#).is_none());
        assert!(parse_start(br#"{"steps":[{"id":"s1"}],"ifRev":0}"#).is_none());
        assert!(parse_start(br#"{"steps":[{"id":"s1"}],"locale":"fr"}"#).is_none());
        assert!(parse_start(br#"{"steps":[{"id":"s1","assigneeId":"x"}]}"#).is_none());
    }
}
