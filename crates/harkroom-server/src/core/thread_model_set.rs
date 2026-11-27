//! S5.4 TM4 — 스레드 × 에이전트 모델 지정 한 줄. TS `routes/threadAgentModelRoutes.ts` 의
//! `PUT /channels/:id/threads/:rootId/agent-models/:agentId` 와 `checkOffered`·`setThreadAgentModel`·`announceChange`(사람 갈래)·
//! `emitChanged` 를 옮긴다.
//!
//! - 순서(TS 와 같다): 인증(401) → 경로 세 id(400 `invalid_request`) → 사람만(403 `human_only`) → 본문 zod(400 `bad_request`)
//!   → `channelPostGate`(403 `forbidden`·403 `channel_archived`) → `cleanAxis`·`axisValid`(400 `bad_model_value`)
//!   → `checkOffered`(400 `model_not_offered`·`effort_not_offered`) → 루트(404 `not_a_root`) → 에이전트(404 `not_found`·400 `not_an_agent`)
//!   → 쓰기(두 축이 비면 지우기) → 시스템 줄 → `thread.agent_model.changed` → 감사 `thread.agent_model.set` → 200 `{ row }`.
//! - 하네스 목록은 능력 스냅숏(`operator_capability`)만 본다 — **오퍼레이터 코어가 Rust 일 때만** TS 와 같은 답이라 `main.rs` 는 그때만 붙인다.
use super::audience::audience_for;
use super::mcp::model_options::{ASSIGNMENT_SQL, SNAPSHOT_FRESH_SEC, SNAPSHOT_SQL, models_in};
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, gate_sql, post_in_tx};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, emit_event, record_audit};
use crate::writes_settings::ip_of;
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// 이 줄이 글 올리기 권한([`super::msg_post::MESSAGE_POST_PRIVILEGES`]) 위에 쓰는 권한 — homelab GRANT 와 같아야 한다.
pub const THREAD_MODEL_SET_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.harness", "SELECT"),
    ("agent_config.model", "SELECT"),
    ("agent_assignment.agent_id", "SELECT"),
    ("agent_assignment.operator_id", "SELECT"),
    ("operator_capability.operator_id", "SELECT"),
    ("operator_capability.body", "SELECT"),
    ("operator_capability.seen_at", "SELECT"),
    ("thread_agent_model", "SELECT"),
    ("thread_agent_model", "INSERT"),
    ("thread_agent_model", "UPDATE"),
    ("thread_agent_model", "DELETE"),
    ("audit_log", "INSERT"),
    ("event_outbox", "INSERT"),
];

/// TS `MODEL_ID_MAX`·`EFFORT_MAX`.
pub(crate) const MODEL_ID_MAX: usize = 120;
pub(crate) const EFFORT_MAX: usize = 32;
const BODY_LIMIT: usize = 1024 * 1024;
/// TS `SYSTEM_ACCOUNT_PLACEHOLDER`.
const PLACEHOLDER: &str = "{account}";

pub(crate) const ROOT_SQL: &str = "select 1 from message where id = $1::uuid and channel_id = $2::uuid \
     and thread_root_id is null and deleted_at is null";
pub(crate) const AGENT_SQL: &str = "select a.kind, c.harness from account a left join agent_config c on c.account_id = a.id \
      where a.id = $1::uuid and a.deleted_at is null";
const CFG_SQL: &str = "select harness, model from agent_config where account_id = $1::uuid";
pub(crate) const CLEAR_SQL: &str =
    "delete from thread_agent_model where thread_root_id = $1::uuid and agent_id = $2::uuid";
pub(crate) const UPSERT_SQL: &str = "insert into thread_agent_model (thread_root_id, agent_id, harness, model, effort, set_by, set_by_kind) \
     values ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, 'human') \
     on conflict (thread_root_id, agent_id) do update set \
       harness = excluded.harness, model = excluded.model, effort = excluded.effort, \
       set_by = excluded.set_by, set_by_kind = excluded.set_by_kind, combo_id = null, set_at = now()";
/// TS `getThreadAgentModel` — `COLS`·`FROM` 과 `normalize`(setAt → `toISOString()` 꼴), 칸 순서 그대로.
const ROW_SQL: &str = concat!(
    "select json_build_object(",
    "'threadRootId', t.thread_root_id, 'agentId', t.agent_id, 'harness', t.harness, ",
    "'model', t.model, 'effort', t.effort, 'setBy', t.set_by, 'setByKind', t.set_by_kind, ",
    "'setAt', to_char(t.set_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), ",
    "'currentHarness', coalesce(c.harness, 'claude-code'), ",
    "'stale', (t.harness is distinct from coalesce(c.harness, 'claude-code'))",
    ")::text from thread_agent_model t left join agent_config c on c.account_id = t.agent_id ",
    "where t.thread_root_id = $1::uuid and t.agent_id = $2::uuid"
);
const HANDLE_SQL: &str = "select handle from account where id = $1::uuid";

