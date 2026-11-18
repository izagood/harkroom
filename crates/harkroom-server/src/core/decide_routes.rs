//! S5.3 C3b-3c — 권한 카드 **거절**(deny)을 라우트에 잇는다. 판정·쓰기는 3b 코어([`super::decide_core::decide_deny`])다.
//!
//! 붙는 입구 셋(모두 `HARKROOM_CORE=rust` + 쓰기 풀 `ASK_PRIVILEGES` + 거절 두 겹 검사([`super::decide_core::deny_pool`])일 때만):
//! 1. `POST /agents/{id}/permission-requests/{requestId}/deny` — TS `permissionRequestRoutes.ts`.
//! 2. `POST /channels/{id}/messages/{messageId}/ask-answer` 의 권한 카드(거울 아님) + `deny` — TS `messageRoutes.ts`.
//! 3. `POST /channels/{id}/messages/{messageId}/ask-bundle/answer` 의 권한 줄 + `deny` — TS `answerBundleItem`(`via: bundle`).
//!
//! **맡지 않으면 언제나 쓰기 전에 TS 로 넘긴다**(읽은 바이트 그대로): 사람 세션이 아님·uuid 아님·요청 줄의 에이전트가 경로와 다름·
//! 거울·`once`·거절이 아닌 선택지·코어가 `HandToTs`(만료·꼴 바뀜). 코어가 쓰기 tx 안에서 실패하면 `internal` 이고 TS 로 넘기지 않는다.
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
use super::decide_core::{DecisionRef, DenyArgs, DenyOutcome, decide_deny, resolve_decision};
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
async fn deny_then_answer(
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
    let (request, agent) = match permission_card(st, card).await {
        Ok(Some(p)) => p,
        Ok(None) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    };
    let args = DenyArgs {
        agent_id: &agent,
        request_id: &request,
        actor_id: &me.id,
        bundle_message_id: None,
    };
    Taken::Done(match deny_then_answer(st, deny, args).await {
        Err(r) => r,
        Ok(DenyOutcome::HandToTs) => return Taken::Hand,
        Ok(DenyOutcome::Refused {
            status,
            code,
            message,
        }) => card_refusal(status, code, &message),
        // TS `decidedCard` — 답이 적힌 원본 카드.
        Ok(DenyOutcome::Denied { .. }) => match message_by_id(&st.read, card).await {
            Ok(Some(row)) => ok_json(row),
            Ok(None) => ok_json("null".to_owned()),
            Err(e) => internal(e),
        },
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
async fn approve_then_answer(
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
        // REST 는 카드를 거치지 않는다(TS: `ref.cardMessageId` null → onceFromCard 안 부름).
        has_once: false,
        bundle_message_id: None,
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
            card_message_id,
            grant_expires_at,
            grant_mode,
            ..
        }) => {
            let mut body = json!({
                "status": "granted", "grantExpiresAt": grant_expires_at, "cardMessageId": card_message_id,
            });
            if let Some(m) = grant_mode {
                body["grantMode"] = json!(m);
            }
            ok_json(body.to_string())
        }
    })
}

async fn card_has_once(read: &PgPool, card: &str, option: &str) -> sqlx::Result<bool> {
    // TS 는 `approve_once` 일 때만 카드에서 1회 머지 값을 읽는다.
    if option != "approve_once" {
        return Ok(false);
    }
    Ok(sqlx::query_scalar::<_, bool>(CARD_HAS_ONCE)
        .bind(card)
        .fetch_optional(read)
        .await?
        .unwrap_or(false))
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
    let (request, agent) = match permission_card(st, card).await {
        Ok(Some(p)) => p,
        Ok(None) => return Taken::Hand,
        Err(e) => return Taken::Done(internal(e)),
    };
    let has_once = match card_has_once(&st.read, card, option).await {
        Ok(b) => b,
        Err(e) => return Taken::Done(internal(e)),
    };
    let args = ApproveArgs {
        agent_id: &agent,
        request_id: &request,
        actor_id: &me.id,
        option,
        has_once,
        bundle_message_id: None,
    };
    Taken::Done(match approve_then_answer(st, pool, args).await {
        Err(r) => r,
        Ok(ApproveOutcome::HandToTs) => return Taken::Hand,
        Ok(ApproveOutcome::Refused {
            status,
            code,
            message,
        }) => card_refusal(status, code, &message),
        Ok(ApproveOutcome::Granted { .. }) => match message_by_id(&st.read, card).await {
            Ok(Some(row)) => ok_json(row),
            Ok(None) => ok_json("null".to_owned()),
            Err(e) => internal(e),
        },
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
    let has_once = match card_has_once(&st.read, root, option).await {
        Ok(b) => b,
        Err(e) => return Taken::Done(internal(e)),
    };
    let args = ApproveArgs {
        agent_id: &agent,
        request_id: &request,
        actor_id: &me.id,
        option,
        has_once,
        bundle_message_id: Some(bundle),
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
    match rest_approve(&st, &me, &auth, &agent, &request, option).await {
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

/// `POST /agents/{id}/permission-requests/{requestId}/approve-once`(1회 머지, 머지 거절 카드) — **부분 이식**.
/// Rust 는 판정 전 세 갈래(경로 400·사람 세션 아님 403·본문 400)만 답하고, 1회 승인 쓰기는 TS 로 넘긴다.
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
    to_ts(st.up.clone(), peer, parts, bytes).await
}

#[cfg(test)]
mod once_tests {
    use super::once_body_ok;
    use serde_json::json;

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
