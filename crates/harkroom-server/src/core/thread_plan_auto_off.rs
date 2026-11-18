//! S5.4 TP3 — 스레드 계획 자동 진행 끄기 한 줄. TS `routes/threadPlanRoutes.ts` 의 `DELETE /threads/:rootId/plan/auto` 와
//! `services/threadPlanAuto.ts` 의 `clearPlanAuto`(사람 갈래)·`notice` 를 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 사람 **세션**만(403 `human_only`) → rootId 가 uuid 아님(404 `not_found`) →
//!   `threadRootChannel`(404 `not_found`·`not_root`) → `assertChannelVisible`(404 `not_found`) → 잠그고 끄기(계획 없음 404 `no_plan`)
//!   → 바뀌었을 때만 `thread.plan.changed`(청중 맵 진행률) → 스레드 안 시스템 줄(`▶ 자동 진행 꺼짐`, 부르지 않는다) → 200 `{ plan }`.
//!   거절 몸통은 `{ "error": { "code": … } }` 이다. 감사는 없다(TS 도 없다).
//! - 이미 꺼져 있으면 아무것도 바꾸지 않고 이벤트·줄 없이 지금 판을 돌려준다(TS `changed: false`).
//! - 권한은 [`THREAD_PLAN_AUTO_OFF_PRIVILEGES`] 와 글 올리기 권한 — 둘 다 있어야 `main.rs` 가 붙인다(없으면 TS 에 남는다).
use super::audience::audience_for;
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, post_in_tx};
use super::msg_read::channel_visible;
use super::thread_plan_read::{ROOT_SQL, plan_view_json};
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_ok};
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// 이 줄이 글 올리기 권한([`super::msg_post::MESSAGE_POST_PRIVILEGES`]) 위에 쓰는 권한 — homelab GRANT 와 같아야 한다.
/// `thread_plan` 은 칸 권한으로 본다(읽는 칸 SELECT, 끄는 칸 UPDATE). 답(`plan_view_json`)·이벤트 진행률도 쓰기 풀에서 읽는다.
pub const THREAD_PLAN_AUTO_OFF_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("thread_plan.root_id", "SELECT"),
    ("thread_plan.channel_id", "SELECT"),
    ("thread_plan.doc", "SELECT"),
    ("thread_plan.rev", "SELECT"),
    ("thread_plan.updated_at", "SELECT"),
    ("thread_plan.updated_by", "SELECT"),
    ("thread_plan.flag_reason", "SELECT"),
    ("thread_plan.auto_until", "SELECT"),
    ("thread_plan.auto_source", "SELECT"),
    ("thread_plan.auto_by", "SELECT"),
    ("thread_plan.auto_at", "SELECT"),
    ("thread_plan.auto_until", "UPDATE"),
    ("thread_plan.auto_source", "UPDATE"),
    ("thread_plan.auto_by", "UPDATE"),
    ("thread_plan.auto_mandate", "UPDATE"),
    ("thread_plan.auto_at", "UPDATE"),
    ("thread_plan.auto_woken", "UPDATE"),
    ("thread_plan.auto_range", "UPDATE"),
    ("thread_plan.rev", "UPDATE"),
    ("thread_plan.updated_at", "UPDATE"),
    ("event_outbox", "INSERT"),
];

#[derive(Clone)]
pub struct AutoOffState {
    /// 시스템 줄을 올리는 글 경로의 상태 — 판정·쓰기·답 읽기는 그 쓰기 풀(`post.write`)에서 한다.
    pub post: PostState,
}

/// TS `select doc, auto_until from thread_plan where root_id = $1 for update`.
const LOCK_SQL: &str =
    "select (auto_until is not null) from thread_plan where root_id = $1::uuid for update";
/// TS `clearPlanAuto` 의 끄기.
const OFF_SQL: &str = "update thread_plan \
     set auto_until = null, auto_source = null, auto_by = null, auto_mandate = null, auto_at = null, \
         auto_woken = '{}'::jsonb, auto_range = '{}'::jsonb, \
         rev = rev + 1, updated_at = greatest(now(), updated_at + interval '1 millisecond') \
     where root_id = $1::uuid returning channel_id::text, rev::int8, doc::text";

const BODY_LIMIT: usize = 1024 * 1024;

/// TS 거절 몸통 `{ error: { code } }`.
fn code_err(status: StatusCode, code: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        format!(r#"{{"error":{{"code":"{code}"}}}}"#),
    )
        .into_response()
}

/// TS `notice(…, '▶ 자동 진행 꺼짐', { planAutoState, i18n })`(사람 갈래).
fn off_line(actor: &str) -> (String, Map<String, Value>) {
    let mut meta = Map::new();
    meta.insert(
        "planAutoState".into(),
        json!({ "on": false, "reason": "human" }),
    );
    meta.insert(
        "i18n".into(),
        json!({ "key": "system.plan.autoOffHuman", "args": { "accountId": actor } }),
    );
    ("▶ 자동 진행 꺼짐".to_owned(), meta)
}