#[derive(Clone)]
pub struct SetState {
    pub post: PostState,
    pub trust: TrustProxy,
}

/// zod `string().max(n).nullable().optional()` — `Ok(None)` 은 빠짐·null. 길이는 UTF-16 단위.
fn axis_field(o: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, ()> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.encode_utf16().count() <= max => Ok(Some(s.clone())),
        _ => Err(()),
    }
}

/// 본문 `{ model?, effort? }`. 비었으면 TS `req.body ?? {}`.
fn parse_body(bytes: &[u8]) -> Result<(Option<String>, Option<String>), ()> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok((None, None));
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let o = match &v {
        Value::Object(o) => o,
        Value::Null => return Ok((None, None)),
        _ => return Err(()),
    };
    Ok((
        axis_field(o, "model", MODEL_ID_MAX)?,
        axis_field(o, "effort", EFFORT_MAX)?,
    ))
}

/// JS `String.prototype.trim` 의 공백(유니코드 White_Space + BOM).
fn js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// TS `cleanAxis` — 다듬고, 비면 null, `max` UTF-16 단위로 자른다.
pub fn clean_axis(v: Option<&str>, max: usize) -> Option<String> {
    let t = v?.trim_matches(js_ws);
    if t.is_empty() {
        return None;
    }
    let mut n = 0;
    let mut out = String::new();
    for c in t.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    Some(out)
}

/// TS `axisValid` — `/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/`.
pub fn axis_valid(v: Option<&str>) -> bool {
    let Some(v) = v else { return true };
    let mut cs = v.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    cs.all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}

/// TS `announceChange(…, byKind = 'human')` 의 본문과 meta.
#[cfg(test)]
fn change_line(
    actor: &str,
    agent: &str,
    handle: &str,
    row: Option<(Option<&str>, Option<&str>)>,
) -> (String, Map<String, Value>) {
    change_line_by(actor, agent, handle, row, false)
}

/// TS `announceChange` — `by_agent` 면 `byKind: 'agent'`(문구 끝 ` (에이전트 지정)`, i18n `…ByAgent`).
pub(crate) fn change_line_by(
    actor: &str,
    agent: &str,
    handle: &str,
    row: Option<(Option<&str>, Option<&str>)>,
    by_agent: bool,
) -> (String, Map<String, Value>) {
    let tag = if by_agent {
        " (에이전트 지정)"
    } else {
        ""
    };
    let by_kind = if by_agent { "agent" } else { "human" };
    let value = row.map(|(m, e)| {
        let mut parts = vec![m.unwrap_or("설정 모델")];
        if let Some(e) = e.filter(|e| !e.is_empty()) {
            parts.push(e);
        }
        parts.retain(|p| !p.is_empty());
        parts.join(" · ")
    });
    let mut meta = Map::new();
    meta.insert("accountId".into(), Value::String(actor.to_owned()));
    let (model, effort) = row.unwrap_or((None, None));
    meta.insert(
        "threadAgentModel".into(),
        json!({ "agentId": agent, "model": model, "effort": effort, "byKind": by_kind }),
    );
    let body = match &value {
        Some(v) => {
            meta.insert(
                "i18n".into(),
                json!({ "key": if by_agent { "system.threadModel.setByAgent" } else { "system.threadModel.set" }, "args": { "accountId": actor, "agentId": agent, "value": v } }),
            );
            format!(
                "{PLACEHOLDER}님이 이 스레드에서 {handle} 의 모델을 {v} 로 정했습니다{tag}. 다음 턴부터 적용됩니다."
            )
        }
        None => {
            meta.insert(
                "i18n".into(),
                json!({ "key": if by_agent { "system.threadModel.clearedByAgent" } else { "system.threadModel.cleared" }, "args": { "accountId": actor, "agentId": agent } }),
            );
            format!(
                "{PLACEHOLDER}님이 이 스레드에서 {handle} 의 모델 지정을 풀었습니다{tag}. 다음 턴부터 기본값으로 돕니다."
            )
        }
    };
    (body, meta)
}

