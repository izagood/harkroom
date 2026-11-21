//! S5.3 C3b-3c — 권한 카드 **거절**(deny)을 라우트에 잇는다. 판정·쓰기는 3b 코어([`super::decide_core::decide_deny`])다.
//!
//! 붙는 입구 셋(모두 `HARKROOM_CORE=rust` + 쓰기 풀 `ASK_PRIVILEGES` + 거절 두 겹 검사([`super::decide_core::deny_pool`])일 때만):
//! 1. `POST /agents/{id}/permission-requests/{requestId}/deny` — TS `permissionRequestRoutes.ts`.
//! 2. `POST /channels/{id}/messages/{messageId}/ask-answer` 의 권한 카드 + `deny` — TS `messageRoutes.ts`. S5.5 d 부터 권한 카드의
//!    **거울**도 맡는다([`card_target`]): 서버가 세운 진짜 거울이고 누른 사람이 원본 채널을 보면 원본 요청을 정하고(`via: mirror`),
//!    답은 원본 카드에 적혀 `sync_ask_mirrors` 가 거울을 같은 tx 에서 닫는다. 응답은 누른 거울 글이다.
//! 3. `POST /channels/{id}/messages/{messageId}/ask-bundle/answer` 의 권한 줄 + `deny` — TS `answerBundleItem`(`via: bundle`).
//!
//! **맡지 않으면 언제나 쓰기 전에 TS 로 넘긴다**(읽은 바이트 그대로): 사람 세션이 아님·uuid 아님·요청 줄의 에이전트가 경로와 다름·
//! 진짜 거울이 아님·`once`·거절이 아닌 선택지·코어가 `HandToTs`(만료·꼴 바뀜). 코어가 쓰기 tx 안에서 실패하면 `internal` 이고 TS 로 넘기지 않는다.
//!
//! **W1(security, 3b 검토)** — `bundle_message_id` 는 [`answer_bundle_deny`] 를 부르기 **전에** 호출자(`ask_bundle::answer`)가
//! 「그 묶음 글이 이 채널의 묶음이고 그 줄(rootId)을 담는다」를 확인한 뒤에만 넘긴다. 여기서도 그 줄의 원본이 권한 카드인지·원본 채널을
//! 볼 수 있는지·거울이 아닌지를 TS 와 같은 순서로 다시 본다.
//!
//! 커밋 뒤(TS `decidePermissionRequest` 끝과 같은 자리): 카드에 누른 사람 이름으로 답을 적어 에이전트를 깨우고(`viaPermissionDecision`),
//! 카드 `message.updated` 를 낸다. 답 적기가 실패해도 결정은 남는다(TS 도 결정 커밋 뒤의 일이다).
use super::ask::{AskState, ok_json, read_ask_row, record_permission_answer, to_ts};
use super::audience::audience_on;
use super::decide_approve::{ApproveArgs, ApproveOutcome, decide_approve};
use super::decide_core::{
    DecisionRef, DenyArgs, DenyOutcome, channel_visible_conn, decide_deny,
    is_genuine_permission_mirror, resolve_decision,
};
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::{Account, Auth, Via};
use crate::directory::{internal, json_err};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;

/// 거절 선택지 id(TS `PERMISSION_OPTION_DENY`).
pub const DENY_OPTION: &str = "deny";

/// TS 권한 라우트가 받는 사람: 앱 세션의 사람만.
pub fn human_session(me: &Account, auth: &Auth) -> bool {
    me.kind == "human" && auth.via == Some(Via::Session)
}

/// 거절 코어 한 번 + 커밋 뒤 카드 답. `Err` 는 곧 응답(internal)이다.
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
pub(crate) async fn deny_then_answer(
    st: &AskState,
    deny: &PgPool,
    args: DenyArgs<'_>,
) -> Result<DenyOutcome, Response> {
    let out = match decide_deny(deny, args).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("front: permission deny failed ({e:?})");
            return Err(json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            ));
        }
    };
    if let DenyOutcome::Denied {
        card_message_id: Some(card),
        ..
    } = &out
        && let Err(e) = answer_card(st, card, args.actor_id).await
    {
        // 결정은 이미 커밋됐다 — TS 도 답 적기 실패를 결정 실패로 돌리지 않는다(500 이 나지만 결정은 남는다).
        return Err(internal(e));
    }
    Ok(out)
}

/// TS `answerOptionId(card, ['deny'])` — 카드 선택지에 `deny` 가 있으면 그것, 없으면 그래도 `deny`(깨우지 못할 뿐).
async fn answer_card(st: &AskState, card: &str, actor: &str) -> sqlx::Result<()> {
    answer_card_with(st, card, actor, DENY_OPTION).await
}

async fn answer_card_with(
    st: &AskState,
    card: &str,
    actor: &str,
    option: &str,
) -> sqlx::Result<()> {
    let mut tx = st.write.begin().await?;
    // 카드에 없는 선택지면 `UnknownOption` 으로 끝나 깨우지 못한다 — TS 와 같다.
    let _ = record_permission_answer(&st.read, &mut tx, card, actor, option).await?;
    if let Some((_, channel, _)) = read_ask_row(&mut tx, card).await?
        && let Some(row) = message_by_id(&mut *tx, card).await?
    {
        let message: Value =
            serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
        let audience = audience_on(&mut tx, &channel).await?.to_json();
        crate::write::emit_event(
            &mut tx,
            &json!({ "type": "message.updated", "message": message, "audience": audience }),
        )
        .await?;
    }
    tx.commit().await
}

