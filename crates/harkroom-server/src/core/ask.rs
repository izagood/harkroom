//! S5.3 C3b-1 — 선택 카드에 답하기·닫기. TS `routes/messageRoutes.ts` 의 `POST /channels/:id/messages/:messageId/ask-answer`·
//! `ask-close` 와 `services/messages.ts` 의 `recordAskAnswer`·`answerAskRow`·`closeAsk`·`closeAskRow`·`readAskRow`, shared 의
//! `readAskMeta`·`askTakesText` 를 옮긴다. 뒤처리(깨움·거울·묶음)는 `core/ask_sync.rs`.
//!
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → 경로(400) → 본문(400) → 볼 수 있는가(403) → 이 채널의 글인가(404) → 판정 → 쓰기 → 이벤트.
//! - **Rust 가 맡는 카드는 좁다(닫힌 쪽).** 카드나 그 거울의 원본이 권한·머지·사슬 카드(`permissionRequest`·`permissionMirror`·
//!   `mergeDenial`·`chainBackstop`)이거나 권한 요청 줄이 가리키는 카드, 또는 종류(`meta.kind`)·모양을 못 읽는 카드면
//!   Rust 는 판정하지 않고 읽어 둔 본문 그대로 TS 로 넘긴다([`hand_to_ts`]). 그런 카드의 결정은 C3b-3 몫이다.
//! - 판정·쓰기·깨움·이벤트는 쓰기 풀의 **한 트랜잭션**이다. `Err` 면 500 이고 답·닫힘도 되돌아간다. 깨움 실패만 TS 처럼 삼킨다
//!   (SAVEPOINT — 답은 남는다).
//! - 이벤트 순서는 TS 그대로: 거울 경로는 원본 `message.updated` → 거울 맞추기(묶음 → 거울마다 깨움·`message.updated`) →
//!   라우트가 돌려줄 행의 `message.updated`(거울 맞추기가 이미 보낸 것과 겹쳐도 TS 처럼 한 번 더).
use super::ask_sync::{announce_updated, sync_ask_mirrors, wake_asker};
use super::audience::audience_for;
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::proxy::Upstream;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use std::net::SocketAddr;
use std::sync::Arc;

/// 이 줄이 쓰는 권한 — homelab GRANT 와 같아야 한다. 글은 `meta` 칸만 고친다.
pub const ASK_PRIVILEGES: &[(&str, &str)] = &[
    ("message.meta", "UPDATE"),
    ("inbox", "INSERT"),
    ("event_outbox", "INSERT"),
];
pub const ASK_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS shared `ASK_TEXT_OPTION_ID`·`ASK_TEXT_MAX_CHARS`·`ASK_MIN_OPTIONS`·`ASK_MAX_OPTIONS`.
pub const ASK_TEXT_OPTION_ID: &str = "__text__";
pub const ASK_TEXT_MAX_CHARS: usize = 2000;
pub(crate) const ASK_MIN_OPTIONS: usize = 2;
pub(crate) const ASK_MAX_OPTIONS: usize = 5;
use crate::write::BODY_LIMIT;
const LABEL: &str = "ask";

/// 이 카드들의 결정은 Rust 가 하지 않는다(C3b-3). TS `askTakesText` 가 보는 표지와 같다.
const TS_ONLY_MARKERS: &[&str] = &[
    "permissionRequest",
    "permissionMirror",
    "mergeDenial",
    "chainBackstop",
];