/// TS `checkOffered` 의 판정(목록을 읽은 뒤). `Err((code, message))` 면 400.
fn offered_verdict(
    harness: &str,
    cfg_model: Option<&str>,
    models: &[super::mcp::model_options::HarnessModel],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), (&'static str, String)> {
    if let Some(m) = model
        && !models.iter().any(|x| x.id == m)
    {
        return Err((
            "model_not_offered",
            format!("{harness} 가 이 머신에서 밝힌 모델 목록에 {m} 가 없다"),
        ));
    }
    let target = model.or(cfg_model);
    let efforts = target.and_then(|t| models.iter().find(|x| x.id == t)?.efforts.as_ref());
    if let (Some(e), Some(es), Some(t)) = (effort, efforts, target)
        && !es.iter().any(|x| x == e)
    {
        return Err((
            "effort_not_offered",
            format!("{t} 는 effort {e} 를 받지 않는다({})", es.join("·")),
        ));
    }
    Ok(())
}

pub(crate) async fn check_offered(
    w: &sqlx::PgPool,
    agent: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> sqlx::Result<Result<(), (&'static str, String)>> {
    if model.is_none() && effort.is_none() {
        return Ok(Ok(()));
    }
    let op: Option<String> = sqlx::query_scalar(ASSIGNMENT_SQL)
        .bind(agent)
        .fetch_optional(w)
        .await?;
    let Some(op) = op else { return Ok(Ok(())) };
    let cfg: Option<(Option<String>, Option<String>)> = sqlx::query_as(CFG_SQL)
        .bind(agent)
        .fetch_optional(w)
        .await?;
    let (harness, cfg_model) = cfg.unwrap_or((None, None));
    let harness = harness.unwrap_or_else(|| "claude-code".into());
    let body: Option<Value> = sqlx::query_scalar(SNAPSHOT_SQL)
        .bind(&op)
        .bind(SNAPSHOT_FRESH_SEC)
        .fetch_optional(w)
        .await?;
    let Some(models) = body.as_ref().and_then(|b| models_in(b, &harness)) else {
        return Ok(Ok(()));
    };
    Ok(offered_verdict(
        &harness,
        cfg_model.as_deref(),
        &models,
        model,
        effort,
    ))
}

/// `PUT /channels/{id}/threads/{rootId}/agent-models/{agentId}`.
pub async fn set(
    State(st): State<Arc<SetState>>,
    RequireAccount(me, _): RequireAccount,
    Path((id, root, agent)): Path<(String, String, String)>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let Ok(bytes) = to_bytes(body, BODY_LIMIT).await else {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        );
    };
    let uuid = crate::lists::is_zod_uuid;
    if !uuid(&id) || !uuid(&root) || !uuid(&agent) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    if me.kind != "human" {
        return json_err(
            StatusCode::FORBIDDEN,
            "human_only",
            "모델 지정은 사람만 바꾼다",
        );
    }
    let Ok((raw_model, raw_effort)) = parse_body(&bytes) else {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
        return json_err(StatusCode::BAD_REQUEST, "bad_request", "invalid body");
    };
    let w = &st.post.write;
    let gate: Option<(bool, bool)> = match sqlx::query_as(gate_sql())
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(w)
        .await
    {
        Ok(g) => g,
        Err(e) => return internal(e),
    };
    match gate {
        Some((false, _)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this dm channel",
            );
        }
        Some((true, true)) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "channel_archived",
                "archived channels are read-only",
            );
        }
        _ => {}
    }
    let model = clean_axis(raw_model.as_deref(), MODEL_ID_MAX);
    let effort = clean_axis(raw_effort.as_deref(), EFFORT_MAX);
    if !axis_valid(model.as_deref()) || !axis_valid(effort.as_deref()) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_model_value",
            "모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다",
        );
    }
    match check_offered(w, &agent, model.as_deref(), effort.as_deref()).await {
        Ok(Ok(())) => {}
        Ok(Err((code, msg))) => return json_err(StatusCode::BAD_REQUEST, code, &msg),
        Err(e) => return internal(e),
    }
    match sqlx::query_scalar::<_, i32>(ROOT_SQL)
        .bind(&root)
        .bind(&id)
        .fetch_optional(w)
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
    let found: Option<(String, Option<String>)> = match sqlx::query_as(AGENT_SQL)
        .bind(&agent)
        .fetch_optional(w)
        .await
    {
        Ok(f) => f,
        Err(e) => return internal(e),
    };
    let harness = match found {
        None => return json_err(StatusCode::NOT_FOUND, "not_found", "no such account"),
        Some((kind, _)) if kind != "agent" => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "not_an_agent",
                "에이전트에게만 모델을 정한다",
            );
        }
        Some((_, h)) => h.unwrap_or_else(|| "claude-code".into()),
    };
    let row: Option<String> = if model.is_none() && effort.is_none() {
        if let Err(e) = sqlx::query(CLEAR_SQL)
            .bind(&root)
            .bind(&agent)
            .execute(w)
            .await
        {
            return internal(e);
        }
        None
    } else {
        if let Err(e) = sqlx::query(UPSERT_SQL)
            .bind(&root)
            .bind(&agent)
            .bind(&harness)
            .bind(&model)
            .bind(&effort)
            .bind(&me.id)
            .execute(w)
            .await
        {
            return internal(e);
        }
        match sqlx::query_scalar(ROW_SQL)
            .bind(&root)
            .bind(&agent)
            .fetch_optional(w)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        }
    };
    let row_val: Value = row
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or(Value::Null);
    let axes = if row_val.is_null() {
        None
    } else {
        Some((
            row_val["model"].as_str().map(str::to_owned),
            row_val["effort"].as_str().map(str::to_owned),
        ))
    };
    if let Err(e) = announce(&st.post, &id, &root, &me.id, &agent, axes.as_ref()).await {
        return internal(e);
    }
    let audience = match audience_for(w, &id).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let ev = json!({ "type": "thread.agent_model.changed", "channelId": id, "threadRootId": root,
        "agentId": agent, "row": row_val, "audience": audience });
    let emitted = match w.acquire().await {
        Ok(mut c) => emit_event(&mut c, &ev).await.map(|_| ()),
        Err(e) => Err(e),
    };
    if let Err(e) = emitted {
        return internal(e);
    }
    let ip = ip_of(&parts, &st.trust);
    record_audit(
        w,
        AuditEntry {
            action: "thread.agent_model.set",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&root),
            ip: ip.as_deref(),
            detail: json!({ "agentId": agent, "model": model, "effort": effort }),
        },
    )
    .await;
    json_ok(format!(
        "{{\"row\":{}}}",
        row.unwrap_or_else(|| "null".to_owned())
    ))
}

