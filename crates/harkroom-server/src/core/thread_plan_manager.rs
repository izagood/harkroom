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
use super::mcp::plan_write::{ManagerWrite, write_custom, write_manager};
use super::msg_post::{gate_sql, to_ts};
use super::msg_read::channel_visible;
use super::thread_plan_read::{ROOT_SQL, plan_view_json};
use super::thread_plan_start::{
    Sent, StartReq, activate, bodies_after, finish, handles_of, nothing_json, plan_routes,
    preview_json, refused_json, started_full_json,
};
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err, json_ok};
use crate::proxy::Upstream;
use crate::write::{Body, fastify_body};
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
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

/// 올 수 없는 갈래 — 흔적을 남기고 500 `internal`(TS 오류 처리기와 같은 몸통).
fn broken(what: &str) -> Response {
    eprintln!("[threadPlanStart] {what}");
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
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

/// zod `z.number().int().min(1)` — 정수 값인 수(`2.0`·`1e2` 포함)만. i64 를 넘는 값은 어떤 판 번호와도 맞지 않으니 끝값으로 접는다.
fn zod_rev(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return (n >= 1).then_some(n);
    }
    if v.as_u64().is_some() {
        return Some(i64::MAX);
    }
    let f = v.as_f64()?;
    #[allow(clippy::cast_possible_truncation)] // 넘치면 끝값으로 접힌다(`as` 는 포화한다).
    (f.is_finite() && f >= 1.0 && f.fract() == 0.0).then_some(f as i64)
}

/// zod `startBody` 그대로 — 어긋나면 `None`(→ 400 `invalid_request`). 모르는 칸은 버리고, 겹친 단계 id 는 앞의 것만 남긴다(TS 라우트).
fn parse_start(v: &Value) -> Option<StartReq> {
    let o = v.as_object()?;
    let raw = o.get("steps")?.as_array()?;
    if raw.is_empty() || raw.len() > 40 {
        return None;
    }
    let mut steps: Vec<(String, Option<String>)> = Vec::new();
    for st in raw {
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
        let assignee = match so.get("assigneeId") {
            None => None,
            Some(Value::String(a)) if crate::lists::is_zod_uuid(a) => Some(a.clone()),
            Some(_) => return None,
        };
        if !steps.iter().any(|(x, _)| x == id) {
            steps.push((id.to_owned(), assignee));
        }
    }
    let dry = match o.get("dryRun") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    let if_rev = match o.get("ifRev") {
        None => None,
        Some(v) => Some(zod_rev(v)?),
    };
    let en = match o.get("locale") {
        None => false,
        Some(Value::String(l)) if l == "ko" || l == "en" => l == "en",
        Some(_) => return None,
    };
    Some(StartReq {
        steps,
        en,
        if_rev,
        dry,
    })
}