#[derive(Clone)]
pub struct AskState {
    pub read: PgPool,
    pub write: PgPool,
    pub up: Upstream,
    /// C3b-3c — 권한 카드 **거절** 쓰기 풀([`super::decide_core::deny_pool`] 이 두 겹 검사로 준 것). `None` 이면 거절도 TS 가 맡는다.
    pub deny: Option<PgPool>,
    /// S5.3 B2 — 권한 카드 **승인**(소유자, tool 7일·command 1회/1시간) 쓰기 풀([`super::decide_approve::approve_pool`]). `None` 이면 TS.
    pub approve: Option<PgPool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum To {
    Human,
    Account(String),
}

/// TS `readAskMeta` 가 돌려주는 것 중 여기서 쓰는 칸.
#[derive(Debug, Clone)]
pub(super) struct Ask {
    pub(super) options: Vec<String>,
    pub(super) to: To,
    pub(super) mirror_of: Option<String>,
    pub(super) answered: bool,
    pub(super) closed: bool,
}

impl Ask {
    /// `to.kind == 'human'` — 사람 앞 물음인가(C3b-3a 거울 판정이 쓴다).
    pub(super) fn to_human(&self) -> bool {
        self.to == To::Human
    }
}

/// TS `isPermissionCardMeta`.
fn is_permission_card_meta(meta: &Value) -> bool {
    meta.get("permissionRequest").is_some_and(Value::is_object)
        || meta
            .get("permissionMirror")
            .is_some_and(|m| m.is_object() && m.get("rootId").is_some_and(Value::is_string))
}

/// TS shared `readAskMeta` — 못 알아보면 None.
pub(super) fn read_ask_meta(meta: &Value) -> Option<Ask> {
    if meta.get("kind").and_then(Value::as_str) != Some("ask") {
        return None;
    }
    let ask = meta.get("ask").filter(|a| a.is_object())?;
    let options = ask.get("options")?.as_array()?;
    let min = if is_permission_card_meta(meta) {
        1
    } else {
        ASK_MIN_OPTIONS
    };
    if options.len() < min || options.len() > ASK_MAX_OPTIONS {
        return None;
    }
    let mut ids = Vec::with_capacity(options.len());
    for o in options {
        let id = o.get("id").and_then(Value::as_str)?;
        o.get("label").and_then(Value::as_str)?;
        ids.push(id.to_owned());
    }
    let to = ask.get("to")?;
    let to = match to.get("kind").and_then(Value::as_str) {
        Some("human") => To::Human,
        Some("account") => To::Account(to.get("accountId").and_then(Value::as_str)?.to_owned()),
        _ => return None,
    };
    let truthy_str = |k: &str| {
        ask.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let present = |k: &str| ask.get(k).is_some_and(|v| !v.is_null());
    Some(Ask {
        options: ids,
        to,
        mirror_of: truthy_str("mirrorOf"),
        answered: present("answeredWith"),
        closed: present("closedAt"),
    })
}

/// TS shared `askTakesText`.
fn ask_takes_text(meta: &Value) -> bool {
    meta.is_object() && TS_ONLY_MARKERS.iter().all(|k| meta.get(*k).is_none())
}

fn has_ts_marker(meta: &Value) -> bool {
    TS_ONLY_MARKERS.iter().any(|k| meta.get(*k).is_some())
}

async fn meta_of<'e, E: sqlx::PgExecutor<'e>>(ex: E, id: &str) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar("select meta from message where id = $1::uuid and deleted_at is null")
        .bind(id)
        .fetch_optional(ex)
        .await
        .map(Option::flatten)
}

async fn is_permission_request_card(pool: &PgPool, id: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "select exists(select 1 from permission_request where card_message_id = $1::uuid)",
    )
    .bind(id)
    .fetch_one(pool)
    .await
}

/// 이 카드를 TS 에 넘기나 — 닫힌 쪽: 확신할 수 없으면 넘긴다.
pub(super) async fn hand_to_ts(pool: &PgPool, id: &str) -> sqlx::Result<bool> {
    let Some(meta) = meta_of(pool, id).await? else {
        return Ok(true);
    };
    let Some(ask) = read_ask_meta(&meta) else {
        return Ok(true);
    };
    if has_ts_marker(&meta) || is_permission_request_card(pool, id).await? {
        return Ok(true);
    }
    // 거울 표지가 문자열이 아니거나 uuid 가 아니면 못 읽은 것이다.
    match meta.get("ask").and_then(|a| a.get("mirrorOf")) {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(Value::String(s)) if is_uuid(s) => {}
        Some(_) => return Ok(true),
    }
    if let Some(root) = &ask.mirror_of
        && let Some(root_meta) = meta_of(pool, root).await?
        && (read_ask_meta(&root_meta).is_none()
            || has_ts_marker(&root_meta)
            || is_permission_request_card(pool, root).await?)
    {
        return Ok(true);
    }
    Ok(false)
}