fn refusal(status: u16, code: &str, message: &str) -> Response {
    json_err(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        code,
        message,
    )
}

/// 카드·묶음 길의 거절 문구 바꿈(TS: `already_decided`·`request_expired` → `already_answered`).
fn card_refusal(status: u16, code: &str, message: &str) -> Response {
    let code = match code {
        "already_decided" | "request_expired" => "already_answered",
        c => c,
    };
    refusal(status, code, message)
}

/// 맡을지 본 결과. `Hand` 면 호출자가 읽은 바이트 그대로 TS 로 넘긴다(쓰기 전).
pub enum Taken {
    Done(Response),
    Hand,
}

/// 1. `POST /agents/{id}/permission-requests/{requestId}/deny`. 응답은 TS 와 같은 `{ status, grantExpiresAt, cardMessageId }`.
pub async fn rest_deny(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    agent: &str,
    request: &str,
) -> Taken {
    let Some(deny) = st.deny.as_ref() else {
        return Taken::Hand;
    };
    if !is_uuid(agent) || !is_uuid(request) || !human_session(me, auth) {
        return Taken::Hand;
    }
    // TS 는 경로 에이전트가 요청 줄과 다르면 판정 순서상 403/404 가 갈린다 — 그 꼴은 TS 가 한다.
    let peek: sqlx::Result<Option<String>> =
        sqlx::query_scalar("select agent_id::text from permission_request where id = $1::uuid")
            .bind(request)
            .fetch_optional(&st.read)
            .await;
    match peek {
        Ok(Some(a)) if a == agent => {}
        Ok(_) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    }
    let args = DenyArgs {
        agent_id: agent,
        request_id: request,
        actor_id: &me.id,
        bundle_message_id: None,
        mirror_message_id: None,
        chat: None,
    };
    Taken::Done(match deny_then_answer(st, deny, args).await {
        Err(r) => r,
        Ok(DenyOutcome::HandToTs) => return Taken::Hand,
        Ok(DenyOutcome::Refused {
            status,
            code,
            message,
        }) => refusal(status, code, &message),
        Ok(DenyOutcome::Denied {
            card_message_id, ..
        }) => ok_json(
            json!({ "status": "denied", "grantExpiresAt": null, "cardMessageId": card_message_id })
                .to_string(),
        ),
    })
}

/// 카드가 거울이 아닌 권한 카드면 (request, agent). 아니면 `None`(호출자 흐름 그대로).
async fn permission_card(st: &AskState, card: &str) -> sqlx::Result<Option<(String, String)>> {
    let mut conn = st.read.acquire().await?;
    Ok(match resolve_decision(&mut conn, card).await {
        Ok(Some(DecisionRef::Permission {
            request_id,
            agent_id,
            mirror_message_id: None,
            ..
        })) => Some((request_id, agent_id)),
        Ok(_) => None,
        // 못 읽는 거울 표지 등 — 맡지 않는다(호출자가 TS 로 넘긴다).
        Err(sqlx::Error::Protocol(_)) => None,
        Err(e) => return Err(e),
    })
}

/// ask-answer 로 누른 권한 카드가 정할 요청. `mirror` 가 있으면 누른 글은 거울이고 `root` 가 원본 카드다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PermTarget {
    request: String,
    agent: String,
    root: String,
    mirror: Option<String>,
}

enum CardTarget {
    Go(PermTarget),
    /// 권한 카드(또는 그 진짜 거울)가 아니다 — 호출자 흐름 그대로(TS 로 넘김).
    Hand,
    /// 진짜 거울인데 누른 사람이 원본 채널을 못 본다 — TS `decide` 의 `forbidden`(쓰기 전).
    Forbidden,
}

/// 카드·거울 길의 거절 문구 바꿈. 원본 카드 길은 `already_decided`·`request_expired` 를, 거울 길은 TS `messageRoutes.ts`
/// 대로 `already_decided` 만 `already_answered` 로 바꾼다.
fn mirror_refusal_code(via_mirror: bool, code: &str) -> &str {
    match code {
        "already_decided" => "already_answered",
        "request_expired" if !via_mirror => "already_answered",
        c => c,
    }
}

/// TS 거울 길의 404(누른 거울이 결정 뒤 사라짐).
pub const MIRROR_NOT_FOUND: &str = "no such choice request";

fn mirror_forbidden() -> Response {
    refusal(403, "forbidden", super::decide_core::FORBIDDEN_MESSAGE)
}

impl PermTarget {
    fn refusal(&self, status: u16, code: &str, message: &str) -> Response {
        refusal(
            status,
            mirror_refusal_code(self.mirror.is_some(), code),
            message,
        )
    }