/// `POST /threads/{rootId}/plan/start` — TS `startPlanSteps` 의 앞 거절들(`human_only`·`not_found`·`if_rev_required`·
/// `not_root`·보기 404·`channel_archived`·`no_plan`·`plan_flagged`), 미리보기, 자기 단계만 시작(TP5b), 글을 올리는 시작(TP5c)을
/// Rust 가 답한다. 본문 판정(fastify 본문 규칙 → zod `startBody`, 400 `invalid_request`)도 Rust 다. 글 경로가 없는 글 올리기만
/// 요청을 그대로 TS 에 넘긴다.
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
    // fastify 는 본문을 인증·사람 판정보다 먼저 읽는다 — JSON 이 깨졌거나 매체가 틀리면 여기서 끝난다.
    let json = match fastify_body(&parts.headers, &bytes) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return code_err(StatusCode::FORBIDDEN, "human_only");
    }
    if !crate::lists::is_zod_uuid(&root) {
        return code_err(StatusCode::NOT_FOUND, "not_found");
    }
    let parsed = match &json {
        Body::Json(v) => parse_start(v),
        _ => None,
    };
    let Some(req) = parsed else {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid");
    };
    let dry = req.dry;
    if !dry && req.if_rev.is_none() {
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
    // jsonb 를 글자로 읽은 것이라 깨질 수 없다 — 깨졌으면 서버 쪽 고장이다.
    let Ok(doc) = serde_json::from_str::<Value>(&doc_text) else {
        return broken("plan doc is not json");
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
    // 보낼 글이 있는 꼴(다른 담당·관리자 부르기, TP5c)은 글 경로가 붙어 있을 때(`post`)만 Rust. 글은 TS 서비스 `postMessage` 와 같이
    // 라우트 몫(카드 고르기·카드 닫기)을 끈 채 올린다([`super::msg_post::Origin::service_call`]).
    let post_st = if route.posts.is_empty() {
        None
    } else {
        let Some(p) = st.post.as_ref() else {
            return to_ts(st.up.clone(), peer, parts, bytes).await;
        };
        Some(p)
    };
    // 실제 시작에는 꼭 있다(위에서 봤다).
    let Some(if_rev) = req.if_rev else {
        return code_err(StatusCode::BAD_REQUEST, "if_rev_required");
    };
    let handles = if post_st.is_some() {
        match handles_of(w, &route, &doc).await {
            Ok(h) => h,
            Err(e) => return internal(e),
        }
    } else {
        HashMap::new()
    };
    let map = match super::thread_plan_read::linked_map(w, &me.id, &doc).await {
        Ok(m) => m,
        Err(e) => return internal(e),
    };
    let wanted: Vec<String> = route
        .self_ids
        .iter()
        .cloned()
        .chain(route.posts.iter().flat_map(|p| p.2.iter().cloned()))
        .collect();
    type Out = (
        Vec<String>,
        Vec<(String, &'static str)>,
        Option<&'static str>,
        Value,
    );
    let out: Arc<std::sync::Mutex<Out>> = Arc::default();
    let f = {
        let out = out.clone();
        let (row_doc, ids, actor, picks) = (
            doc.clone(),
            wanted.clone(),
            me.id.clone(),
            route.picked.clone(),
        );
        Box::new(move |prev: Option<(&Value, i64)>| {
            let r = activate(prev, if_rev, &row_doc, &ids, &actor, &picks, &map);
            let mut o = out
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match r {
                Ok((next, ok, sk)) => {
                    *o = (ok, sk, None, next.clone());
                    Ok(next)
                }
                Err((code, sk)) => {
                    *o = (Vec::new(), sk, Some(code), Value::Null);
                    Err(code)
                }
            }
        })
    };
    let written = write_custom(w, &me.id, &root, &channel, f).await;
    let (activated, extra, _, active_doc) = std::mem::take(
        &mut *out
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    let mut skipped = route.skipped.clone();
    skipped.extend(extra);
    let mut rev = match written {
        Ok((ManagerWrite::Written { auto_off: None }, r)) => r.unwrap_or(rev),
        Ok((ManagerWrite::Refused { code, .. }, _)) if code == "nothing_to_start" => {
            let (c, fields) = refused_json(code, &skipped);
            return err_fields(status_of(c), &fields);
        }
        Ok((ManagerWrite::Refused { code, fields }, _)) => {
            return err_fields(status_of(code), &fields);
        }
        Ok((ManagerWrite::Deleted, _)) => return code_err(StatusCode::NOT_FOUND, "no_plan"),
        // 관리자를 바꾸지 않는 판이라 오지 않는다.
        Ok((ManagerWrite::Written { auto_off: Some(_) } | ManagerWrite::ToTs, _)) => {
            return broken("plan start changed the manager");
        }
        Err(e) => return internal(e),
    };
    let mut sent: Vec<Sent> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut not_notified: Vec<String> = Vec::new();
    if let Some(ps) = post_st {
        let posts = bodies_after(&route, &activated, &active_doc, &handles, req.en);
        match send_posts(ps, &channel, &me.id, &root, if_rev, &posts).await {
            Ok((s, f, n)) => (sent, failed, not_notified) = (s, f, n),
            Err(e) => return internal(e),
        }
        if !sent.is_empty() || !failed.is_empty() {
            let link_of: Vec<(String, String)> =
                sent.iter().map(|x| (x.0.clone(), x.3.clone())).collect();
            let (fl, before, activated_rev) = (failed.clone(), doc.clone(), rev);
            let f2 = Box::new(move |prev: Option<(&Value, i64)>| {
                finish(prev, activated_rev, &link_of, &fl, &before)
            });
            // TS 와 같이 마무리 쓰기가 실패해도 시작 답은 낸다(흔적만).
            match write_custom(w, &me.id, &root, &channel, f2).await {
                Ok((ManagerWrite::Written { .. }, Some(r))) => rev = r,
                Ok(_) => {}
                Err(e) => eprintln!("[threadPlanStart] 시작 뒤 판 쓰기 실패: {e}"),
            }
        }
    }
    match plan_view_json(w, &me.id, &root).await {
        Ok(view) => json_ok(started_full_json(
            rev,
            &route.self_ids,
            &activated,
            &sent,
            &skipped,
            &failed,
            &not_notified,
            route.manager_skipped,
            &view,
        )),
        Err(e) => internal(e),
    }
}

/// 시작 글들을 올린다(TS `postMessage(…, authVia: 'session')` 고리) — 글마다 따로 커밋한다. 실패한 글의 단계는 `failed`.
#[allow(clippy::type_complexity)]
async fn send_posts(
    ps: &super::msg_post::PostState,
    channel: &str,
    actor: &str,
    root: &str,
    start_rev: i64,
    posts: &[(String, bool, Vec<String>, String)],
) -> sqlx::Result<(Vec<Sent>, Vec<String>, Vec<String>)> {
    use super::msg_post::{Origin, Outcome, PostBody, channel_is_dm, post_in_tx};
    let (mut sent, mut failed, mut nn) = (Vec::new(), Vec::new(), Vec::new());
    if posts.is_empty() {
        return Ok((sent, failed, nn));
    }
    let audience = super::audience::audience_for(&ps.write, channel)
        .await?
        .to_json();
    let is_dm = channel_is_dm(&ps.write, channel).await?;
    for (to, manager, ids, body) in posts {
        let input = PostBody {
            body: body.clone(),
            attachment_ids: Vec::new(),
            thread_root: Some(root.to_owned()),
            also_in_channel: false,
        };
        let key = format!("plan-start:{root}:{to}:{start_rev}:{}", ids.join(","));
        let r = post_in_tx(
            ps,
            channel,
            actor,
            false,
            &input,
            Some(&key),
            &audience,
            is_dm,
            &Origin {
                service_call: true,
                ..Origin::default()
            },
        )
        .await;
        let mid = match r {
            Ok(Outcome::Posted { row, notified, .. }) => {
                if !notified.contains(to) {
                    nn.push(to.clone());
                }
                message_id(&row)
            }
            Ok(Outcome::Replayed(row)) => message_id(&row),
            Ok(_) => None,
            Err(e) => {
                eprintln!("[threadPlanStart] 시작 글 실패: {e}");
                None
            }
        };
        match mid {
            Some(m) => {
                for id in ids {
                    sent.push((id.clone(), *manager, to.clone(), m.clone()));
                }
            }
            None => failed.extend(ids.iter().cloned()),
        }
    }
    Ok((sent, failed, nn))
}

fn message_id(row: &str) -> Option<String> {
    let v: Value = serde_json::from_str(row).ok()?;
    v["id"].as_str().map(str::to_string)
}

/// 코어 라우터에 합칠 줄 — 인증은 `route_layer`, CORS 는 `layer`. `POST …/plan/start` 는 앞 거절·미리보기·실제 시작 모두 Rust(글 경로가 없을 때만 TS).
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
    use serde_json::json;

    const A: &str = "00000000-0000-4000-8000-00000000000a";

    #[test]
    fn start_body_follows_zod() {
        let r = parse_start(&json!({"steps":[{"id":"s1"}],"ifRev":2})).unwrap();
        assert_eq!((r.dry, r.if_rev, r.en), (false, Some(2), false));
        let r =
            parse_start(&json!({"steps":[{"id":"s9999"}],"dryRun":true,"locale":"en"})).unwrap();
        assert_eq!((r.dry, r.if_rev, r.en), (true, None, true));
        assert_eq!(
            parse_start(&json!({"steps":[{"id":"s1"}]})).unwrap().if_rev,
            None
        );
        for bad in [
            json!({}),
            json!([]),
            json!("x"),
            json!({"steps":[]}),
            json!({"steps":[{"id":"s0"}]}),
            json!({"steps":[{"id":"s10000"}]}),
            json!({"steps":[{"id":1}]}),
            json!({"steps":["s1"]}),
            json!({"steps":[{"id":"s1"}],"ifRev":0}),
            json!({"steps":[{"id":"s1"}],"ifRev":1.5}),
            json!({"steps":[{"id":"s1"}],"ifRev":"1"}),
            json!({"steps":[{"id":"s1"}],"ifRev":null}),
            json!({"steps":[{"id":"s1"}],"dryRun":null}),
            json!({"steps":[{"id":"s1"}],"dryRun":"true"}),
            json!({"steps":[{"id":"s1"}],"locale":"fr"}),
            json!({"steps":[{"id":"s1","assigneeId":"x"}]}),
            json!({"steps":[{"id":"s1","assigneeId":null}]}),
        ] {
            assert!(parse_start(&bad).is_none(), "{bad}");
        }
        let many: Vec<_> = (1..=41).map(|n| json!({"id": format!("s{n}")})).collect();
        assert!(parse_start(&json!({ "steps": many })).is_none());
    }

    /// zod `.int()` 는 정수 **값**을 본다 — `2.0`·`1e2` 도 통과한다. 예전에는 이 꼴을 TS 로 넘겼다.
    #[test]
    fn if_rev_takes_integer_valued_numbers() {
        let rev = |s: &str| {
            let v: serde_json::Value =
                serde_json::from_str(&format!(r#"{{"steps":[{{"id":"s1"}}],"ifRev":{s}}}"#))
                    .unwrap();
            parse_start(&v).map(|r| r.if_rev)
        };
        assert_eq!(rev("2.0"), Some(Some(2)));
        assert_eq!(rev("1e2"), Some(Some(100)));
        assert_eq!(rev("18446744073709551615"), Some(Some(i64::MAX)));
        assert_eq!(rev("1e30"), Some(Some(i64::MAX)));
        assert_eq!(rev("-1"), None);
        assert_eq!(rev("0.5"), None);
    }

    /// 겹친 단계 id 는 앞의 것만(TS 라우트의 `seen`), 모르는 칸은 버린다.
    #[test]
    fn dedupes_steps_and_drops_unknown_keys() {
        let r = parse_start(&json!({
            "steps":[{"id":"s2","assigneeId":A,"x":1},{"id":"s1"},{"id":"s2"}],
            "dryRun":true,"zzz":[1]
        }))
        .unwrap();
        assert_eq!(
            r.steps,
            vec![
                ("s2".to_owned(), Some(A.to_owned())),
                ("s1".to_owned(), None)
            ]
        );
    }
}