async fn is_human(conn: &mut PgConnection, id: &str) -> sqlx::Result<bool> {
    let k: Option<String> = sqlx::query_scalar("select kind from account where id = $1::uuid")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    Ok(k.as_deref() == Some("human"))
}

/// TS `readAskRow` — (ask, channelId, meta).
pub(super) async fn read_ask_row(
    conn: &mut PgConnection,
    id: &str,
) -> sqlx::Result<Option<(Ask, String, Value)>> {
    let row: Option<(Value, String)> = sqlx::query_as(
        "select meta, channel_id::text from message where id = $1::uuid and deleted_at is null",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row.and_then(|(meta, ch)| read_ask_meta(&meta).map(|a| (a, ch, meta))))
}

#[derive(Debug)]
pub(super) enum Outcome {
    NotFound,
    Forbidden,
    UnknownOption,
    AlreadyAnswered,
    Row(String),
}

/// TS `answerAskRow` — 답을 적고 물어본 쪽을 깨운다. 경합에서 졌으면 None.
async fn answer_ask_row(
    conn: &mut PgConnection,
    id: &str,
    option: &str,
    actor: &str,
    text: Option<&str>,
    answered_via: Option<&str>,
) -> sqlx::Result<Option<String>> {
    // 직접 쓴 답만 `answeredText` 를 싣는다 — 보통 답의 meta 모양은 그대로다(TS 와 같은 문장 둘).
    const ANSWERED: &str = "update message set meta = jsonb_set(jsonb_set(jsonb_set(meta::jsonb, '{ask,answeredWith}', to_jsonb($2::text)), \
                '{ask,answeredBy}', to_jsonb($3::text)), '{ask,answeredAt}', to_jsonb(now())) \
          where id = $1::uuid and deleted_at is null and meta->'ask'->>'answeredWith' is null \
            and meta->'ask'->>'closedReason' is distinct from 'superseded' \
          returning author_id::text";
    const ANSWERED_TEXT: &str = "update message set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta::jsonb, '{ask,answeredWith}', to_jsonb($2::text)), \
                '{ask,answeredBy}', to_jsonb($3::text)), '{ask,answeredAt}', to_jsonb(now())), '{ask,answeredText}', to_jsonb($4::text)) \
          where id = $1::uuid and deleted_at is null and meta->'ask'->>'answeredWith' is null \
            and meta->'ask'->>'closedReason' is distinct from 'superseded' \
          returning author_id::text";
    // 묶음 「추천대로 일괄」의 답 — 사람이 그 줄을 골라 누르지 않았다는 표지(TS `answeredVia`, security F1). 직접 쓴 답과는 겹치지 않는다.
    const ANSWERED_VIA: &str = "update message set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta::jsonb, '{ask,answeredWith}', to_jsonb($2::text)), \
                '{ask,answeredBy}', to_jsonb($3::text)), '{ask,answeredAt}', to_jsonb(now())), '{ask,answeredVia}', to_jsonb($4::text)) \
          where id = $1::uuid and deleted_at is null and meta->'ask'->>'answeredWith' is null \
            and meta->'ask'->>'closedReason' is distinct from 'superseded' \
          returning author_id::text";
    let sql = match (text, answered_via) {
        (Some(_), _) => ANSWERED_TEXT,
        (None, Some(_)) => ANSWERED_VIA,
        (None, None) => ANSWERED,
    };
    let mut q = sqlx::query_scalar::<_, Option<String>>(sql)
        .bind(id)
        .bind(option)
        .bind(actor);
    if let Some(t) = text {
        q = q.bind(t);
    } else if let Some(v) = answered_via {
        q = q.bind(v);
    }
    let Some(author) = q.fetch_optional(&mut *conn).await? else {
        return Ok(None);
    };
    wake_asker(conn, LABEL, author.as_deref(), actor, id, "ask_answered").await;
    message_by_id(&mut *conn, id).await
}