    /// 정한 뒤 돌려줄 글 — 원본 카드 길은 원본(없으면 null), 거울 길은 누른 거울(없으면 404).
    async fn decided_reply(&self, st: &AskState) -> Response {
        match &self.mirror {
            None => match message_by_id(&st.read, &self.root).await {
                Ok(Some(row)) => ok_json(row),
                Ok(None) => ok_json("null".to_owned()),
                Err(e) => internal(e),
            },
            Some(m) => match message_by_id(&st.read, m).await {
                Ok(Some(row)) => ok_json(row),
                Ok(None) => json_err(StatusCode::NOT_FOUND, "not_found", MIRROR_NOT_FOUND),
                Err(e) => internal(e),
            },
        }
    }
}

/// TS `resolveDecision` + `decide` 앞머리(거울 갈래). 권한 카드면 그 요청, 권한 카드의 거울이면 **서버가 세운 진짜 거울**
/// (`isGenuinePermissionMirror`)이고 누른 사람이 원본 채널을 볼 때만 원본 요청. 진짜 거울이 아니면 TS 는 물음 길로 가서
/// 거절한다 — 그 길은 TS 가 한다(`Hand`). 모두 쓰기 전 읽기다.
async fn card_target(st: &AskState, card: &str, actor: &str) -> sqlx::Result<CardTarget> {
    let mut conn = st.read.acquire().await?;
    let r = match resolve_decision(&mut conn, card).await {
        Ok(r) => r,
        // 못 읽는 거울 표지 등 — 맡지 않는다(호출자가 TS 로 넘긴다).
        Err(sqlx::Error::Protocol(_)) => return Ok(CardTarget::Hand),
        Err(e) => return Err(e),
    };
    let Some(DecisionRef::Permission {
        request_id,
        agent_id,
        card_message_id: Some(root),
        mirror_message_id,
        ..
    }) = r
    else {
        return Ok(CardTarget::Hand);
    };
    if let Some(m) = &mirror_message_id {
        if !is_genuine_permission_mirror(&mut conn, m, &root, &agent_id).await? {
            return Ok(CardTarget::Hand);
        }
        // TS: 거울로 정하는 사람도 원본 채널을 볼 수 있어야 한다. 원본이 사라졌으면(경합) TS 도 forbidden.
        let Some((_, root_channel, _)) = read_ask_row(&mut conn, &root).await? else {
            return Ok(CardTarget::Forbidden);
        };
        if !channel_visible_conn(&mut conn, &root_channel, actor).await? {
            return Ok(CardTarget::Forbidden);
        }
    }
    Ok(CardTarget::Go(PermTarget {
        request: request_id,
        agent: agent_id,
        root,
        mirror: mirror_message_id,
    }))
}

/// 2⁰. ask-answer 의 권한 카드(와 그 거울)에 **선택지**로 온 답 가운데 TS 가 쓰기 없이 거절하는 꼴 — Rust 가 같은 답을 한다
/// (TS `messageRoutes.ts` ask-answer + `decisions.ts` `decide` 의 차례 그대로). 모두 읽기뿐이라 풀 권한과 무관하다.
/// - 권한 카드(`meta ? 'permissionRequest'`)인데 사람 세션이 아님 → 403(`NOT_SESSION`).
/// - 권한 카드인데 그 뒤에 요청 줄이 없음 → 404.
/// - 권한 카드의 거울인데 사람 세션이 아님 → 403(진짜 거울 판정보다 앞).
/// - 모르는 선택지: 정할 수 없는 사람이면 403, 아니면 400 `unknown_option`(원본 채널 보기 판정보다 앞).
///
/// 아는 선택지·표지 없는 요청 줄 카드·진짜가 아닌 거울(TS 는 물음 길)·표지와 거울 표지가 함께 있는 꼴(TS 는 500)은 `Hand` —
/// 호출자의 다음 갈래가 맡는다.
pub async fn answer_card_refuse(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    card: &str,
    option: &str,
) -> Taken {
    match card_refusal_of(st, me, auth, card, option).await {
        Ok(Some(r)) => Taken::Done(r),
        Ok(None) => Taken::Hand,
        Err(e) => Taken::Done(internal(e)),
    }
}

