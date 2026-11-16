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
    let mut tx = st.write.begin().await?;
    // 카드에 없는 선택지면 `UnknownOption` 으로 끝나 깨우지 못한다 — TS 와 같다.
    let _ = record_permission_answer(&st.read, &mut tx, card, actor, DENY_OPTION).await?;
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