/// TS `closeAskRow` — 「답하지 않기로 했다」로 닫고 깨운다. 이미 답했거나 닫혔으면 None.
async fn close_ask_row(
    conn: &mut PgConnection,
    id: &str,
    actor: &str,
) -> sqlx::Result<Option<String>> {
    let author: Option<Option<String>> = sqlx::query_scalar(
        "update message set meta = jsonb_set(jsonb_set(jsonb_set(meta::jsonb, '{ask,closedAt}', to_jsonb(now())), \
                '{ask,closedBy}', to_jsonb($2::text)), '{ask,closedReason}', to_jsonb('declined'::text)) \
          where id = $1::uuid and deleted_at is null \
            and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null \
          returning author_id::text",
    )
    .bind(id)
    .bind(actor)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(author) = author else {
        return Ok(None);
    };
    wake_asker(conn, LABEL, author.as_deref(), actor, id, "ask_closed").await;
    message_by_id(&mut *conn, id).await
}

/// TS `recordAskAnswer`(라우트가 부르는 꼴 — `viaPermissionDecision`·`answeredVia`·`skipWakeIfInboxFor` 없음).
pub(super) async fn record_ask_answer(
    read: &PgPool,
    conn: &mut PgConnection,
    id: &str,
    actor: &str,
    option: &str,
    written: Option<&str>,
    answered_via: Option<&str>,
) -> sqlx::Result<Outcome> {
    record_ask_answer_with(read, conn, id, actor, option, written, answered_via, false).await
}

/// TS `recordAskAnswer(… viaPermissionDecision: true)` — 권한 결정을 **커밋한 뒤** 카드에 답을 적는 길(C3b-3c).
/// 권한 카드 표지(`permissionRequest`) 거절만 건너뛴다. 결정권 판정은 이미 결정 tx 가 했다.
pub(super) async fn record_permission_answer(
    read: &PgPool,
    conn: &mut PgConnection,
    id: &str,
    actor: &str,
    option: &str,
) -> sqlx::Result<Outcome> {
    record_ask_answer_with(read, conn, id, actor, option, None, None, true).await
}

#[allow(clippy::too_many_arguments)]
async fn record_ask_answer_with(
    read: &PgPool,
    conn: &mut PgConnection,
    id: &str,
    actor: &str,
    option: &str,
    written: Option<&str>,
    answered_via: Option<&str>,
    via_permission: bool,
) -> sqlx::Result<Outcome> {
    let Some(meta) = meta_of(&mut *conn, id).await? else {
        return Ok(Outcome::NotFound);
    };
    let Some(ask) = read_ask_meta(&meta) else {
        return Ok(Outcome::NotFound);
    };
    if written.is_none() && !ask.options.iter().any(|o| o == option) {
        return Ok(Outcome::UnknownOption);
    }
    if !via_permission && meta.get("permissionRequest").is_some_and(|v| !v.is_null()) {
        return Ok(Outcome::Forbidden);
    }
    match &ask.to {
        To::Account(a) if a != actor => return Ok(Outcome::Forbidden),
        To::Human if !is_human(conn, actor).await? => return Ok(Outcome::Forbidden),
        _ => {}
    }
    if written.is_some() && (!ask_takes_text(&meta) || !is_human(conn, actor).await?) {
        return Ok(Outcome::Forbidden);
    }
    if let Some(root) = &ask.mirror_of
        && let Some((root_ask, root_channel, root_meta)) = read_ask_row(conn, root).await?
    {
        if root_meta.get("permissionRequest").is_some() {
            return Ok(Outcome::Forbidden);
        }
        if root_ask.to != To::Human {
            return Ok(Outcome::Forbidden);
        }
        if written.is_none() && !root_ask.options.iter().any(|o| o == option) {
            return Ok(Outcome::UnknownOption);
        }
        if written.is_some() && !ask_takes_text(&root_meta) {
            return Ok(Outcome::Forbidden);
        }
        if !channel_visible(read, actor, &root_channel).await? {
            return Ok(Outcome::Forbidden);
        }
        let root_row = answer_ask_row(conn, root, option, actor, written, answered_via).await?;
        if root_row.is_some() {
            announce_updated(conn, root).await?;
        }
        sync_ask_mirrors(conn, LABEL, root).await?;
        if root_row.is_none() {
            return Ok(Outcome::AlreadyAnswered);
        }
        return Ok(match message_by_id(&mut *conn, id).await? {
            Some(r) => Outcome::Row(r),
            None => Outcome::NotFound,
        });
    }
    let Some(row) = answer_ask_row(conn, id, option, actor, written, answered_via).await? else {
        return Ok(Outcome::AlreadyAnswered);
    };
    if ask.mirror_of.is_none() {
        sync_ask_mirrors(conn, LABEL, id).await?;
    }
    Ok(Outcome::Row(row))
}