async fn card_refusal_of(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    card: &str,
    option: &str,
) -> sqlx::Result<Option<Response>> {
    let mut conn = st.read.acquire().await?;
    let marked: Option<bool> = sqlx::query_scalar(
        "select meta ? 'permissionRequest' from message where id = $1::uuid and deleted_at is null",
    )
    .bind(card)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(marked) = marked else {
        return Ok(None);
    };
    let session = human_session(me, auth);
    let not_session = || Some(refusal(403, "forbidden", NOT_SESSION));
    if marked && !session {
        return Ok(not_session());
    }
    let r = match resolve_decision(&mut conn, card).await {
        Ok(r) => r,
        Err(sqlx::Error::Protocol(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(DecisionRef::Permission {
        request_id,
        agent_id,
        card_message_id: Some(root),
        mirror_message_id,
        ..
    }) = r
    else {
        return Ok(marked.then(|| refusal(404, "not_found", NO_REQUEST_BEHIND)));
    };
    match (marked, &mirror_message_id) {
        // 표지가 있는 글이 거울이기도 하다(TS 500)·표지 없는 요청 줄 카드(TS 물음 길) — 맡지 않는다.
        (true, Some(_)) | (false, None) => return Ok(None),
        (false, Some(_)) if !session => return Ok(not_session()),
        _ => {}
    }
    if super::decide_core::option_decision(option).is_some() {
        return Ok(None);
    }
    if let Some(m) = &mirror_message_id
        && !is_genuine_permission_mirror(&mut conn, m, &root, &agent_id).await?
    {
        return Ok(None);
    }
    let channel: Option<Option<String>> = sqlx::query_scalar(
        "select channel_id::text from permission_request where id = $1::uuid and agent_id = $2::uuid",
    )
    .bind(&request_id)
    .bind(&agent_id)
    .fetch_optional(&mut *conn)
    .await?;
    let v = super::decide_core::may_decide_for_unlocked(
        &mut conn,
        &agent_id,
        &me.id,
        channel.flatten().as_deref(),
    )
    .await?;
    Ok(Some(if v.ok.is_none() {
        mirror_forbidden()
    } else {
        refusal(
            400,
            "unknown_option",
            super::decide_core::UNKNOWN_OPTION_MESSAGE,
        )
    }))
}

/// TS ask-answer 의 404 — 권한 표지는 있는데 요청 줄이 없는 카드.
pub const NO_REQUEST_BEHIND: &str = "no permission request behind this card";

/// 2. ask-answer 의 권한 카드 거절. `gate`(채널 보기·카드가 이 채널 글) 뒤에 부른다.
pub async fn answer_card_deny(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    card: &str,
    option: &str,
) -> Taken {
    let Some(deny) = st.deny.as_ref() else {
        return Taken::Hand;
    };
    if option != DENY_OPTION || !human_session(me, auth) {
        return Taken::Hand;
    }
    let t = match card_target(st, card, &me.id).await {
        Ok(CardTarget::Go(t)) => t,
        Ok(CardTarget::Hand) => return Taken::Hand,
        Ok(CardTarget::Forbidden) => return Taken::Done(mirror_forbidden()),
        Err(e) => return Taken::Done(internal(e)),
    };
    let args = DenyArgs {
        agent_id: &t.agent,
        request_id: &t.request,
        actor_id: &me.id,
        bundle_message_id: None,
        mirror_message_id: t.mirror.as_deref(),
        chat: None,
    };
    Taken::Done(match deny_then_answer(st, deny, args).await {
        Err(r) => r,
        Ok(DenyOutcome::HandToTs) => return Taken::Hand,
        Ok(DenyOutcome::Refused {
            status,
            code,
            message,
        }) => t.refusal(status, code, &message),
        // TS `decidedCard` — 답이 적힌 원본 카드(거울이면 누른 거울).
        Ok(DenyOutcome::Denied { .. }) => t.decided_reply(st).await,
    })
}

/// 3. 묶음 줄의 권한 카드 거절. **W1:** 호출자가 `bundle`(이 채널의 묶음)이 `root` 줄을 담는다고 확인한 뒤에만 부른다.
pub async fn answer_bundle_deny(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    bundle: &str,
    root: &str,
    option: &str,
) -> Taken {
    let Some(deny) = st.deny.as_ref() else {
        return Taken::Hand;
    };
    if option != DENY_OPTION || !human_session(me, auth) {
        return Taken::Hand;
    }
    // TS `answerBundleItem` 순서: 원본 읽기 → 원본 채널 보기 → 거울 아님 → 권한 카드. 하나라도 어긋나면 TS 가 그 문구로 답한다.
    let row = {
        let mut conn = match st.read.acquire().await {
            Ok(c) => c,
            Err(e) => return Taken::Done(internal(e)),
        };
        match read_ask_row(&mut conn, root).await {
            Ok(r) => r,
            Err(e) => return Taken::Done(internal(e)),
        }
    };
    let Some((ask, root_channel, _)) = row else {
        return Taken::Hand;
    };
    if ask.mirror_of.is_some() {
        return Taken::Hand;
    }
    match channel_visible(&st.read, &me.id, &root_channel).await {
        Ok(true) => {}
        Ok(false) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    }
    let (request, agent) = match permission_card(st, root).await {
        Ok(Some(p)) => p,
        Ok(None) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    };
    let args = DenyArgs {
        agent_id: &agent,
        request_id: &request,
        actor_id: &me.id,
        bundle_message_id: Some(bundle),
        mirror_message_id: None,
        chat: None,
    };
    Taken::Done(match deny_then_answer(st, deny, args).await {
        Err(r) => r,
        Ok(DenyOutcome::HandToTs) => return Taken::Hand,
        Ok(DenyOutcome::Refused {
            status,
            code,
            message,
        }) => card_refusal(status, code, &message),
        Ok(DenyOutcome::Denied { .. }) => match message_by_id(&st.read, bundle).await {
            Ok(Some(row)) => ok_json(row),
            Ok(None) => json_err(
                StatusCode::NOT_FOUND,
                "not_found",
                super::ask_bundle::BUNDLE_NOT_FOUND,
            ),
            Err(e) => internal(e),
        },
    })
}

/// `POST /agents/{id}/permission-requests/{requestId}/deny` 핸들러 — 본문은 fastify 규칙으로 읽고(TS 는 deny 본문을 보지 않는다), 맡지 않으면 TS.
pub async fn deny_route(
    axum::extract::State(st): axum::extract::State<std::sync::Arc<AskState>>,
    crate::auth::RequireAccount(me, auth): crate::auth::RequireAccount,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    axum::extract::Path((agent, request)): axum::extract::Path<(String, String)>,
    req: axum::extract::Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((b, _)) => b,
        Err(r) => return r,
    };
    match rest_deny(&st, &me, &auth, &agent, &request).await {
        Taken::Done(r) => r,
        Taken::Hand => to_ts(st.up.clone(), peer, parts, bytes).await,
    }
}

// ───────────────────────── S5.3 B2 승인(approve) ─────────────────────────

/// Rust 가 맡을 수 있는 승인 선택지(꼴은 코어가 잠근 요청 줄로 다시 가른다 — tool·approve, command·approve_once/hour,
/// C1 의 tool·approve_mandate/approve_turn). REST 경로는 TS 의 decision 목록(`approve`·`approve_once`·`approve_hour`)만 붙인다 —
/// `approve_mandate`·`approve_turn` 은 TS 도 REST 에서 400 이라 카드·묶음 답으로만 온다.
pub fn is_approve_option(option: &str) -> bool {
    matches!(
        option,
        "approve"
            | "approve_mandate"
            | "approve_new_mandate"
            | "approve_turn"
            | "approve_once"
            | "approve_hour"
    )
}

/// TS `onceFromCard` 가 값을 만드는 꼴인가 — `permissionRequest.once` 에 숫자 `number` 와 문자열 `headSha`.
const CARD_HAS_ONCE: &str = "select coalesce(jsonb_typeof(meta->'permissionRequest'->'once'->'number') = 'number' \
     and jsonb_typeof(meta->'permissionRequest'->'once'->'headSha') = 'string', false) from message where id = $1::uuid";

/// TS `answerOptionId` — 후보 중 카드 선택지에 있는 첫 것, 없으면 첫 후보.
const CARD_OPTION_IDS: &str = "select coalesce(array(select jsonb_array_elements(meta->'ask'->'options')->>'id'), '{}') \
     from message where id = $1::uuid";

async fn pick_answer(
    read: &PgPool,
    card: &str,
    candidates: &[&'static str],
) -> sqlx::Result<&'static str> {
    let ids: Option<Vec<Option<String>>> = sqlx::query_scalar(CARD_OPTION_IDS)
        .bind(card)
        .fetch_optional(read)
        .await?;
    let ids = ids.unwrap_or_default();
    Ok(candidates
        .iter()
        .find(|c| ids.iter().any(|i| i.as_deref() == Some(**c)))
        .copied()
        .unwrap_or(candidates[0]))
}

/// 승인 코어 한 번 + 커밋 뒤 카드 답. `Err` 는 곧 응답(internal)이다.
#[allow(clippy::result_large_err)]
pub(crate) async fn approve_then_answer(
    st: &AskState,
    pool: &PgPool,
    args: ApproveArgs<'_>,
) -> Result<ApproveOutcome, Response> {
    let out = match decide_approve(pool, args).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("front: permission approve failed ({e:?})");
            return Err(json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            ));
        }
    };
    if let ApproveOutcome::Granted {
        card_message_id: Some(card),
        answer_candidates,
        ..
    } = &out
    {
        let r = match pick_answer(&st.read, card, answer_candidates).await {
            Ok(option) => answer_card_with(st, card, args.actor_id, option).await,
            Err(e) => Err(e),
        };
        if let Err(e) = r {
            return Err(internal(e));
        }
    }
    // P3 B4e — TS 와 같은 자리(카드 답 뒤): 소유자가 아닌 사람의 승인이면 소유자에게 알린다. 실패해도 결정은 남는다.
    if let ApproveOutcome::Granted {
        owner_notice: Some(n),
        ..
    } = &out
    {
        match &st.owner_notice {
            Some(post) => super::decide_owner_notice::notify_owner(post, n).await,
            None => eprintln!(
                "[permissionRequests] 소유자 알림 실패: no post state requestId={}",
                n.request_id
            ),
        }
    }
    Ok(out)
}

