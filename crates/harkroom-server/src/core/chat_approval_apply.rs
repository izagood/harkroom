//! P3b-2 입구 — 사람이 앱에서 올린 글로 권한 요청을 정한다(TS `applyChatApproval` → `approveFromMessage`).
//!
//! 고르기([`super::chat_approval_pick::select`]) → 정하기([`super::chat_approval_decide::decide_one`]) → 줄
//! ([`super::chat_approval_notice`]). 글은 이미 커밋됐다 — 실패해도 던지지 않고 로그만 남긴다(TS 와 같다).
//!
//! 선택 카드 글 답(TS `answerAskFromMessage`, P5)은 여기 오지 않는다: 같은 스레드에 열린 카드가 있으면 글째 TS 로 가고
//! (`msg_post::TS_THREAD_SQL`), 카드 링크가 선택 카드를 가리키면 쓰기 전에 [`links_ask_card`] 가 TS 로 넘긴다.

use super::ask::AskState;
use super::chat_approval_decide::decide_one;
use super::chat_approval_notice::{
    ambiguous_text, confirm_line, notice_line, post_line, refuse_line,
};
use super::chat_approval_parse::{parse_ask_pick, parse_chat_approval};
use super::chat_approval_pick::{PostedMsg, Selection, select};
use super::decide_core::{DecisionRef, resolve_decision};
use super::msg_post::PostState;
use serde_json::Value;
use sqlx::PgPool;

/// 쓰기 **전**: 이 글이 선택 카드 답(TS P5)이 될 수 있는 카드 링크를 품는가 — 그러면 글째 TS 로 넘긴다(커밋 뒤에는 넘길 수 없다).
/// 읽기 실패·이상한 거울은 넘기는 쪽(true)으로.
pub async fn links_ask_card(read: &PgPool, body: &str) -> bool {
    let Some(p) = parse_ask_pick(body) else {
        return false;
    };
    if p.card_ids.is_empty() {
        return false;
    }
    let Ok(mut conn) = read.acquire().await else {
        return true;
    };
    for id in &p.card_ids {
        match resolve_decision(&mut conn, id).await {
            Ok(Some(DecisionRef::Ask { .. })) => return true,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    false
}

/// 이 글을 글 승인 판정이 볼 것인가(쓰기 전, 순수) — 보면 `inbox.updated` 를 판정 뒤로 미룬다(TS security n2).
pub fn wants_chat_approval(body: &str) -> bool {
    parse_chat_approval(body).is_some()
}

/// 올라간 글 행(JSON)에서 판정에 쓸 칸.
pub fn posted_from_row(row: &str) -> Option<PostedMsg> {
    let v: Value = serde_json::from_str(row).ok()?;
    let created = v.get("createdAt")?.as_str()?;
    let created_ms = chrono::DateTime::parse_from_rfc3339(created)
        .ok()?
        .timestamp_millis();
    Some(PostedMsg {
        id: v.get("id")?.as_str()?.to_owned(),
        channel_id: v.get("channelId")?.as_str()?.to_owned(),
        thread_root_id: v
            .get("threadRootId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        seq: v.get("seq")?.as_i64()?,
        created_ms,
    })
}

/// TS `applyChatApproval`(권한 쪽). 부르는 쪽이 사람 세션 글임을 확인했다.
pub async fn apply(ask: &AskState, post: &PostState, msg: &PostedMsg, body: &str, actor: &str) {
    let Some(parsed) = parse_chat_approval(body) else {
        return;
    };
    let r: sqlx::Result<()> = async {
        let sel = {
            let mut conn = ask.read.acquire().await?;
            select(&mut conn, msg, body, actor, &parsed).await?
        };
        match sel {
            Selection::Silent => Ok(()),
            Selection::Refuse(why) => {
                let (b, m) = refuse_line(&msg.id, why);
                post_line(post, msg, actor, b, m).await
            }
            Selection::Ambiguous {
                in_thread,
                count,
                card_ids,
            } => {
                let (b, m) = notice_line(&msg.id, &ambiguous_text(in_thread, count), &card_ids);
                post_line(post, msg, actor, b, m).await
            }
            Selection::Decide { targets, target } => {
                let mut outs = Vec::with_capacity(targets.len());
                for c in &targets {
                    outs.push(decide_one(ask, msg, actor, c, target, &parsed).await?);
                }
                let mine: Vec<_> = outs.into_iter().filter(|o| o.c.can_decide).collect();
                if mine.is_empty() {
                    return Ok(());
                }
                if mine.len() == 1
                    && let Err(e) = &mine[0].r
                {
                    let (b, m) = refuse_line(&msg.id, e.why);
                    return post_line(post, msg, actor, b, m).await;
                }
                let (b, m) = confirm_line(&msg.id, &mine);
                post_line(post, msg, actor, b, m).await
            }
        }
    }
    .await;
    if let Err(e) = r {
        eprintln!("[chat_approval] 글 승인 판정 실패(글은 올라갔다): {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posted_row_fields() {
        let row = r#"{"id":"a","channelId":"c","threadRootId":null,"seq":42,"createdAt":"2026-11-19T07:00:00.123Z"}"#;
        let p = posted_from_row(row).unwrap();
        assert_eq!(p.thread_root(), "a");
        assert_eq!(p.seq, 42);
        assert_eq!(p.created_ms % 1000, 123);
    }

    #[test]
    fn wants_only_decision_words_or_links() {
        assert!(wants_chat_approval("승인"));
        assert!(wants_chat_approval(
            "harkroom://message/0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b"
        ));
        assert!(!wants_chat_approval("점심 뭐 먹지"));
    }
}