fn meta_of_row(row: &str) -> Value {
    serde_json::from_str::<Value>(row)
        .ok()
        .and_then(|v| v.get("meta").cloned())
        .unwrap_or(Value::Null)
}

/// 다시 읽은 행으로 경합 결과를 가른다(TS `closeAsk` 의 `after`).
async fn after_close(
    conn: &mut PgConnection,
    id: &str,
    need_closed: bool,
) -> sqlx::Result<Option<Outcome>> {
    let Some(after) = message_by_id(&mut *conn, id).await? else {
        return Ok(Some(Outcome::NotFound));
    };
    let ask = read_ask_meta(&meta_of_row(&after));
    if ask.as_ref().is_some_and(|a| a.answered) {
        return Ok(Some(Outcome::AlreadyAnswered));
    }
    if !need_closed || ask.as_ref().is_some_and(|a| a.closed) {
        return Ok(Some(Outcome::Row(after)));
    }
    Ok(None)
}

/// TS `closeAsk`.
async fn close_ask(
    read: &PgPool,
    conn: &mut PgConnection,
    id: &str,
    actor: &str,
    actor_is_admin: bool,
) -> sqlx::Result<Outcome> {
    let found: Option<(Value, Option<String>)> = sqlx::query_as(
        "select meta, author_id::text from message where id = $1::uuid and deleted_at is null",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((meta, asker)) = found else {
        return Ok(Outcome::NotFound);
    };
    let Some(ask) = read_ask_meta(&meta) else {
        return Ok(Outcome::NotFound);
    };
    if ask.answered {
        return Ok(Outcome::AlreadyAnswered);
    }
    let actor_is_human = is_human(conn, actor).await?;
    let may_answer = match &ask.to {
        To::Human => actor_is_human,
        To::Account(a) => a == actor,
    };
    if !may_answer && asker.as_deref() != Some(actor) && !actor_is_admin {
        return Ok(Outcome::Forbidden);
    }
    if let (Some(root), true) = (&ask.mirror_of, actor_is_human)
        && let Some((root_ask, root_channel, _)) = read_ask_row(conn, root).await?
        && root_ask.to == To::Human
        && channel_visible(read, actor, &root_channel).await?
    {
        if close_ask_row(conn, root, actor).await?.is_some() {
            announce_updated(conn, root).await?;
        }
        sync_ask_mirrors(conn, LABEL, root).await?;
        if let Some(o) = after_close(conn, id, true).await? {
            return Ok(o);
        }
    }
    let Some(row) = close_ask_row(conn, id, actor).await? else {
        return Ok(after_close(conn, id, false)
            .await?
            .unwrap_or(Outcome::NotFound));
    };
    if ask.mirror_of.is_none() {
        sync_ask_mirrors(conn, LABEL, id).await?;
    }
    Ok(Outcome::Row(row))
}

fn bad_request() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태만 본다(`msg_read.rs` 와 같은 약속).
    json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid")
}

fn no_request() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such choice request")
}

pub(super) fn ok_json(body: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// 판정 결과의 응답 — `Row` 는 그 행, 그 밖은 TS 와 같은 상태·코드.
fn reply(o: Outcome) -> Response {
    match o {
        Outcome::Row(r) => ok_json(r),
        Outcome::NotFound => no_request(),
        Outcome::Forbidden => json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "this choice is addressed to someone else",
        ),
        Outcome::UnknownOption => json_err(
            StatusCode::BAD_REQUEST,
            "unknown_option",
            "no such option in this request",
        ),
        Outcome::AlreadyAnswered => json_err(
            StatusCode::CONFLICT,
            "already_answered",
            "this choice is already answered",
        ),
    }
}

/// JS `String.prototype.trim` 이 지우는 것(유니코드 공백 + BOM).
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

enum Answer {
    Option(String),
    Text(String),
}