/// REST 승인 — `POST /agents/{id}/permission-requests/{requestId}/{approve|approve_once|approve_hour}`.
/// 응답은 TS 와 같은 `{ status, grantExpiresAt, cardMessageId, grantMode? }`.
pub async fn rest_approve(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    agent: &str,
    request: &str,
    option: &str,
    once: Option<&super::decide_merge_once::Once>,
) -> Taken {
    let Some(pool) = st.approve.as_ref() else {
        return Taken::Hand;
    };
    if !is_approve_option(option)
        || !is_uuid(agent)
        || !is_uuid(request)
        || !human_session(me, auth)
    {
        return Taken::Hand;
    }
    let peek: sqlx::Result<Option<String>> =
        sqlx::query_scalar("select agent_id::text from permission_request where id = $1::uuid")
            .bind(request)
            .fetch_optional(&st.read)
            .await;
    match peek {
        Ok(Some(a)) if a == agent => {}
        Ok(_) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    }
    let args = ApproveArgs {
        agent_id: agent,
        request_id: request,
        actor_id: &me.id,
        option,
        // REST 는 카드를 거치지 않는다(TS: `ref.cardMessageId` null → onceFromCard 안 부름). `approve-once` 만 본문에서 once 를 받는다.
        has_once: once.is_some(),
        once,
        bundle_message_id: None,
        mirror_message_id: None,
        chat: None,
    };
    Taken::Done(match approve_then_answer(st, pool, args).await {
        Err(r) => r,
        Ok(ApproveOutcome::HandToTs) => return Taken::Hand,
        Ok(ApproveOutcome::Refused {
            status,
            code,
            message,
        }) => refusal(status, code, &message),
        Ok(ApproveOutcome::Granted {
            status,
            approval_expires_at,
            card_message_id,
            grant_expires_at,
            grant_mode,
            ..
        }) => {
            let mut body = json!({
                "status": status, "grantExpiresAt": grant_expires_at,
            });
            if let Some(a) = approval_expires_at {
                body["approvalExpiresAt"] = json!(a);
            }
            body["cardMessageId"] = json!(card_message_id);
            if let Some(m) = grant_mode {
                body["grantMode"] = json!(m);
            }
            ok_json(body.to_string())
        }
    })
}

