//! P3b-2c — 글 승인이 고른 카드 하나를 정한다(TS `services/chatApproval.ts` `decideOne`).
//!
//! 버튼과 같은 코어(`decide_routes::deny_then_answer`·`approve_then_answer`)를 `chat: Some(..)` 으로 부른다 — 커밋·카드 답·
//! 소유자 알림(B4e)까지 버튼과 같다. 글은 이미 커밋됐으므로 코어가 `HandToTs` 를 돌려도 TS 로 넘길 수 없다 — 그때는
//! 「결정하지 못했다(failed)」로 안내한다(기동 스위치 [`super::msg_post::ChatDecideSwitches::all_on`] 이 켜졌으면 드문 꼴).

use super::ask::AskState;
use super::chat_approval_parse::{ChatAction, ChatApprovalParse};
use super::chat_approval_pick::{Candidate, ChatTarget, PostedMsg, Refusal};
use super::decide_approve::{ApproveArgs, ApproveOutcome};
use super::decide_core::{ChatVia, DenyArgs, DenyOutcome, channel_visible_conn};
use super::decide_merge_once::Once;
use super::decide_routes::{approve_then_answer, deny_then_answer};
use serde_json::Value;

/// TS `Outcome` — 카드 하나의 결말.
#[derive(Debug, Clone)]
pub struct DecideResult {
    pub c: Candidate,
    pub r: Result<Done, Refused>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    pub grant_expires_at: Option<String>,
    pub grant_mode: Option<&'static str>,
    pub denied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused {
    pub why: Refusal,
    /// 볼 수 없는 채널의 카드 — 안내 줄에 내용을 적지 않는다(security F1).
    pub hidden: bool,
}

fn no(c: &Candidate, why: Refusal) -> DecideResult {
    DecideResult {
        c: c.clone(),
        r: Err(Refused { why, hidden: false }),
    }
}

/// TS `REFUSAL_BY_CODE`.
pub fn refusal_by_code(code: &str) -> Refusal {
    match code {
        "card_stale" | "head_moved" => Refusal::HeadChanged,
        "already_decided" | "superseded" | "denial_used" | "pr_closed" => Refusal::Decided,
        "request_expired" | "denial_expired" => Refusal::Expired,
        "relax_required" => Refusal::CiWord,
        "mandate_unavailable" => Refusal::MergeNoMandate,
        _ => Refusal::Failed,
    }
}

/// 머지 거절 카드의 1회 값(TS: `o.number` 가 number, `o.headSha` 가 string). gh 계정은 비운다(G1).
fn once_for_chat(once: Option<&Value>, ci_word: bool) -> Result<Once, Refusal> {
    let o = once.ok_or(Refusal::Failed)?;
    // TS `typeof o.number !== 'number'` — 정수가 아닌 수는 TS 는 받지만 Rust 1회 코어는 정수만 받는다(드문 꼴 → failed).
    let number = o
        .get("number")
        .and_then(Value::as_i64)
        .ok_or(Refusal::Failed)?;
    let head_sha = o
        .get("headSha")
        .and_then(Value::as_str)
        .ok_or(Refusal::Failed)?
        .to_owned();
    let ci = o.get("reason").and_then(Value::as_str) == Some("ci_not_green");
    if ci && !ci_word {
        return Err(Refusal::CiWord);
    }
    let failed_checks = ci.then(|| {
        o.get("failedChecks")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    });
    Ok(Once {
        gh_user: None,
        relax_checks: ci,
        number,
        head_sha,
        failed_checks,
    })
}

/// TS `decideOne`.
pub async fn decide_one(
    st: &AskState,
    msg: &PostedMsg,
    actor: &str,
    c: &Candidate,
    target: ChatTarget,
    parsed: &ChatApprovalParse,
) -> sqlx::Result<DecideResult> {
    if !c.can_decide {
        return Ok(no(c, Refusal::NoCard));
    }
    {
        let mut conn = st.read.acquire().await?;
        if !channel_visible_conn(&mut conn, &c.channel_id, actor).await? {
            return Ok(DecideResult {
                c: c.clone(),
                r: Err(Refused {
                    why: Refusal::Hidden,
                    hidden: true,
                }),
            });
        }
    }
    let before = if c.channel_id == msg.channel_id {
        c.card_seq < msg.seq
    } else {
        c.card_created_ms <= msg.created_ms
    };
    if !before {
        return Ok(no(c, Refusal::NotBefore));
    }
    if c.status != "pending" {
        return Ok(no(c, Refusal::Decided));
    }
    if c.expired {
        return Ok(no(c, Refusal::Expired));
    }
    let chat = Some(ChatVia {
        message_id: &msg.id,
        target: Some(target.as_str()),
    });
    if parsed.action == Some(ChatAction::Deny) {
        let Some(pool) = st.deny.as_ref() else {
            return Ok(no(c, Refusal::Failed));
        };
        let args = DenyArgs {
            agent_id: &c.agent_id,
            request_id: &c.request_id,
            actor_id: actor,
            bundle_message_id: None,
            mirror_message_id: None,
            chat,
        };
        return Ok(match deny_then_answer(st, pool, args).await {
            Ok(DenyOutcome::Denied { .. }) => DecideResult {
                c: c.clone(),
                r: Ok(Done {
                    grant_expires_at: None,
                    grant_mode: None,
                    denied: true,
                }),
            },
            Ok(DenyOutcome::Refused { code, .. }) => no(c, refusal_by_code(code)),
            Ok(DenyOutcome::HandToTs) | Err(_) => no(c, Refusal::Failed),
        });
    }
    let (option, once) = if c.denial_id.is_some() {
        // 머지 거절 카드 — 이번 한 번. 맨 글(T3)은 카드에서.
        if target == ChatTarget::T3 {
            return Ok(no(c, Refusal::OnceOnCard));
        }
        match once_for_chat(c.once.as_ref(), parsed.ci_word) {
            Ok(o) => ("approve_once", Some(o)),
            Err(why) => return Ok(no(c, why)),
        }
    } else if c.kind == "command" {
        ("approve_once", None)
    } else {
        ("approve_new_mandate", None)
    };
    let Some(pool) = st.approve.as_ref() else {
        return Ok(no(c, Refusal::Failed));
    };
    let args = ApproveArgs {
        agent_id: &c.agent_id,
        request_id: &c.request_id,
        actor_id: actor,
        option,
        has_once: once.is_some(),
        once: once.as_ref(),
        bundle_message_id: None,
        mirror_message_id: None,
        chat,
    };
    Ok(match approve_then_answer(st, pool, args).await {
        Ok(ApproveOutcome::Granted {
            grant_expires_at,
            grant_mode,
            ..
        }) => DecideResult {
            c: c.clone(),
            r: Ok(Done {
                grant_expires_at,
                grant_mode,
                denied: false,
            }),
        },
        Ok(ApproveOutcome::Refused { code, .. }) => no(c, refusal_by_code(code)),
        Ok(ApproveOutcome::HandToTs) | Err(_) => no(c, Refusal::Failed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refusal_codes_like_ts() {
        assert_eq!(refusal_by_code("card_stale"), Refusal::HeadChanged);
        assert_eq!(refusal_by_code("superseded"), Refusal::Decided);
        assert_eq!(refusal_by_code("denial_expired"), Refusal::Expired);
        assert_eq!(refusal_by_code("relax_required"), Refusal::CiWord);
        assert_eq!(
            refusal_by_code("mandate_unavailable"),
            Refusal::MergeNoMandate
        );
        assert_eq!(refusal_by_code("forbidden"), Refusal::Failed);
    }

    #[test]
    fn once_needs_ci_word_on_ci_cards() {
        let o = json!({ "number": 7, "headSha": "a".repeat(40), "reason": "ci_not_green", "failedChecks": ["ci", 3] });
        assert_eq!(once_for_chat(Some(&o), false).unwrap_err(), Refusal::CiWord);
        let once = once_for_chat(Some(&o), true).unwrap();
        assert!(once.relax_checks);
        assert_eq!(once.gh_user, None);
        assert_eq!(once.failed_checks, Some(vec!["ci".to_owned()]));
        let o = json!({ "number": 7, "headSha": "a".repeat(40), "reason": "not_granted" });
        let once = once_for_chat(Some(&o), false).unwrap();
        assert!(!once.relax_checks);
        assert_eq!(once.failed_checks, None);
        assert_eq!(once_for_chat(None, true).unwrap_err(), Refusal::Failed);
        assert_eq!(
            once_for_chat(Some(&json!({ "number": "7", "headSha": "x" })), true).unwrap_err(),
            Refusal::Failed
        );
    }
}