/// TS 의 zod union(`{optionId}` 또는 `{text}`) — 다른 칸은 무시한다.
fn parse_answer(v: &Value) -> Option<Answer> {
    let o = v.as_object()?;
    match (o.get("optionId"), o.get("text")) {
        (Some(Value::String(id)), None) => {
            let n = id.encode_utf16().count();
            (1..=64).contains(&n).then(|| Answer::Option(id.clone()))
        }
        (None, Some(Value::String(t))) => {
            let t = js_trim(t);
            let n = t.encode_utf16().count();
            ((1..=ASK_TEXT_MAX_CHARS).contains(&n) && !t.contains('\0'))
                .then(|| Answer::Text(t.to_owned()))
        }
        _ => None,
    }
}

/// 공통 앞부분: 경로 → 볼 수 있는가 → 이 채널의 글인가. 통과하면 None.
async fn gate(st: &AskState, me: &str, channel: &str, message: &str) -> Option<Response> {
    match channel_visible(&st.read, me, channel).await {
        Ok(true) => {}
        Ok(false) => {
            return Some(json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this dm channel",
            ));
        }
        Err(e) => return Some(internal(e)),
    }
    let here: Result<bool, sqlx::Error> = sqlx::query_scalar(
        "select exists(select 1 from message where id = $1::uuid and channel_id = $2::uuid and deleted_at is null)",
    )
    .bind(message)
    .bind(channel)
    .fetch_one(&st.read)
    .await;
    match here {
        Ok(true) => None,
        Ok(false) => Some(no_request()),
        Err(e) => Some(internal(e)),
    }
}

type Boxed<'c> =
    std::pin::Pin<Box<dyn std::future::Future<Output = sqlx::Result<Outcome>> + Send + 'c>>;

/// 판정 → 쓰기 → 라우트의 `message.updated` → 커밋. 한 트랜잭션.
async fn commit_with<F>(st: &AskState, channel: &str, f: F) -> Response
where
    F: for<'c> FnOnce(&'c PgPool, &'c mut PgConnection) -> Boxed<'c>,
{
    let audience = match audience_for(&st.read, channel).await {
        Ok(a) => a.to_json(),
        Err(e) => return internal(e),
    };
    let r: sqlx::Result<Outcome> = async {
        let mut tx = st.write.begin().await?;
        let out = f(&st.read, &mut tx).await?;
        if let Outcome::Row(row) = &out {
            let message: Value =
                serde_json::from_str(row).map_err(|e| sqlx::Error::Decode(e.into()))?;
            crate::write::emit_event(
                &mut tx,
                &json!({ "type": "message.updated", "message": message, "audience": audience }),
            )
            .await?;
        }
        // 거절도 커밋한다 — 거울 경로는 진 경합에서도 거울을 맞춘다(TS 와 같다). 거절에 쓰기가 없으면 빈 커밋이다.
        tx.commit().await?;
        Ok(out)
    }
    .await;
    match r {
        Ok(o) => reply(o),
        Err(e) => internal(e),
    }
}

pub(super) async fn to_ts(
    up: Upstream,
    peer: SocketAddr,
    parts: axum::http::request::Parts,
    bytes: axum::body::Bytes,
) -> Response {
    crate::proxy::forward(
        State(up),
        ConnectInfo(peer),
        Request::from_parts(parts, Body::from(bytes)),
    )
    .await
}

/// 본문을 fastify 처럼 읽는다(한도 413 → 형식 400/415, `write::fastify_body`). 넘길 때 쓰려고 바이트도 돌려준다.
/// TS 처럼 인증보다 앞서지는 않는다 — 인증은 `route_layer` 라 익명은 본문과 상관없이 401 이다(`msg_edit`·`msg_delete` 와 같다).
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
pub(super) async fn read_bytes(
    headers: &axum::http::HeaderMap,
    body: Body,
) -> Result<(axum::body::Bytes, Option<Value>), Response> {
    let bytes = to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "fst_err_ctp_body_too_large",
            "Request body is too large",
        )
    })?;
    let parsed = crate::write::fastify_body(headers, &bytes)?;
    Ok((
        bytes,
        match parsed {
            crate::write::Body::Json(v) => Some(v),
            _ => None,
        },
    ))
}