const CARD_META: &str = "select meta from message where id = $1::uuid";

async fn card_has_once(
    read: &PgPool,
    card: &str,
    option: &str,
) -> sqlx::Result<(bool, Option<super::decide_merge_once::Once>)> {
    // TS 는 `approve_once` 일 때만 카드에서 1회 머지 값을 읽는다.
    if option != "approve_once" {
        return Ok((false, None));
    }
    let has = sqlx::query_scalar::<_, bool>(CARD_HAS_ONCE)
        .bind(card)
        .fetch_optional(read)
        .await?
        .unwrap_or(false);
    if !has {
        return Ok((false, None));
    }
    // 값이 정수가 아니면(드문 꼴) once 없이 — 머지 갈래는 쓰기 전에 TS 로 넘긴다.
    let meta: Option<serde_json::Value> = sqlx::query_scalar(CARD_META)
        .bind(card)
        .fetch_optional(read)
        .await?;
    Ok((
        true,
        meta.as_ref()
            .and_then(super::decide_merge_once::once_from_card),
    ))
}

/// 2'. ask-answer 의 권한 카드 승인. `gate` 뒤에 부른다.
pub async fn answer_card_approve(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    card: &str,
    option: &str,
) -> Taken {
    let Some(pool) = st.approve.as_ref() else {
        return Taken::Hand;
    };
    if !is_approve_option(option) || !human_session(me, auth) {
        return Taken::Hand;
    }
    let t = match card_target(st, card, &me.id).await {
        Ok(CardTarget::Go(t)) => t,
        Ok(CardTarget::Hand) => return Taken::Hand,
        Ok(CardTarget::Forbidden) => return Taken::Done(mirror_forbidden()),
        Err(e) => return Taken::Done(internal(e)),
    };
    // 거울에서 [이번 한 번]을 누르면 PR·head 는 원본 카드가 보인 값이다(TS `onceFromCard(ref.cardMessageId)`).
    let (has_once, once) = match card_has_once(&st.read, &t.root, option).await {
        Ok(b) => b,
        Err(e) => return Taken::Done(internal(e)),
    };
    let args = ApproveArgs {
        agent_id: &t.agent,
        request_id: &t.request,
        actor_id: &me.id,
        option,
        has_once,
        once: once.as_ref(),
        bundle_message_id: None,
        mirror_message_id: t.mirror.as_deref(),
        chat: None,
    };
    Taken::Done(match approve_then_answer(st, pool, args).await {
        Err(r) => r,
        Ok(ApproveOutcome::HandToTs) => return Taken::Hand,
        Ok(ApproveOutcome::Refused {
            status,
            code,
            message,
        }) => t.refusal(status, code, &message),
        Ok(ApproveOutcome::Granted { .. }) => t.decided_reply(st).await,
    })
}