/// `DELETE /threads/{rootId}/plan/auto`.
pub async fn auto_off(
    State(st): State<Arc<AutoOffState>>,
    RequireAccount(me, auth): RequireAccount,
    Path(root): Path<String>,
    req: Request,
) -> Response {
    let (_, body) = req.into_parts();
    let Ok(_) = to_bytes(body, BODY_LIMIT).await else {
        return code_err(StatusCode::PAYLOAD_TOO_LARGE, "fst_err_ctp_body_too_large");
    };
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return code_err(StatusCode::FORBIDDEN, "human_only");
    }
    if !crate::lists::is_zod_uuid(&root) {
        return code_err(StatusCode::NOT_FOUND, "not_found");
    }
    let w = &st.post.write;
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
    match channel_visible(w, &me.id, &channel).await {
        Ok(true) => {}
        Ok(false) => return code_err(StatusCode::NOT_FOUND, "not_found"),
        Err(e) => return internal(e),
    }
    match switch_off(w, &root, &me.id).await {
        Ok(Some(true)) => {
            if let Err(e) = announce(&st.post, &channel, &root, &me.id).await {
                return internal(e);
            }
        }
        Ok(Some(false)) => {}
        Ok(None) => return code_err(StatusCode::NOT_FOUND, "no_plan"),
        Err(e) => return internal(e),
    }
    match plan_view_json(w, &me.id, &root).await {
        Ok(body) => json_ok(body),
        Err(e) => internal(e),
    }
}

/// TS `clearPlanAuto` 의 tx — 없으면 `None`, 켜져 있어 껐으면 `Some(true)`. 끈 판의 `thread.plan.changed` 는 같은 tx 의 outbox 로 낸다
/// (TS `emitPlanChanged` — 청중 맵 진행률).
async fn switch_off(w: &sqlx::PgPool, root: &str, actor: &str) -> sqlx::Result<Option<bool>> {
    let mut tx = w.begin().await?;
    let on: Option<bool> = sqlx::query_scalar(LOCK_SQL)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(on) = on else {
        tx.rollback().await?;
        return Ok(None);
    };
    if !on {
        tx.commit().await?;
        return Ok(Some(false));
    }
    let (channel, rev, doc): (String, i64, String) = sqlx::query_as(OFF_SQL)
        .bind(root)
        .fetch_one(&mut *tx)
        .await?;
    let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
    super::mcp::plan_write::emit_changed(&mut tx, &channel, root, rev, &doc, actor).await?;
    tx.commit().await?;
    Ok(Some(true))
}

/// TS `noticePlanAutoOff(pool, row, authors, 'manager_changed')` — 채널을 볼 수 있는 첫 사람 이름으로 한 줄. 아무도 못 보면 줄 없이 지나간다.
pub(crate) async fn notice_manager_changed(
    st: &PostState,
    channel: &str,
    root: &str,
    authors: &[Option<&str>],
) -> sqlx::Result<()> {
    for a in authors.iter().flatten() {
        if channel_visible(&st.write, a, channel).await? {
            let mut meta = Map::new();
            meta.insert(
                "planAutoState".into(),
                json!({ "on": false, "reason": "manager_changed" }),
            );
            meta.insert(
                "i18n".into(),
                json!({ "key": "system.plan.autoOffManagerChanged", "args": {} }),
            );
            return post_line(st, channel, root, a, "▶ 자동 진행 꺼짐".to_owned(), meta).await;
        }
    }
    Ok(())
}

/// TS `notice` — 스레드 안 시스템 줄(`serverNotice`·`noMentions`). `message.created` 는 글 경로가 같은 tx 의 outbox 로 낸다.
async fn announce(st: &PostState, channel: &str, root: &str, actor: &str) -> sqlx::Result<()> {
    let (body, meta) = off_line(actor);
    post_line(st, channel, root, actor, body, meta).await
}

async fn post_line(
    st: &PostState,
    channel: &str,
    root: &str,
    actor: &str,
    body: String,
    meta: Map<String, Value>,
) -> sqlx::Result<()> {
    let audience = audience_for(&st.write, channel).await?.to_json();
    let is_dm = channel_is_dm(&st.write, channel).await?;
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: Some(root.to_owned()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        server_notice: true,
        no_mentions: true,
        ..Origin::default()
    };
    match post_in_tx(
        st, channel, actor, false, &input, None, &audience, is_dm, &origin,
    )
    .await?
    {
        Outcome::Posted { .. } => {}
        // TS 는 `posted.failure` 면 알리지 않고 지나간다 — 판은 이미 꺼졌다. 흔적만 남긴다.
        Outcome::ToTs => eprintln!("[threadPlanAutoOff] system line not posted: to_ts"),
        Outcome::BadThread => eprintln!("[threadPlanAutoOff] system line not posted: bad_thread"),
        Outcome::BadAttachment | Outcome::ChainLimit | Outcome::Replayed(_) => {
            eprintln!("[threadPlanAutoOff] system line not posted")
        }
    }
    Ok(())
}

/// 코어 라우터에 합칠 줄 — 인증은 `route_layer`, CORS 는 `layer`. 같은 접두의 `GET …/plan` 은 읽기 코어
/// (`thread_plan_read.rs`)가, `POST …/plan/start`·`PUT …/plan/manager` 는 TS 가 맡는다.
pub fn routes(
    st: AutoOffState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AutoOffState>>::new()
        .delete("/threads/{rootId}/plan/auto", auto_off)
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
    fn off_line_like_ts() {
        let (body, meta) = off_line(A);
        assert_eq!(body, "▶ 자동 진행 꺼짐");
        assert_eq!(
            meta["planAutoState"],
            json!({ "on": false, "reason": "human" })
        );
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.plan.autoOffHuman", "args": { "accountId": A } })
        );
        assert!(!meta.contains_key("accountId"));
    }

    #[test]
    fn privileges_column_level_for_thread_plan() {
        assert!(
            !THREAD_PLAN_AUTO_OFF_PRIVILEGES
                .iter()
                .any(|(t, _)| *t == "thread_plan")
        );
        assert!(THREAD_PLAN_AUTO_OFF_PRIVILEGES.contains(&("thread_plan.auto_woken", "UPDATE")));
    }

    #[test]
    fn code_err_shape() {
        let r = code_err(StatusCode::NOT_FOUND, "no_plan");
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }
}