/// `POST /channels/{id}/messages/{messageId}/ask-answer`.
pub async fn answer(
    State(st): State<Arc<AskState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, message)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad_request();
    }
    let (parts, body) = req.into_parts();
    let bytes = match read_bytes(&parts.headers, body).await {
        Ok((b, Some(v))) => match parse_answer(&v) {
            Some(a) => (b, a),
            None => return bad_request(),
        },
        Ok(_) => return bad_request(),
        Err(r) => return r,
    };
    let (bytes, ans) = bytes;
    if let Some(r) = gate(&st, &me.id, &id, &message).await {
        return r;
    }
    // C3b-3c — 권한 카드(거울 아님)의 거절은 3b 코어가 정한다. 그 밖의 권한 카드 답은 아래 `hand_to_ts` 가 TS 로 넘긴다.
    if let Answer::Option(o) = &ans
        && let super::decide_routes::Taken::Done(r) =
            super::decide_routes::answer_card_deny(&st, &me, &auth, &message, o).await
    {
        return r;
    }
    // S5.3 B2 — 소유자의 승인(tool approve·command approve_once/hour). 맡지 않는 꼴은 아래 `hand_to_ts` 가 TS 로 넘긴다.
    if let Answer::Option(o) = &ans
        && let super::decide_routes::Taken::Done(r) =
            super::decide_routes::answer_card_approve(&st, &me, &auth, &message, o).await
    {
        return r;
    }
    match hand_to_ts(&st.read, &message).await {
        Ok(false) => {}
        Ok(true) => return to_ts(st.up.clone(), peer, parts, bytes).await,
        Err(e) => return internal(e),
    }
    let actor = me.id.clone();
    commit_with(&st, &id, move |read, conn| {
        Box::pin(async move {
            match &ans {
                Answer::Text(t) => {
                    record_ask_answer(
                        read,
                        conn,
                        &message,
                        &actor,
                        ASK_TEXT_OPTION_ID,
                        Some(t),
                        None,
                    )
                    .await
                }
                Answer::Option(o) => {
                    record_ask_answer(read, conn, &message, &actor, o, None, None).await
                }
            }
        })
    })
    .await
}

/// `POST /channels/{id}/messages/{messageId}/ask-close`.
pub async fn close(
    State(st): State<Arc<AskState>>,
    RequireAccount(me, _): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, message)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&message) {
        return bad_request();
    }
    let (parts, body) = req.into_parts();
    let bytes = match read_bytes(&parts.headers, body).await {
        Ok((b, _)) => b,
        Err(r) => return r,
    };
    if let Some(r) = gate(&st, &me.id, &id, &message).await {
        return r;
    }
    match hand_to_ts(&st.read, &message).await {
        Ok(false) => {}
        Ok(true) => return to_ts(st.up.clone(), peer, parts, bytes).await,
        Err(e) => return internal(e),
    }
    let (actor, admin) = (me.id.clone(), me.is_admin);
    commit_with(&st, &id, move |read, conn| {
        Box::pin(async move { close_ask(read, conn, &message, &actor, admin).await })
    })
    .await
}