/// 3'. 묶음 줄의 권한 카드 승인. **W1:** 호출자가 `bundle` 이 `root` 줄을 담는다고 확인한 뒤에만 부른다.
pub async fn answer_bundle_approve(
    st: &AskState,
    me: &Account,
    auth: &Auth,
    bundle: &str,
    root: &str,
    option: &str,
    body_once: Option<&super::decide_merge_once::Once>,
) -> Taken {
    let Some(pool) = st.approve.as_ref() else {
        return Taken::Hand;
    };
    if !is_approve_option(option) || !human_session(me, auth) {
        return Taken::Hand;
    }
    let row = {
        let mut conn = match st.read.acquire().await {
            Ok(c) => c,
            Err(e) => return Taken::Done(internal(e)),
        };
        match read_ask_row(&mut conn, root).await {
            Ok(r) => r,
            Err(e) => return Taken::Done(internal(e)),
        }
    };
    let Some((ask, root_channel, _)) = row else {
        return Taken::Hand;
    };
    if ask.mirror_of.is_some() {
        return Taken::Hand;
    }
    match channel_visible(&st.read, &me.id, &root_channel).await {
        Ok(true) => {}
        Ok(false) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    }
    let (request, agent) = match permission_card(st, root).await {
        Ok(Some(p)) => p,
        Ok(None) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    };
    // TS `decide`: 본문의 `once` 가 먼저고(입구가 `approve_once` 일 때만 넘긴다), 없으면 카드가 보인 값이다.
    let (has_once, once) = match body_once {
        Some(o) => (true, Some(o.clone())),
        None => match card_has_once(&st.read, root, option).await {
            Ok(b) => b,
            Err(e) => return Taken::Done(internal(e)),
        },
    };
    let args = ApproveArgs {
        agent_id: &agent,
        request_id: &request,
        actor_id: &me.id,
        option,
        has_once,
        once: once.as_ref(),
        bundle_message_id: Some(bundle),
        mirror_message_id: None,
        chat: None,
    };
    Taken::Done(match approve_then_answer(st, pool, args).await {
        Err(r) => r,
        Ok(ApproveOutcome::HandToTs) => return Taken::Hand,
        Ok(ApproveOutcome::Refused {
            status,
            code,
            message,
        }) => card_refusal(status, code, &message),
        Ok(ApproveOutcome::Granted { .. }) => match message_by_id(&st.read, bundle).await {
            Ok(Some(row)) => ok_json(row),
            Ok(None) => json_err(
                StatusCode::NOT_FOUND,
                "not_found",
                super::ask_bundle::BUNDLE_NOT_FOUND,
            ),
            Err(e) => internal(e),
        },
    })
}

#[allow(clippy::too_many_arguments)]
/// 승인 REST 핸들러 셋을 한 꼴로 — 경로 마지막 낱말이 선택지다(라우트 표에 정확한 글자만 적는다).
async fn approve_route_with(
    st: std::sync::Arc<AskState>,
    me: Account,
    auth: Auth,
    peer: std::net::SocketAddr,
    agent: String,
    request: String,
    option: &'static str,
    req: axum::extract::Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((b, _)) => b,
        Err(r) => return r,
    };
    match rest_approve(&st, &me, &auth, &agent, &request, option, None).await {
        Taken::Done(r) => r,
        Taken::Hand => to_ts(st.up.clone(), peer, parts, bytes).await,
    }
}

macro_rules! approve_route {
    ($name:ident, $option:literal) => {
        pub async fn $name(
            axum::extract::State(st): axum::extract::State<std::sync::Arc<AskState>>,
            crate::auth::RequireAccount(me, auth): crate::auth::RequireAccount,
            axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
            axum::extract::Path((agent, request)): axum::extract::Path<(String, String)>,
            req: axum::extract::Request,
        ) -> Response {
            approve_route_with(st, me, auth, peer, agent, request, $option, req).await
        }
    };
}
approve_route!(approve_route, "approve");
approve_route!(approve_once_route, "approve_once");
approve_route!(approve_hour_route, "approve_hour");

const BAD_PARAMS: &str = "agent id and request id must be uuids; decision is approve, approve-once (a merge refusal card), approve_once, approve_hour (an exact command) or deny";
const NOT_SESSION: &str = "only a person signed in to the app can decide a permission request";
const BAD_ONCE: &str = "number and a 40-hex headSha are required; ghUser is optional (null lets the operator pick); relaxChecks is a boolean; nothing else";

/// TS `onceBody`(`.strict()`) — `{ ghUser?: string(1..39)|null, relaxChecks?: bool, number, headSha, failedChecks?: string(≤200)[≤20] }`.
pub fn once_body_ok(body: Option<&serde_json::Value>) -> bool {
    let empty = serde_json::Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        for k in o.keys() {
            if !matches!(
                k.as_str(),
                "ghUser" | "relaxChecks" | "number" | "headSha" | "failedChecks"
            ) {
                return None;
            }
        }
        match o.get("ghUser") {
            None | Some(Value::Null) => {}
            Some(v) => {
                super::merge_approval_peek::str_len_ok(v, 1, 39)?;
            }
        }
        if let Some(v) = o.get("relaxChecks") {
            v.as_bool()?;
        }
        super::merge_approval_peek::positive_int(o.get("number")?)?;
        let h = o.get("headSha")?.as_str()?;
        if !(h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))) {
            return None;
        }
        if let Some(v) = o.get("failedChecks") {
            let a = v.as_array()?;
            if a.len() > 20 {
                return None;
            }
            for x in a {
                super::merge_approval_peek::str_len_ok(x, 0, 200)?;
            }
        }
        Some(())
    })();
    ok.is_some()
}

/// TS 라우트의 `once` — `{ ghUser: ghUser ?? null, relaxChecks: relaxChecks ?? false, number, headSha, failedChecks? }`.
/// [`once_body_ok`] 를 지난 본문에만 부른다. number 가 i64 로 안 읽히면 `None`(TS 로 넘긴다).
pub fn once_from_body(body: Option<&serde_json::Value>) -> Option<super::decide_merge_once::Once> {
    let o = body?.as_object()?;
    let number = super::merge_approval_peek::positive_int(o.get("number")?)?;
    Some(super::decide_merge_once::Once {
        gh_user: o.get("ghUser").and_then(Value::as_str).map(str::to_owned),
        relax_checks: o
            .get("relaxChecks")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        number,
        head_sha: o.get("headSha")?.as_str()?.to_owned(),
        failed_checks: o.get("failedChecks").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        }),
    })
}