async fn announce(
    st: &PostState,
    channel: &str,
    root: &str,
    actor: &str,
    agent: &str,
    axes: Option<&(Option<String>, Option<String>)>,
) -> sqlx::Result<()> {
    announce_by(st, channel, root, actor, agent, axes, false).await
}

/// TS `announceChange(…, byKind)` + `emitChanged` — 에이전트 고르기(`agentModels`)가 커밋된 뒤 바뀐 줄마다 부른다.
pub(crate) async fn announce_agent_pick(
    st: &PostState,
    channel: &str,
    root: &str,
    actor: &str,
    agent: &str,
    axes: Option<&(Option<String>, Option<String>)>,
) -> sqlx::Result<()> {
    announce_pick(st, channel, root, actor, agent, axes, true).await
}

/// [`announce_agent_pick`] 의 두 갈래 — `by_agent` 가 거짓이면 사람 작성창 칩(REST 글의 `agentModels`, [`super::msg_post_models`]).
pub(crate) async fn announce_pick(
    st: &PostState,
    channel: &str,
    root: &str,
    actor: &str,
    agent: &str,
    axes: Option<&(Option<String>, Option<String>)>,
    by_agent: bool,
) -> sqlx::Result<()> {
    announce_by(st, channel, root, actor, agent, axes, by_agent).await?;
    let row: Option<String> = sqlx::query_scalar(ROW_SQL)
        .bind(root)
        .bind(agent)
        .fetch_optional(&st.write)
        .await?;
    let row_val: Value = row
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or(Value::Null);
    let audience = audience_for(&st.write, channel).await?.to_json();
    let ev = json!({ "type": "thread.agent_model.changed", "channelId": channel, "threadRootId": root,
        "agentId": agent, "row": row_val, "audience": audience });
    let mut c = st.write.acquire().await?;
    emit_event(&mut c, &ev).await.map(|_| ())
}

async fn announce_by(
    st: &PostState,
    channel: &str,
    root: &str,
    actor: &str,
    agent: &str,
    axes: Option<&(Option<String>, Option<String>)>,
    by_agent: bool,
) -> sqlx::Result<()> {
    let handle: Option<String> = sqlx::query_scalar(HANDLE_SQL)
        .bind(agent)
        .fetch_optional(&st.write)
        .await?;
    let (body, meta) = change_line_by(
        actor,
        agent,
        handle.as_deref().unwrap_or(""),
        axes.map(|(m, e)| (m.as_deref(), e.as_deref())),
        by_agent,
    );
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
        no_mentions: true,
        ..Origin::default()
    };
    match post_in_tx(
        st, channel, actor, false, &input, None, &audience, is_dm, &origin,
    )
    .await?
    {
        Outcome::Posted { .. } => {}
        Outcome::ToTs => eprintln!("[threadModelSet] system line not posted: to_ts"),
        Outcome::BadThread => eprintln!("[threadModelSet] system line not posted: bad_thread"),
        Outcome::BadAttachment | Outcome::Rejected(_) | Outcome::Replayed(_) => {
            eprintln!("[threadModelSet] system line not posted")
        }
    }
    Ok(())
}