/// 코어 라우터에 합칠 줄 — `msg_delete.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: AskState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AskState>>::new()
        .post("/channels/{id}/messages/{messageId}/ask-answer", answer)
        .post("/channels/{id}/messages/{messageId}/ask-close", close)
        // C3b-3c — 권한 요청 거절 REST. 거절 풀(`deny`)이 없거나 맡지 않는 꼴이면 핸들러가 TS 로 넘긴다.
        .post(
            "/agents/{id}/permission-requests/{requestId}/deny",
            super::decide_routes::deny_route,
        )
        // S5.3 B2 — 승인 REST(정확한 글자만; `approve-once` 하이픈은 1회 머지라 TS). 승인 풀이 없거나 맡지 않으면 TS.
        .post(
            "/agents/{id}/permission-requests/{requestId}/approve",
            super::decide_routes::approve_route,
        )
        .post(
            "/agents/{id}/permission-requests/{requestId}/approve_once",
            super::decide_routes::approve_once_route,
        )
        .post(
            "/agents/{id}/permission-requests/{requestId}/approve_hour",
            super::decide_routes::approve_hour_route,
        )
        // `approve-once`(1회 머지) — 경로·세션·본문 거절만 Rust, 1회 승인 쓰기는 TS.
        .post(
            "/agents/{id}/permission-requests/{requestId}/approve-once",
            super::decide_routes::approve_once_merge_route,
        )
        // 그 밖의 낱말 — TS zod 처럼 400(고정 경로가 먼저 맞는다).
        .post(
            "/agents/{id}/permission-requests/{requestId}/{decision}",
            super::decide_routes::other_decision_route,
        )
        // C3b-2a — 묶음 카드 REST. 같은 표·같은 칸을 쓰므로 같은 잠금(`ASK_PRIVILEGES`)으로 함께 붙는다.
        .post(
            "/channels/{id}/messages/{messageId}/ask-bundle/answer",
            super::ask_bundle::answer,
        )
        .post(
            "/channels/{id}/messages/{messageId}/ask-bundle/accept-recommended",
            super::ask_bundle::accept_recommended,
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
    use super::*;

    fn card(extra: Value) -> Value {
        let mut m = json!({
            "kind": "ask",
            "ask": { "options": [{"id":"a","label":"A"},{"id":"b","label":"B"}], "to": {"kind":"human"} }
        });
        if let (Some(o), Some(e)) = (m.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                o.insert(k.clone(), v.clone());
            }
        }
        m
    }

    #[test]
    fn reads_plain_card() {
        let a = read_ask_meta(&card(json!({}))).expect("ask");
        assert_eq!(a.options, vec!["a", "b"]);
        assert_eq!(a.to, To::Human);
        assert!(a.mirror_of.is_none() && !a.answered && !a.closed);
    }

    #[test]
    fn unknown_kind_is_not_an_ask() {
        assert!(read_ask_meta(&card(json!({ "kind": "askBundle" }))).is_none());
        assert!(read_ask_meta(&card(json!({ "kind": "something_new" }))).is_none());
        assert!(read_ask_meta(&json!({ "ask": {} })).is_none());
    }

    #[test]
    fn one_option_only_for_permission_cards() {
        let one = json!({ "kind": "ask", "ask": { "options": [{"id":"x","label":"X"}], "to": {"kind":"human"} } });
        assert!(read_ask_meta(&one).is_none());
        let mut perm = one.clone();
        perm["permissionRequest"] = json!({});
        assert!(read_ask_meta(&perm).is_some());
    }

    #[test]
    fn markers_route_to_ts_and_block_text() {
        for k in TS_ONLY_MARKERS {
            let m = card(json!({ *k: {} }));
            assert!(has_ts_marker(&m), "{k}");
            assert!(!ask_takes_text(&m), "{k}");
        }
        assert!(ask_takes_text(&card(json!({}))));
    }

    #[test]
    fn body_union() {
        assert!(matches!(
            parse_answer(&serde_json::from_slice(br#"{"optionId":"a"}"#).unwrap()),
            Some(Answer::Option(_))
        ));
        assert!(
            matches!(parse_answer(&serde_json::from_slice(br#"{"text":"  hi  "}"#).unwrap()), Some(Answer::Text(t)) if t == "hi")
        );
        assert!(
            parse_answer(&serde_json::from_slice(br#"{"optionId":"a","text":"x"}"#).unwrap())
                .is_none()
        );
        assert!(parse_answer(&serde_json::from_slice(br#"{"optionId":""}"#).unwrap()).is_none());
        assert!(parse_answer(&serde_json::from_slice(br#"{"text":"   "}"#).unwrap()).is_none());
        assert!(
            parse_answer(&serde_json::from_slice(br#"{"text":"a\u0000b"}"#).unwrap()).is_none()
        );
        assert!(
            parse_answer(&serde_json::from_slice(br#"{"text":"x","optionId":null}"#).unwrap())
                .is_none()
        );
        assert!(parse_answer(&json!([])).is_none());
        let long = format!(r#"{{"text":"{}"}}"#, "가".repeat(ASK_TEXT_MAX_CHARS + 1));
        assert!(parse_answer(&serde_json::from_str(&long).unwrap()).is_none());
    }
}