/// `POST /agents/{id}/permission-requests/{requestId}/approve-once`(1회 머지, 머지 거절 카드).
/// 판정 전 세 갈래(경로 400·사람 세션 아님 403·본문 400)는 Rust. 그 뒤 1회 승인 쓰기도 Rust(10차 카드 [이번 한 번]과 같은 코어,
/// once 는 본문에서) — 맡지 않는 꼴(위임장·소유자 아님·만료·스위치 꺼짐 등)은 쓰기 전에 TS.
pub async fn approve_once_merge_route(
    axum::extract::State(st): axum::extract::State<std::sync::Arc<AskState>>,
    crate::auth::RequireAccount(me, auth): crate::auth::RequireAccount,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    axum::extract::Path((agent, request)): axum::extract::Path<(String, String)>,
    req: axum::extract::Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !is_uuid(&agent) || !is_uuid(&request) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_PARAMS);
    }
    if !human_session(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", NOT_SESSION);
    }
    if !once_body_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_ONCE);
    }
    // 빈 본문(`{}`)은 number 가 없어 위에서 400 — 여기 오면 언제나 객체다.
    let Some(once) = once_from_body(parsed.as_ref()) else {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    };
    match rest_approve(
        &st,
        &me,
        &auth,
        &agent,
        &request,
        "approve_once",
        Some(&once),
    )
    .await
    {
        Taken::Done(r) => r,
        Taken::Hand => to_ts(st.up.clone(), peer, parts, bytes).await,
    }
}

/// 그 밖의 `{decision}` — TS `params` zod(`approve|deny|approve-once|approve_once|approve_hour`)에 없는 낱말은 언제나 400
/// (정확한 낱말은 위의 고정 경로가 먼저 받는다; 혹시 여기로 오면 TS 로 넘긴다).
pub async fn other_decision_route(
    axum::extract::State(st): axum::extract::State<std::sync::Arc<AskState>>,
    crate::auth::RequireAccount(_me, _auth): crate::auth::RequireAccount,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    axum::extract::Path((_agent, _request, decision)): axum::extract::Path<(
        String,
        String,
        String,
    )>,
    req: axum::extract::Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((b, _)) => b,
        Err(r) => return r,
    };
    if matches!(
        decision.as_str(),
        "approve" | "deny" | "approve-once" | "approve_once" | "approve_hour"
    ) {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_PARAMS)
}

#[cfg(test)]
mod once_tests {
    use super::{once_body_ok, once_from_body};
    use serde_json::json;

    #[test]
    fn once_from_body_like_ts_route() {
        let b = json!({ "ghUser": null, "number": 7.0, "headSha": "a".repeat(40) });
        let o = once_from_body(Some(&b)).unwrap();
        assert_eq!(o.gh_user, None);
        assert!(!o.relax_checks);
        assert_eq!(o.number, 7);
        assert_eq!(o.failed_checks, None);
        let b = json!({ "ghUser": "octo", "relaxChecks": true, "number": 3, "headSha": "b".repeat(40), "failedChecks": ["ci"] });
        let o = once_from_body(Some(&b)).unwrap();
        assert_eq!(o.gh_user.as_deref(), Some("octo"));
        assert!(o.relax_checks);
        assert_eq!(o.failed_checks, Some(vec!["ci".to_owned()]));
        assert!(once_from_body(None).is_none());
    }

    #[test]
    fn once_body_like_zod_strict() {
        let ok = json!({ "ghUser": null, "relaxChecks": true, "number": 7, "headSha": "a".repeat(40), "failedChecks": ["ci"] });
        assert!(once_body_ok(Some(&ok)));
        assert!(!once_body_ok(None));
        for (k, v) in [
            ("ghUser", json!("")),
            ("relaxChecks", json!(null)),
            ("number", json!(0)),
            ("headSha", json!("x")),
            ("failedChecks", json!(["c".repeat(201)])),
            ("extra", json!(1)),
        ] {
            let mut b = ok.clone();
            b[k] = v;
            assert!(!once_body_ok(Some(&b)), "{k}");
        }
    }
}

#[cfg(test)]
mod mirror_tests {
    use super::mirror_refusal_code;

    #[test]
    fn refusal_codes_like_ts_routes() {
        // 원본 카드 길: 둘 다 already_answered.
        assert_eq!(
            mirror_refusal_code(false, "already_decided"),
            "already_answered"
        );
        assert_eq!(
            mirror_refusal_code(false, "request_expired"),
            "already_answered"
        );
        // 거울 길(TS messageRoutes 거울 갈래): already_decided 만 바꾼다.
        assert_eq!(
            mirror_refusal_code(true, "already_decided"),
            "already_answered"
        );
        assert_eq!(
            mirror_refusal_code(true, "request_expired"),
            "request_expired"
        );
        assert_eq!(mirror_refusal_code(true, "forbidden"), "forbidden");
        assert_eq!(mirror_refusal_code(false, "not_once"), "not_once");
    }
}