/// 코어 라우터에 합칠 줄. 같은 경로의 `GET` 은 읽기 코어, `DELETE` 는 풀기 코어가 맡는다.
pub fn routes(
    st: SetState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<SetState>>::new()
        .put(
            "/channels/{id}/threads/{rootId}/agent-models/{agentId}",
            set,
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
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::super::mcp::model_options::HarnessModel;
    use super::*;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const G: &str = "00000000-0000-4000-8000-00000000000b";

    #[test]
    fn axis_like_ts() {
        assert_eq!(clean_axis(Some("  opus "), 120).as_deref(), Some("opus"));
        assert_eq!(clean_axis(Some("\u{feff} "), 120), None);
        assert_eq!(clean_axis(None, 120), None);
        assert_eq!(clean_axis(Some("abcdef"), 3).as_deref(), Some("abc"));
        assert!(axis_valid(None));
        assert!(axis_valid(Some("claude-opus-5[1m]")));
        assert!(axis_valid(Some("rro/openai/gpt-oss-120b")));
        assert!(!axis_valid(Some("-x")));
        assert!(!axis_valid(Some("a b")));
        assert!(!axis_valid(Some("a=b")));
    }

    #[test]
    fn body_like_zod() {
        assert_eq!(parse_body(b""), Ok((None, None)));
        assert_eq!(
            parse_body(br#"{"model":"opus","effort":null}"#),
            Ok((Some("opus".into()), None))
        );
        assert!(parse_body(br#"{"model":1}"#).is_err());
        assert!(parse_body(b"[]").is_err());
        let long = format!("{{\"effort\":\"{}\"}}", "x".repeat(33));
        assert!(parse_body(long.as_bytes()).is_err());
    }

    #[test]
    fn line_like_ts() {
        let (body, meta) = change_line(A, G, "scout", Some((None, Some("high"))));
        assert_eq!(
            body,
            "{account}님이 이 스레드에서 scout 의 모델을 설정 모델 · high 로 정했습니다. 다음 턴부터 적용됩니다."
        );
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.threadModel.set", "args": { "accountId": A, "agentId": G, "value": "설정 모델 · high" } })
        );
        assert_eq!(
            meta["threadAgentModel"],
            json!({ "agentId": G, "model": null, "effort": "high", "byKind": "human" })
        );
        let (body, meta) = change_line(A, G, "scout", None);
        assert!(body.contains("모델 지정을 풀었습니다"));
        assert_eq!(meta["i18n"]["key"], "system.threadModel.cleared");
    }

    #[test]
    fn offered_like_ts() {
        let ms = vec![HarnessModel {
            id: "opus".into(),
            label: None,
            efforts: Some(vec!["low".into(), "high".into()]),
        }];
        assert!(offered_verdict("claude-code", None, &ms, Some("opus"), Some("high")).is_ok());
        assert_eq!(
            offered_verdict("claude-code", None, &ms, Some("x"), None)
                .unwrap_err()
                .0,
            "model_not_offered"
        );
        assert_eq!(
            offered_verdict("claude-code", Some("opus"), &ms, None, Some("max"))
                .unwrap_err()
                .1,
            "opus 는 effort max 를 받지 않는다(low·high)"
        );
        // 설정 모델이 목록에 없으면 effort 는 모른다 — 받는다.
        assert!(offered_verdict("claude-code", Some("y"), &ms, None, Some("max")).is_ok());
    }

    #[test]
    fn change_line_by_agent_tags_and_keys() {
        let (body, meta) = change_line_by(A, G, "scout", Some((Some("opus"), None)), true);
        assert_eq!(
            body,
            "{account}님이 이 스레드에서 scout 의 모델을 opus 로 정했습니다 (에이전트 지정). 다음 턴부터 적용됩니다."
        );
        assert_eq!(meta["i18n"]["key"], "system.threadModel.setByAgent");
        assert_eq!(meta["threadAgentModel"]["byKind"], "agent");
        let (body, meta) = change_line_by(A, G, "scout", None, true);
        assert!(body.ends_with("풀었습니다 (에이전트 지정). 다음 턴부터 기본값으로 돕니다."));
        assert_eq!(meta["i18n"]["key"], "system.threadModel.clearedByAgent");
    }
}
